/**
 * Fastify Application
 */

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import Fastify, { FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { authPlugin } from './plugins/index.js';
import { docsRoutes, healthRoutes, metricsRoutes, oauthRoutes, reconciliationRoutes, reportsRoutes, schedulerRoutes, syncRoutes } from './routes/index.js';
import { connectDatabase, disconnectDatabase } from './shared/database/client.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:standard' },
            }
          : undefined,
    },
    trustProxy: true,
    requestIdHeader: 'x-request-id',
  });

  // Security plugins
  await app.register(cors, { origin: true, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(sensible);

  // Auth plugin
  await app.register(authPlugin, {
    headerName: 'x-api-key',
    excludePaths: ['/health', '/health/ready', '/health/live', '/', '/auth/ml/callback', '/auth/mp/callback', '/auth/ml/authorize', '/auth/mp/authorize', '/docs', '/docs/openapi.json', '/docs/redoc'],
  });

  // Routes
  await app.register(docsRoutes);
  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(oauthRoutes);
  await app.register(reconciliationRoutes);
  await app.register(reportsRoutes);
  await app.register(schedulerRoutes);
  await app.register(syncRoutes);

  // Root route
  app.get('/', async () => ({
    name: 'ML-MP Financial Reconciliation API',
    version: '1.0.0',
    status: 'running',
  }));

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    request.log.error({
      err: error,
      requestId: request.id,
    });

    return reply.status(statusCode).send({
      success: false,
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: env.NODE_ENV === 'production' && statusCode >= 500 ? 'Internal Server Error' : error.message,
      },
      requestId: request.id,
    });
  });

  // Not found handler
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${request.method} ${request.url}`,
      },
    });
  });

  return app;
}

export { connectDatabase, disconnectDatabase };
