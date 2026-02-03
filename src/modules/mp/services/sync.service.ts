/**
 * MP Sync Service
 * Synchronizes movements from Mercado Pago to local database
 */

import { MovementType, Prisma, SyncStatus } from '@prisma/client';
import { createLogger } from '../../../config/logger.js';
import { prisma } from '../../../shared/database/client.js';
import { syncLogRepository } from '../../sync/repositories/sync-log.repository.js';
import { MPClient, MPMovement, MPPayment as MPApiPayment } from '../clients/mp.client.js';

const logger = createLogger('mp-sync-service');

// Map MP movement type to our enum
function mapMovementType(type: string): MovementType {
  const typeMap: Record<string, MovementType> = {
    payment: MovementType.SALE,
    payment_addition: MovementType.SALE,
    refund: MovementType.REFUND,
    payout: MovementType.WITHDRAWAL,
    withdrawal: MovementType.WITHDRAWAL,
    transfer: MovementType.TRANSFER,
    fee: MovementType.FEE,
    chargeback: MovementType.CHARGEBACK,
    reserve: MovementType.ADJUSTMENT,
    release: MovementType.ADJUSTMENT,
    shipping: MovementType.SHIPPING,
    tax: MovementType.TAX,
  };

  return typeMap[type.toLowerCase()] || MovementType.OTHER;
}

interface SyncOptions {
  dateFrom?: Date;
  dateTo?: Date;
  forceFullSync?: boolean;
}

interface SyncResult {
  syncedMovements: number;
  syncedPayments: number;
  errors: number;
  syncLogId: string;
  duration: number;
}

export class MPSyncService {
  private client: MPClient;
  private userId: string | null = null;

  constructor(client: MPClient) {
    this.client = client;
  }

  /**
   * Ensure we have the user ID
   */
  private async ensureUserId(): Promise<string> {
    if (!this.userId) {
      const me = await this.client.getMe();
      this.userId = String(me.id);
    }
    return this.userId;
  }

  /**
   * Sync all movements from MP
   */
  async syncMovements(options: SyncOptions = {}): Promise<SyncResult> {
    const startTime = Date.now();
    let syncedMovements = 0;
    let syncedPayments = 0;
    let errors = 0;

    // Get date range
    const dateTo = options.dateTo || new Date();
    let dateFrom = options.dateFrom;

    // If no date from, get from last successful sync or default to 30 days
    if (!dateFrom && !options.forceFullSync) {
      const lastSync = await syncLogRepository.findLatestSuccessful('movements', 'mp');
      if (lastSync?.completedAt) {
        dateFrom = lastSync.completedAt;
      } else {
        // Default: last 30 days
        dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - 30);
      }
    } else if (!dateFrom) {
      // Full sync: last 90 days (MP API limit)
      dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - 90);
    }

    // Create sync log entry
    const syncLog = await syncLogRepository.create({
      entityType: 'movements',
      source: 'mp',
      status: SyncStatus.RUNNING,
      startedAt: new Date(),
      dateFrom,
      dateTo,
      metadata: {
        forceFullSync: options.forceFullSync || false,
      } as Prisma.InputJsonValue,
    });

    logger.info({ syncLogId: syncLog.id, dateFrom, dateTo }, 'Starting MP movements sync');

    try {
      const userId = await this.ensureUserId();

      // Sync balance first (may fail for test accounts)
      try {
        await this.syncBalance(userId);
      } catch (balanceError) {
        logger.warn({ error: balanceError }, 'Balance sync failed (may be test account), continuing...');
      }

      // Fetch all movements (may return empty for test accounts)
      const movements = await this.client.getAllMovements({
        dateFrom,
        dateTo,
      });

      logger.info({ count: movements.length }, 'Fetched movements from MP');

      // Process movements in batches
      const batchSize = 50;
      for (let i = 0; i < movements.length; i += batchSize) {
        const batch = movements.slice(i, i + batchSize);

        for (const movement of batch) {
          try {
            await this.syncMovement(userId, movement);
            syncedMovements++;
          } catch (error) {
            logger.error({ movementId: movement.id, error }, 'Error syncing movement');
            errors++;
          }
        }

        logger.debug({ progress: Math.min(i + batchSize, movements.length), total: movements.length }, 'Sync progress');
      }

      // Also sync payments for reference matching (this is the main data source)
      const paymentsSynced = await this.syncPayments(userId, dateFrom, dateTo);
      syncedPayments = paymentsSynced;

      // Update sync log
      const duration = Date.now() - startTime;
      await syncLogRepository.complete(syncLog.id, {
        totalRecords: syncedMovements + syncedPayments,
        createdRecords: syncedMovements + syncedPayments,
        updatedRecords: 0,
        failedRecords: errors,
      });

      logger.info({ syncedMovements, syncedPayments, errors, duration }, 'MP movements sync completed');

      return {
        syncedMovements,
        syncedPayments,
        errors,
        syncLogId: syncLog.id,
        duration,
      };
    } catch (error) {
      await syncLogRepository.fail(syncLog.id, error instanceof Error ? error : new Error('Unknown error'));

      logger.error({ error }, 'MP movements sync failed');
      throw error;
    }
  }

  /**
   * Sync a single movement
   */
  private async syncMovement(userId: string, movement: MPMovement): Promise<void> {
    await prisma.mPMovement.upsert({
      where: { externalId: String(movement.id) },
      create: {
        externalId: String(movement.id),
        userId,
        type: mapMovementType(movement.type),
        action: movement.action,
        amount: movement.amount,
        fee: movement.fee,
        netAmount: movement.amount - movement.fee,
        currency: movement.currency_id,
        referenceId: movement.reference_id,
        externalReference: movement.external_reference,
        dateCreated: new Date(movement.date_created),
        releaseDate: movement.money_release_date
          ? new Date(movement.money_release_date)
          : null,
        description: movement.description,
        status: movement.status,
        detail: movement.detail,
        balanceAvailable: movement.balance,
        rawData: JSON.parse(JSON.stringify(movement)) as Prisma.InputJsonValue,
      },
      update: {
        status: movement.status,
        releaseDate: movement.money_release_date
          ? new Date(movement.money_release_date)
          : null,
        rawData: JSON.parse(JSON.stringify(movement)) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Sync balance
   */
  private async syncBalance(userId: string): Promise<void> {
    try {
      const balance = await this.client.getBalance();

      const now = new Date();

      await prisma.mPBalance.create({
        data: {
          userId,
          snapshotDate: now,
          availableBalance: balance.available_balance,
          pendingBalance: balance.unavailable_balance,
          totalBalance: balance.total_amount,
          currency: 'BRL',
          rawData: JSON.parse(JSON.stringify(balance)) as Prisma.InputJsonValue,
        },
      });

      logger.debug({ availableBalance: balance.available_balance }, 'Balance synced');
    } catch (error) {
      logger.warn({ error }, 'Failed to sync balance');
    }
  }

  /**
   * Sync payments for reference matching
   */
  private async syncPayments(userId: string, dateFrom: Date, dateTo: Date): Promise<number> {
    try {
      const payments = await this.client.getAllPayments({
        dateFrom,
        dateTo,
      });

      let count = 0;
      for (const payment of payments) {
        try {
          await this.syncPayment(userId, payment);
          count++;
        } catch (error) {
          logger.warn({ paymentId: payment.id, error }, 'Failed to sync payment');
        }
      }

      return count;
    } catch (error) {
      logger.warn({ error }, 'Failed to sync payments');
      return 0;
    }
  }

  /**
   * Sync a single payment (for reference matching with ML)
   */
  private async syncPayment(userId: string, payment: MPApiPayment): Promise<void> {
    // Store payment data in movements table with SALE type
    // This helps with reconciliation between ML and MP
    const existingMovement = await prisma.mPMovement.findFirst({
      where: {
        referenceId: String(payment.id),
        type: MovementType.SALE,
      },
    });

    if (!existingMovement) {
      // Create a movement record from payment if not exists
      const feeAmount = payment.fee_details?.reduce((sum, f) => sum + f.amount, 0) || 0;
      await prisma.mPMovement.create({
        data: {
          externalId: `payment-${payment.id}`,
          userId,
          type: MovementType.SALE,
          action: payment.operation_type,
          amount: payment.transaction_amount,
          fee: feeAmount,
          netAmount: payment.transaction_details.net_received_amount,
          currency: payment.currency_id,
          referenceId: String(payment.id),
          externalReference: payment.external_reference,
          dateCreated: new Date(payment.date_created),
          releaseDate: payment.money_release_date
            ? new Date(payment.money_release_date)
            : null,
          description: payment.description,
          status: payment.status,
          rawData: JSON.parse(JSON.stringify(payment)) as Prisma.InputJsonValue,
        },
      });
    }
  }

  /**
   * Get sync status
   */
  async getSyncStatus() {
    const lastSync = await syncLogRepository.findLatestByType('movements', 'mp');
    const lastSuccessful = await syncLogRepository.findLatestSuccessful('movements', 'mp');

    // Get latest balance
    const balance = await prisma.mPBalance.findFirst({
      orderBy: { snapshotDate: 'desc' },
    });

    // Get movement counts
    const movementCounts = await prisma.mPMovement.groupBy({
      by: ['type'],
      _count: true,
    });

    return {
      lastSync: lastSync
        ? {
            id: lastSync.id,
            status: lastSync.status,
            startedAt: lastSync.startedAt,
            completedAt: lastSync.completedAt,
            totalRecords: lastSync.totalRecords,
            failedRecords: lastSync.failedRecords,
            errorMessage: lastSync.errorMessage,
          }
        : null,
      lastSuccessfulSync: lastSuccessful?.completedAt || null,
      currentBalance: balance
        ? {
            available: balance.availableBalance,
            pending: balance.pendingBalance,
            total: balance.totalBalance,
            currency: balance.currency,
            snapshotDate: balance.snapshotDate,
          }
        : null,
      movementCounts: movementCounts.reduce(
        (acc, item) => {
          acc[item.type] = item._count;
          return acc;
        },
        {} as Record<string, number>
      ),
    };
  }

  /**
   * Get movements for a date range
   */
  async getMovements(options: {
    dateFrom?: Date;
    dateTo?: Date;
    type?: MovementType;
    limit?: number;
    offset?: number;
  }) {
    const where: Prisma.MPMovementWhereInput = {};

    if (options.dateFrom || options.dateTo) {
      where.dateCreated = {};
      if (options.dateFrom) where.dateCreated.gte = options.dateFrom;
      if (options.dateTo) where.dateCreated.lte = options.dateTo;
    }

    if (options.type) {
      where.type = options.type;
    }

    const [movements, total] = await Promise.all([
      prisma.mPMovement.findMany({
        where,
        orderBy: { dateCreated: 'desc' },
        take: options.limit || 50,
        skip: options.offset || 0,
      }),
      prisma.mPMovement.count({ where }),
    ]);

    return {
      movements,
      total,
      limit: options.limit || 50,
      offset: options.offset || 0,
    };
  }
}

// Factory function
export function createMPSyncService(client: MPClient): MPSyncService {
  return new MPSyncService(client);
}
