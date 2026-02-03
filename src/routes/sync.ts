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
}
