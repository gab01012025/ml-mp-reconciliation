/**
 * Mercado Livre API Client
 * HTTP client for ML API with automatic token refresh
 */

import { createLogger } from '../../../config/logger.js';
import { mlTokenService } from '../../auth/services/token.service.js';

const logger = createLogger('ml-client');

export interface MLApiError {
  message: string;
  error: string;
  status: number;
  cause?: string[];
}

export interface MLOrder {
  id: number;
  status: string;
  status_detail: string | null;
  date_created: string;
  date_closed: string | null;
  last_updated: string;
  manufacturing_ending_date: string | null;
  feedback: { sale: unknown; purchase: unknown };
  mediations: unknown[];
  comments: unknown;
  pack_id: number | null;
  pickup_id: number | null;
  order_request: { return: unknown | null; change: unknown | null };
  fulfilled: boolean;
  total_amount: number;
  paid_amount: number;
  coupon: { id: string | null; amount: number };
  expiration_date: string;
  order_items: MLOrderItem[];
  currency_id: string;
  payments: MLPayment[];
  shipping: MLShipping;
  buyer: MLBuyer;
  seller: { id: number };
  taxes: { amount: number | null; currency_id: string | null };
}

export interface MLOrderItem {
  item: {
    id: string;
    title: string;
    category_id: string;
    variation_id: number | null;
    seller_custom_field: string | null;
    variation_attributes: Array<{ id: string; name: string; value_id: string; value_name: string }>;
    warranty: string;
    condition: string;
    seller_sku: string | null;
    global_price: number | null;
    net_weight: number | null;
  };
  quantity: number;
  unit_price: number;
  full_unit_price: number;
  currency_id: string;
  manufacturing_days: number | null;
  sale_fee: number;
  listing_type_id: string;
}

export interface MLPayment {
  id: number;
  order_id: number;
  payer_id: number;
  collector: { id: number };
  card_id: number | null;
  site_id: string;
  reason: string;
  payment_method_id: string;
  currency_id: string;
  installments: number;
  issuer_id: string;
  atm_transfer_reference: { company_id: string | null; transaction_id: string | null };
  coupon_id: string | null;
  activation_uri: string | null;
  operation_type: string;
  payment_type: string;
  available_actions: string[];
  status: string;
  status_code: string | null;
  status_detail: string;
  transaction_amount: number;
  transaction_amount_refunded: number;
  taxes_amount: number;
  shipping_cost: number;
  coupon_amount: number;
  overpaid_amount: number;
  total_paid_amount: number;
  installment_amount: number | null;
  deferred_period: string | null;
  date_approved: string | null;
  authorization_code: string | null;
  transaction_order_id: string | null;
  date_created: string;
  date_last_modified: string;
}

export interface MLShipping {
  id: number | null;
}

export interface MLBuyer {
  id: number;
  nickname: string;
  first_name: string;
  last_name: string;
}

export interface MLOrdersResponse {
  query: string;
  results: MLOrder[];
  paging: {
    total: number;
    offset: number;
    limit: number;
  };
}

export interface MLShipmentDetails {
  id: number;
  mode: string;
  created_by: string;
  order_id: number;
  order_cost: number;
  base_cost: number;
  site_id: string;
  status: string;
  substatus: string | null;
  status_history: { date_cancelled: string | null; date_delivered: string | null; date_first_visit: string | null; date_handling: string | null; date_not_delivered: string | null; date_ready_to_ship: string | null; date_shipped: string | null };
  date_created: string;
  last_updated: string;
  tracking_number: string | null;
  tracking_method: string | null;
  service_id: number;
  carrier_info: unknown | null;
  sender_id: number;
  sender_address: unknown;
  receiver_id: number;
  receiver_address: unknown;
  shipping_items: Array<{ id: string; description: string; quantity: number; dimensions: string | null }>;
  shipping_option: unknown;
  comments: string | null;
  date_first_printed: string | null;
  market_place: string;
  return_details: unknown | null;
  tags: string[];
  delay: string[];
  type: string;
  logistic_type: string;
  application_id: string | null;
  return_tracking_number: string | null;
  cost_components: unknown;
}

export class MLClient {
  private baseUrl = 'https://api.mercadolibre.com';
  private userId: string | null = null;

  constructor(userId?: string) {
    this.userId = userId ?? null;
  }

  private async getAccessToken(): Promise<string> {
    if (this.userId) {
      return mlTokenService.getValidToken(this.userId);
    }

    const token = await mlTokenService.getActiveToken();
    if (!token) {
      throw new Error('No active ML token available');
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

    logger.debug({ method, path }, 'ML API request');

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as MLApiError;
      logger.error({ method, path, status: response.status, error }, 'ML API error');
      throw new Error(`ML API error: ${error.message || response.statusText}`);
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
   * Get orders with filters
   */
  async getOrders(params: {
    seller?: string;
    offset?: number;
    limit?: number;
    sort?: 'date_asc' | 'date_desc';
    'order.date_created.from'?: string;
    'order.date_created.to'?: string;
    'order.status'?: string;
  }): Promise<MLOrdersResponse> {
    const seller = params.seller ?? this.userId;
    if (!seller) {
      throw new Error('Seller ID is required');
    }

    return this.request('GET', `/orders/search`, {
      params: {
        seller,
        offset: params.offset ?? 0,
        limit: params.limit ?? 50,
        sort: params.sort ?? 'date_desc',
        ...(params['order.date_created.from'] && { 'order.date_created.from': params['order.date_created.from'] }),
        ...(params['order.date_created.to'] && { 'order.date_created.to': params['order.date_created.to'] }),
        ...(params['order.status'] && { 'order.status': params['order.status'] }),
      },
    });
  }

  /**
   * Get all orders with pagination
   */
  async getAllOrders(params: {
    dateFrom: Date;
    dateTo: Date;
    status?: string;
    onProgress?: (fetched: number, total: number) => void;
  }): Promise<MLOrder[]> {
    const allOrders: MLOrder[] = [];
    let offset = 0;
    const limit = 50;
    let total = 0;

    do {
      const response = await this.getOrders({
        offset,
        limit,
        'order.date_created.from': params.dateFrom.toISOString(),
        'order.date_created.to': params.dateTo.toISOString(),
        'order.status': params.status,
      });

      allOrders.push(...response.results);
      total = response.paging.total;
      offset += limit;

      if (params.onProgress) {
        params.onProgress(allOrders.length, total);
      }

      logger.debug({ fetched: allOrders.length, total }, 'Fetching ML orders');
    } while (offset < total);

    return allOrders;
  }

  /**
   * Get a single order by ID
   */
  async getOrder(orderId: number): Promise<MLOrder> {
    return this.request('GET', `/orders/${orderId}`);
  }

  /**
   * Get shipment details
   */
  async getShipment(shipmentId: number): Promise<MLShipmentDetails> {
    return this.request('GET', `/shipments/${shipmentId}`);
  }

  /**
   * Get seller ID
   */
  async getSellerId(): Promise<string> {
    if (this.userId) {
      return this.userId;
    }
    const me = await this.getMe();
    this.userId = String(me.id);
    return this.userId;
  }
}

// Default client instance
export const mlClient = new MLClient();
