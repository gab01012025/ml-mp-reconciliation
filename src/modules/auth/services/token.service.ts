/**
 * Token Service
 * Manages OAuth tokens for Mercado Livre and Mercado Pago
 */

import { MercadoLivreToken, MercadoPagoToken } from '@prisma/client';
import { env } from '../../../config/env.js';
import { createLogger } from '../../../config/logger.js';
import { prisma } from '../../../shared/database/client.js';

const logger = createLogger('token-service');

// Token expiry buffer (refresh 5 minutes before expiry)
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id: number;
  refresh_token: string;
}

// ============================================================================
// MERCADO LIVRE TOKEN SERVICE
// ============================================================================

export class MLTokenService {
  private baseUrl = 'https://api.mercadolibre.com';

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<MercadoLivreToken> {
    logger.info('Exchanging authorization code for ML token');

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.ML_CLIENT_ID,
        client_secret: env.ML_CLIENT_SECRET,
        code,
        redirect_uri: env.ML_REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ error, status: response.status }, 'Failed to exchange ML code');
      throw new Error(`ML OAuth error: ${error}`);
    }

    const data = (await response.json()) as OAuthTokenResponse;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    const token = await prisma.mercadoLivreToken.upsert({
      where: { userId: String(data.user_id) },
      create: {
        userId: String(data.user_id),
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        status: 'ACTIVE',
        scopes: data.scope ? data.scope.split(' ') : [],
      },
      update: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        status: 'ACTIVE',
        scopes: data.scope ? data.scope.split(' ') : [],
      },
    });

    logger.info({ userId: data.user_id }, 'ML token saved successfully');
    return token;
  }

  /**
   * Refresh an expired token
   */
  async refreshToken(token: MercadoLivreToken): Promise<MercadoLivreToken> {
    logger.info({ userId: token.userId }, 'Refreshing ML token');

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.ML_CLIENT_ID,
        client_secret: env.ML_CLIENT_SECRET,
        refresh_token: token.refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ error, userId: token.userId }, 'Failed to refresh ML token');

      // Mark token as expired
      await prisma.mercadoLivreToken.update({
        where: { id: token.id },
        data: { status: 'EXPIRED' },
      });

      throw new Error(`ML token refresh error: ${error}`);
    }

    const data = (await response.json()) as OAuthTokenResponse;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    const updatedToken = await prisma.mercadoLivreToken.update({
      where: { id: token.id },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        status: 'ACTIVE',
      },
    });

    logger.info({ userId: token.userId }, 'ML token refreshed successfully');
    return updatedToken;
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getValidToken(userId: string): Promise<string> {
    const token = await prisma.mercadoLivreToken.findUnique({
      where: { userId },
    });

    if (!token) {
      throw new Error(`No ML token found for user ${userId}`);
    }

    if (token.status === 'REVOKED') {
      throw new Error(`ML token for user ${userId} has been revoked`);
    }

    // Check if token needs refresh
    const needsRefresh = token.expiresAt.getTime() - Date.now() < TOKEN_EXPIRY_BUFFER_MS;

    if (needsRefresh) {
      const refreshedToken = await this.refreshToken(token);
      return refreshedToken.accessToken;
    }

    return token.accessToken;
  }

  /**
   * Get the first active token (for single-seller scenarios)
   */
  async getActiveToken(): Promise<MercadoLivreToken | null> {
    const token = await prisma.mercadoLivreToken.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
    });

    if (!token) return null;

    // Check if needs refresh
    const needsRefresh = token.expiresAt.getTime() - Date.now() < TOKEN_EXPIRY_BUFFER_MS;

    if (needsRefresh) {
      try {
        return await this.refreshToken(token);
      } catch {
        return null;
      }
    }

    return token;
  }

  /**
   * Revoke a token
   */
  async revokeToken(userId: string): Promise<void> {
    await prisma.mercadoLivreToken.update({
      where: { userId },
      data: { status: 'REVOKED' },
    });
    logger.info({ userId }, 'ML token revoked');
  }

  /**
   * Generate OAuth authorization URL
   */
  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.ML_CLIENT_ID,
      redirect_uri: env.ML_REDIRECT_URI,
    });

    if (state) {
      params.set('state', state);
    }

    return `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;
  }
}

// ============================================================================
// MERCADO PAGO TOKEN SERVICE
// ============================================================================

export class MPTokenService {
  private baseUrl = 'https://api.mercadopago.com';

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<MercadoPagoToken> {
    logger.info('Exchanging authorization code for MP token');

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.MP_CLIENT_ID,
        client_secret: env.MP_CLIENT_SECRET,
        code,
        redirect_uri: env.ML_REDIRECT_URI, // Same redirect URI
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ error, status: response.status }, 'Failed to exchange MP code');
      throw new Error(`MP OAuth error: ${error}`);
    }

    const data = (await response.json()) as OAuthTokenResponse;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    const token = await prisma.mercadoPagoToken.upsert({
      where: { userId: String(data.user_id) },
      create: {
        userId: String(data.user_id),
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        status: 'ACTIVE',
        scopes: data.scope ? data.scope.split(' ') : [],
      },
      update: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        status: 'ACTIVE',
        scopes: data.scope ? data.scope.split(' ') : [],
      },
    });

    logger.info({ userId: data.user_id }, 'MP token saved successfully');
    return token;
  }

  /**
   * Refresh an expired token
   */
  async refreshToken(token: MercadoPagoToken): Promise<MercadoPagoToken> {
    logger.info({ userId: token.userId }, 'Refreshing MP token');

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.MP_CLIENT_ID,
        client_secret: env.MP_CLIENT_SECRET,
        refresh_token: token.refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ error, userId: token.userId }, 'Failed to refresh MP token');

      await prisma.mercadoPagoToken.update({
        where: { id: token.id },
        data: { status: 'EXPIRED' },
      });

      throw new Error(`MP token refresh error: ${error}`);
    }

    const data = (await response.json()) as OAuthTokenResponse;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    const updatedToken = await prisma.mercadoPagoToken.update({
      where: { id: token.id },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        status: 'ACTIVE',
      },
    });

    logger.info({ userId: token.userId }, 'MP token refreshed successfully');
    return updatedToken;
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getValidToken(userId: string): Promise<string> {
    const token = await prisma.mercadoPagoToken.findUnique({
      where: { userId },
    });

    if (!token) {
      throw new Error(`No MP token found for user ${userId}`);
    }

    if (token.status === 'REVOKED') {
      throw new Error(`MP token for user ${userId} has been revoked`);
    }

    const needsRefresh = token.expiresAt.getTime() - Date.now() < TOKEN_EXPIRY_BUFFER_MS;

    if (needsRefresh) {
      const refreshedToken = await this.refreshToken(token);
      return refreshedToken.accessToken;
    }

    return token.accessToken;
  }

  /**
   * Get the first active token or use env token
   */
  async getActiveToken(): Promise<MercadoPagoToken | null> {
    // First try to use the env access token if available
    if (env.MP_ACCESS_TOKEN) {
      logger.info('Using MP access token from environment');
      return {
        id: 'env-token',
        userId: 'env-user',
        accessToken: env.MP_ACCESS_TOKEN,
        refreshToken: '',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year from now
        status: 'ACTIVE',
        scopes: ['read', 'write', 'offline_access'],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MercadoPagoToken;
    }

    const token = await prisma.mercadoPagoToken.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
    });

    if (!token) return null;

    const needsRefresh = token.expiresAt.getTime() - Date.now() < TOKEN_EXPIRY_BUFFER_MS;

    if (needsRefresh) {
      try {
        return await this.refreshToken(token);
      } catch {
        return null;
      }
    }

    return token;
  }

  /**
   * Revoke a token
   */
  async revokeToken(userId: string): Promise<void> {
    await prisma.mercadoPagoToken.update({
      where: { userId },
      data: { status: 'REVOKED' },
    });
    logger.info({ userId }, 'MP token revoked');
  }

  /**
   * Generate OAuth authorization URL
   */
  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.MP_CLIENT_ID,
      redirect_uri: env.ML_REDIRECT_URI,
    });

    if (state) {
      params.set('state', state);
    }

    return `https://auth.mercadopago.com/authorization?${params.toString()}`;
  }
}

// Singleton instances
export const mlTokenService = new MLTokenService();
export const mpTokenService = new MPTokenService();
