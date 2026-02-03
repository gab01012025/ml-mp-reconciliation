import { Prisma } from '@prisma/client';
import { prisma } from '../../../shared/database/client.js';

export type MPMovementCreateInput = Prisma.MPMovementCreateInput;
export type MPMovementUpdateInput = Prisma.MPMovementUpdateInput;

export interface MPMovementFilters {
  userId?: string;
  type?: Prisma.EnumMovementTypeFilter;
  dateFrom?: Date;
  dateTo?: Date;
  referenceId?: string;
  externalReference?: string;
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

export class MPMovementRepository {
  async create(data: MPMovementCreateInput) {
    return prisma.mPMovement.create({ data });
  }

  async createMany(data: Prisma.MPMovementCreateManyInput[]) {
    return prisma.mPMovement.createMany({
      data,
      skipDuplicates: true,
    });
  }

  async update(id: string, data: MPMovementUpdateInput) {
    return prisma.mPMovement.update({
      where: { id },
      data,
    });
  }

  async upsertByExternalId(
    externalId: string,
    create: MPMovementCreateInput,
    update: MPMovementUpdateInput
  ) {
    return prisma.mPMovement.upsert({
      where: { externalId },
      create,
      update,
    });
  }

  async findById(id: string) {
    return prisma.mPMovement.findUnique({ where: { id } });
  }

  async findByExternalId(externalId: string) {
    return prisma.mPMovement.findUnique({ where: { externalId } });
  }

  async findByReferenceId(referenceId: string) {
    return prisma.mPMovement.findMany({
      where: { referenceId },
      orderBy: { dateCreated: 'desc' },
    });
  }

  async findMany(
    filters: MPMovementFilters = {},
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<Prisma.MPMovementGetPayload<object>>> {
    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const where: Prisma.MPMovementWhereInput = {};

    if (filters.userId) {
      where.userId = filters.userId;
    }
    if (filters.type) {
      where.type = filters.type;
    }
    if (filters.referenceId) {
      where.referenceId = filters.referenceId;
    }
    if (filters.externalReference) {
      where.externalReference = filters.externalReference;
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
      prisma.mPMovement.findMany({
        where,
        skip,
        take: limit,
        orderBy: { dateCreated: 'desc' },
      }),
      prisma.mPMovement.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findByDateRange(dateFrom: Date, dateTo: Date, userId?: string) {
    const where: Prisma.MPMovementWhereInput = {
      dateCreated: { gte: dateFrom, lte: dateTo },
    };
    if (userId) {
      where.userId = userId;
    }

    return prisma.mPMovement.findMany({
      where,
      orderBy: { dateCreated: 'desc' },
    });
  }

  async getMovementStats(dateFrom: Date, dateTo: Date, userId?: string) {
    const where: Prisma.MPMovementWhereInput = {
      dateCreated: { gte: dateFrom, lte: dateTo },
    };
    if (userId) {
      where.userId = userId;
    }

    const stats = await prisma.mPMovement.groupBy({
      by: ['type'],
      where,
      _count: { id: true },
      _sum: { amount: true, fee: true, netAmount: true },
    });

    return stats.map((s: (typeof stats)[number]) => ({
      type: s.type,
      count: s._count.id,
      totalAmount: s._sum.amount,
      totalFee: s._sum.fee,
      totalNetAmount: s._sum.netAmount,
    }));
  }

  async getSaleMovementsByOrderIds(orderExternalIds: string[]) {
    return prisma.mPMovement.findMany({
      where: {
        type: 'SALE',
        referenceId: { in: orderExternalIds },
      },
      orderBy: { dateCreated: 'desc' },
    });
  }

  async delete(id: string) {
    return prisma.mPMovement.delete({ where: { id } });
  }
}

export const mpMovementRepository = new MPMovementRepository();
