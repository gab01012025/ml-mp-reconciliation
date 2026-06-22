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

  // Retry com backoff exponencial em 429/5xx ou body vazio
  let lastErr: any;
  let hitRateLimit = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const text = await res.text();
      if (res.status === 429) {
        hitRateLimit = true;
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
        const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * Math.pow(2, attempt), 30000);
        console.warn(`[ML] 429 rate limit em ${path} — aguardando ${wait}ms (tentativa ${attempt + 1}/5)`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500 && attempt < 4) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(`ML API ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      }
      if (!text || text.trim().length === 0) {
        if (attempt < 4) { await new Promise(r => setTimeout(r, 600)); continue; }
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        if (attempt < 4) { await new Promise(r => setTimeout(r, 600)); continue; }
        throw new Error(`ML API ${path} returned non-JSON: ${text.slice(0, 200)}`);
      }
    } catch (err: any) {
      lastErr = err;
      if (attempt < 4) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; }
    }
  }
  // Inclui "429 rate limit" na mensagem se esse foi o motivo
  if (hitRateLimit) {
    throw new Error(`ML API ${path}: 429 rate limit — máximo de tentativas atingido`);
  }
  throw lastErr || new Error(`ML API ${path}: máximo de tentativas atingido`);
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
 * Busca pedidos do ML recentes com status `paid` (pagos).
 * Filtragem por data de coleta (pay_before) é feita no bot.service.ts.
 * Removido filtro shipping.status=ready_to_ship que não retorna nada para pedidos Full.
 */
export async function searchRecentPaidOrders(daysBack: number = 30, maxPages: number = 60): Promise<MLOrderSummary[]> {
  const t = loadTokens();
  if (!t) throw new Error('ML não conectado');

  const now = new Date();
  const past = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const fromIso = past.toISOString();
  const toIso = now.toISOString();

  const all: MLOrderSummary[] = [];
  const seen = new Set<number>();

  let offset = 0;
  const limit = 50;
  for (let page = 0; page < maxPages; page++) {
    try {
      const data = await mlGet('/orders/search', {
        seller: String(t.user_id),
        'order.date_created.from': fromIso,
        'order.date_created.to': toIso,
        'order.status': 'paid',
        sort: 'date_desc',
        offset: String(offset),
        limit: String(limit),
      });
      const results = data?.results || [];
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
      console.warn('[ML] searchRecentPaidOrders falhou na página', page, err);
      break;
    }
  }
  console.log(`[ML] searchRecentPaidOrders (${daysBack}d, paid): ${all.length} pedidos`);
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
 * Busca dados do shipment ML — extrai a data de coleta / deadline NF.
 * Usa apenas o endpoint /shipments/:id (pay_before está em shipping_option.estimated_delivery_time)
 * para reduzir consumo de rate limit.
 */
export async function getShipment(shipmentId: number): Promise<MLShipmentInfo> {
  // Cache em disco com TTL — evita reconsultar o mesmo shipment a cada execução
  const cached = readShipmentCache(shipmentId);
  if (cached) return cached;

  const data = await mlGet(`/shipments/${shipmentId}`);

  // Normaliza um valor que pode ser string direta ou objeto { date, type }
  const pickDate = (v: any): string | undefined => {
    if (!v) return undefined;
    if (typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v;
      return undefined;
    }
    if (typeof v === 'object') {
      if (v.date && typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.date)) return v.date;
      if (v.from && typeof v.from === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.from)) return v.from;
    }
    return undefined;
  };

  // pay_before do shipping_option é o que o painel ML usa para "Coleta | Hoje/Amanhã"
  const payBeforeShip = data?.shipping_option?.estimated_delivery_time?.pay_before;
  const candidates: Array<[string, any]> = [
    ['shipping_option.estimated_delivery_time.pay_before', payBeforeShip],
    ['shipping_option.estimated_schedule_limit', data?.shipping_option?.estimated_schedule_limit],
    ['shipping_option.estimated_handling_limit', data?.shipping_option?.estimated_handling_limit],
    ['shipping_option.pickup_promise', data?.shipping_option?.pickup_promise],
    ['estimated_handling_limit', data?.estimated_handling_limit],
    ['date_handling', data?.date_handling],
  ];

  let rawDate: string | undefined;
  let rawSource: string | undefined;
  for (const [src, val] of candidates) {
    const d = pickDate(val);
    if (d) { rawDate = d; rawSource = src; break; }
  }

  let localDate: string | undefined;
  if (rawDate) {
    localDate = rawDate.slice(0, 10);
  }

  const info: MLShipmentInfo = {
    id: data?.id,
    status: data?.status,
    substatus: data?.substatus,
    estimated_handling_limit_date: localDate,
    pay_before_full: payBeforeShip,
    date_first_printed: data?.date_first_printed,
    date_handling: data?.date_handling,
    logistic_type: data?.logistic_type,
    raw_date_source: rawSource,
    raw: data,
  };
  writeShipmentCache(shipmentId, info);
  return info;
}

// ============================================================================
// Cache de shipments (TTL configurável) — reduz drasticamente chamadas à API ML
// ============================================================================
interface ShipmentCacheEntry { ts: number; info: MLShipmentInfo }
let shipmentCache: Record<string, ShipmentCacheEntry> | null = null;

function loadShipmentCache(): Record<string, ShipmentCacheEntry> {
  if (shipmentCache) return shipmentCache;
  try {
    if (fs.existsSync(config.mlShipmentCachePath)) {
      shipmentCache = JSON.parse(fs.readFileSync(config.mlShipmentCachePath, 'utf-8'));
      return shipmentCache!;
    }
  } catch (err) {
    console.warn('[ML] Falha ao ler cache de shipments:', err);
  }
  shipmentCache = {};
  return shipmentCache;
}

function persistShipmentCache(): void {
  if (!shipmentCache) return;
  try {
    fs.writeFileSync(config.mlShipmentCachePath, JSON.stringify(shipmentCache), 'utf-8');
  } catch (err) {
    console.warn('[ML] Falha ao salvar cache de shipments:', err);
  }
}

function readShipmentCache(id: number): MLShipmentInfo | null {
  const cache = loadShipmentCache();
  const entry = cache[String(id)];
  if (!entry) return null;
  if (Date.now() - entry.ts > config.mlShipmentCacheTtlMs) return null;
  return entry.info;
}

function writeShipmentCache(id: number, info: MLShipmentInfo): void {
  const cache = loadShipmentCache();
  cache[String(id)] = { ts: Date.now(), info };
  // Persiste IMEDIATAMENTE — cota do ML é tão escassa que cada chamada bem sucedida vale ouro
  persistShipmentCache();
}

export function flushShipmentCache(): void {
  persistShipmentCache();
}

export function isShipmentCached(id: number): boolean {
  return readShipmentCache(id) !== null;
}

/**
 * Usado para debug: retorna uma amostra de shipments com todos os campos relevantes
 */
export async function debugSampleShipments(limit: number = 10): Promise<any[]> {
  const orders = await searchRecentPaidOrders(7);
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

// === Shipping Labels ===

/**
 * Lista pedidos ML com shipments prontos para impressão de etiqueta.
 * Busca pedidos pagos dos últimos N dias e filtra os que têm shipment com status ready_to_ship.
 */
export interface LabelOrderInfo {
  orderId: number;
  shipmentId: number;
  totalAmount: number;
  dateClosed: string;
  cachedStatus?: string;    // status do cache se disponível
  cachedSubstatus?: string;
}

export interface LabelsResult {
  orders: LabelOrderInfo[];
  totalPaidOrders: number;
}

/**
 * Busca pedidos recentes sem filtrar por status (pega paid, confirmed, etc.).
 * Para labels, precisamos de todos os pedidos com shipping_id,
 * pois order.status=paid pode não capturar todos os que têm etiqueta.
 */
async function searchRecentOrdersAllStatuses(daysBack: number, maxPages: number = 5): Promise<MLOrderSummary[]> {
  const t = loadTokens();
  if (!t) throw new Error('ML não conectado');

  const now = new Date();
  const past = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const all: MLOrderSummary[] = [];
  const seen = new Set<number>();

  let offset = 0;
  const limit = 50;
  for (let page = 0; page < maxPages; page++) {
    try {
      const data = await mlGet('/orders/search', {
        seller: String(t.user_id),
        'order.date_created.from': past.toISOString(),
        'order.date_created.to': now.toISOString(),
        sort: 'date_desc',
        offset: String(offset),
        limit: String(limit),
      });
      const results = data?.results || [];
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
      console.warn('[ML] searchRecentOrdersAllStatuses falhou na página', page, err);
      break;
    }
  }
  console.log(`[ML] searchRecentOrdersAllStatuses (${daysBack}d): ${all.length} pedidos`);
  return all;
}

/**
 * Lista pedidos com shipping_id para download de etiquetas.
 * NÃO faz chamadas individuais a /shipments/{id} — usa apenas cache local.
 * Busca sem filtro de status para capturar TODOS os pedidos com envio.
 */
export async function getOrdersReadyForLabels(daysBack: number = 7): Promise<LabelsResult> {
  const safeDays = Math.min(daysBack, 7);
  const orders = await searchRecentOrdersAllStatuses(safeDays, 5);
  const results: LabelOrderInfo[] = [];

  // Status de pedido que não fazem sentido para etiquetas
  const skipOrderStatuses = ['cancelled', 'invalid'];

  for (const o of orders) {
    if (!o.shipping_id) continue;
    if (skipOrderStatuses.includes(o.status)) continue;

    // Usa cache se disponível para mostrar status, mas NÃO faz novas chamadas à API
    const cached = readShipmentCache(o.shipping_id);

    // Se temos cache e o status é terminal (já enviado/entregue), pula
    if (cached) {
      const terminalStatuses = ['shipped', 'delivered', 'not_delivered', 'cancelled'];
      if (terminalStatuses.includes(cached.status || '')) continue;
    }

    results.push({
      orderId: o.id,
      shipmentId: o.shipping_id,
      totalAmount: o.total_amount,
      dateClosed: o.date_closed,
      cachedStatus: cached?.status,
      cachedSubstatus: cached?.substatus,
    });
  }

  console.log(`[ML] ${results.length} pedidos com envio pendente (de ${orders.length} total, ${safeDays} dias)`);
  return {
    orders: results,
    totalPaidOrders: orders.length,
  };
}

/**
 * Faz uma única chamada a /shipment_labels com os IDs fornecidos.
 * Retorna { pdf } se sucesso, ou { failedIds, errorDetails } se falhou.
 */
async function tryShipmentLabels(ids: number[]): Promise<{
  pdf?: Buffer;
  failedIds?: number[];
  errorDetails?: Array<{ shipment_id: number; message: string; error_code: string }>;
  error?: string;
}> {
  const token = await getValidAccessToken();
  const url = `${ML_API_URL}/shipment_labels?shipment_ids=${ids.join(',')}&response_type=pdf`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/pdf',
    },
  });

  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/pdf')) {
    const arrayBuffer = await res.arrayBuffer();
    return { pdf: Buffer.from(arrayBuffer) };
  }

  // Resposta de erro — parsear failed_shipments
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (json.failed_shipments && Array.isArray(json.failed_shipments)) {
      const failedIds = json.failed_shipments.map((f: any) => parseInt(String(f.shipment_id), 10));
      const errorDetails = json.failed_shipments.map((f: any) => ({
        shipment_id: parseInt(String(f.shipment_id), 10),
        message: f.message || '',
        error_code: f.error_code || '',
      }));
      return { failedIds, errorDetails };
    }
    // Erro genérico (ex: "Shipment Id X: message")
    const errMsg = json.error || json.message || text.slice(0, 300);
    // Tentar extrair shipment_id do erro genérico: "Shipment Id 12345: ..."
    const match = errMsg.match(/Shipment Id (\d+)/i);
    if (match) {
      const failedId = parseInt(match[1], 10);
      return {
        failedIds: [failedId],
        errorDetails: [{ shipment_id: failedId, message: errMsg, error_code: 'unknown' }],
      };
    }
    return { error: errMsg };
  } catch {
    return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
}

/**
 * Baixa etiquetas em lote via /shipment_labels.
 * Estratégia: tenta batch → parseia erros → remove IDs que falharam → retry.
 * Máximo 3 tentativas para convergir para os IDs válidos.
 */
export async function downloadShippingLabelsBatch(
  shipmentIds: number[]
): Promise<{
  success: boolean;
  pdf?: Buffer;
  count?: number;
  failedIds?: number[];
  failedDetails?: Array<{ shipment_id: number; message: string; error_code: string }>;
  error?: string;
}> {
  if (!shipmentIds || shipmentIds.length === 0) {
    return { success: false, error: 'Nenhum shipment_id fornecido' };
  }

  const BATCH_SIZE = 50;
  const allPdfs: Buffer[] = [];
  const allFailed: number[] = [];
  const allFailedDetails: Array<{ shipment_id: number; message: string; error_code: string }> = [];
  let totalSuccess = 0;

  // Dividir em lotes de 50
  const batches: number[][] = [];
  for (let i = 0; i < shipmentIds.length; i += BATCH_SIZE) {
    batches.push(shipmentIds.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    let remaining = [...batch];
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES && remaining.length > 0; attempt++) {
      console.log(`[ML] shipment_labels: tentativa ${attempt + 1} com ${remaining.length} IDs...`);

      try {
        const result = await tryShipmentLabels(remaining);

        if (result.pdf) {
          // Batch inteiro deu certo
          allPdfs.push(result.pdf);
          totalSuccess += remaining.length;
          console.log(`[ML] shipment_labels: ${remaining.length} etiquetas OK`);
          remaining = [];
          break;
        }

        if (result.failedIds && result.failedIds.length > 0) {
          // Remover os que falharam e tentar novamente com os restantes
          const failedSet = new Set(result.failedIds);
          for (const detail of (result.errorDetails || [])) {
            if (!allFailedDetails.some(d => d.shipment_id === detail.shipment_id)) {
              allFailedDetails.push(detail);
              console.warn(`[ML] Etiqueta indisponível: shipment ${detail.shipment_id} — ${detail.error_code}: ${detail.message.slice(0, 100)}`);
            }
          }
          allFailed.push(...result.failedIds.filter(id => !allFailed.includes(id)));
          remaining = remaining.filter(id => !failedSet.has(id));

          if (remaining.length === 0) {
            console.warn(`[ML] Todos os ${batch.length} IDs falharam neste lote`);
            break;
          }
          console.log(`[ML] ${result.failedIds.length} falharam, tentando ${remaining.length} restantes...`);
          continue;
        }

        // Erro genérico sem failed_shipments identificáveis
        console.warn(`[ML] shipment_labels erro genérico: ${result.error}`);
        allFailed.push(...remaining);
        remaining = [];
        break;
      } catch (err: any) {
        console.warn(`[ML] shipment_labels exceção: ${err.message}`);
        allFailed.push(...remaining);
        remaining = [];
        break;
      }
    }

    // Se sobrou algum remaining após MAX_RETRIES, marca como falho
    if (remaining.length > 0) {
      allFailed.push(...remaining);
    }
  }

  if (allPdfs.length === 0) {
    // Montar mensagem de erro descritiva
    const reasons = allFailedDetails.reduce((acc, d) => {
      const code = d.error_code || 'unknown';
      acc[code] = (acc[code] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const reasonStr = Object.entries(reasons).map(([code, n]) => `${code}: ${n}`).join(', ');
    return {
      success: false,
      failedIds: allFailed,
      failedDetails: allFailedDetails,
      error: `Nenhuma etiqueta disponível (${allFailed.length} falharam${reasonStr ? ' — ' + reasonStr : ''})`,
    };
  }

  const finalPdf = allPdfs.length === 1 ? allPdfs[0] : Buffer.concat(allPdfs);
  return {
    success: true,
    pdf: finalPdf,
    count: totalSuccess,
    failedIds: allFailed.length > 0 ? allFailed : undefined,
    failedDetails: allFailedDetails.length > 0 ? allFailedDetails : undefined,
  };
}

/**
 * Baixa etiqueta(s) de envio do Mercado Livre em formato PDF.
 * Aceita até 50 shipment IDs por chamada (limite da API ML).
 * Retorna o PDF buffer ou erro.
 */
export async function downloadShippingLabels(shipmentIds: number[]): Promise<{ success: boolean; pdf?: Buffer; error?: string }> {
  if (!shipmentIds || shipmentIds.length === 0) {
    return { success: false, error: 'Nenhum shipment_id fornecido' };
  }
  if (shipmentIds.length > 50) {
    return { success: false, error: `Máximo 50 etiquetas por vez (recebido: ${shipmentIds.length})` };
  }

  try {
    const token = await getValidAccessToken();
    const ids = shipmentIds.join(',');
    const url = `${ML_API_URL}/shipment_labels?shipment_ids=${ids}&response_type=pdf`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/pdf',
      },
    });

    const contentType = res.headers.get('content-type') || '';
    console.log(`[ML] shipment_labels: status=${res.status} content-type=${contentType} ids=${ids}`);

    if (contentType.includes('application/pdf')) {
      const arrayBuffer = await res.arrayBuffer();
      return { success: true, pdf: Buffer.from(arrayBuffer) };
    }

    // Error response (JSON)
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return { success: false, error: `${json.error || json.message || 'unknown'}: ${json.cause?.[0]?.message || text.slice(0, 200)}` };
    } catch {
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Baixa etiqueta de um único pedido ML pelo order_id.
 * Busca o shipment_id do pedido e baixa a etiqueta.
 */
export async function downloadLabelByOrderId(orderId: number): Promise<{ success: boolean; pdf?: Buffer; shipmentId?: number; error?: string }> {
  try {
    // Busca dados do pedido para pegar o shipping_id
    const orderData = await mlGet(`/orders/${orderId}`);
    const shipmentId = orderData?.shipping?.id;
    if (!shipmentId) {
      return { success: false, error: 'Pedido sem shipment_id' };
    }

    const result = await downloadShippingLabels([shipmentId]);
    return { ...result, shipmentId };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

export function disconnect(): void {
  cachedTokens = null;
  try {
    if (fs.existsSync(config.mlTokenStorePath)) fs.unlinkSync(config.mlTokenStorePath);
  } catch {}
}
