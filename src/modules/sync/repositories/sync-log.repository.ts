import { Prisma, SyncStatus } from '@prisma/client';
import { prisma } from '../../../shared/database/client.js';

export type SyncLogCreateInput = Prisma.SyncLogCreateInput;
export type SyncLogUpdateInput = Prisma.SyncLogUpdateInput;

export interface SyncLogFilters {
  entityType?: string;
  source?: string;
  status?: SyncStatus;
  dateFrom?: Date;
  dateTo?: Date;
}

export class SyncLogRepository {
  async create(data: SyncLogCreateInput) {
    return prisma.syncLog.create({ data });
  }

  async update(id: string, data: SyncLogUpdateInput) {
    return prisma.syncLog.update({
      where: { id },
      data,
    });
  }

  async complete(
    id: string,
    stats: {
      totalRecords: number;
      createdRecords: number;
      updatedRecords: number;
      failedRecords?: number;
    }
  ) {
    return prisma.syncLog.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        ...stats,
      },
    });
  }

  async fail(id: string, error: Error) {
    return prisma.syncLog.update({
      where: { id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: error.message,
        errorStack: error.stack,
      },
    });
  }

  async findById(id: string) {
    return prisma.syncLog.findUnique({ where: { id } });
  }

  async findLatestByType(entityType: string, source: string) {
    return prisma.syncLog.findFirst({
      where: { entityType, source },
      orderBy: { startedAt: 'desc' },
    });
  }

  async findLatestSuccessful(entityType: string, source: string) {
    return prisma.syncLog.findFirst({
      where: { entityType, source, status: 'COMPLETED' },
      orderBy: { startedAt: 'desc' },
    });
  }

  async findMany(filters: SyncLogFilters = {}, limit = 50) {
    const where: Prisma.SyncLogWhereInput = {};

    if (filters.entityType) {
      where.entityType = filters.entityType;
    }
    if (filters.source) {
      where.source = filters.source;
    }
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.dateFrom || filters.dateTo) {
      where.startedAt = {};
      if (filters.dateFrom) {
        where.startedAt.gte = filters.dateFrom;
      }
      if (filters.dateTo) {
        where.startedAt.lte = filters.dateTo;
      }
    }

    return prisma.syncLog.findMany({
      where,
      take: limit,
      orderBy: { startedAt: 'desc' },
    });
  }

  async isRunning(entityType: string, source: string) {
    const running = await prisma.syncLog.findFirst({
      where: {
        entityType,
        source,
        status: 'RUNNING',
      },
    });
    return !!running;
  }

  async getSyncStats(daysBack = 7) {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - daysBack);

    const stats = await prisma.syncLog.groupBy({
      by: ['entityType', 'source', 'status'],
      where: { startedAt: { gte: dateFrom } },
      _count: { id: true },
    });

    return stats.map((s: (typeof stats)[number]) => ({
      entityType: s.entityType,
      source: s.source,
      status: s.status,
      count: s._count.id,
    }));
  }

  async cleanOldLogs(daysToKeep = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    return prisma.syncLog.deleteMany({
      where: {
        startedAt: { lt: cutoffDate },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
    });
  }
}

export const syncLogRepository = new SyncLogRepository();
