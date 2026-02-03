/**
 * Reports Routes
 * Endpoints for generating reports and exporting data
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '../config/logger.js';
import { csvExportService } from '../modules/reports/services/csv-export.service.js';
import { excelExportService } from '../modules/reports/services/excel-export.service.js';
import { reportService } from '../modules/reports/services/report.service.js';

const logger = createLogger('reports-routes');

// Query interface for date range
interface DateRangeQuery {
  startDate: string;
  endDate: string;
}

// Query interface for export
interface ExportQuery extends DateRangeQuery {
  format?: 'json' | 'csv';
}

// Query for top products
interface TopProductsQuery extends DateRangeQuery {
  limit?: string;
}

// Query for period comparison
interface ComparisonQuery {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
}

export async function reportsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Helper to validate and parse date range
   */
  const parseDateRange = (startDate: string, endDate: string) => {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid date format');
    }

    if (start > end) {
      throw new Error('startDate must be before endDate');
    }

    return { startDate: start, endDate: end };
  };

  // ==========================================================================
  // SUMMARY & ANALYTICS
  // ==========================================================================

  /**
   * Get financial summary
   */
  fastify.get(
    '/reports/summary',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const summary = await reportService.getFinancialSummary(range);

        return reply.code(200).send({
          success: true,
          data: summary,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get financial summary');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get daily report
   */
  fastify.get(
    '/reports/daily',
    async (
      request: FastifyRequest<{ Querystring: ExportQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate, format } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);

        if (format === 'csv') {
          const csv = await csvExportService.exportDailyReport(range);
          return reply
            .code(200)
            .header('Content-Type', 'text/csv')
            .header('Content-Disposition', `attachment; filename="daily-report-${startDate}-${endDate}.csv"`)
            .send(csv);
        }

        const report = await reportService.getDailyReport(range);

        return reply.code(200).send({
          success: true,
          data: report,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get daily report');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get top products
   */
  fastify.get(
    '/reports/top-products',
    async (
      request: FastifyRequest<{ Querystring: TopProductsQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate, limit } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const products = await reportService.getTopProducts(
          range,
          limit ? parseInt(limit, 10) : 10
        );

        return reply.code(200).send({
          success: true,
          data: products,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get top products');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get fee breakdown
   */
  fastify.get(
    '/reports/fees',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const fees = await reportService.getFeeBreakdown(range);

        return reply.code(200).send({
          success: true,
          data: fees,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get fee breakdown');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Compare two periods
   */
  fastify.get(
    '/reports/comparison',
    async (
      request: FastifyRequest<{ Querystring: ComparisonQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { currentStart, currentEnd, previousStart, previousEnd } = request.query;

        if (!currentStart || !currentEnd || !previousStart || !previousEnd) {
          return reply.code(400).send({
            success: false,
            message: 'currentStart, currentEnd, previousStart, and previousEnd are required',
          });
        }

        const currentPeriod = parseDateRange(currentStart, currentEnd);
        const previousPeriod = parseDateRange(previousStart, previousEnd);

        const comparison = await reportService.getPeriodComparison(currentPeriod, previousPeriod);

        return reply.code(200).send({
          success: true,
          data: comparison,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get period comparison');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  // ==========================================================================
  // CSV EXPORTS
  // ==========================================================================

  /**
   * Export orders to CSV
   */
  fastify.get(
    '/reports/export/orders',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const csv = await csvExportService.exportOrders(range);

        return reply
          .code(200)
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', `attachment; filename="orders-${startDate}-${endDate}.csv"`)
          .send(csv);
      } catch (error) {
        logger.error({ error }, 'Failed to export orders');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Export order items to CSV
   */
  fastify.get(
    '/reports/export/order-items',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const csv = await csvExportService.exportOrderItems(range);

        return reply
          .code(200)
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', `attachment; filename="order-items-${startDate}-${endDate}.csv"`)
          .send(csv);
      } catch (error) {
        logger.error({ error }, 'Failed to export order items');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Export movements to CSV
   */
  fastify.get(
    '/reports/export/movements',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const csv = await csvExportService.exportMovements(range);

        return reply
          .code(200)
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', `attachment; filename="movements-${startDate}-${endDate}.csv"`)
          .send(csv);
      } catch (error) {
        logger.error({ error }, 'Failed to export movements');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Export reconciliation items to CSV
   */
  fastify.get(
    '/reports/export/reconciliation/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        const csv = await csvExportService.exportReconciliationItems(id);

        return reply
          .code(200)
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', `attachment; filename="reconciliation-${id}.csv"`)
          .send(csv);
      } catch (error) {
        logger.error({ error }, 'Failed to export reconciliation');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Export financial summary to CSV
   */
  fastify.get(
    '/reports/export/summary',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const csv = await csvExportService.exportFinancialSummary(range);

        return reply
          .code(200)
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', `attachment; filename="summary-${startDate}-${endDate}.csv"`)
          .send(csv);
      } catch (error) {
        logger.error({ error }, 'Failed to export summary');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Export top products to CSV
   */
  fastify.get(
    '/reports/export/top-products',
    async (
      request: FastifyRequest<{ Querystring: TopProductsQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate, limit } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const csv = await csvExportService.exportTopProducts(
          range,
          limit ? parseInt(limit, 10) : 50
        );

        return reply
          .code(200)
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', `attachment; filename="top-products-${startDate}-${endDate}.csv"`)
          .send(csv);
      } catch (error) {
        logger.error({ error }, 'Failed to export top products');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  // ==========================================================================
  // EXCEL EXPORTS
  // ==========================================================================

  /**
   * Export orders to Excel
   */
  fastify.get(
    '/reports/excel/orders',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const buffer = await excelExportService.exportOrders(range);

        return reply
          .code(200)
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('Content-Disposition', `attachment; filename="pedidos-ml-${startDate}-${endDate}.xlsx"`)
          .send(buffer);
      } catch (error) {
        logger.error({ error }, 'Failed to export orders to Excel');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Export movements to Excel
   */
  fastify.get(
    '/reports/excel/movements',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const buffer = await excelExportService.exportMovements(range);

        return reply
          .code(200)
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('Content-Disposition', `attachment; filename="movimentos-mp-${startDate}-${endDate}.xlsx"`)
          .send(buffer);
      } catch (error) {
        logger.error({ error }, 'Failed to export movements to Excel');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Export reconciliation to Excel
   */
  fastify.get(
    '/reports/excel/reconciliation',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery & { reconciliationId?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate, reconciliationId } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const buffer = await excelExportService.exportReconciliation({
          ...range,
          reconciliationId,
        });

        return reply
          .code(200)
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('Content-Disposition', `attachment; filename="conciliacao-${startDate}-${endDate}.xlsx"`)
          .send(buffer);
      } catch (error) {
        logger.error({ error }, 'Failed to export reconciliation to Excel');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Export complete financial report to Excel
   */
  fastify.get(
    '/reports/excel/full',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const buffer = await excelExportService.exportFullReport(range);

        return reply
          .code(200)
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('Content-Disposition', `attachment; filename="relatorio-financeiro-${startDate}-${endDate}.xlsx"`)
          .send(buffer);
      } catch (error) {
        logger.error({ error }, 'Failed to export full report to Excel');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );
}
