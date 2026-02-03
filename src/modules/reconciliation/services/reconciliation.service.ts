/**
 * Reconciliation Service
 * Engine to match ML orders with MP movements
 */

import {
  ReconciliationStatus,
  Prisma,
  MLOrder,
  MPMovement,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { createLogger } from '../../../config/logger.js';;
import { prisma } from '../../../shared/database/client.js';
import { reconciliationRepository } from '../repositories/reconciliation.repository.js';

const logger = createLogger('reconciliation-service');

// Tolerance for amount matching (in BRL)
const AMOUNT_TOLERANCE = 0.01;

// Match confidence thresholds
const HIGH_CONFIDENCE = 0.95;
const MEDIUM_CONFIDENCE = 0.7;
const LOW_CONFIDENCE = 0.5;

export interface ReconciliationOptions {
  periodStart: Date;
  periodEnd: Date;
  tolerancePercent?: number; // Tolerance for amount differences (default: 1%)
}

export interface ReconciliationResult {
  reconciliationId: string;
  periodStart: Date;
  periodEnd: Date;
  totalOrders: number;
  totalMovements: number;
  matched: number;
  partialMatched: number;
  unmatched: number;
  divergent: number;
  expectedRevenue: Decimal;
  actualRevenue: Decimal;
  totalFees: Decimal;
  discrepancy: Decimal;
  duration: number;
}

interface OrderWithPayments extends MLOrder {
  payments: Array<{
    id: string;
    externalId: string;
    transactionAmount: Decimal;
    status: string;
  }>;
}

interface MatchCandidate {
  movement: MPMovement;
  confidence: number;
  matchType: string;
  difference: Decimal;
}

export class ReconciliationService {
  /**
   * Run reconciliation for a period
   */
  async reconcile(options: ReconciliationOptions): Promise<ReconciliationResult> {
    const startTime = Date.now();
    const tolerancePercent = options.tolerancePercent ?? 1;

    logger.info(
      { periodStart: options.periodStart, periodEnd: options.periodEnd },
      'Starting reconciliation'
    );

    // Create reconciliation record
    const reconciliation = await reconciliationRepository.create({
      periodStart: options.periodStart,
      periodEnd: options.periodEnd,
      status: ReconciliationStatus.PENDING,
    });

    try {
      // Fetch orders for period
      const orders = await this.fetchOrdersForPeriod(
        options.periodStart,
        options.periodEnd
      );

      // Fetch movements for period
      const movements = await this.fetchMovementsForPeriod(
        options.periodStart,
        options.periodEnd
      );

      logger.info(
        { orders: orders.length, movements: movements.length },
        'Fetched data for reconciliation'
      );

      // Create a map of movements by reference for quick lookup
      const movementsByRef = this.groupMovementsByReference(movements);
      const matchedMovementIds = new Set<string>();

      // Process each order
      const items: Prisma.ReconciliationItemCreateManyInput[] = [];
      let matched = 0;
      let partialMatched = 0;
      let unmatched = 0;
      let divergent = 0;
      let expectedRevenue = new Decimal(0);
      let actualRevenue = new Decimal(0);
      let totalFees = new Decimal(0);

      for (const order of orders) {
        expectedRevenue = expectedRevenue.plus(order.totalAmount);

        // Try to find matching movement(s)
        const matchResult = this.findMatchingMovement(
          order,
          movementsByRef,
          matchedMovementIds,
          tolerancePercent
        );

        if (matchResult.status === ReconciliationStatus.MATCHED) {
          matched++;
          if (matchResult.movement) {
            matchedMovementIds.add(matchResult.movement.id);
            actualRevenue = actualRevenue.plus(matchResult.movement.amount);
            if (matchResult.movement.fee) {
              totalFees = totalFees.plus(matchResult.movement.fee);
            }
          }
        } else if (matchResult.status === ReconciliationStatus.PARTIAL_MATCH) {
          partialMatched++;
          if (matchResult.movement) {
            matchedMovementIds.add(matchResult.movement.id);
            actualRevenue = actualRevenue.plus(matchResult.movement.amount);
          }
        } else if (matchResult.status === ReconciliationStatus.DIVERGENT) {
          divergent++;
          if (matchResult.movement) {
            matchedMovementIds.add(matchResult.movement.id);
            actualRevenue = actualRevenue.plus(matchResult.movement.amount);
          }
        } else {
          unmatched++;
        }

        items.push({
          reconciliationId: reconciliation.id,
          orderId: order.id,
          movementId: matchResult.movement?.id || null,
          status: matchResult.status,
          orderAmount: order.totalAmount,
          movementAmount: matchResult.movement?.amount || null,
          difference: matchResult.difference,
          matchType: matchResult.matchType,
          matchConfidence: matchResult.confidence,
          matchedBy: 'auto',
          matchedAt: matchResult.status !== ReconciliationStatus.UNMATCHED ? new Date() : null,
        });
      }

      // Add unmatched movements (movements without orders)
      for (const movement of movements) {
        if (!matchedMovementIds.has(movement.id)) {
          items.push({
            reconciliationId: reconciliation.id,
            orderId: null,
            movementId: movement.id,
            status: ReconciliationStatus.UNMATCHED,
            orderAmount: null,
            movementAmount: movement.amount,
            difference: movement.amount,
            matchType: 'no_order',
            matchConfidence: 0,
            matchedBy: null,
            matchedAt: null,
          });
          unmatched++;
          actualRevenue = actualRevenue.plus(movement.amount);
        }
      }

      // Create all items
      await prisma.reconciliationItem.createMany({ data: items });

      // Calculate discrepancy
      const discrepancy = actualRevenue.minus(expectedRevenue);

      // Determine overall status
      let overallStatus: ReconciliationStatus = ReconciliationStatus.MATCHED;
      if (unmatched > 0 || divergent > 0) {
        overallStatus = ReconciliationStatus.PARTIAL_MATCH;
      }
      if (matched === 0 && partialMatched === 0) {
        overallStatus = ReconciliationStatus.UNMATCHED;
      }

      // Update reconciliation with results
      await reconciliationRepository.update(reconciliation.id, {
        status: overallStatus,
        totalOrders: orders.length,
        totalMovements: movements.length,
        matchedCount: matched,
        unmatchedCount: unmatched,
        divergentCount: divergent,
        expectedRevenue,
        actualRevenue,
        totalFees,
        netRevenue: actualRevenue.minus(totalFees),
        discrepancy,
        completedAt: new Date(),
      });

      const duration = Date.now() - startTime;

      logger.info(
        {
          reconciliationId: reconciliation.id,
          matched,
          partialMatched,
          unmatched,
          divergent,
          discrepancy: discrepancy.toNumber(),
          duration,
        },
        'Reconciliation completed'
      );

      return {
        reconciliationId: reconciliation.id,
        periodStart: options.periodStart,
        periodEnd: options.periodEnd,
        totalOrders: orders.length,
        totalMovements: movements.length,
        matched,
        partialMatched,
        unmatched,
        divergent,
        expectedRevenue,
        actualRevenue,
        totalFees,
        discrepancy,
        duration,
      };
    } catch (error) {
      // Update reconciliation as failed
      await reconciliationRepository.update(reconciliation.id, {
        status: ReconciliationStatus.UNMATCHED,
        notes: error instanceof Error ? error.message : 'Unknown error',
      });

      logger.error({ error }, 'Reconciliation failed');
      throw error;
    }
  }

  /**
   * Fetch orders for the period
   */
  private async fetchOrdersForPeriod(
    periodStart: Date,
    periodEnd: Date
  ): Promise<OrderWithPayments[]> {
    return prisma.mLOrder.findMany({
      where: {
        dateCreated: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      include: {
        payments: {
          select: {
            id: true,
            externalId: true,
            transactionAmount: true,
            status: true,
          },
        },
      },
      orderBy: { dateCreated: 'asc' },
    });
  }

  /**
   * Fetch movements for the period
   */
  private async fetchMovementsForPeriod(
    periodStart: Date,
    periodEnd: Date
  ): Promise<MPMovement[]> {
    return prisma.mPMovement.findMany({
      where: {
        dateCreated: {
          gte: periodStart,
          lte: periodEnd,
        },
        type: 'SALE', // Only sale movements
      },
      orderBy: { dateCreated: 'asc' },
    });
  }

  /**
   * Group movements by reference ID and external reference
   */
  private groupMovementsByReference(movements: MPMovement[]): Map<string, MPMovement[]> {
    const map = new Map<string, MPMovement[]>();

    for (const movement of movements) {
      // Group by reference ID
      if (movement.referenceId) {
        const key = `ref:${movement.referenceId}`;
        if (!map.has(key)) {
          map.set(key, []);
        }
        map.get(key)!.push(movement);
      }

      // Group by external reference
      if (movement.externalReference) {
        const key = `ext:${movement.externalReference}`;
        if (!map.has(key)) {
          map.set(key, []);
        }
        map.get(key)!.push(movement);
      }

      // Group by amount (for fallback matching)
      const amountKey = `amt:${movement.amount.toString()}`;
      if (!map.has(amountKey)) {
        map.set(amountKey, []);
      }
      map.get(amountKey)!.push(movement);
    }

    return map;
  }

  /**
   * Find matching movement for an order
   */
  private findMatchingMovement(
    order: OrderWithPayments,
    movementsByRef: Map<string, MPMovement[]>,
    matchedIds: Set<string>,
    tolerancePercent: number
  ): {
    status: ReconciliationStatus;
    movement: MPMovement | null;
    confidence: number;
    matchType: string;
    difference: Decimal;
  } {
    const candidates: MatchCandidate[] = [];

    // Strategy 1: Match by payment ID (highest confidence)
    for (const payment of order.payments) {
      const movements = movementsByRef.get(`ref:${payment.externalId}`) || [];
      for (const movement of movements) {
        if (!matchedIds.has(movement.id)) {
          const difference = new Decimal(movement.amount).minus(order.totalAmount);
          candidates.push({
            movement,
            confidence: HIGH_CONFIDENCE,
            matchType: 'payment_id',
            difference,
          });
        }
      }
    }

    // Strategy 2: Match by order ID in external reference
    const orderRef = movementsByRef.get(`ext:${order.externalId}`) || [];
    for (const movement of orderRef) {
      if (!matchedIds.has(movement.id)) {
        const difference = new Decimal(movement.amount).minus(order.totalAmount);
        candidates.push({
          movement,
          confidence: HIGH_CONFIDENCE * 0.95,
          matchType: 'order_reference',
          difference,
        });
      }
    }

    // Strategy 3: Match by exact amount + date proximity
    const amountMovements = movementsByRef.get(`amt:${order.totalAmount.toString()}`) || [];
    for (const movement of amountMovements) {
      if (!matchedIds.has(movement.id)) {
        const orderDate = new Date(order.dateCreated).getTime();
        const movementDate = new Date(movement.dateCreated).getTime();
        const daysDiff = Math.abs(orderDate - movementDate) / (1000 * 60 * 60 * 24);

        // Higher confidence if dates are close
        let confidence = MEDIUM_CONFIDENCE;
        if (daysDiff < 1) confidence = 0.85;
        else if (daysDiff < 3) confidence = 0.75;
        else if (daysDiff < 7) confidence = 0.65;

        candidates.push({
          movement,
          confidence,
          matchType: 'amount_date',
          difference: new Decimal(0),
        });
      }
    }

    // If no candidates, return unmatched
    if (candidates.length === 0) {
      return {
        status: ReconciliationStatus.UNMATCHED,
        movement: null,
        confidence: 0,
        matchType: 'none',
        difference: order.totalAmount.negated(),
      };
    }

    // Sort by confidence (descending)
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];

    // Calculate tolerance
    const toleranceAmount = order.totalAmount
      .times(tolerancePercent)
      .dividedBy(100);

    // Determine status based on difference
    const absDifference = best.difference.abs();

    if (absDifference.lessThanOrEqualTo(AMOUNT_TOLERANCE)) {
      // Exact match
      return {
        status: ReconciliationStatus.MATCHED,
        movement: best.movement,
        confidence: best.confidence,
        matchType: best.matchType,
        difference: best.difference,
      };
    } else if (absDifference.lessThanOrEqualTo(toleranceAmount)) {
      // Within tolerance
      return {
        status: ReconciliationStatus.PARTIAL_MATCH,
        movement: best.movement,
        confidence: best.confidence * 0.9,
        matchType: best.matchType,
        difference: best.difference,
      };
    } else if (best.confidence >= LOW_CONFIDENCE) {
      // Matched but with significant difference
      return {
        status: ReconciliationStatus.DIVERGENT,
        movement: best.movement,
        confidence: best.confidence * 0.8,
        matchType: best.matchType,
        difference: best.difference,
      };
    }

    // No good match found
    return {
      status: ReconciliationStatus.UNMATCHED,
      movement: null,
      confidence: 0,
      matchType: 'none',
      difference: order.totalAmount.negated(),
    };
  }

  /**
   * Get reconciliation by ID with items
   */
  async getReconciliation(id: string) {
    return reconciliationRepository.findById(id);
  }

  /**
   * Get reconciliation list
   */
  async getReconciliations(
    filters: {
      status?: ReconciliationStatus;
      periodStart?: Date;
      periodEnd?: Date;
    } = {},
    page = 1,
    limit = 20
  ) {
    return reconciliationRepository.findMany(
      {
        status: filters.status,
        periodFrom: filters.periodStart,
        periodTo: filters.periodEnd,
      },
      { page, limit }
    );
  }

  /**
   * Get reconciliation summary
   */
  async getSummary(id: string) {
    const [reconciliation, itemStats] = await Promise.all([
      reconciliationRepository.findById(id),
      reconciliationRepository.getReconciliationSummary(id),
    ]);

    if (!reconciliation) {
      return null;
    }

    return {
      reconciliation: {
        id: reconciliation.id,
        periodStart: reconciliation.periodStart,
        periodEnd: reconciliation.periodEnd,
        status: reconciliation.status,
        totalOrders: reconciliation.totalOrders,
        totalMovements: reconciliation.totalMovements,
        matchedCount: reconciliation.matchedCount,
        unmatchedCount: reconciliation.unmatchedCount,
        divergentCount: reconciliation.divergentCount,
        expectedRevenue: reconciliation.expectedRevenue,
        actualRevenue: reconciliation.actualRevenue,
        totalFees: reconciliation.totalFees,
        netRevenue: reconciliation.netRevenue,
        discrepancy: reconciliation.discrepancy,
        completedAt: reconciliation.completedAt,
      },
      itemStats,
    };
  }

  /**
   * Resolve an item manually
   */
  async resolveItem(
    itemId: string,
    data: {
      status: ReconciliationStatus;
      notes?: string;
      resolvedBy?: string;
    }
  ) {
    const item = await prisma.reconciliationItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      throw new Error('Item not found');
    }

    const updated = await reconciliationRepository.updateItemStatus(
      itemId,
      data.status,
      data.notes,
      data.resolvedBy
    );

    // Update reconciliation counts
    await this.updateReconciliationCounts(item.reconciliationId);

    return updated;
  }

  /**
   * Update reconciliation counts after manual resolution
   */
  private async updateReconciliationCounts(reconciliationId: string) {
    const counts = await prisma.reconciliationItem.groupBy({
      by: ['status'],
      where: { reconciliationId },
      _count: true,
    });

    const statusCounts: Record<string, number> = {};
    for (const c of counts) {
      statusCounts[c.status] = c._count;
    }

    await reconciliationRepository.update(reconciliationId, {
      matchedCount: (statusCounts[ReconciliationStatus.MATCHED] || 0) +
        (statusCounts[ReconciliationStatus.RESOLVED] || 0),
      unmatchedCount: statusCounts[ReconciliationStatus.UNMATCHED] || 0,
      divergentCount: statusCounts[ReconciliationStatus.DIVERGENT] || 0,
    });
  }

  /**
   * Get dashboard stats
   */
  async getDashboardStats() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      latestReconciliation,
      recentReconciliations,
      orderCount,
      movementCount,
    ] = await Promise.all([
      reconciliationRepository.getLatest(),
      reconciliationRepository.findMany(
        { periodFrom: thirtyDaysAgo },
        { page: 1, limit: 10 }
      ),
      prisma.mLOrder.count({
        where: { dateCreated: { gte: thirtyDaysAgo } },
      }),
      prisma.mPMovement.count({
        where: { dateCreated: { gte: thirtyDaysAgo } },
      }),
    ]);

    return {
      latest: latestReconciliation
        ? {
            id: latestReconciliation.id,
            periodStart: latestReconciliation.periodStart,
            periodEnd: latestReconciliation.periodEnd,
            status: latestReconciliation.status,
            matchedCount: latestReconciliation.matchedCount,
            unmatchedCount: latestReconciliation.unmatchedCount,
            discrepancy: latestReconciliation.discrepancy,
          }
        : null,
      recentCount: recentReconciliations.total,
      last30Days: {
        orders: orderCount,
        movements: movementCount,
      },
    };
  }
}

export const reconciliationService = new ReconciliationService();
