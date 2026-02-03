/**
 * Scheduler Service
 * Manages automated sync and reconciliation jobs
 */

import { createLogger } from '../../config/logger.js';
import { MLSyncService } from '../../modules/ml/services/sync.service.js';
import { reconciliationService } from '../../modules/reconciliation/services/reconciliation.service.js';
import { prisma } from '../database/client.js';

const logger = createLogger('scheduler');

interface ScheduledJob {
  name: string;
  schedule: string;
  intervalMs: number;
  enabled: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  running: boolean;
}

interface JobDefinition extends ScheduledJob {
  handler: () => Promise<void>;
}

interface AlertEntry {
  type: string;
  message: string;
  data: unknown;
  sentAt: Date;
}

class SchedulerService {
  private jobs: Map<string, JobDefinition> = new Map();
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private started = false;
  private alertHistory: AlertEntry[] = [];

  constructor() {
    this.registerJobs();
  }

  private registerJobs(): void {
    // Daily sync at 6 AM (every 24 hours)
    this.jobs.set('daily-sync', {
      name: 'Daily Sync',
      schedule: 'Every day at 6:00 AM',
      intervalMs: 24 * 60 * 60 * 1000,
      enabled: true,
      lastRun: null,
      nextRun: null,
      running: false,
      handler: this.runDailySync.bind(this),
    });

    // Auto reconciliation (every 6 hours)
    this.jobs.set('auto-reconcile', {
      name: 'Auto Reconciliation',
      schedule: 'Every 6 hours',
      intervalMs: 6 * 60 * 60 * 1000,
      enabled: true,
      lastRun: null,
      nextRun: null,
      running: false,
      handler: this.runAutoReconcile.bind(this),
    });

    // Check for alerts (every 30 minutes)
    this.jobs.set('check-alerts', {
      name: 'Check Alerts',
      schedule: 'Every 30 minutes',
      intervalMs: 30 * 60 * 1000,
      enabled: true,
      lastRun: null,
      nextRun: null,
      running: false,
      handler: this.checkAlerts.bind(this),
    });
  }

  start(): void {
    if (this.started) {
      logger.warn('Scheduler already started');
      return;
    }

    logger.info('Starting scheduler...');

    for (const [id, job] of this.jobs) {
      if (job.enabled) {
        this.startJob(id);
      }
    }

    this.started = true;
    logger.info({ jobCount: this.jobs.size }, 'Scheduler started');
  }

  stop(): void {
    logger.info('Stopping scheduler...');

    for (const [id] of this.intervals) {
      this.stopJob(id);
    }

    this.started = false;
    logger.info('Scheduler stopped');
  }

  private startJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    const existingInterval = this.intervals.get(id);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    job.nextRun = new Date(Date.now() + job.intervalMs);

    const interval = setInterval(async () => {
      await this.executeJob(id);
    }, job.intervalMs);

    this.intervals.set(id, interval);

    logger.info({ job: id, nextRun: job.nextRun }, 'Job scheduled');
  }

  private stopJob(id: string): void {
    const interval = this.intervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(id);
    }
  }

  private async executeJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.running) return;

    job.running = true;
    job.lastRun = new Date();
    job.nextRun = new Date(Date.now() + job.intervalMs);

    logger.info({ job: id }, 'Executing scheduled job');

    try {
      await job.handler();
      logger.info({ job: id, duration: Date.now() - job.lastRun.getTime() }, 'Job completed');
    } catch (error) {
      logger.error({ job: id, error }, 'Job failed');
      this.addAlert('JOB_FAILURE', `Job ${job.name} failed`, { jobId: id, error: String(error) });
    } finally {
      job.running = false;
    }
  }

  async runNow(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }
    await this.executeJob(id);
  }

  getJobsStatus(): Array<Omit<ScheduledJob, 'handler'>> {
    return Array.from(this.jobs.values()).map(({ handler: _handler, ...job }) => job);
  }

  getAlertHistory(): AlertEntry[] {
    return this.alertHistory.slice(0, 50);
  }

  private addAlert(type: string, message: string, data: unknown): void {
    this.alertHistory.unshift({
      type,
      message,
      data,
      sentAt: new Date(),
    });

    // Keep only last 100 alerts
    if (this.alertHistory.length > 100) {
      this.alertHistory.pop();
    }

    logger.warn({ alertType: type, alertData: data }, message);
  }

  private async runDailySync(): Promise<void> {
    logger.info('Running daily sync...');

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 1);

    // Get all active seller tokens
    const tokens = await prisma.mercadoLivreToken.findMany({
      where: { status: 'ACTIVE' },
      select: { userId: true },
    });

    let successCount = 0;
    let errorCount = 0;

    for (const token of tokens) {
      try {
        const mlSync = new MLSyncService(token.userId);
        await mlSync.syncOrders({
          dateFrom: startDate,
          dateTo: endDate,
        });

        successCount++;
        logger.info({ userId: token.userId }, 'User sync completed');
      } catch (error) {
        errorCount++;
        logger.error({ userId: token.userId, error }, 'User sync failed');
        this.addAlert('SYNC_FAILURE', `Sync failed for user ${token.userId}`, {
          userId: token.userId,
          error: String(error),
        });
      }
    }

    logger.info({ successCount, errorCount, totalUsers: tokens.length }, 'Daily sync finished');
  }

  private async runAutoReconcile(): Promise<void> {
    logger.info('Running auto reconciliation...');

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    try {
      const result = await reconciliationService.reconcile({
        periodStart: startDate,
        periodEnd: endDate,
      });

      logger.info({
        reconciliationId: result.reconciliationId,
        matched: result.matched,
        unmatched: result.unmatched,
        divergent: result.divergent,
        discrepancy: Number(result.discrepancy),
      }, 'Auto reconciliation completed');

      // Send alert if divergences found
      if (result.divergent > 0) {
        this.addAlert('DIVERGENCE_FOUND', 'Divergences found in reconciliation', {
          reconciliationId: result.reconciliationId,
          divergentCount: result.divergent,
          discrepancy: Number(result.discrepancy),
          periodStart: startDate.toISOString(),
          periodEnd: endDate.toISOString(),
        });
      }

      // Send alert if significant discrepancy
      const discrepancyValue = Number(result.discrepancy);
      if (Math.abs(discrepancyValue) > 100) {
        this.addAlert('HIGH_DISCREPANCY', `High discrepancy detected: R$ ${discrepancyValue.toFixed(2)}`, {
          reconciliationId: result.reconciliationId,
          discrepancy: discrepancyValue,
        });
      }
    } catch (error) {
      logger.error({ error }, 'Auto reconciliation failed');
      this.addAlert('RECONCILIATION_FAILURE', 'Auto reconciliation failed', { error: String(error) });
    }
  }

  private async checkAlerts(): Promise<void> {
    logger.debug('Checking for alerts...');

    // Check for pending reconciliation items older than 24 hours
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 24);

    const pendingItems = await prisma.reconciliationItem.count({
      where: {
        status: 'PENDING',
        createdAt: { lt: cutoff },
      },
    });

    if (pendingItems > 0) {
      this.addAlert('PENDING_ITEMS', `${pendingItems} pending items older than 24h`, {
        count: pendingItems,
        olderThanHours: 24,
      });
    }

    // Check for failed syncs in last 24 hours
    const failedSyncs = await prisma.syncLog.count({
      where: {
        status: 'FAILED',
        createdAt: { gte: cutoff },
      },
    });

    if (failedSyncs > 0) {
      this.addAlert('SYNC_FAILURES', `${failedSyncs} sync failures in last 24h`, {
        count: failedSyncs,
        periodHours: 24,
      });
    }
  }
}

export const schedulerService = new SchedulerService();
