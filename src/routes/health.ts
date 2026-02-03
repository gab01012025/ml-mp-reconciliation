/**
 * Health Routes
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '../shared/database/client.js';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  fastify.get('/health/ready', async (_, reply) => {
    try {
      // Check database connection
      await prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ready',
        timestamp: new Date().toISOString(),
        database: 'connected',
      };
    } catch {
      return reply.status(503).send({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
      });
    }
  });

  fastify.get('/health/live', async () => ({
    status: 'alive',
    timestamp: new Date().toISOString(),
  }));
}
