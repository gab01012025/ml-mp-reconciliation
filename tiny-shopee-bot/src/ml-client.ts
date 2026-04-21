import * as fs from 'fs';
import { config } from './config';

/**
 * Mercado Livre OAuth + API client
 * Docs: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao
 */

const ML_AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const ML_API_URL = 'https://api.mercadolibre.com';

export interface MLTokens {
  access_token: string;
  refresh_token: string;
  user_id: number;
  expires_at: number; // epoch ms
  scope?: string;
}

let cachedTokens: MLTokens | null = null;

function loadTokens(): MLTokens | null {
  if (cachedTokens) return cachedTokens;
  try {
    if (!fs.existsSync(config.mlTokenStorePath)) return null;
    const raw = fs.readFileSync(config.mlTokenStorePath, 'utf-8');
    cachedTokens = JSON.parse(raw) as MLTokens;
    return cachedTokens;
  } catch (err) {
    console.error('[ML] Falha ao carregar tokens:', err);
    return null;
  }
}

function saveTokens(t: MLTokens): void {
  cachedTokens = t;
  try {
    fs.writeFileSync(config.mlTokenStorePath, JSON.stringify(t, null, 2), 'utf-8');
    console.log('[ML] Tokens salvos em', config.mlTokenStorePath);
  } catch (err) {
    console.error('[ML] Falha ao persistir tokens:', err);
  }
}

export function isConnected(): boolean {
  return !!loadTokens()?.refresh_token;
}

export function getConnectionInfo(): { connected: boolean; userId?: number; expiresAt?: number } {
  const t = loadTokens();
  if (!t) return { connected: false };
  return { connected: true, userId: t.user_id, expiresAt: t.expires_at };
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.mlClientId,
    redirect_uri: config.mlRedirectUri,
    state,
  });
  return `${ML_AUTH_URL}?${params.toString()}`;
}

/**
 * Troca o authorization code por access_token + refresh_token
 */
export async function exchangeCodeForTokens(code: string): Promise<MLTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.mlClientId,
    client_secret: config.mlClientSecret,
    code,
    redirect_uri: config.mlRedirectUri,
  });

  const res = await fetch(`${ML_API_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const data: any = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`ML token exchange failed: ${JSON.stringify(data)}`);
  }

  const tokens: MLTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user_id: data.user_id,
    expires_at: Date.now() + (data.expires_in || 21600) * 1000,
    scope: data.scope,
  };
  saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken(): Promise<MLTokens> {
  const current = loadTokens();
  if (!current?.refresh_token) {
    throw new Error('ML não conectado — refresh_token ausente. Conecte a conta no painel.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.mlClientId,
    client_secret: config.mlClientSecret,
    refresh_token: current.refresh_token,
  });

  const res = await fetch(`${ML_API_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const data: any = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`ML refresh token failed: ${JSON.stringify(data)}`);
  }

  const tokens: MLTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || current.refresh_token,
    user_id: data.user_id || current.user_id,
    expires_at: Date.now() + (data.expires_in || 21600) * 1000,
    scope: data.scope || current.scope,
  };
  saveTokens(tokens);
  console.log('[ML] Access token renovado');
  return tokens;
}

async function getValidAccessToken(): Promise<string> {
  let t = loadTokens();
  if (!t) throw new Error('ML não conectado');
  // Renova se expira em menos de 5 min
  if (Date.now() >= t.expires_at - 5 * 60 * 1000) {
    t = await refreshAccessToken();
  }
  return t.access_token;
}

async function mlGet(path: string, params?: Record<string, string>): Promise<any> {
  const token = await getValidAccessToken();
  const url = new URL(`${ML_API_URL}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`ML API ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

export interface MLOrderSummary {
  id: number;
  status: string;
  date_closed: string;
  total_amount: number;
  buyer_doc_type?: string; // CPF / CNPJ
  buyer_doc?: string;
  shipping_id?: number;
}

/**
 * Busca pedidos do ML em um range de datas (dd/mm/yyyy) do seller autenticado
 */
export async function searchOrdersByDate(dataInicial: string, dataFinal: string): Promise<MLOrderSummary[]> {
  const t = loadTokens();
  if (!t) throw new Error('ML não conectado');

  const fromIso = ddmmyyyyToIso(dataInicial, false);
  const toIso = ddmmyyyyToIso(dataFinal, true);

  const all: MLOrderSummary[] = [];
  let offset = 0;
  const limit = 50;
  // Paginação simples: até 10 páginas (500 pedidos/dia já é bastante)
  for (let page = 0; page < 10; page++) {
    const data = await mlGet('/orders/search', {
      seller: String(t.user_id),
      'order.date_closed.from': fromIso,
      'order.date_closed.to': toIso,
      sort: 'date_desc',
      offset: String(offset),
      limit: String(limit),
    });
    const results = data.results || [];
    for (const o of results) {
      const billing = o.buyer?.billing_info || {};
      all.push({
        id: o.id,
        status: o.status,
        date_closed: o.date_closed,
        total_amount: o.total_amount,
        buyer_doc_type: billing.doc_type,
        buyer_doc: billing.doc_number,
        shipping_id: o.shipping?.id,
      });
    }
    if (results.length < limit) break;
    offset += limit;
  }
  return all;
}

/**
 * Busca pedidos do ML recentes com shipping pendente de envio (útil para "data de coleta").
 * Inclui todos os status de pedido, mas prioriza aqueles com shipping ainda a ser despachado.
 */
export async function searchRecentPaidOrders(daysBack: number = 45): Promise<MLOrderSummary[]> {
  const t = loadTokens();
  if (!t) throw new Error('ML não conectado');

  const now = new Date();
  const past = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const fromIso = past.toISOString();
  const toIso = now.toISOString();

  const all: MLOrderSummary[] = [];
  const seen = new Set<number>();
  // Tenta vários filtros pra maximizar cobertura
  const queries: Array<Record<string, string>> = [
    { 'shipping.status': 'ready_to_ship' },
    { 'shipping.status': 'handling' },
    { 'order.status': 'paid' },
  ];

  for (const extra of queries) {
    let offset = 0;
    const limit = 50;
    for (let page = 0; page < 30; page++) {
      try {
        const data = await mlGet('/orders/search', {
          seller: String(t.user_id),
          'order.date_created.from': fromIso,
          'order.date_created.to': toIso,
          sort: 'date_desc',
          offset: String(offset),
          limit: String(limit),
          ...extra,
        });
        const results = data.results || [];
        for (const o of results) {
          if (seen.has(o.id)) continue;
          seen.add(o.id);
          all.push({
            id: o.id,
            status: o.status,
            date_closed: o.date_closed,
            total_amount: o.total_amount,
            shipping_id: o.shipping?.id,
          });
        }
        if (results.length < limit) break;
        offset += limit;
      } catch (err) {
        console.warn('[ML] searchRecentPaidOrders query falhou:', extra, err);
        break;
      }
    }
  }
  console.log(`[ML] searchRecentPaidOrders: ${all.length} pedidos únicos retornados`);
  return all;
}

export interface MLShipmentInfo {
  id: number;
  status?: string;
  substatus?: string;
  estimated_handling_limit_date?: string; // YYYY-MM-DD local BR — data efetiva de "coleta" (pay_before no Full)
  pay_before_full?: string; // ISO completo do pay_before (deadline emissão NF)
  date_first_printed?: string;
  date_handling?: string;
  logistic_type?: string;
  raw_date_source?: string;
  raw?: any;
}

/**
 * Busca dados do shipment ML — extrai a data de coleta do vendedor.
 * Tenta múltiplos campos conforme versão da API, incluindo endpoint /lead_time.
 */
export async function getShipment(shipmentId: number): Promise<MLShipmentInfo> {
  const data = await mlGet(`/shipments/${shipmentId}`);

  // Buscar lead_time separadamente (endpoint dedicado costuma ter as datas reais)
  let leadTime: any = null;
  try {
    leadTime = await mlGet(`/shipments/${shipmentId}/lead_time`);
  } catch (err: any) {
    // silencioso — nem todos shipments têm esse endpoint disponível
  }

  // Normaliza um valor que pode ser string direta ou objeto { date, type }
  const pickDate = (v: any): string | undefined => {
    if (!v) return undefined;
    if (typeof v === 'string') {
      // Descarta estados como "estimated" que não são datas
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v;
      return undefined;
    }
    if (typeof v === 'object') {
      if (v.date && typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.date)) return v.date;
      if (v.from && typeof v.from === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.from)) return v.from;
    }
    return undefined;
  };

  // Caminhos possíveis para a data-limite de emissão de NF / coleta, em ordem de preferência.
  // IMPORTANTE: Para Full (`logistic_type=fulfillment`), os campos de coleta do seller ficam null;
  // o prazo real que o painel ML usa em "Coleta | Amanhã → NF-e para gerenciar" é
  // `estimated_delivery_time.pay_before` (deadline para a NF estar emitida).
  const payBeforeLead = leadTime?.estimated_delivery_time?.pay_before;
  const payBeforeShip = data.shipping_option?.estimated_delivery_time?.pay_before;
  const candidates: Array<[string, any]> = [
    ['lead_time.estimated_delivery_time.pay_before', payBeforeLead],
    ['shipping_option.estimated_delivery_time.pay_before', payBeforeShip],
    ['lead_time.buffering.date', leadTime?.buffering?.date],
    ['lead_time.estimated_handling_limit', leadTime?.estimated_handling_limit],
    ['lead_time.estimated_schedule_limit', leadTime?.estimated_schedule_limit],
    ['lead_time.pickup_promise', leadTime?.pickup_promise],
    ['shipping_option.estimated_schedule_limit', data.shipping_option?.estimated_schedule_limit],
    ['shipping_option.estimated_handling_limit', data.shipping_option?.estimated_handling_limit],
    ['shipping_option.pickup_promise', data.shipping_option?.pickup_promise],
    ['estimated_handling_limit', data.estimated_handling_limit],
    ['date_handling', data.date_handling],
  ];

  let rawDate: string | undefined;
  let rawSource: string | undefined;
  for (const [src, val] of candidates) {
    const d = pickDate(val);
    if (d) { rawDate = d; rawSource = src; break; }
  }

  // ML retorna em ISO com timezone brasileiro geralmente; pega só a parte da data local (-03:00)
  let localDate: string | undefined;
  if (rawDate) {
    // Se vier com timezone, primeiro 10 chars já são YYYY-MM-DD local
    localDate = rawDate.slice(0, 10);
  }

  return {
    id: data.id,
    status: data.status,
    substatus: data.substatus,
    estimated_handling_limit_date: localDate,
    pay_before_full: payBeforeLead || payBeforeShip,
    date_first_printed: data.date_first_printed,
    date_handling: data.date_handling,
    logistic_type: data.logistic_type,
    raw_date_source: rawSource,
    raw: { ...data, __lead_time_endpoint: leadTime },
  };
}

/**
 * Usado para debug: retorna uma amostra de shipments com todos os campos relevantes
 */
export async function debugSampleShipments(limit: number = 10): Promise<any[]> {
  const orders = await searchRecentPaidOrders(15);
  const sample = orders.slice(0, limit);
  const out: any[] = [];
  for (const o of sample) {
    if (!o.shipping_id) { out.push({ order_id: o.id, shipping_id: null, status: o.status }); continue; }
    try {
      const info = await getShipment(o.shipping_id);
      out.push({
        order_id: o.id,
        shipping_id: o.shipping_id,
        status: info.status,
        substatus: info.substatus,
        logistic_type: info.logistic_type,
        pay_before: info.pay_before_full,
        date_source: info.raw_date_source,
        handling_limit_date: info.estimated_handling_limit_date,
        shipping_option: info.raw?.shipping_option ? {
          estimated_schedule_limit: info.raw.shipping_option.estimated_schedule_limit,
          estimated_handling_limit: info.raw.shipping_option.estimated_handling_limit,
          pickup_promise: info.raw.shipping_option.pickup_promise,
          delivery_promise: info.raw.shipping_option.delivery_promise,
          processing_time: info.raw.shipping_option.processing_time,
        } : null,
        lead_time_endpoint: info.raw?.__lead_time_endpoint,
        top_level_keys: info.raw ? Object.keys(info.raw).filter(k => !k.startsWith('__')) : null,
      });
    } catch (e: any) {
      out.push({ order_id: o.id, shipping_id: o.shipping_id, error: e.message });
    }
  }
  return out;
}

function ddmmyyyyToIso(d: string, endOfDay: boolean): string {
  const [dd, mm, yyyy] = d.split('/');
  const time = endOfDay ? '23:59:59.999-03:00' : '00:00:00.000-03:00';
  return `${yyyy}-${mm}-${dd}T${time}`;
}

export function disconnect(): void {
  cachedTokens = null;
  try {
    if (fs.existsSync(config.mlTokenStorePath)) fs.unlinkSync(config.mlTokenStorePath);
  } catch {}
}
