/**
 * Report Service
 * Generates financial reports and analytics
 */

import { Decimal } from '@prisma/client/runtime/library';
import { createLogger } from '../../../config/logger.js';
import { prisma } from '../../../shared/database/client.js';

const logger = createLogger('report-service');

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

export interface FinancialSummary {
  period: DateRange;
  orders: {
    total: number;
    totalAmount: Decimal;
    byStatus: Record<string, { count: number; amount: Decimal }>;
  };
  movements: {
    total: number;
    totalAmount: Decimal;
    totalFees: Decimal;
    netAmount: Decimal;
    byType: Record<string, { count: number; amount: Decimal }>;
  };
  reconciliation: {
    matched: number;
    unmatched: number;
    divergent: number;
    discrepancy: Decimal;
  };
}

export interface DailyReport {
  date: string;
  ordersCount: number;
  ordersAmount: Decimal;
  movementsCount: number;
  movementsAmount: Decimal;
  feesAmount: Decimal;
  netAmount: Decimal;
}

export interface TopProduct {
  itemId: string;
  title: string;
  quantity: number;
  revenue: Decimal;
}

export class ReportService {
  /**
   * Generate financial summary for a period
   */
  async getFinancialSummary(range: DateRange): Promise<FinancialSummary> {
    logger.info({ range }, 'Generating financial summary');

    const [orders, movements, reconciliations] = await Promise.all([
      this.getOrdersSummary(range),
      this.getMovementsSummary(range),
      this.getReconciliationSummary(range),
    ]);

    return {
      period: range,
      orders,
      movements,
      reconciliation: reconciliations,
    };
  }

  /**
   * Get orders summary for period
   */
  private async getOrdersSummary(range: DateRange) {
    const orders = await prisma.mLOrder.findMany({
      where: {
        dateCreated: {
          gte: range.startDate,
          lte: range.endDate,
        },
      },
      select: {
        status: true,
        totalAmount: true,
      },
    });

    const byStatus: Record<string, { count: number; amount: Decimal }> = {};
    let totalAmount = new Decimal(0);

    for (const order of orders) {
      totalAmount = totalAmount.plus(order.totalAmount);

      if (!byStatus[order.status]) {
        byStatus[order.status] = { count: 0, amount: new Decimal(0) };
      }
      byStatus[order.status].count++;
      byStatus[order.status].amount = byStatus[order.status].amount.plus(order.totalAmount);
    }

    return {
      total: orders.length,
      totalAmount,
      byStatus,
    };
  }

  /**
   * Get movements summary for period
   */
  private async getMovementsSummary(range: DateRange) {
    const movements = await prisma.mPMovement.findMany({
      where: {
        dateCreated: {
          gte: range.startDate,
          lte: range.endDate,
        },
      },
      select: {
        type: true,
        amount: true,
        fee: true,
        netAmount: true,
      },
    });

    const byType: Record<string, { count: number; amount: Decimal }> = {};
    let totalAmount = new Decimal(0);
    let totalFees = new Decimal(0);
    let netAmount = new Decimal(0);

    for (const movement of movements) {
      totalAmount = totalAmount.plus(movement.amount);
      if (movement.fee) {
        totalFees = totalFees.plus(movement.fee);
      }
      if (movement.netAmount) {
        netAmount = netAmount.plus(movement.netAmount);
      }

      if (!byType[movement.type]) {
        byType[movement.type] = { count: 0, amount: new Decimal(0) };
      }
      byType[movement.type].count++;
      byType[movement.type].amount = byType[movement.type].amount.plus(movement.amount);
    }

    return {
      total: movements.length,
      totalAmount,
      totalFees,
      netAmount,
      byType,
    };
  }

  /**
   * Get reconciliation summary for period
   */
  private async getReconciliationSummary(range: DateRange) {
    const reconciliations = await prisma.reconciliation.findMany({
      where: {
        periodStart: { gte: range.startDate },
        periodEnd: { lte: range.endDate },
      },
      select: {
        matchedCount: true,
        unmatchedCount: true,
        divergentCount: true,
        discrepancy: true,
      },
    });

    let matched = 0;
    let unmatched = 0;
    let divergent = 0;
    let discrepancy = new Decimal(0);

    for (const recon of reconciliations) {
      matched += recon.matchedCount;
      unmatched += recon.unmatchedCount;
      divergent += recon.divergentCount;
      discrepancy = discrepancy.plus(recon.discrepancy);
    }

    return {
      matched,
      unmatched,
      divergent,
      discrepancy,
    };
  }

  /**
   * Generate daily report
   */
  async getDailyReport(range: DateRange): Promise<DailyReport[]> {
    logger.info({ range }, 'Generating daily report');

    const days: DailyReport[] = [];
    const currentDate = new Date(range.startDate);

    while (currentDate <= range.endDate) {
      const dayStart = new Date(currentDate);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(currentDate);
      dayEnd.setHours(23, 59, 59, 999);

      const [orders, movements] = await Promise.all([
        prisma.mLOrder.aggregate({
          where: {
            dateCreated: { gte: dayStart, lte: dayEnd },
          },
          _count: true,
          _sum: { totalAmount: true },
        }),
        prisma.mPMovement.aggregate({
          where: {
            dateCreated: { gte: dayStart, lte: dayEnd },
          },
          _count: true,
          _sum: {
            amount: true,
            fee: true,
            netAmount: true,
          },
        }),
      ]);

      days.push({
        date: currentDate.toISOString().split('T')[0],
        ordersCount: orders._count,
        ordersAmount: orders._sum.totalAmount || new Decimal(0),
        movementsCount: movements._count,
        movementsAmount: movements._sum.amount || new Decimal(0),
        feesAmount: movements._sum.fee || new Decimal(0),
        netAmount: movements._sum.netAmount || new Decimal(0),
      });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    return days;
  }

  /**
   * Get top selling products
   */
  async getTopProducts(range: DateRange, limit = 10): Promise<TopProduct[]> {
    logger.info({ range, limit }, 'Getting top products');

    const items = await prisma.mLOrderItem.groupBy({
      by: ['externalId', 'title'],
      where: {
        order: {
          dateCreated: {
            gte: range.startDate,
            lte: range.endDate,
          },
        },
      },
      _sum: {
        quantity: true,
        unitPrice: true,
      },
      orderBy: {
        _sum: {
          quantity: 'desc',
        },
      },
      take: limit,
    });

    return items.map((item) => ({
      itemId: item.externalId,
      title: item.title,
      quantity: item._sum.quantity || 0,
      revenue: item._sum.unitPrice || new Decimal(0),
    }));
  }

  /**
   * Get fee breakdown
   */
  async getFeeBreakdown(range: DateRange) {
    logger.info({ range }, 'Getting fee breakdown');

    const movements = await prisma.mPMovement.findMany({
      where: {
        dateCreated: {
          gte: range.startDate,
          lte: range.endDate,
        },
        fee: { not: null },
      },
      select: {
        type: true,
        fee: true,
        amount: true,
      },
    });

    const byType: Record<string, { totalFees: Decimal; totalAmount: Decimal; percentage: number }> = {};
    let grandTotalFees = new Decimal(0);
    let grandTotalAmount = new Decimal(0);

    for (const movement of movements) {
      if (!movement.fee) continue;

      grandTotalFees = grandTotalFees.plus(movement.fee);
      grandTotalAmount = grandTotalAmount.plus(movement.amount);

      if (!byType[movement.type]) {
        byType[movement.type] = {
          totalFees: new Decimal(0),
          totalAmount: new Decimal(0),
          percentage: 0,
        };
      }
      byType[movement.type].totalFees = byType[movement.type].totalFees.plus(movement.fee);
      byType[movement.type].totalAmount = byType[movement.type].totalAmount.plus(movement.amount);
    }

    // Calculate percentages
    for (const type of Object.keys(byType)) {
      if (!byType[type].totalAmount.isZero()) {
        byType[type].percentage = byType[type].totalFees
          .dividedBy(byType[type].totalAmount)
          .times(100)
          .toNumber();
      }
    }

    return {
      byType,
      totals: {
        totalFees: grandTotalFees,
        totalAmount: grandTotalAmount,
        averagePercentage: grandTotalAmount.isZero()
          ? 0
          : grandTotalFees.dividedBy(grandTotalAmount).times(100).toNumber(),
      },
    };
  }

  /**
   * Get comparison between two periods
   */
  async getPeriodComparison(
    currentPeriod: DateRange,
    previousPeriod: DateRange
  ) {
    logger.info({ currentPeriod, previousPeriod }, 'Generating period comparison');

    const [current, previous] = await Promise.all([
      this.getFinancialSummary(currentPeriod),
      this.getFinancialSummary(previousPeriod),
    ]);

    const calculateChange = (curr: Decimal, prev: Decimal) => {
      if (prev.isZero()) return curr.isZero() ? 0 : 100;
      return curr.minus(prev).dividedBy(prev).times(100).toNumber();
    };

    return {
      current,
      previous,
      changes: {
        orders: {
          countChange: previous.orders.total === 0
            ? (current.orders.total === 0 ? 0 : 100)
            : ((current.orders.total - previous.orders.total) / previous.orders.total) * 100,
          amountChange: calculateChange(current.orders.totalAmount, previous.orders.totalAmount),
        },
        movements: {
          countChange: previous.movements.total === 0
            ? (current.movements.total === 0 ? 0 : 100)
            : ((current.movements.total - previous.movements.total) / previous.movements.total) * 100,
          amountChange: calculateChange(current.movements.totalAmount, previous.movements.totalAmount),
          feesChange: calculateChange(current.movements.totalFees, previous.movements.totalFees),
        },
        reconciliation: {
          matchedChange: previous.reconciliation.matched === 0
            ? (current.reconciliation.matched === 0 ? 0 : 100)
            : ((current.reconciliation.matched - previous.reconciliation.matched) / previous.reconciliation.matched) * 100,
        },
      },
    };
  }
}

export const reportService = new ReportService();
