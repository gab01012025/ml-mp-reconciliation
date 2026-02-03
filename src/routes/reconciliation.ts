/**
 * Reconciliation Routes
 * Endpoints for running and viewing reconciliations
 */

import { ReconciliationStatus } from '@prisma/client';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../config/logger.js';
import { reconciliationService } from '../modules/reconciliation/services/reconciliation.service.js';

const logger = createLogger('reconciliation-routes');

// Query interfaces
interface ReconcileQuery {
  periodStart: string;
  periodEnd: string;
  tolerancePercent?: string;
}

interface ListQuery {
  status?: ReconciliationStatus;
  periodStart?: string;
  periodEnd?: string;
  page?: string;
  limit?: string;
}

interface ResolveBody {
  status: ReconciliationStatus;
  notes?: string;
  resolvedBy?: string;
}

export async function reconciliationRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Run reconciliation for a period
   */
  fastify.post(
    '/reconciliation/run',
    async (
      request: FastifyRequest<{ Querystring: ReconcileQuery }>,
      reply: FastifyReply
    ) => {
      const { periodStart, periodEnd, tolerancePercent } = request.query;

      if (!periodStart || !periodEnd) {
        return reply.code(400).send({
          success: false,
          message: 'periodStart and periodEnd are required',
        });
      }

      logger.info({ periodStart, periodEnd }, 'Reconciliation requested');

      try {
        const result = await reconciliationService.reconcile({
          periodStart: new Date(periodStart),
          periodEnd: new Date(periodEnd),
          tolerancePercent: tolerancePercent ? parseFloat(tolerancePercent) : undefined,
        });

        return reply.code(200).send({
          success: true,
          message: 'Reconciliation completed',
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'Reconciliation failed');
        return reply.code(500).send({
          success: false,
          message: 'Reconciliation failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get reconciliation list
   */
  fastify.get(
    '/reconciliation',
    async (
      request: FastifyRequest<{ Querystring: ListQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { status, periodStart, periodEnd, page, limit } = request.query;

        const result = await reconciliationService.getReconciliations(
          {
            status,
            periodStart: periodStart ? new Date(periodStart) : undefined,
            periodEnd: periodEnd ? new Date(periodEnd) : undefined,
          },
          page ? parseInt(page, 10) : 1,
          limit ? parseInt(limit, 10) : 20
        );

        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get reconciliations');
        return reply.code(500).send({
          success: false,
          message: 'Failed to get reconciliations',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get reconciliation by ID
   */
  fastify.get(
    '/reconciliation/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        const result = await reconciliationService.getReconciliation(id);

        if (!result) {
          return reply.code(404).send({
            success: false,
            message: 'Reconciliation not found',
          });
        }

        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get reconciliation');
        return reply.code(500).send({
          success: false,
          message: 'Failed to get reconciliation',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get reconciliation summary
   */
  fastify.get(
    '/reconciliation/:id/summary',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        const result = await reconciliationService.getSummary(id);

        if (!result) {
          return reply.code(404).send({
            success: false,
            message: 'Reconciliation not found',
          });
        }

        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get reconciliation summary');
        return reply.code(500).send({
          success: false,
          message: 'Failed to get reconciliation summary',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Resolve a reconciliation item manually
   */
  fastify.patch(
    '/reconciliation/items/:itemId/resolve',
    async (
      request: FastifyRequest<{
        Params: { itemId: string };
        Body: ResolveBody;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { itemId } = request.params;
        const { status, notes, resolvedBy } = request.body;

        if (!status) {
          return reply.code(400).send({
            success: false,
            message: 'status is required',
          });
        }

        const result = await reconciliationService.resolveItem(itemId, {
          status,
          notes,
          resolvedBy,
        });

        return reply.code(200).send({
          success: true,
          message: 'Item resolved',
          data: result,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to resolve item');

        if (error instanceof Error && error.message === 'Item not found') {
          return reply.code(404).send({
            success: false,
            message: 'Item not found',
          });
        }

        return reply.code(500).send({
          success: false,
          message: 'Failed to resolve item',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get dashboard stats
   */
  fastify.get('/reconciliation/dashboard', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stats = await reconciliationService.getDashboardStats();

      return reply.code(200).send({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get dashboard stats');
      return reply.code(500).send({
        success: false,
        message: 'Failed to get dashboard stats',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
