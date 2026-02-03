/**
 * Reconciliation Service Tests
 */
import { ReconciliationStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../shared/database/client.js';
import { reconciliationRepository } from '../repositories/reconciliation.repository.js';
import { ReconciliationService } from './reconciliation.service.js';

// Mock Prisma client
vi.mock('../../../shared/database/client.js', () => ({
  prisma: {
    mLOrder: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    mPMovement: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    reconciliation: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    reconciliationItem: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

// Mock repository
vi.mock('../repositories/reconciliation.repository.js', () => ({
  reconciliationRepository: {
    create: vi.fn(),
    update: vi.fn(),
    findById: vi.fn(),
    findMany: vi.fn(),
    getLatest: vi.fn(),
    getReconciliationSummary: vi.fn(),
    updateItemStatus: vi.fn(),
  },
}));

// Mock logger
vi.mock('../../../config/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('ReconciliationService', () => {
  let service: ReconciliationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ReconciliationService();
  });

  describe('reconcile', () => {
    it('should create reconciliation and match orders with movements', async () => {
      // Setup mock data
      const mockReconciliation = {
        id: 'recon-1',
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
        status: ReconciliationStatus.PENDING,
      };

      const mockOrders = [
        {
          id: 'order-1',
          externalId: 'ML-123',
          totalAmount: new Decimal(100),
          dateCreated: new Date('2025-01-15'),
          payments: [
            { id: 'pay-1', externalId: 'PAY-123', transactionAmount: new Decimal(100), status: 'approved' },
          ],
        },
        {
          id: 'order-2',
          externalId: 'ML-456',
          totalAmount: new Decimal(200),
          dateCreated: new Date('2025-01-16'),
          payments: [
            { id: 'pay-2', externalId: 'PAY-456', transactionAmount: new Decimal(200), status: 'approved' },
          ],
        },
      ];

      const mockMovements = [
        {
          id: 'mov-1',
          externalId: 'MP-123',
          amount: new Decimal(100),
          fee: new Decimal(5),
          referenceId: 'PAY-123',
          externalReference: null,
          dateCreated: new Date('2025-01-15'),
          type: 'SALE',
        },
        {
          id: 'mov-2',
          externalId: 'MP-456',
          amount: new Decimal(200),
          fee: new Decimal(10),
          referenceId: 'PAY-456',
          externalReference: null,
          dateCreated: new Date('2025-01-16'),
          type: 'SALE',
        },
      ];

      // Setup mocks
      vi.mocked(reconciliationRepository.create).mockResolvedValue(mockReconciliation as never);
      vi.mocked(reconciliationRepository.update).mockResolvedValue({
        ...mockReconciliation,
        status: ReconciliationStatus.MATCHED,
      } as never);
      vi.mocked(prisma.mLOrder.findMany).mockResolvedValue(mockOrders as never);
      vi.mocked(prisma.mPMovement.findMany).mockResolvedValue(mockMovements as never);
      vi.mocked(prisma.reconciliationItem.createMany).mockResolvedValue({ count: 2 } as never);

      // Execute
      const result = await service.reconcile({
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
      });

      // Assert
      expect(result.reconciliationId).toBe('recon-1');
      expect(result.totalOrders).toBe(2);
      expect(result.totalMovements).toBe(2);
      expect(result.matched).toBe(2);
      expect(result.unmatched).toBe(0);
      expect(reconciliationRepository.create).toHaveBeenCalledWith({
        periodStart: expect.any(Date),
        periodEnd: expect.any(Date),
        status: ReconciliationStatus.PENDING,
      });
    });

    it('should handle unmatched orders', async () => {
      const mockReconciliation = {
        id: 'recon-2',
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
        status: ReconciliationStatus.PENDING,
      };

      const mockOrders = [
        {
          id: 'order-1',
          externalId: 'ML-123',
          totalAmount: new Decimal(100),
          dateCreated: new Date('2025-01-15'),
          payments: [
            { id: 'pay-1', externalId: 'PAY-123', transactionAmount: new Decimal(100), status: 'approved' },
          ],
        },
      ];

      // No movements available
      const mockMovements: unknown[] = [];

      vi.mocked(reconciliationRepository.create).mockResolvedValue(mockReconciliation as never);
      vi.mocked(reconciliationRepository.update).mockResolvedValue({
        ...mockReconciliation,
        status: ReconciliationStatus.UNMATCHED,
      } as never);
      vi.mocked(prisma.mLOrder.findMany).mockResolvedValue(mockOrders as never);
      vi.mocked(prisma.mPMovement.findMany).mockResolvedValue(mockMovements as never);
      vi.mocked(prisma.reconciliationItem.createMany).mockResolvedValue({ count: 1 } as never);

      const result = await service.reconcile({
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
      });

      expect(result.unmatched).toBe(1);
      expect(result.matched).toBe(0);
    });

    it('should detect divergent amounts', async () => {
      const mockReconciliation = {
        id: 'recon-3',
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
        status: ReconciliationStatus.PENDING,
      };

      const mockOrders = [
        {
          id: 'order-1',
          externalId: 'ML-123',
          totalAmount: new Decimal(100),
          dateCreated: new Date('2025-01-15'),
          payments: [
            { id: 'pay-1', externalId: 'PAY-123', transactionAmount: new Decimal(100), status: 'approved' },
          ],
        },
      ];

      // Movement with different amount
      const mockMovements = [
        {
          id: 'mov-1',
          externalId: 'MP-123',
          amount: new Decimal(80), // Difference of 20
          fee: new Decimal(5),
          referenceId: 'PAY-123',
          externalReference: null,
          dateCreated: new Date('2025-01-15'),
          type: 'SALE',
        },
      ];

      vi.mocked(reconciliationRepository.create).mockResolvedValue(mockReconciliation as never);
      vi.mocked(reconciliationRepository.update).mockResolvedValue({
        ...mockReconciliation,
        status: ReconciliationStatus.PARTIAL_MATCH,
      } as never);
      vi.mocked(prisma.mLOrder.findMany).mockResolvedValue(mockOrders as never);
      vi.mocked(prisma.mPMovement.findMany).mockResolvedValue(mockMovements as never);
      vi.mocked(prisma.reconciliationItem.createMany).mockResolvedValue({ count: 1 } as never);

      const result = await service.reconcile({
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
      });

      expect(result.divergent).toBe(1);
      expect(result.matched).toBe(0);
    });
  });

  describe('getReconciliation', () => {
    it('should return reconciliation by ID', async () => {
      const mockReconciliation = {
        id: 'recon-1',
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
        status: ReconciliationStatus.MATCHED,
        items: [],
      };

      vi.mocked(reconciliationRepository.findById).mockResolvedValue(mockReconciliation as never);

      const result = await service.getReconciliation('recon-1');

      expect(result).toEqual(mockReconciliation);
      expect(reconciliationRepository.findById).toHaveBeenCalledWith('recon-1');
    });

    it('should return null for non-existent reconciliation', async () => {
      vi.mocked(reconciliationRepository.findById).mockResolvedValue(null as never);

      const result = await service.getReconciliation('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('resolveItem', () => {
    it('should resolve item and update reconciliation counts', async () => {
      const mockItem = {
        id: 'item-1',
        reconciliationId: 'recon-1',
        status: ReconciliationStatus.UNMATCHED,
      };

      const mockUpdatedItem = {
        ...mockItem,
        status: ReconciliationStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedBy: 'user-1',
        notes: 'Manual resolution',
      };

      vi.mocked(prisma.reconciliationItem.findUnique).mockResolvedValue(mockItem as never);
      vi.mocked(reconciliationRepository.updateItemStatus).mockResolvedValue(mockUpdatedItem as never);
      vi.mocked(prisma.reconciliationItem.groupBy).mockResolvedValue([
        { status: ReconciliationStatus.MATCHED, _count: 5 },
        { status: ReconciliationStatus.RESOLVED, _count: 1 },
      ] as never);
      vi.mocked(reconciliationRepository.update).mockResolvedValue({} as never);

      const result = await service.resolveItem('item-1', {
        status: ReconciliationStatus.RESOLVED,
        notes: 'Manual resolution',
        resolvedBy: 'user-1',
      });

      expect(result.status).toBe(ReconciliationStatus.RESOLVED);
      expect(reconciliationRepository.updateItemStatus).toHaveBeenCalledWith(
        'item-1',
        ReconciliationStatus.RESOLVED,
        'Manual resolution',
        'user-1'
      );
    });

    it('should throw error for non-existent item', async () => {
      vi.mocked(prisma.reconciliationItem.findUnique).mockResolvedValue(null as never);

      await expect(
        service.resolveItem('non-existent', {
          status: ReconciliationStatus.RESOLVED,
        })
      ).rejects.toThrow('Item not found');
    });
  });

  describe('getDashboardStats', () => {
    it('should return dashboard stats', async () => {
      const mockLatest = {
        id: 'recon-1',
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
        status: ReconciliationStatus.MATCHED,
        matchedCount: 10,
        unmatchedCount: 2,
        discrepancy: new Decimal(0),
      };

      vi.mocked(reconciliationRepository.getLatest).mockResolvedValue(mockLatest as never);
      vi.mocked(reconciliationRepository.findMany).mockResolvedValue({
        data: [],
        total: 5,
        page: 1,
        limit: 10,
        totalPages: 1,
      } as never);
      vi.mocked(prisma.mLOrder.count).mockResolvedValue(100 as never);
      vi.mocked(prisma.mPMovement.count).mockResolvedValue(95 as never);

      const result = await service.getDashboardStats();

      expect(result.latest).toBeDefined();
      expect(result.latest?.id).toBe('recon-1');
      expect(result.recentCount).toBe(5);
      expect(result.last30Days.orders).toBe(100);
      expect(result.last30Days.movements).toBe(95);
    });
  });
});
