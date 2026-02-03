/**
 * Mercado Pago API Client
 * HTTP client for MP API with automatic token refresh
 */

import { createLogger } from '../../../config/logger.js';
import { mpTokenService } from '../../auth/services/token.service.js';

const logger = createLogger('mp-client');

export interface MPApiError {
  message: string;
  error: string;
  status: number;
  cause?: Array<{ code: string; description: string }>;
}

export interface MPMovement {
  id: number;
  user_id: number;
  type: string;
  action: string;
  amount: number;
  fee: number;
  currency_id: string;
  balance: number;
  reference_id: string | null;
  external_reference: string | null;
  date_created: string;
  source_id: number | null;
  status: string;
  detail: string | null;
  description: string | null;
  money_release_date: string | null;
  payer_id: number | null;
  collector_id: number | null;
}

export interface MPMovementsResponse {
  paging: {
    total: number;
    limit: number;
    offset: number;
  };
  results: MPMovement[];
}

export interface MPBalance {
  available_balance: number;
  unavailable_balance: number;
  total_amount: number;
  currency_id: string;
}

export interface MPBalanceResponse {
  available_balance: number;
  unavailable_balance: number;
  total_amount: number;
}

export interface MPPayment {
  id: number;
  date_created: string;
  date_approved: string | null;
  date_last_updated: string;
  money_release_date: string | null;
  operation_type: string;
  payment_method_id: string;
  payment_type_id: string;
  status: string;
  status_detail: string;
  currency_id: string;
  description: string | null;
  taxes_amount: number;
  shipping_amount: number;
  collector_id: number;
  payer: {
    id: number;
    email: string;
    first_name: string | null;
    last_name: string | null;
  };
  order: {
    id: string;
    type: string;
  } | null;
  transaction_amount: number;
  transaction_amount_refunded: number;
  transaction_details: {
    net_received_amount: number;
    total_paid_amount: number;
    overpaid_amount: number;
    installment_amount: number;
  };
  fee_details: Array<{
    type: string;
    amount: number;
    fee_payer: string;
  }>;
  captured: boolean;
  refunds: unknown[];
  external_reference: string | null;
}

export interface MPPaymentsResponse {
  paging: {
    total: number;
    limit: number;
    offset: number;
  };
  results: MPPayment[];
}

export class MPClient {
  private baseUrl = 'https://api.mercadopago.com';
  private userId: string | null = null;
  private envAccessToken: string | null = null;

  constructor(userId?: string) {
    this.userId = userId ?? null;
  }

  private async getAccessToken(): Promise<string> {
    // First check if we have an env token cached
    if (this.envAccessToken) {
      return this.envAccessToken;
    }

    // Try to get active token (which will use env token if available)
    const token = await mpTokenService.getActiveToken();
    if (!token) {
      throw new Error('No active MP token available');
    }
    
    // If it's the env token, cache it
    if (token.userId === 'env-user') {
      this.envAccessToken = token.accessToken;
      this.userId = 'env-user';
      return token.accessToken;
    }

    if (this.userId && this.userId !== 'env-user') {
      return mpTokenService.getValidToken(this.userId);
    }

    this.userId = token.userId;
    return token.accessToken;
  }

  private async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number>;
    }
  ): Promise<T> {
    const accessToken = await this.getAccessToken();

    let url = `${this.baseUrl}${path}`;
    if (options?.params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(options.params)) {
        searchParams.set(key, String(value));
      }
      url += `?${searchParams.toString()}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options?.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    logger.debug({ method, path }, 'MP API request');

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as MPApiError;
      logger.error({ method, path, status: response.status, error }, 'MP API error');
      throw new Error(`MP API error: ${error.message || response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get user information
   */
  async getMe(): Promise<{ id: number; nickname: string; site_id: string }> {
    return this.request('GET', '/users/me');
  }

  /**
   * Get account balance
   * Note: This API requires special permissions that test accounts don't have
   */
  async getBalance(): Promise<MPBalanceResponse> {
    try {
      const userId = await this.getUserId();
      return await this.request('GET', `/users/${userId}/mercadopago_account/balance`);
    } catch (error) {
      // If balance API is not available (test account or no permissions), return zeroes
      logger.warn({ error }, 'Balance API not available, returning empty balance');
      return {
        available_balance: 0,
        unavailable_balance: 0,
        total_amount: 0,
      };
    }
  }

  /**
   * Get account movements (financial transactions)
   * Note: This API requires special permissions. Falls back to payments API.
   */
  async getMovements(params: {
    offset?: number;
    limit?: number;
    begin_date?: string;
    end_date?: string;
    type?: string;
  }): Promise<MPMovementsResponse> {
    try {
      const userId = await this.getUserId();

      // Movements API requires range parameter
      const searchParams: Record<string, string | number> = {
        user_id: userId,
        offset: params.offset ?? 0,
        limit: params.limit ?? 50,
      };

      // Add date range (required by API)
      if (params.begin_date && params.end_date) {
        searchParams.range = 'date_created';
        searchParams.begin_date = params.begin_date;
        searchParams.end_date = params.end_date;
      }

      if (params.type) {
        searchParams.type = params.type;
      }

      return await this.request('GET', `/mercadopago_account/movements/search`, { params: searchParams });
    } catch (error) {
      // If movements API is not available, return empty results
      // The sync service should fall back to using payments API
      logger.warn({ error }, 'Movements API not available, returning empty results');
      return {
        paging: { total: 0, limit: params.limit ?? 50, offset: params.offset ?? 0 },
        results: [],
      };
    }
  }

  /**
   * Get all movements with pagination
   */
  async getAllMovements(params: {
    dateFrom: Date;
    dateTo: Date;
    type?: string;
    onProgress?: (fetched: number, total: number) => void;
  }): Promise<MPMovement[]> {
    const allMovements: MPMovement[] = [];
    let offset = 0;
    const limit = 50;
    let total = 0;

    // Format dates for MP API
    const beginDate = this.formatDateForMPApi(params.dateFrom);
    const endDate = this.formatDateForMPApi(params.dateTo);

    do {
      const response = await this.getMovements({
        offset,
        limit,
        begin_date: beginDate,
        end_date: endDate,
        type: params.type,
      });

      allMovements.push(...response.results);
      total = response.paging.total;
      offset += limit;

      if (params.onProgress) {
        params.onProgress(allMovements.length, total);
      }

      logger.debug({ fetched: allMovements.length, total }, 'Fetching MP movements');
    } while (offset < total);

    return allMovements;
  }

  /**
   * Format date for MP API
   * MP API uses format like "NOW-30DAYS" or ISO format with specific requirements
   */
  private formatDateForMPApi(date: Date): string {
    // MP API accepts ISO 8601 format: yyyy-MM-dd'T'HH:mm:ss.SSSZ
    return date.toISOString();
  }

  /**
   * Get payments received
   */
  async getPayments(params: {
    offset?: number;
    limit?: number;
    begin_date?: string;
    end_date?: string;
    status?: string;
  }): Promise<MPPaymentsResponse> {
    const searchParams: Record<string, string | number> = {
      offset: params.offset ?? 0,
      limit: params.limit ?? 50,
      sort: 'date_created',
      criteria: 'desc',
    };

    // Add date range if provided
    if (params.begin_date && params.end_date) {
      searchParams.range = 'date_created';
      searchParams.begin_date = params.begin_date;
      searchParams.end_date = params.end_date;
    }

    if (params.status) {
      searchParams.status = params.status;
    }

    return this.request('GET', `/v1/payments/search`, { params: searchParams });
  }

  /**
   * Get all payments with pagination
   */
  async getAllPayments(params: {
    dateFrom: Date;
    dateTo: Date;
    status?: string;
    onProgress?: (fetched: number, total: number) => void;
  }): Promise<MPPayment[]> {
    const allPayments: MPPayment[] = [];
    let offset = 0;
    const limit = 50;
    let total = 0;

    // Format dates for MP API
    const beginDate = this.formatDateForMPApi(params.dateFrom);
    const endDate = this.formatDateForMPApi(params.dateTo);

    do {
      const response = await this.getPayments({
        offset,
        limit,
        begin_date: beginDate,
        end_date: endDate,
        status: params.status,
      });

      allPayments.push(...response.results);
      total = response.paging.total;
      offset += limit;

      if (params.onProgress) {
        params.onProgress(allPayments.length, total);
      }

      logger.debug({ fetched: allPayments.length, total }, 'Fetching MP payments');
    } while (offset < total);

    return allPayments;
  }

  /**
   * Get a single payment by ID
   */
  async getPayment(paymentId: number): Promise<MPPayment> {
    return this.request('GET', `/v1/payments/${paymentId}`);
  }

  /**
   * Get user ID
   */
  async getUserId(): Promise<string> {
    if (this.userId) {
      return this.userId;
    }
    const me = await this.getMe();
    this.userId = String(me.id);
    return this.userId;
  }

  /**
   * Save balance snapshot
   */
  async saveBalanceSnapshot(): Promise<MPBalanceResponse> {
    const balance = await this.getBalance();
    logger.info({ balance }, 'Balance snapshot saved');
    return balance;
  }
}

// Default client instance
export const mpClient = new MPClient();
