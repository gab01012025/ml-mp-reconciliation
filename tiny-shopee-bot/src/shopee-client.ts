/**
 * Shopee Open Platform API v2 Client
 * Handles authentication, token refresh, and invoice submission.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { config } from './config';

// === Types ===
interface ShopeeTokens {
  shop_id: string;
  access_token: string;
  refresh_token: string;
  expire_in: number;
  obtained_at: string;
}

interface ShopeeApiResponse {
  error?: string;
  message?: string;
  request_id?: string;
  response?: any;
}

// === Constants ===
const BASE_URL = 'https://partner.shopeemobile.com';
const PARTNER_ID = config.shopeePartnerId;
const PARTNER_KEY = config.shopeePartnerKey;
const SHOP_ID = config.shopeeShopId;
const TOKEN_PATH = config.shopeeTokenStorePath;

// === In-memory token state ===
let currentTokens: ShopeeTokens | null = null;

// === Sign generation ===
function generateSign(path: string, timestamp: number, accessToken?: string, shopId?: string | number): string {
  let baseString = `${PARTNER_ID}${path}${timestamp}`;
  if (accessToken) baseString += accessToken;
  if (shopId) baseString += shopId;
  return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
}

// === Token persistence ===
function loadTokens(): ShopeeTokens | null {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      currentTokens = data;
      return data;
    }
  } catch (err) {
    console.error('[SHOPEE] Erro ao carregar tokens:', err);
  }
  return null;
}

function saveTokens(tokens: ShopeeTokens): void {
  currentTokens = tokens;
  try {
    const dir = TOKEN_PATH.substring(0, TOKEN_PATH.lastIndexOf('/'));
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log(`[SHOPEE] Tokens salvos em ${TOKEN_PATH}`);
  } catch (err) {
    console.error('[SHOPEE] Erro ao salvar tokens:', err);
  }
}

// === Token refresh ===
async function refreshAccessToken(): Promise<boolean> {
  const tokens = currentTokens || loadTokens();
  if (!tokens?.refresh_token) {
    console.error('[SHOPEE] Sem refresh_token disponível. Re-autorização necessária.');
    return false;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/auth/access_token/get';
  const sign = generateSign(path, timestamp);

  const url = `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;
  const body = JSON.stringify({
    refresh_token: tokens.refresh_token,
    shop_id: Number(tokens.shop_id || SHOP_ID),
    partner_id: Number(PARTNER_ID),
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json() as any;

    if (data.error) {
      console.error('[SHOPEE] Refresh token falhou:', data);
      return false;
    }

    const newTokens: ShopeeTokens = {
      shop_id: tokens.shop_id || String(SHOP_ID),
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expire_in: data.expire_in,
      obtained_at: new Date().toISOString(),
    };
    saveTokens(newTokens);
    console.log(`[SHOPEE] Token refreshed com sucesso. Expira em ${data.expire_in}s`);
    return true;
  } catch (err) {
    console.error('[SHOPEE] Erro no refresh:', err);
    return false;
  }
}

// === Ensure valid token ===
async function ensureValidToken(): Promise<string | null> {
  let tokens = currentTokens || loadTokens();
  if (!tokens) {
    console.error('[SHOPEE] Nenhum token encontrado. Execute a autorização primeiro.');
    return null;
  }

  // Check if token is expired (with 5 min buffer)
  const obtainedAt = new Date(tokens.obtained_at).getTime();
  const expiresAt = obtainedAt + (tokens.expire_in * 1000);
  const now = Date.now();

  if (now >= expiresAt - 300_000) {
    console.log('[SHOPEE] Token expirado ou prestes a expirar, fazendo refresh...');
    const refreshed = await refreshAccessToken();
    if (!refreshed) return null;
    tokens = currentTokens;
  }

  return tokens?.access_token || null;
}

// === API call helper ===
async function shopeeApiCall(path: string, body: Record<string, any>): Promise<ShopeeApiResponse> {
  const accessToken = await ensureValidToken();
  if (!accessToken) {
    return { error: 'no_token', message: 'Token não disponível. Re-autorize a loja.' };
  }

  const shopId = currentTokens?.shop_id || String(SHOP_ID);
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp, accessToken, shopId);

  const url = `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&access_token=${accessToken}&shop_id=${shopId}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const rawText = await res.text();
    try {
      return JSON.parse(rawText) as ShopeeApiResponse;
    } catch {
      return { error: 'parse_error', message: `Status ${res.status}: ${rawText.slice(0, 200)}` };
    }
  } catch (err: any) {
    return { error: 'fetch_error', message: err.message || String(err) };
  }
}

// === Shopee API GET helper (para endpoints que usam GET, como get_order_detail) ===
async function shopeeApiGet(path: string, params: Record<string, string>): Promise<ShopeeApiResponse> {
  const accessToken = await ensureValidToken();
  if (!accessToken) {
    return { error: 'no_token', message: 'Token não disponível. Re-autorize a loja.' };
  }

  const shopId = currentTokens?.shop_id || String(SHOP_ID);
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp, accessToken, shopId);

  const queryParams = new URLSearchParams({
    partner_id: String(PARTNER_ID),
    timestamp: String(timestamp),
    sign,
    access_token: accessToken,
    shop_id: shopId,
    ...params,
  });

  const url = `${BASE_URL}${path}?${queryParams.toString()}`;

  try {
    const res = await fetch(url, { method: 'GET' });
    const rawText = await res.text();
    try {
      return JSON.parse(rawText) as ShopeeApiResponse;
    } catch {
      return { error: 'parse_error', message: `Status ${res.status}: ${rawText.slice(0, 200)}` };
    }
  } catch (err: any) {
    return { error: 'fetch_error', message: err.message || String(err) };
  }
}

// === Public API: Check if order already has invoice on Shopee ===
export async function checkOrderInvoice(orderSn: string): Promise<{ hasInvoice: boolean; orderStatus?: string; error?: string }> {
  try {
    const result = await shopeeApiGet('/api/v2/order/get_order_detail', {
      order_sn_list: orderSn,
      response_optional_fields: 'order_status,invoice_data',
    });

    const orderInfo = result.response?.order_list?.[0];
    if (!orderInfo) {
      console.log(`[SHOPEE] Pedido ${orderSn}: sem dados (${result.error || 'N/A'})`);
      return { hasInvoice: false, error: result.error || undefined };
    }

    const status = orderInfo.order_status || 'UNKNOWN';
    const invoiceData = orderInfo.invoice_data;
    const hasInvoice = !!(invoiceData && (invoiceData.number || invoiceData.invoice_number || invoiceData.access_key));

    if (hasInvoice) {
      console.log(`[SHOPEE] Pedido ${orderSn}: status=${status} já tem invoice (NF ${invoiceData.number || 'N/A'})`);
    }
    return { hasInvoice, orderStatus: status };
  } catch (err: any) {
    console.warn(`[SHOPEE] Falha ao verificar pedido ${orderSn}:`, err);
    return { hasInvoice: false, error: err.message };
  }
}

// === Public API: Download Invoice Doc (verifica se existe) ===
export async function downloadInvoiceDoc(orderSn: string): Promise<{ exists: boolean }> {
  try {
    const result = await shopeeApiGet('/api/v2/order/download_invoice_doc', {
      order_sn: orderSn,
    });
    // Se retornou sem erro, a invoice existe
    if (!result.error) {
      return { exists: true };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

// === Public API: Upload Invoice Doc (BR seller — multipart file upload) ===
export async function uploadInvoiceDoc(
  orderSn: string,
  xmlContent: string,
): Promise<{ success: boolean; error?: string }> {
  // Garante que o XML tem declaração <?xml?> no início (Shopee pode exigir)
  let xml = xmlContent;
  if (!xml.startsWith('<?xml')) {
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
  }

  // Verifica se o pedido já tem invoice na Shopee (para evitar "File error" em duplicatas)
  const invoiceCheck = await checkOrderInvoice(orderSn);
  if (invoiceCheck.hasInvoice) {
    console.log(`[SHOPEE] Pedido ${orderSn} já tem invoice na Shopee — pulando upload`);
    return { success: true }; // Considera sucesso (já foi enviada antes)
  }

  console.log(`[SHOPEE] Enviando XML NF para pedido ${orderSn} (${xml.length} bytes) status=${invoiceCheck.orderStatus || 'N/A'}`);

  const accessToken = await ensureValidToken();
  if (!accessToken) {
    return { success: false, error: 'no_token: Token não disponível. Re-autorize a loja.' };
  }

  const shopId = currentTokens?.shop_id || String(SHOP_ID);
  const path = '/api/v2/order/upload_invoice_doc';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp, accessToken, shopId);

  const url = `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&access_token=${accessToken}&shop_id=${shopId}`;

  // Constrói multipart/form-data com Buffer
  const boundary = '----ShopeeUpload' + Date.now();
  const CRLF = '\r\n';
  const xmlBuffer = Buffer.from(xml, 'utf-8');

  const parts: Buffer[] = [];

  // order_sn
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="order_sn"${CRLF}${CRLF}` +
    `${orderSn}${CRLF}`
  ));

  // file_type (1 = XML)
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file_type"${CRLF}${CRLF}` +
    `1${CRLF}`
  ));

  // file (XML content)
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="nfe_${orderSn}.xml"${CRLF}` +
    `Content-Type: text/xml${CRLF}${CRLF}`
  ));
  parts.push(xmlBuffer);
  parts.push(Buffer.from(`${CRLF}`));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));

  const body = Buffer.concat(parts);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
    const rawText = await res.text();

    let result: ShopeeApiResponse;
    try {
      result = JSON.parse(rawText) as ShopeeApiResponse;
    } catch {
      return { success: false, error: `parse_error: Status ${res.status}: ${rawText.slice(0, 200)}` };
    }

    if (result.error) {
      console.error(`[SHOPEE] Falha ao enviar NF para ${orderSn}: ${result.error} — ${result.message || ''}`);
      return { success: false, error: `${result.error}: ${result.message || ''}` };
    }

    console.log(`[SHOPEE] NF XML enviada com sucesso para pedido ${orderSn}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: `fetch_error: ${err.message || String(err)}` };
  }
}

// === Compat wrapper: setInvoiceInfo now uses uploadInvoiceDoc when XML is provided ===
export async function setInvoiceInfo(
  orderSn: string,
  _invoiceNumber: string,
  _invoiceSerialNumber: string,
  _invoiceAccessKey: string,
  _extraFields?: any,
  xmlContent?: string,
): Promise<{ success: boolean; error?: string }> {
  if (xmlContent) {
    return uploadInvoiceDoc(orderSn, xmlContent);
  }
  // Fallback: try JSON endpoint (for backwards compat, though it returns 403 on BR)
  console.warn(`[SHOPEE] Sem XML para pedido ${orderSn}, tentando upload sem XML...`);
  return { success: false, error: 'no_xml: XML da NF-e é obrigatório para upload_invoice_doc' };
}

// === Public API: Get connection info ===
export function getConnectionInfo(): { connected: boolean; shopId: string | null; expiresAt: string | null } {
  const tokens = currentTokens || loadTokens();
  if (!tokens?.access_token) {
    return { connected: false, shopId: null, expiresAt: null };
  }
  const obtainedAt = new Date(tokens.obtained_at).getTime();
  const expiresAt = new Date(obtainedAt + tokens.expire_in * 1000).toISOString();
  return { connected: true, shopId: tokens.shop_id, expiresAt };
}

// === Public API: Check if connected ===
export function isConnected(): boolean {
  const tokens = currentTokens || loadTokens();
  return !!(tokens?.access_token && tokens?.refresh_token);
}

// === Public API: Reload tokens from disk (call after callback writes new tokens) ===
export function reloadTokens(): void {
  currentTokens = null;
  const loaded = loadTokens();
  if (loaded) {
    console.log(`[SHOPEE] Tokens recarregados — shop_id=${loaded.shop_id}`);
  }
}

// === Public API: Manual refresh ===
export async function forceRefresh(): Promise<boolean> {
  return refreshAccessToken();
}

// === Initialize: load tokens on startup ===
const initialTokens = loadTokens();
if (initialTokens) {
  console.log(`[SHOPEE] Tokens carregados — shop_id=${initialTokens.shop_id}`);
} else {
  console.log('[SHOPEE] Nenhum token encontrado. Aguardando autorização via /shopee/callback.');
}
