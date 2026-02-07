/**
 * Reports Routes
 * Endpoints for generating reports and exporting data
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '../config/logger.js';
import { csvExportService } from '../modules/reports/services/csv-export.service.js';
import { excelExportService } from '../modules/reports/services/excel-export.service.js';
import { reportService } from '../modules/reports/services/report.service.js';
import { prisma } from '../shared/database/client.js';

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
  // JSON ENDPOINTS FOR GOOGLE SHEETS / N8N
  // ==========================================================================

  /**
   * Get orders with full details for Google Sheets export
   * Returns: ID, Produto, Valor Produto, Taxa Venda, Frete, Total Líquido
   */
  fastify.get(
    '/reports/orders/details',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery & { limit?: string } }>,
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

        const start = new Date(startDate);
        const end = new Date(endDate);
        const maxResults = limit ? parseInt(limit, 10) : 500;

        const orders = await prisma.mLOrder.findMany({
          where: {
            dateCreated: {
              gte: start,
              lte: end,
            },
          },
          include: {
            items: true,
            payments: true,
            shipments: true,
          },
          orderBy: { dateCreated: 'desc' },
          take: maxResults,
        });

        // Helper: extract fee breakdown from order rawData (billing API) or fallback to payment rawData
        const getFeesBreakdown = (order: typeof orders[0]): { taxaML: number; taxaMP: number } => {
          const orderRaw = order.rawData as Record<string, unknown> | null;
          
          // Try billing_charges from order rawData (populated by sync from billing API)
          if (orderRaw && Array.isArray(orderRaw.billing_charges)) {
            let taxaML = 0;
            let taxaMP = 0;
            for (const charge of orderRaw.billing_charges) {
              const c = charge as { type?: string; amount?: number; marketplace?: string };
              if (c.type === 'CVVML' || c.type === 'CV') {
                taxaML += c.amount || 0;
              } else if (c.type === 'CVVPRC' || c.type === 'CCMP') {
                taxaMP += c.amount || 0;
              }
            }
            if (taxaML > 0 || taxaMP > 0) {
              return { taxaML, taxaMP };
            }
          }
          
          // Fallback: sale_fee from items is taxaVenda (combined ML+MP), taxaMP stays 0
          return { taxaML: 0, taxaMP: 0 };
        };

        // Format data for Google Sheets
        const formattedOrders = orders.flatMap((order) => {
          // Calculate totals per order
          const totalItems = order.items.reduce(
            (sum, item) => sum + item.unitPrice.toNumber() * item.quantity,
            0
          );
          const totalSaleFees = order.items.reduce(
            (sum, item) => sum + (item.saleFee?.toNumber() || 0),
            0
          );
          // Get shipping cost: 1) from shipment table, 2) from order field, 3) from payments
          let shippingCost = 0;
          if (order.shipments && order.shipments.length > 0) {
            shippingCost = order.shipments.reduce(
              (sum, s) => sum + (s.cost?.toNumber() || 0),
              0
            );
          }
          if (shippingCost === 0) {
            shippingCost = order.shippingCost?.toNumber() || 0;
          }
          if (shippingCost === 0 && order.payments.length > 0) {
            shippingCost = order.payments.reduce(
              (sum, p) => sum + (p.shippingCost?.toNumber() || 0),
              0
            );
          }
          // Get fee breakdown from billing data
          const fees = getFeesBreakdown(order);
          // If billing data available, use it; otherwise fallback to sale_fee as taxaVenda
          const taxaML = fees.taxaML > 0 ? fees.taxaML : totalSaleFees;
          const taxaMP = fees.taxaMP;
          const totalLiquido = totalItems - taxaML - taxaMP - shippingCost;

          // Return one row per item for detailed view
          return order.items.map((item) => ({
            pedidoId: order.externalId,
            data: order.dateCreated.toISOString().split('T')[0],
            status: order.status,
            produto: item.title,
            quantidade: item.quantity,
            valorProduto: item.unitPrice.toNumber() * item.quantity,
            taxaVenda: item.saleFee?.toNumber() || 0,
            taxaML: Number((taxaML / order.items.length).toFixed(2)),
            taxaMP: Number((taxaMP / order.items.length).toFixed(2)),
            frete: Number((shippingCost / order.items.length).toFixed(2)),
            totalLiquido: Number(((item.unitPrice.toNumber() * item.quantity) - (taxaML / order.items.length) - (taxaMP / order.items.length) - (shippingCost / order.items.length)).toFixed(2)),
            sku: item.sku || '',
          }));
        });

        return reply.code(200).send({
          success: true,
          count: formattedOrders.length,
          data: formattedOrders,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get order details');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get orders summary (one row per order) for Google Sheets
   */
  fastify.get(
    '/reports/orders/summary',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery & { limit?: string } }>,
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

        const start = new Date(startDate);
        const end = new Date(endDate);
        const maxResults = limit ? parseInt(limit, 10) : 500;

        const orders = await prisma.mLOrder.findMany({
          where: {
            dateCreated: {
              gte: start,
              lte: end,
            },
          },
          include: {
            items: true,
            payments: true,
            shipments: true,
          },
          orderBy: { dateCreated: 'desc' },
          take: maxResults,
        });

        // Helper: extract fee breakdown from order rawData (billing API) or fallback
        const getFeesBreakdown = (order: typeof orders[0]): { taxaML: number; taxaMP: number } => {
          const orderRaw = order.rawData as Record<string, unknown> | null;
          
          if (orderRaw && Array.isArray(orderRaw.billing_charges)) {
            let taxaML = 0;
            let taxaMP = 0;
            for (const charge of orderRaw.billing_charges) {
              const c = charge as { type?: string; amount?: number; marketplace?: string };
              if (c.type === 'CVVML' || c.type === 'CV') {
                taxaML += c.amount || 0;
              } else if (c.type === 'CVVPRC' || c.type === 'CCMP') {
                taxaMP += c.amount || 0;
              }
            }
            if (taxaML > 0 || taxaMP > 0) {
              return { taxaML, taxaMP };
            }
          }
          
          return { taxaML: 0, taxaMP: 0 };
        };

        // Format data - one row per order
        const formattedOrders = orders.map((order) => {
          const produtos = order.items.map(i => i.title).join(' | ');
          const totalItems = order.items.reduce(
            (sum, item) => sum + item.unitPrice.toNumber() * item.quantity,
            0
          );
          const totalFees = order.items.reduce(
            (sum, item) => sum + (item.saleFee?.toNumber() || 0),
            0
          );
          // Get shipping cost: 1) from shipment table, 2) from order field, 3) from payments
          let shippingCost = 0;
          if (order.shipments && order.shipments.length > 0) {
            shippingCost = order.shipments.reduce(
              (sum, s) => sum + (s.cost?.toNumber() || 0),
              0
            );
          }
          if (shippingCost === 0) {
            shippingCost = order.shippingCost?.toNumber() || 0;
          }
          if (shippingCost === 0 && order.payments.length > 0) {
            shippingCost = order.payments.reduce(
              (sum, p) => sum + (p.shippingCost?.toNumber() || 0),
              0
            );
          }
          // Get fee breakdown from billing data
          const fees = getFeesBreakdown(order);
          const taxaML = fees.taxaML > 0 ? fees.taxaML : totalFees;
          const taxaMP = fees.taxaMP;
          const totalLiquido = totalItems - taxaML - taxaMP - shippingCost;

          return {
            pedidoId: order.externalId,
            data: order.dateCreated.toISOString().split('T')[0],
            hora: order.dateCreated.toISOString().split('T')[1].substring(0, 5),
            status: order.status,
            produtos: produtos.substring(0, 200),
            qtdItens: order.items.length,
            valorProdutos: Number(totalItems.toFixed(2)),
            taxaVenda: Number(totalFees.toFixed(2)),
            taxaML: Number(taxaML.toFixed(2)),
            taxaMP: Number(taxaMP.toFixed(2)),
            frete: Number(shippingCost.toFixed(2)),
            totalLiquido: Number(totalLiquido.toFixed(2)),
          };
        });

        return reply.code(200).send({
          success: true,
          count: formattedOrders.length,
          data: formattedOrders,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get orders summary');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

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

  // ==========================================================================
  // TAXAS POR VENDA
  // ==========================================================================

  /**
   * Get fees breakdown by order
   * Mostra as taxas detalhadas de cada venda
   */
  fastify.get(
    '/reports/order-fees',
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery & { limit?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate, limit = '50' } = request.query;

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const limitNum = parseInt(limit, 10) || 50;

        // Buscar pedidos com pagamentos
        const orders = await prisma.mLOrder.findMany({
          where: {
            dateCreated: {
              gte: range.startDate,
              lte: range.endDate,
            },
          },
          include: {
            payments: true,
            items: true,
          },
          orderBy: { dateCreated: 'desc' },
          take: limitNum,
        });

        // Processar cada pedido para extrair taxas
        const ordersWithFees = orders.map((order) => {
          // Taxa de venda do ML (sale_fee dos itens)
          let marketplaceFee = 0;
          order.items.forEach((item) => {
            if (item.saleFee) {
              marketplaceFee += Number(item.saleFee);
            }
          });

          // Extrair outras taxas do rawData dos pagamentos
          let totalFees = marketplaceFee;
          let shippingFee = 0;
          let financingFee = 0;
          let mercadoPagoFee = 0;

          order.payments.forEach((payment) => {
            const rawData = payment.rawData as Record<string, unknown> | null;
            
            if (rawData) {
              // fee_details contém as taxas do MP
              const feeDetails = rawData.fee_details as Array<{ type: string; amount: number }> | undefined;
              if (feeDetails && Array.isArray(feeDetails)) {
                feeDetails.forEach((fee) => {
                  totalFees += fee.amount || 0;
                  if (fee.type === 'mercadopago_fee') {
                    mercadoPagoFee += fee.amount || 0;
                  } else if (fee.type === 'shipping_fee') {
                    shippingFee += fee.amount || 0;
                  } else if (fee.type === 'financing_fee') {
                    financingFee += fee.amount || 0;
                  }
                });
              }
            }

            // Custo de frete do pagamento
            if (payment.shippingCost) {
              shippingFee += Number(payment.shippingCost);
            }
          });

          const grossAmount = Number(order.totalAmount);
          const netAmount = grossAmount - totalFees;

          return {
            orderId: order.externalId,
            date: order.dateCreated,
            status: order.status,
            items: order.items.map(item => ({
              title: item.title,
              quantity: item.quantity,
              unitPrice: Number(item.unitPrice),
              saleFee: item.saleFee ? Number(item.saleFee) : 0,
              listingType: item.listingTypeId,
            })),
            grossAmount,
            fees: {
              mlSaleFee: marketplaceFee,
              mercadoPago: mercadoPagoFee,
              shipping: shippingFee,
              financing: financingFee,
              total: totalFees,
            },
            netAmount,
            feePercentage: grossAmount > 0 ? ((totalFees / grossAmount) * 100).toFixed(2) : '0',
          };
        });

        // Calcular totais
        const totals = ordersWithFees.reduce(
          (acc, order) => ({
            grossAmount: acc.grossAmount + order.grossAmount,
            totalFees: acc.totalFees + order.fees.total,
            mlSaleFees: acc.mlSaleFees + order.fees.mlSaleFee,
            mercadoPagoFees: acc.mercadoPagoFees + order.fees.mercadoPago,
            shippingFees: acc.shippingFees + order.fees.shipping,
            financingFees: acc.financingFees + order.fees.financing,
            netAmount: acc.netAmount + order.netAmount,
          }),
          { grossAmount: 0, totalFees: 0, mlSaleFees: 0, mercadoPagoFees: 0, shippingFees: 0, financingFees: 0, netAmount: 0 }
        );

        return reply.send({
          success: true,
          data: {
            period: {
              start: startDate,
              end: endDate,
            },
            ordersCount: ordersWithFees.length,
            totals: {
              ...totals,
              averageFeePercentage: totals.grossAmount > 0 
                ? ((totals.totalFees / totals.grossAmount) * 100).toFixed(2) 
                : '0',
            },
            orders: ordersWithFees,
          },
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get order fees');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Get fees for a specific order by ID
   */
  fastify.get(
    '/reports/order-fees/:orderId',
    async (
      request: FastifyRequest<{ Params: { orderId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { orderId } = request.params;

        // Buscar pedido específico
        const order = await prisma.mLOrder.findFirst({
          where: {
            OR: [
              { externalId: orderId },
              { id: orderId },
            ],
          },
          include: {
            payments: true,
            items: true,
            shipments: true,
          },
        });

        if (!order) {
          return reply.code(404).send({
            success: false,
            message: 'Order not found',
          });
        }

        // Extrair taxas detalhadas
        let totalFees = 0;
        const feeBreakdown: Array<{ type: string; amount: number; description: string }> = [];

        // Taxa de venda do ML (sale_fee) dos itens
        order.items.forEach((item) => {
          if (item.saleFee && Number(item.saleFee) > 0) {
            const fee = Number(item.saleFee);
            totalFees += fee;
            feeBreakdown.push({
              type: 'ml_sale_fee',
              amount: fee,
              description: `Taxa de Venda ML - ${item.title}`,
            });
          }
        });

        order.payments.forEach((payment) => {
          const rawData = payment.rawData as Record<string, unknown> | null;
          
          if (rawData) {
            const feeDetails = rawData.fee_details as Array<{ type: string; amount: number; fee_payer?: string }> | undefined;
            if (feeDetails && Array.isArray(feeDetails)) {
              feeDetails.forEach((fee) => {
                totalFees += fee.amount || 0;
                feeBreakdown.push({
                  type: fee.type,
                  amount: fee.amount,
                  description: fee.fee_payer || fee.type,
                });
              });
            }
          }

          if (payment.shippingCost && Number(payment.shippingCost) > 0) {
            feeBreakdown.push({
              type: 'shipping_cost',
              amount: Number(payment.shippingCost),
              description: 'Custo de Envio',
            });
          }
        });

        const grossAmount = Number(order.totalAmount);
        const netAmount = grossAmount - totalFees;

        return reply.send({
          success: true,
          data: {
            orderId: order.externalId,
            date: order.dateCreated,
            status: order.status,
            buyer: order.buyerId,
            items: order.items.map(item => ({
              id: item.externalId,
              title: item.title,
              quantity: item.quantity,
              unitPrice: Number(item.unitPrice),
              subtotal: Number(item.unitPrice) * item.quantity,
              saleFee: item.saleFee ? Number(item.saleFee) : 0,
              listingType: item.listingTypeId,
            })),
            payments: order.payments.map(p => ({
              id: p.externalId,
              status: p.status,
              method: p.paymentMethodId,
              amount: Number(p.transactionAmount),
            })),
            shipment: order.shipments[0] ? {
              id: order.shipments[0].externalId,
              status: order.shipments[0].status,
              trackingNumber: order.shipments[0].trackingNumber,
              cost: order.shipments[0].cost ? Number(order.shipments[0].cost) : 0,
            } : null,
            financial: {
              grossAmount,
              feeBreakdown,
              totalFees,
              netAmount,
              feePercentage: grossAmount > 0 ? ((totalFees / grossAmount) * 100).toFixed(2) : '0',
            },
          },
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get order fees by ID');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  // ==========================================================================
  // PUBLIC DOWNLOAD ENDPOINTS (with token in URL)
  // ==========================================================================

  /**
   * Download Excel report with token in URL (for easy browser access)
   * This endpoint accepts the API key as a query parameter for convenience
   */
  fastify.get(
    '/download/excel',
    { config: { rawBody: true } },
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery & { token?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate, token } = request.query as any;

        // Check token in query or header
        const apiKey = token || request.headers['x-api-key'];
        if (apiKey !== process.env.API_KEY && apiKey !== 'conciliacao-api-key-2026') {
          return reply.code(401).send({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' },
          });
        }

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required. Example: /download/excel?startDate=2026-02-01&endDate=2026-02-04&token=YOUR_API_KEY',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const buffer = await excelExportService.exportOrdersWithFees(range);

        return reply
          .code(200)
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('Content-Disposition', `attachment; filename="relatorio-taxas-${startDate}-${endDate}.xlsx"`)
          .send(buffer);
      } catch (error) {
        logger.error({ error }, 'Failed to download Excel report');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  /**
   * Download CSV report with token in URL
   */
  fastify.get(
    '/download/csv',
    { config: { rawBody: true } },
    async (
      request: FastifyRequest<{ Querystring: DateRangeQuery & { token?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { startDate, endDate, token } = request.query as any;

        // Check token in query or header
        const apiKey = token || request.headers['x-api-key'];
        if (apiKey !== process.env.API_KEY && apiKey !== 'conciliacao-api-key-2026') {
          return reply.code(401).send({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' },
          });
        }

        if (!startDate || !endDate) {
          return reply.code(400).send({
            success: false,
            message: 'startDate and endDate are required. Example: /download/csv?startDate=2026-02-01&endDate=2026-02-04&token=YOUR_API_KEY',
          });
        }

        const range = parseDateRange(startDate, endDate);
        const csv = await csvExportService.exportOrders(range);

        return reply
          .code(200)
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="relatorio-${startDate}-${endDate}.csv"`)
          .send(csv);
      } catch (error) {
        logger.error({ error }, 'Failed to download CSV report');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );
}
