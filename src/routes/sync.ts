/**
 * Sync Routes
 * Endpoints for triggering and monitoring data synchronization
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../config/logger.js';
import { mlClient } from '../modules/ml/clients/ml.client.js';
import { createMLSyncService } from '../modules/ml/services/sync.service.js';
import { mpClient } from '../modules/mp/clients/mp.client.js';
import { createMPSyncService } from '../modules/mp/services/sync.service.js';
import { syncLogRepository } from '../modules/sync/repositories/sync-log.repository.js';

const logger = createLogger('sync-routes');

// Query schema for sync requests
interface SyncQuery {
  dateFrom?: string;
  dateTo?: string;
  forceFullSync?: string;
}

// Query schema for sync logs
interface SyncLogsQuery {
  entityType?: string;
  source?: string;
  limit?: string;
}

export async function syncRoutes(fastify: FastifyInstance): Promise<void> {
  // ==========================================================================
  // ML SYNC ROUTES
  // ==========================================================================

  /**
   * Trigger ML orders sync
   */
  fastify.post(
    '/sync/ml/orders',
    async (
      request: FastifyRequest<{ Querystring: SyncQuery }>,
      reply: FastifyReply
    ) => {
      const { dateFrom, dateTo, forceFullSync } = request.query;

      logger.info({ dateFrom, dateTo, forceFullSync }, 'ML orders sync requested');

      try {
        const syncService = createMLSyncService(mlClient);

        const result = await syncService.syncOrders({
          dateFrom: dateFrom ? new Date(dateFrom) : undefined,
          dateTo: dateTo ? new Date(dateTo) : undefined,
          forceFullSync: forceFullSync === 'true',
        });

        return reply.code(200).send({
          success: true,
          message: 'ML orders sync completed',
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'ML orders sync failed');
        return reply.code(500).send({
          success: false,
          message: 'ML orders sync failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get ML sync status
   */
  fastify.get('/sync/ml/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const syncService = createMLSyncService(mlClient);
      const status = await syncService.getSyncStatus();

      return reply.code(200).send({
        success: true,
        data: status,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get ML sync status');
      return reply.code(500).send({
        success: false,
        message: 'Failed to get sync status',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * Get ML orders from database
   */
  fastify.get(
    '/sync/ml/orders',
    async (
      request: FastifyRequest<{
        Querystring: {
          dateFrom?: string;
          dateTo?: string;
          status?: string;
          limit?: string;
          offset?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { dateFrom, dateTo, status, limit, offset } = request.query;

        const syncService = createMLSyncService(mlClient);
        const result = await syncService.getOrders({
          dateFrom: dateFrom ? new Date(dateFrom) : undefined,
          dateTo: dateTo ? new Date(dateTo) : undefined,
          status: status as import('@prisma/client').OrderStatus | undefined,
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : undefined,
        });

        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get ML orders');
        return reply.code(500).send({
          success: false,
          message: 'Failed to get orders',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  // ==========================================================================
  // MP SYNC ROUTES
  // ==========================================================================

  /**
   * Trigger MP movements sync
   */
  fastify.post(
    '/sync/mp/movements',
    async (
      request: FastifyRequest<{ Querystring: SyncQuery }>,
      reply: FastifyReply
    ) => {
      const { dateFrom, dateTo, forceFullSync } = request.query;

      logger.info({ dateFrom, dateTo, forceFullSync }, 'MP movements sync requested');

      try {
        const syncService = createMPSyncService(mpClient);

        const result = await syncService.syncMovements({
          dateFrom: dateFrom ? new Date(dateFrom) : undefined,
          dateTo: dateTo ? new Date(dateTo) : undefined,
          forceFullSync: forceFullSync === 'true',
        });

        return reply.code(200).send({
          success: true,
          message: 'MP movements sync completed',
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'MP movements sync failed');
        return reply.code(500).send({
          success: false,
          message: 'MP movements sync failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get MP sync status
   */
  fastify.get('/sync/mp/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const syncService = createMPSyncService(mpClient);
      const status = await syncService.getSyncStatus();

      return reply.code(200).send({
        success: true,
        data: status,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get MP sync status');
      return reply.code(500).send({
        success: false,
        message: 'Failed to get sync status',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * Get MP movements from database
   */
  fastify.get(
    '/sync/mp/movements',
    async (
      request: FastifyRequest<{
        Querystring: {
          dateFrom?: string;
          dateTo?: string;
          type?: string;
          limit?: string;
          offset?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { dateFrom, dateTo, type, limit, offset } = request.query;

        const syncService = createMPSyncService(mpClient);
        const result = await syncService.getMovements({
          dateFrom: dateFrom ? new Date(dateFrom) : undefined,
          dateTo: dateTo ? new Date(dateTo) : undefined,
          type: type as import('@prisma/client').MovementType | undefined,
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : undefined,
        });

        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get MP movements');
        return reply.code(500).send({
          success: false,
          message: 'Failed to get movements',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  // ==========================================================================
  // COMBINED SYNC ROUTES
  // ==========================================================================

  /**
   * Trigger full sync (ML + MP)
   */
  fastify.post(
    '/sync/all',
    async (
      request: FastifyRequest<{ Querystring: SyncQuery }>,
      reply: FastifyReply
    ) => {
      const { dateFrom, dateTo, forceFullSync } = request.query;

      logger.info({ dateFrom, dateTo, forceFullSync }, 'Full sync requested');

      const options = {
        dateFrom: dateFrom ? new Date(dateFrom) : undefined,
        dateTo: dateTo ? new Date(dateTo) : undefined,
        forceFullSync: forceFullSync === 'true',
      };

      try {
        // Run syncs in parallel
        const [mlResult, mpResult] = await Promise.allSettled([
          createMLSyncService(mlClient).syncOrders(options),
          createMPSyncService(mpClient).syncMovements(options),
        ]);

        return reply.code(200).send({
          success: true,
          message: 'Full sync completed',
          data: {
            ml: mlResult.status === 'fulfilled' ? mlResult.value : { error: (mlResult.reason as Error).message },
            mp: mpResult.status === 'fulfilled' ? mpResult.value : { error: (mpResult.reason as Error).message },
          },
        });
      } catch (error) {
        logger.error({ error }, 'Full sync failed');
        return reply.code(500).send({
          success: false,
          message: 'Full sync failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  // ==========================================================================
  // SYNC LOGS ROUTES
  // ==========================================================================

  /**
   * Get sync logs
   */
  fastify.get(
    '/sync/logs',
    async (
      request: FastifyRequest<{ Querystring: SyncLogsQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { entityType, source, limit } = request.query;

        const logs = await syncLogRepository.findMany(
          {
            entityType,
            source,
          },
          limit ? parseInt(limit, 10) : 50
        );

        return reply.code(200).send({
          success: true,
          data: logs,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get sync logs');
        return reply.code(500).send({
          success: false,
          message: 'Failed to get sync logs',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get sync log by ID
   */
  fastify.get(
    '/sync/logs/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        const log = await syncLogRepository.findById(id);

        if (!log) {
          return reply.code(404).send({
            success: false,
            message: 'Sync log not found',
          });
        }

        return reply.code(200).send({
          success: true,
          data: log,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get sync log');
        return reply.code(500).send({
          success: false,
          message: 'Failed to get sync log',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Reset stuck syncs - marks all RUNNING syncs as FAILED
   */
  fastify.post(
    '/sync/reset',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      logger.info('Resetting stuck syncs');

      try {
        const result = await syncLogRepository.resetStuckSyncs();
        
        return reply.code(200).send({
          success: true,
          message: 'Stuck syncs reset successfully',
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to reset stuck syncs');
        return reply.code(500).send({
          success: false,
          message: 'Failed to reset stuck syncs',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Enrich existing orders with billing fee breakdown (taxaML vs taxaMP)
   * This is a separate endpoint to enrich orders without re-syncing
   */
  fastify.post<{ Body: { days?: number; limit?: number; force?: boolean } }>(
    '/sync/ml/enrich-billing',
    async (request: FastifyRequest<{ Body: { days?: number; limit?: number; force?: boolean } }>, reply: FastifyReply) => {
      const days = request.body?.days || 30;
      const limit = request.body?.limit || 100;
      const force = request.body?.force || false;
      
      logger.info({ days, limit, force }, 'Starting billing enrichment for existing orders');
      
      try {
        const { prisma } = await import('../shared/database/client.js');
        
        const dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - days);
        
        // Find orders that don't have billing_charges yet
        const orders = await prisma.mLOrder.findMany({
          where: {
            dateCreated: { gte: dateFrom },
            status: 'PAID',
          },
          select: { externalId: true, rawData: true },
          orderBy: { dateCreated: 'desc' },
          take: limit,
        });
        
        // Filter orders without billing data (or missing billing_transaction_amount if force)
        const orderIdsToEnrich = orders
          .filter(o => {
            const raw = o.rawData as Record<string, unknown> | null;
            if (!raw || !Array.isArray(raw.billing_charges) || (raw.billing_charges as unknown[]).length === 0) {
              return true; // No billing data at all
            }
            if (force && raw.billing_transaction_amount === undefined) {
              return true; // Has billing_charges but missing transaction_amount
            }
            return false;
          })
          .map(o => o.externalId);
        
        logger.info({ total: orders.length, toEnrich: orderIdsToEnrich.length }, 'Orders to enrich with billing data');
        
        if (orderIdsToEnrich.length === 0) {
          return reply.code(200).send({
            success: true,
            message: 'All orders already have billing data',
            data: { total: orders.length, enriched: 0 },
          });
        }
        
        const syncService = createMLSyncService(mlClient);
        const result = await syncService.enrichOrdersWithBilling(orderIdsToEnrich);
        
        return reply.code(200).send({
          success: true,
          message: 'Billing enrichment completed',
          data: { total: orders.length, ...result },
        });
      } catch (error) {
        logger.error({ error }, 'Billing enrichment failed');
        return reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Diagnostic endpoint: test ML payment details and billing info APIs
   * This checks if the ML token can access fee information
   */
  fastify.get(
    '/sync/ml/diagnose-fees',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      logger.info('Running ML fee diagnostics');
      
      try {
        const { prisma } = await import('../shared/database/client.js');
        
        // Get a recent order with payments
        const order = await prisma.mLOrder.findFirst({
          where: { status: 'PAID' },
          include: { payments: true },
          orderBy: { dateCreated: 'desc' },
        });

        if (!order || order.payments.length === 0) {
          return reply.code(200).send({
            success: false,
            message: 'No paid orders with payments found',
          });
        }

        const payment = order.payments[0];
        const results: Record<string, unknown> = {
          orderId: order.externalId,
          paymentId: payment.externalId,
          tests: {},
        };

        // Test 1: Payment Details API (/v1/payments/{id})
        try {
          const paymentDetails = await mlClient.getPaymentDetails(Number(payment.externalId));
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            paymentDetails: {
              success: true,
              fee_details: paymentDetails.fee_details,
              marketplace_fee: paymentDetails.marketplace_fee,
              shipping_cost: paymentDetails.shipping_cost,
            },
          };
        } catch (error) {
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            paymentDetails: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }

        // Test 2: Order Billing API (/orders/{id}/billing_info)
        try {
          const billing = await mlClient.getOrderBilling(Number(order.externalId));
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            billingInfo: {
              success: true,
              data: billing,
            },
          };
        } catch (error) {
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            billingInfo: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }

        // Test 3: Billing API - Payment charges (/billing/integration/payment/{id}/charges)
        try {
          const billingCharges = await mlClient.getBillingPaymentCharges(payment.externalId);
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            billingPaymentCharges: {
              success: true,
              data: billingCharges,
            },
          };
        } catch (error) {
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            billingPaymentCharges: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }

        // Test 4: Billing API - Period details (try current month)
        try {
          const now = new Date();
          const periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
          const billingPeriod = await mlClient.getBillingPeriodDetails(periodKey, 3);
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            billingPeriodDetails: {
              success: true,
              periodKey,
              data: billingPeriod,
            },
          };
        } catch (error) {
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            billingPeriodDetails: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }

        // Test 5: Billing API - Order details (/billing/integration/group/ML/order/details)
        try {
          const billingOrder = await mlClient.getBillingOrderDetails(order.externalId);
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            billingOrderDetails: {
              success: true,
              total: billingOrder.total,
              sale_fee: billingOrder.results?.[0]?.sale_fee || null,
              charges: billingOrder.results?.[0]?.details?.map((d: { charge_info: { transaction_detail: string; detail_amount: number; detail_sub_type: string; debited_from_operation: string }; marketplace_info: { marketplace: string } }) => ({
                type: d.charge_info?.detail_sub_type,
                description: d.charge_info?.transaction_detail,
                amount: d.charge_info?.detail_amount,
                debited: d.charge_info?.debited_from_operation,
                marketplace: d.marketplace_info?.marketplace,
              })) || [],
            },
          };
        } catch (error) {
          results.tests = {
            ...(results.tests as Record<string, unknown>),
            billingOrderDetails: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }

        // Test 6: Check rawData of payment for existing fee info
        const rawData = payment.rawData as Record<string, unknown> | null;
        results.tests = {
          ...(results.tests as Record<string, unknown>),
          existingRawData: {
            has_fee_details: rawData ? Array.isArray(rawData.fee_details) && (rawData.fee_details as unknown[]).length > 0 : false,
            fee_details: rawData?.fee_details || null,
            marketplace_fee: rawData?.marketplace_fee || null,
            has_charges_details: rawData ? Array.isArray(rawData.charges_details) && (rawData.charges_details as unknown[]).length > 0 : false,
            charges_details: rawData?.charges_details || null,
          },
        };

        return reply.code(200).send({
          success: true,
          data: results,
        });
      } catch (error) {
        logger.error({ error }, 'Fee diagnostics failed');
        return reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );
}
