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
      });
    }
    if (results.length < limit) break;
    offset += limit;
  }
  return all;
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
