import { Prisma, ReconciliationStatus } from '@prisma/client';
import { prisma } from '../../../shared/database/client.js';

export type ReconciliationCreateInput = Prisma.ReconciliationCreateInput;
export type ReconciliationUpdateInput = Prisma.ReconciliationUpdateInput;
export type ReconciliationWithItems = Prisma.ReconciliationGetPayload<{
  include: { items: { include: { order: true; movement: true } } };
}>;

export interface ReconciliationFilters {
  status?: ReconciliationStatus;
  periodFrom?: Date;
  periodTo?: Date;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class ReconciliationRepository {
  async create(data: ReconciliationCreateInput) {
    return prisma.reconciliation.create({
      data,
      include: { items: true },
    });
  }

  async update(id: string, data: ReconciliationUpdateInput) {
    return prisma.reconciliation.update({
      where: { id },
      data,
      include: { items: true },
    });
  }

  async findById(id: string) {
    return prisma.reconciliation.findUnique({
      where: { id },
      include: {
        items: {
          include: { order: true, movement: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  async findMany(
    filters: ReconciliationFilters = {},
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<ReconciliationWithItems>> {
    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    const where: Prisma.ReconciliationWhereInput = {};

    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.periodFrom || filters.periodTo) {
      where.periodStart = {};
      if (filters.periodFrom) {
        where.periodStart.gte = filters.periodFrom;
      }
      if (filters.periodTo) {
        where.periodEnd = { lte: filters.periodTo };
      }
    }

    const [data, total] = await Promise.all([
      prisma.reconciliation.findMany({
        where,
        include: {
          items: {
            include: { order: true, movement: true },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.reconciliation.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getLatest() {
    return prisma.reconciliation.findFirst({
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: { order: true, movement: true },
        },
      },
    });
  }

  async findByPeriod(periodStart: Date, periodEnd: Date) {
    return prisma.reconciliation.findFirst({
      where: {
        periodStart: { equals: periodStart },
        periodEnd: { equals: periodEnd },
      },
      include: {
        items: {
          include: { order: true, movement: true },
        },
      },
    });
  }

  async updateItemStatus(
    itemId: string,
    status: ReconciliationStatus,
    notes?: string,
    resolvedBy?: string
  ) {
    return prisma.reconciliationItem.update({
      where: { id: itemId },
      data: {
        status,
        notes,
        resolvedBy,
        resolvedAt: status === 'RESOLVED' ? new Date() : undefined,
      },
    });
  }

  async getReconciliationSummary(id: string) {
    const items = await prisma.reconciliationItem.groupBy({
      by: ['status'],
      where: { reconciliationId: id },
      _count: { id: true },
      _sum: { difference: true },
    });

    return items.map((item: (typeof items)[number]) => ({
      status: item.status,
      count: item._count.id,
      totalDifference: item._sum.difference,
    }));
  }

  async delete(id: string) {
    return prisma.reconciliation.delete({ where: { id } });
  }
}

export const reconciliationRepository = new ReconciliationRepository();
