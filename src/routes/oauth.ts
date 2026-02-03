/**
 * OAuth Routes
 * Handles OAuth callbacks for ML and MP
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mlTokenService, mpTokenService } from '../modules/auth/services/token.service.js';

interface OAuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export async function oauthRoutes(fastify: FastifyInstance) {
  /**
   * Get ML authorization URL
   */
  fastify.get('/auth/ml/authorize', async (_request: FastifyRequest, reply: FastifyReply) => {
    const state = Math.random().toString(36).substring(7);
    const url = mlTokenService.getAuthorizationUrl(state);

    return reply.send({
      success: true,
      data: { url, state },
    });
  });

  /**
   * ML OAuth callback handler
   */
  const handleMLCallback = async (request: FastifyRequest<{ Querystring: OAuthCallbackQuery; Body?: OAuthCallbackQuery }>, reply: FastifyReply) => {
    // Support both query params (GET) and body (POST)
    const params = request.method === 'POST' && request.body ? request.body : request.query;
    const { code, error, error_description } = params;

    if (error) {
      request.log.error({ error, error_description }, 'ML OAuth error');
      return reply.status(400).send({
        success: false,
        error: {
          code: 'OAUTH_ERROR',
          message: error_description ?? error,
        },
      });
    }

    if (!code) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'MISSING_CODE',
          message: 'Authorization code is required',
        },
      });
    }

    try {
      const token = await mlTokenService.exchangeCodeForToken(code);

      return reply.send({
        success: true,
        data: {
          userId: token.userId,
          expiresAt: token.expiresAt,
          message: 'Mercado Livre authentication successful',
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Failed to exchange ML code');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'TOKEN_EXCHANGE_FAILED',
          message: err instanceof Error ? err.message : 'Failed to exchange authorization code',
        },
      });
    }
  };

  /**
   * ML OAuth callback - GET
   */
  fastify.get('/auth/ml/callback', handleMLCallback);

  /**
   * ML OAuth callback - POST
   */
  fastify.post('/auth/ml/callback', handleMLCallback);

  /**
   * Get MP authorization URL
   */
  fastify.get('/auth/mp/authorize', async (_request: FastifyRequest, reply: FastifyReply) => {
    const state = Math.random().toString(36).substring(7);
    const url = mpTokenService.getAuthorizationUrl(state);

    return reply.send({
      success: true,
      data: { url, state },
    });
  });

  /**
   * MP OAuth callback
   */
  fastify.get('/auth/mp/callback', async (request: FastifyRequest<{ Querystring: OAuthCallbackQuery }>, reply: FastifyReply) => {
    const { code, error, error_description } = request.query;

    if (error) {
      request.log.error({ error, error_description }, 'MP OAuth error');
      return reply.status(400).send({
        success: false,
        error: {
          code: 'OAUTH_ERROR',
          message: error_description ?? error,
        },
      });
    }

    if (!code) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'MISSING_CODE',
          message: 'Authorization code is required',
        },
      });
    }

    try {
      const token = await mpTokenService.exchangeCodeForToken(code);

      return reply.send({
        success: true,
        data: {
          userId: token.userId,
          expiresAt: token.expiresAt,
          message: 'Mercado Pago authentication successful',
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Failed to exchange MP code');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'TOKEN_EXCHANGE_FAILED',
          message: err instanceof Error ? err.message : 'Failed to exchange authorization code',
        },
      });
    }
  });

  /**
   * Get token status
   */
  fastify.get('/auth/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const [mlToken, mpToken] = await Promise.all([
      mlTokenService.getActiveToken(),
      mpTokenService.getActiveToken(),
    ]);

    return reply.send({
      success: true,
      data: {
        mercadoLivre: mlToken
          ? {
              userId: mlToken.userId,
              status: mlToken.status,
              expiresAt: mlToken.expiresAt,
            }
          : null,
        mercadoPago: mpToken
          ? {
              userId: mpToken.userId,
              status: mpToken.status,
              expiresAt: mpToken.expiresAt,
            }
          : null,
      },
    });
  });
}
