import { Prisma } from '@prisma/client';
import { prisma } from '../../../shared/database/client.js';

export type MLOrderCreateInput = Prisma.MLOrderCreateInput;
export type MLOrderUpdateInput = Prisma.MLOrderUpdateInput;
export type MLOrderWithRelations = Prisma.MLOrderGetPayload<{
  include: { items: true; payments: true; shipments: true };
}>;

export interface MLOrderFilters {
  sellerId?: string;
  status?: Prisma.EnumOrderStatusFilter;
  dateFrom?: Date;
  dateTo?: Date;
  externalId?: string;
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

export class MLOrderRepository {
  async create(data: MLOrderCreateInput) {
    return prisma.mLOrder.create({ data });
  }

  async createMany(data: Prisma.MLOrderCreateManyInput[]) {
    return prisma.mLOrder.createMany({
      data,
      skipDuplicates: true,
    });
  }

  async update(id: string, data: MLOrderUpdateInput) {
    return prisma.mLOrder.update({
      where: { id },
      data,
    });
  }

  async upsertByExternalId(
    externalId: string,
    create: MLOrderCreateInput,
    update: MLOrderUpdateInput
  ) {
    return prisma.mLOrder.upsert({
      where: { externalId },
      create,
      update,
    });
  }

  async findById(id: string) {
    return prisma.mLOrder.findUnique({
      where: { id },
      include: { items: true, payments: true, shipments: true },
    });
  }

  async findByExternalId(externalId: string) {
    return prisma.mLOrder.findUnique({
      where: { externalId },
      include: { items: true, payments: true, shipments: true },
    });
  }

  async findMany(
    filters: MLOrderFilters = {},
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<MLOrderWithRelations>> {
    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const where: Prisma.MLOrderWhereInput = {};

    if (filters.sellerId) {
      where.sellerId = filters.sellerId;
    }
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.externalId) {
      where.externalId = filters.externalId;
    }
    if (filters.dateFrom || filters.dateTo) {
      where.dateCreated = {};
      if (filters.dateFrom) {
        where.dateCreated.gte = filters.dateFrom;
      }
      if (filters.dateTo) {
        where.dateCreated.lte = filters.dateTo;
      }
    }

    const [data, total] = await Promise.all([
      prisma.mLOrder.findMany({
        where,
        include: { items: true, payments: true, shipments: true },
        skip,
        take: limit,
        orderBy: { dateCreated: 'desc' },
      }),
      prisma.mLOrder.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findByDateRange(dateFrom: Date, dateTo: Date, sellerId?: string) {
    const where: Prisma.MLOrderWhereInput = {
      dateCreated: { gte: dateFrom, lte: dateTo },
    };
    if (sellerId) {
      where.sellerId = sellerId;
    }

    return prisma.mLOrder.findMany({
      where,
      include: { items: true, payments: true, shipments: true },
      orderBy: { dateCreated: 'desc' },
    });
  }

  async getOrderStats(dateFrom: Date, dateTo: Date, sellerId?: string) {
    const where: Prisma.MLOrderWhereInput = {
      dateCreated: { gte: dateFrom, lte: dateTo },
    };
    if (sellerId) {
      where.sellerId = sellerId;
    }

    const stats = await prisma.mLOrder.groupBy({
      by: ['status'],
      where,
      _count: { id: true },
      _sum: { totalAmount: true },
    });

    return stats.map((s) => ({
      status: s.status,
      count: s._count.id,
      totalAmount: s._sum.totalAmount,
    }));
  }

  async delete(id: string) {
    return prisma.mLOrder.delete({ where: { id } });
  }
}

export const mlOrderRepository = new MLOrderRepository();
