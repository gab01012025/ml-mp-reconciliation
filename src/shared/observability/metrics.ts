/**
 * Metrics Service
 * Simple in-memory metrics collection for observability
 */

import { createLogger } from '../../config/logger.js';
import { circuitBreakerRegistry } from '../utils/circuit-breaker.js';
import { rateLimiterRegistry } from '../utils/rate-limiter.js';

const logger = createLogger('metrics');

export interface Counter {
  name: string;
  value: number;
  labels: Record<string, string>;
}

export interface Gauge {
  name: string;
  value: number;
  labels: Record<string, string>;
}

export interface Histogram {
  name: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  labels: Record<string, string>;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheck[];
  timestamp: Date;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  duration?: number;
}

class MetricsService {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, { values: number[]; labels: Record<string, string> }>();
  private startTime = new Date();

  /**
   * Increment a counter
   */
  incrementCounter(name: string, value = 1, labels: Record<string, string> = {}): void {
    const key = this.getKey(name, labels);
    const existing = this.counters.get(key);

    if (existing) {
      existing.value += value;
    } else {
      this.counters.set(key, { name, value, labels });
    }
  }

  /**
   * Set a gauge value
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.getKey(name, labels);
    this.gauges.set(key, { name, value, labels });
  }

  /**
   * Record a histogram value
   */
  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.getKey(name, labels);
    const existing = this.histograms.get(key);

    if (existing) {
      existing.values.push(value);
      // Keep only last 1000 values to prevent memory issues
      if (existing.values.length > 1000) {
        existing.values.shift();
      }
    } else {
      this.histograms.set(key, { values: [value], labels });
    }
  }

  /**
   * Time a function execution
   */
  async timeAsync<T>(
    name: string,
    fn: () => Promise<T>,
    labels: Record<string, string> = {}
  ): Promise<T> {
    const start = Date.now();

    try {
      const result = await fn();
      const duration = Date.now() - start;

      this.recordHistogram(name, duration, { ...labels, status: 'success' });
      this.incrementCounter(`${name}_total`, 1, { ...labels, status: 'success' });

      return result;
    } catch (error) {
      const duration = Date.now() - start;

      this.recordHistogram(name, duration, { ...labels, status: 'error' });
      this.incrementCounter(`${name}_total`, 1, { ...labels, status: 'error' });

      throw error;
    }
  }

  /**
   * Get all counters
   */
  getCounters(): Counter[] {
    return Array.from(this.counters.values());
  }

  /**
   * Get all gauges
   */
  getGauges(): Gauge[] {
    return Array.from(this.gauges.values());
  }

  /**
   * Get all histograms (computed)
   */
  getHistograms(): Histogram[] {
    return Array.from(this.histograms.entries()).map(([key, data]) => {
      const sorted = [...data.values].sort((a, b) => a - b);
      const count = sorted.length;

      return {
        name: key.split('{')[0],
        count,
        sum: sorted.reduce((a, b) => a + b, 0),
        min: sorted[0] ?? 0,
        max: sorted[count - 1] ?? 0,
        avg: count > 0 ? sorted.reduce((a, b) => a + b, 0) / count : 0,
        p50: this.percentile(sorted, 50),
        p95: this.percentile(sorted, 95),
        p99: this.percentile(sorted, 99),
        labels: data.labels,
      };
    });
  }

  /**
   * Get system metrics
   */
  getSystemMetrics(): Record<string, unknown> {
    const memUsage = process.memoryUsage();

    return {
      uptime: Math.floor((Date.now() - this.startTime.getTime()) / 1000),
      uptimeFormatted: this.formatUptime(Date.now() - this.startTime.getTime()),
      startTime: this.startTime.toISOString(),
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memUsage.rss / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024),
      },
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
    };
  }

  /**
   * Get all metrics summary
   */
  getAllMetrics(): Record<string, unknown> {
    return {
      system: this.getSystemMetrics(),
      counters: this.getCounters(),
      gauges: this.getGauges(),
      histograms: this.getHistograms(),
      circuitBreakers: circuitBreakerRegistry.getAllStats(),
      rateLimiters: rateLimiterRegistry.getAllStats(),
    };
  }

  /**
   * Perform health checks
   */
  async getHealth(checks: Array<{ name: string; check: () => Promise<void> }>): Promise<HealthStatus> {
    const results: HealthCheck[] = [];

    for (const { name, check } of checks) {
      const start = Date.now();

      try {
        await check();
        results.push({
          name,
          status: 'pass',
          duration: Date.now() - start,
        });
      } catch (error) {
        results.push({
          name,
          status: 'fail',
          message: error instanceof Error ? error.message : String(error),
          duration: Date.now() - start,
        });
      }
    }

    const failedChecks = results.filter((r) => r.status === 'fail');
    const warnChecks = results.filter((r) => r.status === 'warn');

    let status: HealthStatus['status'] = 'healthy';
    if (failedChecks.length > 0) {
      status = 'unhealthy';
    } else if (warnChecks.length > 0) {
      status = 'degraded';
    }

    return {
      status,
      checks: results,
      timestamp: new Date(),
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    logger.info('Metrics reset');
  }

  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;

    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Format uptime as human readable
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Generate key for metric with labels
   */
  private getKey(name: string, labels: Record<string, string>): string {
    const sortedLabels = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');

    return sortedLabels ? `${name}{${sortedLabels}}` : name;
  }
}

export const metricsService = new MetricsService();
