/**
 * Auth Plugin
 * API Key authentication for protected routes
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '../config/env.js';

export interface AuthPluginOptions {
  headerName?: string;
  excludePaths?: string[];
}

async function authPlugin(fastify: FastifyInstance, opts: AuthPluginOptions) {
  const headerName = opts.headerName ?? 'x-api-key';
  const excludePaths = opts.excludePaths ?? ['/health', '/'];

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Get the path without query string
    const urlPath = request.url.split('?')[0];
    
    // Skip auth for excluded paths
    if (excludePaths.some(path => urlPath === path || urlPath.startsWith(path + '/'))) {
      return;
    }

    const apiKey = request.headers[headerName];

    if (!apiKey) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'API key is required',
        },
      });
    }

    if (apiKey !== env.API_KEY) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid API key',
        },
      });
    }
  });
}

export default fp(authPlugin, {
  name: 'auth-plugin',
  fastify: '4.x',
});
