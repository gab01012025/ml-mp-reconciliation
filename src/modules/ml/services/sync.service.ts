/**
 * ML Sync Service
 * Synchronizes orders from Mercado Livre to local database
 */

import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { createLogger } from '../../../config/logger.js';
import { prisma } from '../../../shared/database/client.js';
import { syncLogRepository } from '../../sync/repositories/sync-log.repository.js';
import { MLClient, MLOrder, MLPayment as MLApiPayment } from '../clients/ml.client.js';

const logger = createLogger('ml-sync-service');

// Map ML status to our enum
function mapOrderStatus(status: string): OrderStatus {
  const statusMap: Record<string, OrderStatus> = {
    pending: 'PENDING',
    paid: 'PAID',
    shipped: 'SHIPPED',
    delivered: 'DELIVERED',
    cancelled: 'CANCELLED',
    refunded: 'REFUNDED',
  };
  return statusMap[status.toLowerCase()] ?? 'PENDING';
}

function mapPaymentStatus(status: string): PaymentStatus {
  const statusMap: Record<string, PaymentStatus> = {
    pending: 'PENDING',
    approved: 'APPROVED',
    authorized: 'AUTHORIZED',
    in_process: 'IN_PROCESS',
    in_mediation: 'IN_MEDIATION',
    rejected: 'REJECTED',
    cancelled: 'CANCELLED',
    refunded: 'REFUNDED',
    charged_back: 'CHARGED_BACK',
  };
  return statusMap[status.toLowerCase()] ?? 'PENDING';
}

export interface SyncResult {
  totalFetched: number;
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

export class MLSyncService {
  private client: MLClient;

  constructor(userId?: string) {
    this.client = new MLClient(userId);
  }

  /**
   * Sync orders from ML for a date range
   */
  async syncOrders(params: {
    dateFrom?: Date;
    dateTo?: Date;
    forceFullSync?: boolean;
    onProgress?: (fetched: number, total: number) => void;
  } = {}): Promise<SyncResult> {
    const result: SyncResult = {
      totalFetched: 0,
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
    };

    // Check if sync is already running
    const isRunning = await syncLogRepository.isRunning('orders', 'ml');
    if (isRunning) {
      throw new Error('ML orders sync is already running');
    }

    // Get date range
    const dateTo = params.dateTo || new Date();
    let dateFrom = params.dateFrom;

    // If no date from, get from last successful sync or default to 30 days
    if (!dateFrom && !params.forceFullSync) {
      const lastSync = await syncLogRepository.findLatestSuccessful('orders', 'ml');
      if (lastSync?.completedAt) {
        dateFrom = lastSync.completedAt;
      } else {
        // Default: last 30 days
        dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - 30);
      }
    } else if (!dateFrom) {
      // Full sync: last 90 days
      dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - 90);
    }

    // Create sync log
    const syncLog = await syncLogRepository.create({
      entityType: 'orders',
      source: 'ml',
      status: 'RUNNING',
      startedAt: new Date(),
      dateFrom,
      dateTo,
    });

    try {
      logger.info(
        { dateFrom, dateTo },
        'Starting ML orders sync'
      );

      // Get seller ID
      const sellerId = await this.client.getSellerId();

      // Fetch all orders
      const orders = await this.client.getAllOrders({
        dateFrom,
        dateTo,
        onProgress: params.onProgress,
      });

      result.totalFetched = orders.length;
      logger.info({ count: orders.length }, 'Fetched ML orders');

      // Process each order
      for (const order of orders) {
        try {
          await this.upsertOrder(order, sellerId);
          
          // Check if order existed
          const existed = await prisma.mLOrder.findUnique({
            where: { externalId: String(order.id) },
          });
          
          if (existed) {
            result.updated++;
          } else {
            result.created++;
          }
        } catch (error) {
          result.failed++;
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          result.errors.push(`Order ${order.id}: ${errorMsg}`);
          logger.error({ orderId: order.id, error }, 'Failed to sync order');
        }
      }

      // Update sync log
      await syncLogRepository.complete(syncLog.id, {
        totalRecords: result.totalFetched,
        createdRecords: result.created,
        updatedRecords: result.updated,
        failedRecords: result.failed,
      });

      logger.info(result, 'ML orders sync completed');
      return result;
    } catch (error) {
      await syncLogRepository.fail(syncLog.id, error as Error);
      throw error;
    }
  }

  /**
   * Upsert a single order with items, payments, and shipments
   */
  private async upsertOrder(order: MLOrder, sellerId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Upsert main order
      const dbOrder = await tx.mLOrder.upsert({
        where: { externalId: String(order.id) },
        create: {
          externalId: String(order.id),
          sellerId,
          buyerId: order.buyer ? String(order.buyer.id) : null,
          status: mapOrderStatus(order.status),
          totalAmount: order.total_amount,
          currency: order.currency_id,
          shippingCost: order.payments
            ? order.payments.reduce((sum: number, p: { shipping_cost?: number }) => sum + (p.shipping_cost || 0), 0)
            : 0,
          dateCreated: new Date(order.date_created),
          dateClosed: order.date_closed ? new Date(order.date_closed) : null,
          dateLastUpdated: new Date(order.last_updated),
          packId: order.pack_id ? String(order.pack_id) : null,
          rawData: JSON.parse(JSON.stringify(order)) as Prisma.InputJsonValue,
        },
        update: {
          status: mapOrderStatus(order.status),
          totalAmount: order.total_amount,
          shippingCost: order.payments
            ? order.payments.reduce((sum: number, p: { shipping_cost?: number }) => sum + (p.shipping_cost || 0), 0)
            : 0,
          dateClosed: order.date_closed ? new Date(order.date_closed) : null,
          dateLastUpdated: new Date(order.last_updated),
          rawData: JSON.parse(JSON.stringify(order)) as Prisma.InputJsonValue,
        },
      });

      // Upsert order items
      for (const item of order.order_items) {
        await tx.mLOrderItem.upsert({
          where: {
            id: `${dbOrder.id}-${item.item.id}`,
          },
          create: {
            id: `${dbOrder.id}-${item.item.id}`,
            orderId: dbOrder.id,
            externalId: item.item.id,
            title: item.item.title,
            quantity: item.quantity,
            unitPrice: item.unit_price,
            saleFee: item.sale_fee || 0,
            categoryId: item.item.category_id,
            sku: item.item.seller_sku,
            variationId: item.item.variation_id ? String(item.item.variation_id) : null,
            listingTypeId: item.listing_type_id,
          },
          update: {
            title: item.item.title,
            quantity: item.quantity,
            unitPrice: item.unit_price,
            saleFee: item.sale_fee || 0,
            listingTypeId: item.listing_type_id,
          },
        });
      }

      // Upsert payments
      for (const payment of order.payments) {
        await this.upsertPayment(tx, dbOrder.id, payment);
      }

      // Upsert shipment if exists AND update order shippingCost from shipment
      if (order.shipping?.id) {
        try {
          const shipmentDetails = await this.client.getShipment(order.shipping.id);
          
          // Update order shippingCost from the actual shipment cost
          const shipmentCost = shipmentDetails.base_cost || 0;
          if (shipmentCost > 0) {
            await tx.mLOrder.update({
              where: { id: dbOrder.id },
              data: { shippingCost: shipmentCost },
            });
            logger.debug({ orderId: order.id, shipmentCost }, 'Updated order shippingCost from shipment');
          }

          await tx.mLShipment.upsert({
            where: { externalId: String(shipmentDetails.id) },
            create: {
              externalId: String(shipmentDetails.id),
              orderId: dbOrder.id,
              status: shipmentDetails.status,
              substatus: shipmentDetails.substatus,
              shippingMode: shipmentDetails.mode,
              trackingNumber: shipmentDetails.tracking_number,
              trackingMethod: shipmentDetails.tracking_method,
              receiverId: String(shipmentDetails.receiver_id),
              cost: shipmentDetails.base_cost,
              dateCreated: new Date(shipmentDetails.date_created),
              dateFirstPrinted: shipmentDetails.date_first_printed
                ? new Date(shipmentDetails.date_first_printed)
                : null,
              dateDelivered: shipmentDetails.status_history?.date_delivered
                ? new Date(shipmentDetails.status_history.date_delivered)
                : null,
              rawData: JSON.parse(JSON.stringify(shipmentDetails)) as Prisma.InputJsonValue,
            },
            update: {
              status: shipmentDetails.status,
              substatus: shipmentDetails.substatus,
              trackingNumber: shipmentDetails.tracking_number,
              dateDelivered: shipmentDetails.status_history?.date_delivered
                ? new Date(shipmentDetails.status_history.date_delivered)
                : null,
              rawData: JSON.parse(JSON.stringify(shipmentDetails)) as Prisma.InputJsonValue,
            },
          });
        } catch (error) {
          logger.warn({ shipmentId: order.shipping.id, error }, 'Failed to fetch shipment details');
        }
      }
    });
  }

  /**
   * Upsert a payment record with fee details
   */
  private async upsertPayment(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    orderId: string,
    payment: MLApiPayment
  ): Promise<void> {
    // Try to get detailed payment info with fee_details
    let enrichedPayment: Record<string, unknown> = { ...payment };
    
    try {
      const paymentDetails = await this.client.getPaymentDetails(payment.id);
      // Merge fee_details into the payment data
      enrichedPayment = {
        ...payment,
        fee_details: paymentDetails.fee_details || [],
        charges_details: paymentDetails.charges_details || [],
        marketplace_fee: paymentDetails.marketplace_fee || 0,
      };
      logger.debug({ paymentId: payment.id, feeDetails: paymentDetails.fee_details }, 'Got payment fee details');
    } catch (error) {
      logger.debug({ paymentId: payment.id, error }, 'Could not get payment details, using basic info');
    }

    await tx.mLPayment.upsert({
      where: { externalId: String(payment.id) },
      create: {
        externalId: String(payment.id),
        orderId,
        status: mapPaymentStatus(payment.status),
        statusDetail: payment.status_detail,
        paymentType: payment.payment_type,
        paymentMethodId: payment.payment_method_id,
        transactionAmount: payment.transaction_amount,
        totalPaidAmount: payment.total_paid_amount,
        shippingCost: payment.shipping_cost,
        currency: payment.currency_id,
        dateCreated: new Date(payment.date_created),
        dateApproved: payment.date_approved ? new Date(payment.date_approved) : null,
        dateLastModified: payment.date_last_modified
          ? new Date(payment.date_last_modified)
          : null,
        rawData: JSON.parse(JSON.stringify(enrichedPayment)) as Prisma.InputJsonValue,
      },
      update: {
        status: mapPaymentStatus(payment.status),
        statusDetail: payment.status_detail,
        totalPaidAmount: payment.total_paid_amount,
        dateApproved: payment.date_approved ? new Date(payment.date_approved) : null,
        dateLastModified: payment.date_last_modified
          ? new Date(payment.date_last_modified)
          : null,
        rawData: JSON.parse(JSON.stringify(enrichedPayment)) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Get sync status
   */
  async getSyncStatus() {
    const lastSync = await syncLogRepository.findLatestByType('orders', 'ml');
    const lastSuccessful = await syncLogRepository.findLatestSuccessful('orders', 'ml');

    return {
      lastSync: lastSync
        ? {
            id: lastSync.id,
            status: lastSync.status,
            startedAt: lastSync.startedAt,
            completedAt: lastSync.completedAt,
            totalRecords: lastSync.totalRecords,
            createdRecords: lastSync.createdRecords,
            updatedRecords: lastSync.updatedRecords,
            failedRecords: lastSync.failedRecords,
            errorMessage: lastSync.errorMessage,
          }
        : null,
      lastSuccessful: lastSuccessful
        ? {
            id: lastSuccessful.id,
            completedAt: lastSuccessful.completedAt,
            totalRecords: lastSuccessful.totalRecords,
          }
        : null,
    };
  }

  /**
   * Get orders from database
   */
  async getOrders(options: {
    dateFrom?: Date;
    dateTo?: Date;
    status?: OrderStatus;
    limit?: number;
    offset?: number;
  }) {
    const where: Prisma.MLOrderWhereInput = {};

    if (options.dateFrom || options.dateTo) {
      where.dateCreated = {};
      if (options.dateFrom) where.dateCreated.gte = options.dateFrom;
      if (options.dateTo) where.dateCreated.lte = options.dateTo;
    }

    if (options.status) {
      where.status = options.status;
    }

    const [orders, total] = await Promise.all([
      prisma.mLOrder.findMany({
        where,
        include: {
          items: true,
          payments: true,
          shipments: true,
        },
        orderBy: { dateCreated: 'desc' },
        take: options.limit || 50,
        skip: options.offset || 0,
      }),
      prisma.mLOrder.count({ where }),
    ]);

    return {
      orders,
      total,
      limit: options.limit || 50,
      offset: options.offset || 0,
    };
  }
}

export const mlSyncService = new MLSyncService();

// Factory function
export function createMLSyncService(client: MLClient): MLSyncService {
  const service = new MLSyncService();
  // Replace client with provided one
  (service as unknown as { client: MLClient }).client = client;
  return service;
}
