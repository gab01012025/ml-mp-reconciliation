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
    return await res.json() as ShopeeApiResponse;
  } catch (err: any) {
    return { error: 'fetch_error', message: err.message || String(err) };
  }
}

// === Public API: Add Invoice Data (BR local seller) ===
export async function setInvoiceInfo(
  orderSn: string,
  invoiceNumber: string,
  invoiceSerialNumber: string,
  invoiceAccessKey: string,
  extraFields?: {
    issueDate?: number;      // Unix timestamp
    totalValue?: number;
    productsTotalValue?: number;
    taxCode?: string;
  }
): Promise<{ success: boolean; error?: string }> {
  console.log(`[SHOPEE] Enviando NF para pedido ${orderSn}: numero=${invoiceNumber} serie=${invoiceSerialNumber} chave=${invoiceAccessKey.slice(0, 10)}...`);

  const invoiceData: Record<string, any> = {
    number: invoiceNumber,
    series_number: invoiceSerialNumber,
    access_key: invoiceAccessKey,
  };

  if (extraFields?.issueDate) invoiceData.issue_date = extraFields.issueDate;
  if (extraFields?.totalValue != null) invoiceData.total_value = extraFields.totalValue;
  if (extraFields?.productsTotalValue != null) invoiceData.products_total_value = extraFields.productsTotalValue;
  if (extraFields?.taxCode) invoiceData.tax_code = extraFields.taxCode;

  const result = await shopeeApiCall('/api/v2/order/add_invoice_data', {
    order_sn: orderSn,
    invoice_data: invoiceData,
  });

  if (result.error) {
    console.error(`[SHOPEE] Falha ao enviar NF para ${orderSn}:`, result);
    return { success: false, error: `${result.error}: ${result.message || ''}` };
  }

  console.log(`[SHOPEE] NF enviada com sucesso para pedido ${orderSn}`);
  return { success: true };
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
