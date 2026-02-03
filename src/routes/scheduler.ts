/**
 * Scheduler Routes
 * Endpoints for managing scheduled jobs
 */

import { FastifyInstance } from 'fastify';
import { schedulerService } from '../shared/scheduler/index.js';

interface RunJobParams {
  jobId: string;
}

export async function schedulerRoutes(fastify: FastifyInstance): Promise<void> {
  // Get all jobs status
  fastify.get('/scheduler/jobs', {
    schema: {
      tags: ['Scheduler'],
      summary: 'Get all scheduled jobs status',
      response: {
        200: {
          type: 'object',
          properties: {
            jobs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  schedule: { type: 'string' },
                  enabled: { type: 'boolean' },
                  running: { type: 'boolean' },
                  lastRun: { type: ['string', 'null'] },
                  nextRun: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
    handler: async (_request, reply) => {
      const jobs = schedulerService.getJobsStatus();
      return reply.send({ jobs });
    },
  });

  // Run a job manually
  fastify.post<{ Params: RunJobParams }>('/scheduler/jobs/:jobId/run', async (request, reply) => {
    const { jobId } = request.params;

    try {
      await schedulerService.runNow(jobId);
      return reply.send({ message: 'Job executed successfully', jobId });
    } catch (error) {
      return reply.status(404).send({ error: (error as Error).message });
    }
  });

  // Get alert history
  fastify.get('/scheduler/alerts', {
    schema: {
      tags: ['Scheduler'],
      summary: 'Get recent alert history',
      response: {
        200: {
          type: 'object',
          properties: {
            alerts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  message: { type: 'string' },
                  data: { type: 'object' },
                  sentAt: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    handler: async (_request, reply) => {
      const alerts = schedulerService.getAlertHistory();
      return reply.send({ alerts });
    },
  });
}
