/**
 * CSV Export Service
 * Generates CSV files for reports and data exports
 */

import { createLogger } from '../../../config/logger.js';
import { prisma } from '../../../shared/database/client.js';
import { DateRange, reportService } from './report.service.js';

const logger = createLogger('csv-export-service');

type CsvRow = Record<string, string | number | boolean | null | undefined>;

export class CsvExportService {
  /**
   * Convert array of objects to CSV string
   */
  private toCsv(data: CsvRow[], columns?: string[]): string {
    if (data.length === 0) {
      return '';
    }

    const headers = columns || Object.keys(data[0]);
    const rows = data.map((row) =>
      headers.map((header) => this.escapeValue(row[header])).join(',')
    );

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Escape CSV value
   */
  private escapeValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    const str = String(value);

    // Escape if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }

  /**
   * Export orders to CSV
   */
  async exportOrders(range: DateRange): Promise<string> {
    logger.info({ range }, 'Exporting orders to CSV');

    const orders = await prisma.mLOrder.findMany({
      where: {
        dateCreated: {
          gte: range.startDate,
          lte: range.endDate,
        },
      },
      include: {
        items: true,
        payments: true,
        shipments: true,
      },
      orderBy: { dateCreated: 'desc' },
    });

    const rows: CsvRow[] = orders.map((order) => {
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

      return {
        id: order.id,
        externalId: order.externalId,
        sellerId: order.sellerId,
        buyerId: order.buyerId,
        status: order.status,
        totalAmount: order.totalAmount.toNumber(),
        currency: order.currency,
        shippingCost,
        dateCreated: order.dateCreated.toISOString(),
        dateClosed: order.dateClosed?.toISOString() || '',
        itemsCount: order.items.length,
        paymentsCount: order.payments.length,
      };
    });

    return this.toCsv(rows, [
      'id',
      'externalId',
      'sellerId',
      'buyerId',
      'status',
      'totalAmount',
      'currency',
      'shippingCost',
      'dateCreated',
      'dateClosed',
      'itemsCount',
      'paymentsCount',
    ]);
  }

  /**
   * Export order items to CSV
   */
  async exportOrderItems(range: DateRange): Promise<string> {
    logger.info({ range }, 'Exporting order items to CSV');

    const items = await prisma.mLOrderItem.findMany({
      where: {
        order: {
          dateCreated: {
            gte: range.startDate,
            lte: range.endDate,
          },
        },
      },
      include: {
        order: {
          select: {
            externalId: true,
            dateCreated: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows: CsvRow[] = items.map((item) => ({
      orderId: item.orderId,
      orderExternalId: item.order.externalId,
      orderDate: item.order.dateCreated.toISOString(),
      itemId: item.externalId,
      title: item.title,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toNumber(),
      totalPrice: item.unitPrice.times(item.quantity).toNumber(),
      sku: item.sku || '',
      categoryId: item.categoryId || '',
    }));

    return this.toCsv(rows, [
      'orderId',
      'orderExternalId',
      'orderDate',
      'itemId',
      'title',
      'quantity',
      'unitPrice',
      'totalPrice',
      'sku',
      'categoryId',
    ]);
  }

  /**
   * Export movements to CSV
   */
  async exportMovements(range: DateRange): Promise<string> {
    logger.info({ range }, 'Exporting movements to CSV');

    const movements = await prisma.mPMovement.findMany({
      where: {
        dateCreated: {
          gte: range.startDate,
          lte: range.endDate,
        },
      },
      orderBy: { dateCreated: 'desc' },
    });

    const rows: CsvRow[] = movements.map((movement) => ({
      id: movement.id,
      externalId: movement.externalId,
      userId: movement.userId,
      type: movement.type,
      action: movement.action || '',
      status: movement.status || '',
      amount: movement.amount.toNumber(),
      fee: movement.fee?.toNumber() || 0,
      netAmount: movement.netAmount?.toNumber() || 0,
      currency: movement.currency,
      referenceId: movement.referenceId || '',
      externalReference: movement.externalReference || '',
      description: movement.description || '',
      dateCreated: movement.dateCreated.toISOString(),
      releaseDate: movement.releaseDate?.toISOString() || '',
    }));

    return this.toCsv(rows, [
      'id',
      'externalId',
      'userId',
      'type',
      'action',
      'status',
      'amount',
      'fee',
      'netAmount',
      'currency',
      'referenceId',
      'externalReference',
      'description',
      'dateCreated',
      'releaseDate',
    ]);
  }

  /**
   * Export reconciliation items to CSV
   */
  async exportReconciliationItems(reconciliationId: string): Promise<string> {
    logger.info({ reconciliationId }, 'Exporting reconciliation items to CSV');

    const items = await prisma.reconciliationItem.findMany({
      where: { reconciliationId },
      include: {
        order: {
          select: {
            externalId: true,
            totalAmount: true,
            dateCreated: true,
          },
        },
        movement: {
          select: {
            externalId: true,
            amount: true,
            dateCreated: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows: CsvRow[] = items.map((item) => ({
      id: item.id,
      status: item.status,
      orderExternalId: item.order?.externalId || '',
      orderAmount: item.orderAmount?.toNumber() || 0,
      orderDate: item.order?.dateCreated.toISOString() || '',
      movementExternalId: item.movement?.externalId || '',
      movementAmount: item.movementAmount?.toNumber() || 0,
      movementDate: item.movement?.dateCreated.toISOString() || '',
      difference: item.difference?.toNumber() || 0,
      matchType: item.matchType || '',
      matchConfidence: item.matchConfidence || 0,
      matchedBy: item.matchedBy || '',
      notes: item.notes || '',
      resolvedBy: item.resolvedBy || '',
      resolvedAt: item.resolvedAt?.toISOString() || '',
    }));

    return this.toCsv(rows, [
      'id',
      'status',
      'orderExternalId',
      'orderAmount',
      'orderDate',
      'movementExternalId',
      'movementAmount',
      'movementDate',
      'difference',
      'matchType',
      'matchConfidence',
      'matchedBy',
      'notes',
      'resolvedBy',
      'resolvedAt',
    ]);
  }

  /**
   * Export daily report to CSV
   */
  async exportDailyReport(range: DateRange): Promise<string> {
    logger.info({ range }, 'Exporting daily report to CSV');

    const report = await reportService.getDailyReport(range);

    const rows: CsvRow[] = report.map((day) => ({
      date: day.date,
      ordersCount: day.ordersCount,
      ordersAmount: day.ordersAmount.toNumber(),
      movementsCount: day.movementsCount,
      movementsAmount: day.movementsAmount.toNumber(),
      feesAmount: day.feesAmount.toNumber(),
      netAmount: day.netAmount.toNumber(),
    }));

    return this.toCsv(rows, [
      'date',
      'ordersCount',
      'ordersAmount',
      'movementsCount',
      'movementsAmount',
      'feesAmount',
      'netAmount',
    ]);
  }

  /**
   * Export financial summary to CSV
   */
  async exportFinancialSummary(range: DateRange): Promise<string> {
    logger.info({ range }, 'Exporting financial summary to CSV');

    const summary = await reportService.getFinancialSummary(range);

    const rows: CsvRow[] = [
      {
        category: 'Orders',
        metric: 'Total Count',
        value: summary.orders.total,
      },
      {
        category: 'Orders',
        metric: 'Total Amount',
        value: summary.orders.totalAmount.toNumber(),
      },
      {
        category: 'Movements',
        metric: 'Total Count',
        value: summary.movements.total,
      },
      {
        category: 'Movements',
        metric: 'Total Amount',
        value: summary.movements.totalAmount.toNumber(),
      },
      {
        category: 'Movements',
        metric: 'Total Fees',
        value: summary.movements.totalFees.toNumber(),
      },
      {
        category: 'Movements',
        metric: 'Net Amount',
        value: summary.movements.netAmount.toNumber(),
      },
      {
        category: 'Reconciliation',
        metric: 'Matched',
        value: summary.reconciliation.matched,
      },
      {
        category: 'Reconciliation',
        metric: 'Unmatched',
        value: summary.reconciliation.unmatched,
      },
      {
        category: 'Reconciliation',
        metric: 'Divergent',
        value: summary.reconciliation.divergent,
      },
      {
        category: 'Reconciliation',
        metric: 'Discrepancy',
        value: summary.reconciliation.discrepancy.toNumber(),
      },
    ];

    // Add order status breakdown
    for (const [status, data] of Object.entries(summary.orders.byStatus)) {
      rows.push({
        category: 'Orders by Status',
        metric: status,
        value: `${data.count} orders, R$ ${data.amount.toNumber()}`,
      });
    }

    // Add movement type breakdown
    for (const [type, data] of Object.entries(summary.movements.byType)) {
      rows.push({
        category: 'Movements by Type',
        metric: type,
        value: `${data.count} movements, R$ ${data.amount.toNumber()}`,
      });
    }

    return this.toCsv(rows, ['category', 'metric', 'value']);
  }

  /**
   * Export top products to CSV
   */
  async exportTopProducts(range: DateRange, limit = 50): Promise<string> {
    logger.info({ range, limit }, 'Exporting top products to CSV');

    const products = await reportService.getTopProducts(range, limit);

    const rows: CsvRow[] = products.map((product, index) => ({
      rank: index + 1,
      itemId: product.itemId,
      title: product.title,
      quantity: product.quantity,
      revenue: product.revenue.toNumber(),
    }));

    return this.toCsv(rows, ['rank', 'itemId', 'title', 'quantity', 'revenue']);
  }
}

export const csvExportService = new CsvExportService();
