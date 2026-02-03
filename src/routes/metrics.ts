/**
 * Metrics Routes
 * Endpoints for observability and monitoring
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '../config/logger.js';
import { metricsService } from '../shared/observability/metrics.js';
import { circuitBreakerRegistry } from '../shared/utils/circuit-breaker.js';
import { rateLimiterRegistry } from '../shared/utils/rate-limiter.js';

const logger = createLogger('metrics-routes');

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /metrics
   * Get all metrics
   */
  app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    logger.debug('Getting all metrics');

    const metrics = metricsService.getAllMetrics();

    return reply.send({
      success: true,
      data: metrics,
    });
  });

  /**
   * GET /metrics/system
   * Get system metrics only
   */
  app.get('/metrics/system', async (_request: FastifyRequest, reply: FastifyReply) => {
    const system = metricsService.getSystemMetrics();

    return reply.send({
      success: true,
      data: system,
    });
  });

  /**
   * GET /metrics/circuit-breakers
   * Get circuit breaker stats
   */
  app.get('/metrics/circuit-breakers', async (_request: FastifyRequest, reply: FastifyReply) => {
    const stats = circuitBreakerRegistry.getAllStats();

    return reply.send({
      success: true,
      data: stats,
    });
  });

  /**
   * POST /metrics/circuit-breakers/reset
   * Reset all circuit breakers
   */
  app.post('/metrics/circuit-breakers/reset', async (_request: FastifyRequest, reply: FastifyReply) => {
    logger.info('Resetting all circuit breakers');
    circuitBreakerRegistry.resetAll();

    return reply.send({
      success: true,
      message: 'All circuit breakers reset',
    });
  });

  /**
   * GET /metrics/rate-limiters
   * Get rate limiter stats
   */
  app.get('/metrics/rate-limiters', async (_request: FastifyRequest, reply: FastifyReply) => {
    const stats = rateLimiterRegistry.getAllStats();

    return reply.send({
      success: true,
      data: stats,
    });
  });

  /**
   * POST /metrics/rate-limiters/reset
   * Reset all rate limiters
   */
  app.post('/metrics/rate-limiters/reset', async (_request: FastifyRequest, reply: FastifyReply) => {
    logger.info('Resetting all rate limiters');
    rateLimiterRegistry.resetAll();

    return reply.send({
      success: true,
      message: 'All rate limiters reset',
    });
  });

  /**
   * GET /metrics/counters
   * Get counter metrics
   */
  app.get('/metrics/counters', async (_request: FastifyRequest, reply: FastifyReply) => {
    const counters = metricsService.getCounters();

    return reply.send({
      success: true,
      data: counters,
    });
  });

  /**
   * GET /metrics/histograms
   * Get histogram metrics
   */
  app.get('/metrics/histograms', async (_request: FastifyRequest, reply: FastifyReply) => {
    const histograms = metricsService.getHistograms();

    return reply.send({
      success: true,
      data: histograms,
    });
  });

  /**
   * POST /metrics/reset
   * Reset all metrics (for testing)
   */
  app.post('/metrics/reset', async (_request: FastifyRequest, reply: FastifyReply) => {
    logger.warn('Resetting all metrics');
    metricsService.reset();

    return reply.send({
      success: true,
      message: 'All metrics reset',
    });
  });
}
