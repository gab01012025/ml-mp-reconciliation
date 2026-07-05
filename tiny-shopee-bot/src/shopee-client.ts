/**
 * Shopee Open Platform API v2 Client
 * Handles authentication, token refresh, and invoice submission.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { config } from './config';

// Node.js 20+ globals (disponíveis em runtime mas não no @types/node antigo)
/* eslint-disable @typescript-eslint/no-explicit-any */
const _FormData = (globalThis as any).FormData;
const _File = (globalThis as any).File;

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

// === Public API: Get order details with items and recipient ===
export interface OrderItemInfo {
  item_id: number;
  item_name: string;
  item_sku: string;
  model_name: string;
  model_sku: string;
  quantity: number;
  price: number;
}

export interface OrderDetailInfo {
  order_sn: string;
  order_status: string;
  buyer_username: string;
  recipient_name: string;
  recipient_phone: string;
  total_amount: number;
  items: OrderItemInfo[];
  has_invoice: boolean;
}

/**
 * Busca detalhes dos pedidos Shopee (itens, destinatário, etc.)
 * Aceita até 50 order_sn por chamada.
 */
export async function getOrdersDetail(orderSns: string[]): Promise<OrderDetailInfo[]> {
  if (!orderSns || orderSns.length === 0) return [];

  const results: OrderDetailInfo[] = [];
  // API aceita até 50 por vez
  const BATCH = 50;
  for (let i = 0; i < orderSns.length; i += BATCH) {
    const batch = orderSns.slice(i, i + BATCH);
    try {
      const result = await shopeeApiGet('/api/v2/order/get_order_detail', {
        order_sn_list: batch.join(','),
        response_optional_fields: 'order_status,item_list,buyer_username,recipient_address,total_amount,invoice_data',
      });

      const orders = result.response?.order_list || [];
      for (const o of orders) {
        const items: OrderItemInfo[] = (o.item_list || []).map((it: any) => ({
          item_id: it.item_id,
          item_name: it.item_name || '',
          item_sku: it.item_sku || '',
          model_name: it.model_name || '',
          model_sku: it.model_sku || '',
          quantity: it.model_quantity_purchased || 1,
          price: it.model_discounted_price || it.model_original_price || 0,
        }));

        // Verifica se o pedido já tem NF enviada (invoice_data preenchido)
        const inv = o.invoice_data;
        const hasInvoice = !!(inv && (inv.number || inv.access_key));

        results.push({
          order_sn: o.order_sn,
          order_status: o.order_status || '',
          buyer_username: o.buyer_username || '',
          recipient_name: o.recipient_address?.name || '',
          recipient_phone: o.recipient_address?.phone || '',
          total_amount: o.total_amount || 0,
          items,
          has_invoice: hasInvoice,
        });
      }
    } catch (err: any) {
      console.warn(`[SHOPEE] getOrdersDetail batch falhou:`, err.message || err);
    }
  }
  return results;
}

// === Helper: extract NF-e metadata from XML ===
function extractNFeData(xml: string): { chaveAcesso?: string; numero?: string; serie?: string } {
  const chMatch = xml.match(/<chNFe>(\d{44})<\/chNFe>/);
  const numMatch = xml.match(/<nNF>(\d+)<\/nNF>/);
  const serMatch = xml.match(/<serie>(\d+)<\/serie>/);
  return {
    chaveAcesso: chMatch?.[1],
    numero: numMatch?.[1],
    serie: serMatch?.[1],
  };
}

// === Helper: tenta uma variação de upload_invoice_doc ===
async function tryUpload(
  url: string,
  orderSn: string,
  xmlBuffer: Buffer,
  mimeType: string,
  filename: string,
  label: string,
): Promise<ShopeeApiResponse> {
  // Usa Blob em vez de File para melhor compatibilidade com Node.js fetch
  const formData = new _FormData();
  formData.append('order_sn', orderSn);
  formData.append('file_type', '1');
  const blob = new Blob([xmlBuffer], { type: mimeType });
  formData.append('file', blob, filename);

  const res = await fetch(url, { method: 'POST', body: formData as any });
  const rawText = await res.text();
  console.log(`[SHOPEE] ${label} response (${res.status}): ${rawText.slice(0, 300)}`);
  try {
    return JSON.parse(rawText) as ShopeeApiResponse;
  } catch {
    return { error: 'parse_error', message: `Status ${res.status}: ${rawText.slice(0, 200)}` };
  }
}

// === Helper: upload via multipart boundary manual (fallback robusto) ===
async function tryUploadManual(
  url: string,
  orderSn: string,
  xmlBuffer: Buffer,
  label: string,
): Promise<ShopeeApiResponse> {
  const boundary = '----ShopeeUpload' + Date.now();
  const parts: Buffer[] = [];

  // order_sn field
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="order_sn"\r\n\r\n${orderSn}\r\n`));
  // file_type field
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\n1\r\n`));
  // file field
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${orderSn}.xml"\r\nContent-Type: application/xml\r\n\r\n`));
  parts.push(xmlBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const rawText = await res.text();
  console.log(`[SHOPEE] ${label} response (${res.status}): ${rawText.slice(0, 300)}`);
  try {
    return JSON.parse(rawText) as ShopeeApiResponse;
  } catch {
    return { error: 'parse_error', message: `Status ${res.status}: ${rawText.slice(0, 200)}` };
  }
}

// === Public API: Upload Invoice Doc (BR seller — multipart file upload) ===
export async function uploadInvoiceDoc(
  orderSn: string,
  xmlContent: string,
): Promise<{ success: boolean; error?: string }> {
  // Remove BOM (UTF-8 Byte Order Mark) se presente
  let xml = xmlContent;
  if (xml.charCodeAt(0) === 0xFEFF) {
    xml = xml.slice(1);
  }
  xml = xml.trimStart();

  // Verifica se o pedido já tem invoice na Shopee (para evitar "File error" em duplicatas)
  const invoiceCheck = await checkOrderInvoice(orderSn);
  if (invoiceCheck.hasInvoice) {
    console.log(`[SHOPEE] Pedido ${orderSn} já tem invoice na Shopee — pulando upload`);
    return { success: true };
  }

  // Verifica status do pedido — Shopee só aceita NF em status específicos
  const orderStatus = invoiceCheck.orderStatus;
  const UPLOAD_ALLOWED_STATUSES = ['READY_TO_SHIP', 'PROCESSED', 'RETRY'];
  if (orderStatus && !UPLOAD_ALLOWED_STATUSES.includes(orderStatus)) {
    const msg = `Pedido "${orderSn}" está no status "${orderStatus}" na Shopee. ` +
      `Upload de NF só é aceito nos status: ${UPLOAD_ALLOWED_STATUSES.join(', ')}. ` +
      `Aguarde o pedido mudar para "Ready to Ship" ou verifique na Shopee.`;
    console.warn(`[SHOPEE] ${msg}`);
    return { success: false, error: `status_invalido: ${msg}` };
  }

  // Diagnóstico: extrai dados da NF do XML
  const nfeData = extractNFeData(xml);
  console.log(`[SHOPEE] NF-e dados: chave=${nfeData.chaveAcesso || 'N/A'} num=${nfeData.numero || 'N/A'} serie=${nfeData.serie || 'N/A'}`);
  console.log(`[SHOPEE] Enviando NF para pedido ${orderSn} (${xml.length} bytes XML) status=${invoiceCheck.orderStatus || 'N/A'}`);

  // === Estratégia: add_invoice_data (JSON) primeiro, upload de arquivo como fallback ===
  // O add_invoice_data é mais confiável pois envia apenas os dados estruturados da NF
  // sem depender do upload de arquivo XML (que falha com "File error" frequentemente).

  // Tentativa 1: add_invoice_data (dados estruturados via JSON — mais confiável)
  if (nfeData.chaveAcesso && nfeData.numero && nfeData.serie) {
    console.log(`[SHOPEE] Tentativa 1: add_invoice_data (JSON) — num=${nfeData.numero} serie=${nfeData.serie} chave=...${nfeData.chaveAcesso.slice(-8)}`);
    const jsonResult = await addInvoiceData(orderSn, nfeData.numero, nfeData.serie, nfeData.chaveAcesso);
    if (jsonResult.success) {
      console.log(`[SHOPEE] NF registrada com sucesso via add_invoice_data (JSON)`);
      return { success: true };
    }
    console.warn(`[SHOPEE] add_invoice_data falhou: ${jsonResult.error}`);
  } else {
    console.warn(`[SHOPEE] Dados NF incompletos no XML — chave=${!!nfeData.chaveAcesso} num=${!!nfeData.numero} serie=${!!nfeData.serie}`);
  }

  // Tentativa 2+: upload de arquivo XML (fallback)
  const accessToken = await ensureValidToken();
  if (!accessToken) {
    return { success: false, error: 'no_token: Token não disponível. Re-autorize a loja.' };
  }

  const shopId = currentTokens?.shop_id || String(SHOP_ID);

  function buildUrl(): string {
    const ts = Math.floor(Date.now() / 1000);
    const path = '/api/v2/order/upload_invoice_doc';
    const sign = generateSign(path, ts, accessToken!, shopId);
    return `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${ts}&sign=${sign}&access_token=${accessToken}&shop_id=${shopId}`;
  }

  // Tentativa 2: File + text/xml
  const rawBuf = Buffer.from(xml, 'utf-8');
  console.log(`[SHOPEE] Tentativa 2: upload_invoice_doc text/xml (${rawBuf.length} bytes)`);
  let result = await tryUpload(buildUrl(), orderSn, rawBuf, 'text/xml', `${orderSn}.xml`, 'tentativa2');
  if (!result.error) {
    console.log(`[SHOPEE] NF enviada via upload de arquivo (text/xml)`);
    return { success: true };
  }
  console.warn(`[SHOPEE] Upload text/xml falhou: ${result.error} — ${result.message || ''}`);

  // Tentativa 3: File + application/xml com declaração
  let xmlWithDecl = xml;
  if (!xml.startsWith('<?xml')) {
    xmlWithDecl = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
  }
  const declBuf = Buffer.from(xmlWithDecl, 'utf-8');
  console.log(`[SHOPEE] Tentativa 3: upload_invoice_doc application/xml (${declBuf.length} bytes)`);
  result = await tryUpload(buildUrl(), orderSn, declBuf, 'application/xml', `nfe_${orderSn}.xml`, 'tentativa3');
  if (!result.error) {
    console.log(`[SHOPEE] NF enviada via upload de arquivo (application/xml)`);
    return { success: true };
  }
  console.warn(`[SHOPEE] Upload application/xml falhou: ${result.error} — ${result.message || ''}`);

  // Tentativa 4: multipart manual (boundary construído manualmente)
  console.log(`[SHOPEE] Tentativa 4: upload manual multipart (${rawBuf.length} bytes)`);
  result = await tryUploadManual(buildUrl(), orderSn, rawBuf, 'tentativa4');
  if (!result.error) {
    console.log(`[SHOPEE] NF enviada via upload manual multipart`);
    return { success: true };
  }
  console.warn(`[SHOPEE] Upload manual falhou: ${result.error} — ${result.message || ''}`);

  return { success: false, error: `${result.error}: ${result.message || ''}` };
}

// === Fallback: Add Invoice Data via JSON endpoint ===
async function addInvoiceData(
  orderSn: string,
  invoiceNumber: string,
  invoiceSerialNumber: string,
  invoiceAccessKey: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await shopeeApiCall('/api/v2/order/add_invoice_data', {
    order_sn: orderSn,
    invoice_number: invoiceNumber,
    invoice_serial_number: invoiceSerialNumber,
    invoice_access_key: invoiceAccessKey,
  });

  console.log(`[SHOPEE] add_invoice_data response: ${JSON.stringify(result).slice(0, 300)}`);

  if (result.error) {
    return { success: false, error: `add_invoice_data: ${result.error} — ${result.message || ''}` };
  }

  console.log(`[SHOPEE] NF dados enviados com sucesso para pedido ${orderSn} via add_invoice_data`);
  return { success: true };
}

// === Compat wrapper: setInvoiceInfo ===
export async function setInvoiceInfo(
  orderSn: string,
  invoiceNumber: string,
  invoiceSerialNumber: string,
  invoiceAccessKey: string,
  _extraFields?: any,
  xmlContent?: string,
): Promise<{ success: boolean; error?: string }> {
  if (xmlContent) {
    return uploadInvoiceDoc(orderSn, xmlContent);
  }
  // Sem XML: tenta add_invoice_data com dados estruturados
  if (invoiceNumber && invoiceAccessKey) {
    return addInvoiceData(orderSn, invoiceNumber, invoiceSerialNumber || '1', invoiceAccessKey);
  }
  return { success: false, error: 'no_data: Nem XML nem dados da NF disponíveis' };
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

// === Public API: Get shipping parameter (tests logistics API access) ===
export async function getShippingParameter(orderSn: string): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const result = await shopeeApiGet('/api/v2/logistics/get_shipping_parameter', {
      order_sn: orderSn,
    });
    if (result.error) {
      return { success: false, error: `${result.error}: ${result.message || ''}` };
    }
    return { success: true, data: result.response };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// === Public API: Ship order (arranges pickup — required before creating label) ===
export async function shipOrder(orderSn: string, addressId?: number, pickupTimeId?: string): Promise<{ success: boolean; error?: string }> {
  try {
    // If no address/time provided, get shipping parameter and pick default/recommended
    if (!addressId || !pickupTimeId) {
      console.log(`[SHOPEE] ship_order: buscando parâmetros de envio para ${orderSn}...`);
      const params = await getShippingParameter(orderSn);
      if (!params.success || !params.data) {
        return { success: false, error: `Falha ao obter parâmetros: ${params.error || 'sem dados'}` };
      }

      const pickup = params.data.pickup || params.data.info_needed?.pickup;
      const addressList = params.data.pickup?.address_list;
      if (!addressList || addressList.length === 0) {
        return { success: false, error: 'Nenhum endereço de coleta disponível' };
      }

      // Pick default_address or first available
      const defaultAddr = addressList.find((a: any) =>
        a.address_flag?.includes('default_address') || a.address_flag?.includes('pickup_address')
      ) || addressList[0];

      addressId = defaultAddr.address_id;

      // Pick recommended time slot or first available
      const timeSlots = defaultAddr.time_slot_list || [];
      const recommended = timeSlots.find((t: any) => t.flags?.includes('recommended')) || timeSlots[0];
      pickupTimeId = recommended?.pickup_time_id;

      if (!pickupTimeId) {
        return { success: false, error: 'Nenhum horário de coleta disponível' };
      }

      console.log(`[SHOPEE] ship_order: usando address_id=${addressId} pickup_time_id=${pickupTimeId}`);
    }

    const result = await shopeeApiCall('/api/v2/logistics/ship_order', {
      order_sn: orderSn,
      pickup: {
        address_id: addressId,
        pickup_time_id: pickupTimeId,
      },
    });

    if (result.error) {
      return { success: false, error: `${result.error}: ${result.message || ''}` };
    }
    console.log(`[SHOPEE] ship_order: pedido ${orderSn} enviado com sucesso`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// Todos os tipos de documento de envio suportados pela Shopee
// Prioriza NORMAL (retorna PDF) antes de THERMAL (retorna ZIP com ZPL para impressora térmica)
const ALL_SHIPPING_DOC_TYPES = ['NORMAL_AIR_WAYBILL', 'NORMAL_JOB_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL', 'THERMAL_JOB_AIR_WAYBILL'];

// === Public API: Get shipping document parameter (descobre o tipo correto de documento) ===
export async function getShippingDocumentParameter(orderSn: string): Promise<{ success: boolean; suggestedType?: string; selectableTypes?: string[]; error?: string }> {
  try {
    const result = await shopeeApiCall('/api/v2/logistics/get_shipping_document_parameter', {
      order_list: [{ order_sn: orderSn }],
    });
    console.log(`[SHOPEE] get_shipping_document_parameter response: ${JSON.stringify(result).slice(0, 500)}`);
    if (result.error) {
      return { success: false, error: `${result.error}: ${result.message || ''}` };
    }
    const item = result.response?.result_list?.[0];
    if (item?.fail_error) {
      return { success: false, error: `${item.fail_error}: ${item.fail_message || ''}` };
    }
    const suggested = item?.suggest_shipping_document_type;
    const selectable = item?.selectable_shipping_document_type || [];
    console.log(`[SHOPEE] Doc type sugerido: ${suggested}, selecionáveis: ${JSON.stringify(selectable)}`);
    return { success: true, suggestedType: suggested, selectableTypes: selectable };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// === Public API: Create shipping document (step 1 of label download) ===
// Usa o tipo sugerido pela API ou tenta múltiplos tipos como fallback
export async function createShippingDocument(orderSn: string, preferredDocType?: string): Promise<{ success: boolean; docType?: string; error?: string }> {
  // Monta lista de tipos: preferred primeiro, depois fallbacks (sem duplicar)
  const fallback = ALL_SHIPPING_DOC_TYPES.filter(t => t !== preferredDocType);
  const typesToTry = preferredDocType ? [preferredDocType, ...fallback] : ALL_SHIPPING_DOC_TYPES;

  let lastError = '';
  for (const docType of typesToTry) {
    try {
      const result = await shopeeApiCall('/api/v2/logistics/create_shipping_document', {
        order_list: [{
          order_sn: orderSn,
          shipping_document_type: docType,
        }],
      });
      console.log(`[SHOPEE] create_shipping_document (${docType}) response: ${JSON.stringify(result).slice(0, 400)}`);

      // Extrai erro detalhado (pode vir no nível global ou por pedido)
      let failError = '';
      let failMessage = '';
      if (result.error) {
        failError = result.error;
        failMessage = result.message || '';
        if (result.error === 'common.batch_api_all_failed') {
          const item = result.response?.result_list?.[0];
          if (item?.fail_error) { failError = item.fail_error; failMessage = item.fail_message || ''; }
        }
      } else {
        const item = result.response?.result_list?.[0];
        if (item?.fail_error) { failError = item.fail_error; failMessage = item.fail_message || ''; }
      }

      if (!failError) {
        console.log(`[SHOPEE] create_shipping_document (${docType}): sucesso`);
        return { success: true, docType };
      }

      lastError = `${failError}: ${failMessage}`;
      const errLower = lastError.toLowerCase();

      // Documento já existe — sucesso
      if (errLower.includes('repeated') || errLower.includes('already') || errLower.includes('created')
          || errLower.includes('should_print_first') || errLower.includes('should print first')
          || errLower.includes('print_first')) {
        console.log(`[SHOPEE] create_shipping_document (${docType}): documento já existe (${failError}) — OK`);
        return { success: true, docType };
      }

      console.log(`[SHOPEE] create_shipping_document (${docType}) falhou: ${lastError} — tentando próximo tipo...`);
    } catch (err: any) {
      lastError = err.message || String(err);
    }
  }
  return { success: false, error: lastError };
}

// === Public API: Get shipping document result (step 2 — check if ready) ===
export async function getShippingDocumentResult(orderSn: string): Promise<{ success: boolean; status?: string; error?: string }> {
  try {
    const result = await shopeeApiCall('/api/v2/logistics/get_shipping_document_result', {
      order_list: [{ order_sn: orderSn }],
    });
    if (result.error) {
      return { success: false, error: `${result.error}: ${result.message || ''}` };
    }
    const resultList = result.response?.result_list;
    if (resultList && resultList.length > 0) {
      const item = resultList[0];
      if (item.fail_error) {
        return { success: false, status: item.status, error: `${item.fail_error}: ${item.fail_message || ''}` };
      }
      return { success: true, status: item.status };
    }
    return { success: true, status: 'UNKNOWN' };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// === Public API: Download shipping document (step 3 — returns PDF buffer) ===
// Tenta múltiplos tipos de documento (usa docTypeHint se disponível do create)
export async function downloadShippingDocument(orderSn: string, docTypeHint?: string): Promise<{ success: boolean; pdf?: Buffer; error?: string }> {
  const accessToken = await ensureValidToken();
  if (!accessToken) {
    return { success: false, error: 'Token não disponível' };
  }

  // Se temos hint do create, tenta ele primeiro; senão tenta todos
  const typesToTry = docTypeHint
    ? [docTypeHint, ...ALL_SHIPPING_DOC_TYPES.filter(t => t !== docTypeHint)]
    : ALL_SHIPPING_DOC_TYPES;

  let lastError = '';
  let zipFallback: Buffer | undefined;
  for (const docType of typesToTry) {
    const shopId = currentTokens?.shop_id || String(SHOP_ID);
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/logistics/download_shipping_document';
    const sign = generateSign(path, timestamp, accessToken, shopId);

    const url = `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&access_token=${accessToken}&shop_id=${shopId}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_list: [{
            order_sn: orderSn,
            shipping_document_type: docType,
          }],
        }),
      });

      const contentType = res.headers.get('content-type') || '';
      console.log(`[SHOPEE] download_shipping_document (${docType}): status=${res.status} content-type=${contentType}`);

      // If response is NOT JSON, treat as binary
      if (!contentType.includes('application/json')) {
        const arrayBuffer = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);

        // Check if it's actually a PDF (%PDF magic bytes)
        const isPdf = buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
        // Check if it's a ZIP (PK magic bytes) — likely ZPL thermal label, not useful as PDF
        const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B;

        if (isPdf) {
          console.log(`[SHOPEE] download_shipping_document (${docType}): PDF OK (${buf.length} bytes)`);
          return { success: true, pdf: buf };
        }

        if (isZip) {
          // ZIP with thermal/ZPL label — save as fallback, try next type for PDF
          console.log(`[SHOPEE] download_shipping_document (${docType}): ZIP/ZPL detectado (${buf.length} bytes), tentando próximo tipo...`);
          if (!zipFallback) zipFallback = buf;
          lastError = `${docType} retornou formato ZPL (etiqueta térmica), não PDF`;
          continue;
        }

        // Unknown binary — return as-is (might still work)
        console.log(`[SHOPEE] download_shipping_document (${docType}): binário desconhecido (${buf.length} bytes), retornando`);
        return { success: true, pdf: buf };
      }

      // JSON error response
      const rawText = await res.text();
      try {
        const json = JSON.parse(rawText);
        lastError = `${json.error || 'unknown'}: ${json.message || rawText.slice(0, 200)}`;
      } catch {
        lastError = `Status ${res.status}: ${rawText.slice(0, 200)}`;
      }
      console.log(`[SHOPEE] download_shipping_document (${docType}) falhou: ${lastError}`);
    } catch (err: any) {
      lastError = err.message || String(err);
    }
  }
  // Se nenhum tipo retornou PDF mas temos ZIP/ZPL como fallback, retorna ele
  if (zipFallback) {
    console.log(`[SHOPEE] download_shipping_document: nenhum PDF disponível, usando fallback ZIP/ZPL (${zipFallback.length} bytes)`);
    return { success: true, pdf: zipFallback };
  }
  return { success: false, error: lastError };
}

// === Public API: Diagnose shipping label (shows step-by-step what happens) ===
export interface LabelDiagnostic {
  orderSn: string;
  steps: { step: string; success: boolean; detail: string }[];
  finalSuccess: boolean;
  pdfSize?: number;
}

export async function diagnoseShippingLabel(orderSn: string): Promise<LabelDiagnostic> {
  const diag: LabelDiagnostic = { orderSn, steps: [], finalSuccess: false };

  // Step 0: check invoice
  const invoiceCheck = await checkOrderInvoice(orderSn);
  diag.steps.push({
    step: 'check_invoice',
    success: invoiceCheck.hasInvoice,
    detail: invoiceCheck.hasInvoice
      ? `NF presente (status: ${invoiceCheck.orderStatus})`
      : `SEM NF na Shopee (status: ${invoiceCheck.orderStatus || 'N/A'}). Envie a NF primeiro!`,
  });

  // Step 1: get_shipping_parameter
  const params = await getShippingParameter(orderSn);
  diag.steps.push({
    step: 'get_shipping_parameter',
    success: params.success,
    detail: params.success ? JSON.stringify(params.data?.info_needed || {}).slice(0, 200) : (params.error || 'erro'),
  });

  // Step 2: ship_order
  const shipResult = await shipOrder(orderSn);
  diag.steps.push({
    step: 'ship_order',
    success: shipResult.success,
    detail: shipResult.success ? 'Pedido enviado' : (shipResult.error || 'erro'),
  });

  if (shipResult.success) {
    await new Promise(r => setTimeout(r, 3000));
  }

  // Step 3: create_shipping_document
  const createResult = await createShippingDocument(orderSn);
  diag.steps.push({
    step: 'create_shipping_document',
    success: createResult.success,
    detail: createResult.success ? 'Documento criado' : (createResult.error || 'erro'),
  });

  // Step 4: get_shipping_document_result (poll up to 3x)
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusResult = await getShippingDocumentResult(orderSn);
    if (statusResult.success && statusResult.status === 'READY') {
      diag.steps.push({ step: 'get_shipping_document_result', success: true, detail: `READY (tentativa ${i + 1})` });
      break;
    }
    if (i === 2) {
      diag.steps.push({
        step: 'get_shipping_document_result',
        success: false,
        detail: `${statusResult.status || 'N/A'}: ${statusResult.error || 'não ficou READY após 3 tentativas'}`,
      });
    }
  }

  // Step 5: download_shipping_document
  const downloadResult = await downloadShippingDocument(orderSn);
  if (downloadResult.success && downloadResult.pdf) {
    diag.steps.push({ step: 'download_shipping_document', success: true, detail: `PDF ${downloadResult.pdf.length} bytes` });
    diag.finalSuccess = true;
    diag.pdfSize = downloadResult.pdf.length;
  } else {
    diag.steps.push({ step: 'download_shipping_document', success: false, detail: downloadResult.error || 'erro' });
  }

  return diag;
}

// === Public API: Full shipping label flow (ship → create → poll → download) ===
// Returns step-by-step info so we can always see what happened
export interface LabelResult {
  success: boolean;
  pdf?: Buffer;
  error?: string;
  steps: { step: string; ok: boolean; detail: string }[];
}

export async function getShippingLabel(orderSn: string): Promise<LabelResult> {
  const steps: { step: string; ok: boolean; detail: string }[] = [];
  console.log(`[SHOPEE] Etiqueta: iniciando para pedido ${orderSn}...`);

  // Step 0: Check if order has invoice (NF) — required for ship_order in Brazil
  const invoiceCheck = await checkOrderInvoice(orderSn);
  if (!invoiceCheck.hasInvoice) {
    steps.push({ step: 'check_invoice', ok: false, detail: `Pedido sem NF na Shopee (status: ${invoiceCheck.orderStatus || 'N/A'}). Envie a NF primeiro via CSV/upload.` });
    return {
      success: false,
      error: `Pedido ${orderSn} não tem NF na Shopee. A Shopee BR exige NF antes de gerar etiqueta. Faça o upload da NF primeiro.`,
      steps,
    };
  }
  const orderStatus = invoiceCheck.orderStatus || '';
  steps.push({ step: 'check_invoice', ok: true, detail: `NF presente (status: ${orderStatus})` });

  // Pedidos que já foram despachados fisicamente — NÃO podem mais gerar etiqueta
  const tooLateStatuses = ['SHIPPED', 'IN_TRANSIT', 'COMPLETED', 'TO_CONFIRM_RECEIVE'];
  if (tooLateStatuses.includes(orderStatus)) {
    const msg = `Pedido já foi despachado (status: ${orderStatus}). Etiqueta só pode ser impressa antes do envio físico.`;
    steps.push({ step: 'status_check', ok: false, detail: msg });
    return { success: false, error: msg, steps };
  }

  // Step 1: ship_order — only needed for READY_TO_SHIP orders
  // Orders in PROCESSED already passed this stage but can still print labels
  const alreadyProcessed = orderStatus === 'PROCESSED';
  if (alreadyProcessed) {
    steps.push({ step: 'ship_order', ok: true, detail: `Pulado — pedido já em ${orderStatus}` });
  } else {
    const shipResult = await shipOrder(orderSn);
    if (shipResult.success) {
      steps.push({ step: 'ship_order', ok: true, detail: 'Envio agendado' });
      await new Promise(r => setTimeout(r, 3000));
    } else {
      const shipErr = (shipResult.error || '').toLowerCase();
      if (shipErr.includes('already') || shipErr.includes('shipped') || shipErr.includes('processed') || shipErr.includes('order_status') || shipErr.includes('not eligible')) {
        steps.push({ step: 'ship_order', ok: true, detail: `Já enviado (${shipResult.error})` });
      } else {
        steps.push({ step: 'ship_order', ok: false, detail: shipResult.error || 'erro' });
        return { success: false, error: `ship_order falhou: ${shipResult.error}`, steps };
      }
    }
  }

  // Step 2a: get_shipping_document_parameter — descobre tipo correto de documento
  let suggestedDocType: string | undefined;
  const docParam = await getShippingDocumentParameter(orderSn);
  if (docParam.success && docParam.suggestedType) {
    suggestedDocType = docParam.suggestedType;
    steps.push({ step: 'get_shipping_document_parameter', ok: true, detail: `Tipo sugerido: ${suggestedDocType} (disponíveis: ${docParam.selectableTypes?.join(', ') || 'N/A'})` });
  } else {
    steps.push({ step: 'get_shipping_document_parameter', ok: false, detail: `Fallback — ${docParam.error || 'sem sugestão'}` });
  }

  // Step 2b: create_shipping_document (usa tipo sugerido; fallback para todos os tipos)
  let createResult = await createShippingDocument(orderSn, suggestedDocType);
  let usedDocType = createResult.docType; // tipo que deu certo (para passar ao download)

  // Se falhou com tracking_number_invalid, tenta ship_order e cria de novo
  if (!createResult.success && createResult.error?.includes('tracking_number_invalid')) {
    console.log(`[SHOPEE] Etiqueta: ${orderSn} tracking inválido — tentando ship_order para re-gerar...`);
    steps.push({ step: 'create_shipping_document', ok: false, detail: `tracking_number_invalid — tentando re-ship...` });
    const retryShip = await shipOrder(orderSn);
    const shipErr = (retryShip.error || '').toLowerCase();
    if (retryShip.success || shipErr.includes('already') || shipErr.includes('shipped') || shipErr.includes('processed')) {
      await new Promise(r => setTimeout(r, 3000));
      const docParam2 = await getShippingDocumentParameter(orderSn);
      createResult = await createShippingDocument(orderSn, docParam2.suggestedType || suggestedDocType);
      usedDocType = createResult.docType;
    }
  }

  if (createResult.success) {
    steps.push({ step: 'create_shipping_document', ok: true, detail: `Documento criado/existente (${usedDocType || 'auto'})` });
  } else {
    steps.push({ step: 'create_shipping_document', ok: false, detail: createResult.error || 'erro' });
    // Don't return — still try download in case it's already created
  }

  // Step 3: Poll for result (max 5 attempts, 2s apart)
  let ready = false;
  let pollDetail = '';
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusResult = await getShippingDocumentResult(orderSn);
    pollDetail = `${statusResult.status || 'N/A'} (tentativa ${i + 1})`;
    console.log(`[SHOPEE] Etiqueta: status ${i + 1}/5 — ${statusResult.status || statusResult.error}`);
    if (statusResult.status === 'READY') {
      ready = true;
      break;
    }
  }
  steps.push({ step: 'get_shipping_document_result', ok: ready, detail: ready ? 'READY' : pollDetail });

  // Step 4: Download (tenta ambos os tipos automaticamente, prioriza o que foi usado no create)
  const downloadResult = await downloadShippingDocument(orderSn, usedDocType);
  if (downloadResult.success && downloadResult.pdf) {
    steps.push({ step: 'download_shipping_document', ok: true, detail: `PDF ${downloadResult.pdf.length} bytes` });
    console.log(`[SHOPEE] Etiqueta: PDF baixado com sucesso (${downloadResult.pdf.length} bytes)`);
    return { success: true, pdf: downloadResult.pdf, steps };
  }

  steps.push({ step: 'download_shipping_document', ok: false, detail: downloadResult.error || 'erro' });
  return { success: false, error: downloadResult.error || 'Falha ao baixar etiqueta', steps };
}

// === Public API: Prepare shipping label (ship + create doc, SEM download) ===
// Usado no fluxo batch: prepara todos os pedidos e depois baixa em PDF único
export interface PrepareResult {
  order_sn: string;
  success: boolean;
  docType?: string;
  error?: string;
}

export async function prepareShippingLabel(orderSn: string): Promise<PrepareResult> {
  console.log(`[SHOPEE] Batch: preparando pedido ${orderSn}...`);

  // Verifica NF
  const invoiceCheck = await checkOrderInvoice(orderSn);
  if (!invoiceCheck.hasInvoice) {
    return { order_sn: orderSn, success: false, error: `Sem NF na Shopee (status: ${invoiceCheck.orderStatus || 'N/A'})` };
  }

  const orderStatus = invoiceCheck.orderStatus || '';

  // Pedidos já despachados — não dá pra gerar etiqueta
  if (['SHIPPED', 'IN_TRANSIT', 'COMPLETED', 'TO_CONFIRM_RECEIVE'].includes(orderStatus)) {
    return { order_sn: orderSn, success: false, error: `Já despachado (status: ${orderStatus})` };
  }

  // ship_order se necessário
  if (orderStatus !== 'PROCESSED') {
    const shipResult = await shipOrder(orderSn);
    if (!shipResult.success) {
      const shipErr = (shipResult.error || '').toLowerCase();
      if (!(shipErr.includes('already') || shipErr.includes('shipped') || shipErr.includes('processed') || shipErr.includes('order_status') || shipErr.includes('not eligible'))) {
        return { order_sn: orderSn, success: false, error: `ship_order: ${shipResult.error}` };
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Descobre tipo correto de documento
  let suggestedDocType: string | undefined;
  const docParam = await getShippingDocumentParameter(orderSn);
  if (docParam.success && docParam.suggestedType) {
    suggestedDocType = docParam.suggestedType;
  }

  // Cria documento
  let createResult = await createShippingDocument(orderSn, suggestedDocType);

  // Se falhou com tracking_number_invalid, tenta ship_order (re-arranjar envio) e cria de novo
  if (!createResult.success && createResult.error?.includes('tracking_number_invalid')) {
    console.log(`[SHOPEE] Batch: ${orderSn} tracking inválido — tentando ship_order para re-gerar...`);
    const retryShip = await shipOrder(orderSn);
    const shipErr = (retryShip.error || '').toLowerCase();
    // Se ship_order retornou "already shipped" ou similar, o tracking pode ter sido atualizado
    if (retryShip.success || shipErr.includes('already') || shipErr.includes('shipped') || shipErr.includes('processed')) {
      await new Promise(r => setTimeout(r, 3000));
      // Re-descobre tipo de documento (pode ter mudado após ship_order)
      const docParam2 = await getShippingDocumentParameter(orderSn);
      const retryDocType = docParam2.suggestedType || suggestedDocType;
      createResult = await createShippingDocument(orderSn, retryDocType);
    }
  }

  if (!createResult.success) {
    return { order_sn: orderSn, success: false, error: `create: ${createResult.error}` };
  }

  console.log(`[SHOPEE] Batch: pedido ${orderSn} preparado (tipo: ${createResult.docType || 'auto'})`);
  return { order_sn: orderSn, success: true, docType: createResult.docType };
}

// === Public API: Download múltiplas etiquetas em PDF único ===
export async function downloadShippingDocumentBatch(
  orders: Array<{ order_sn: string; docType?: string }>
): Promise<{ success: boolean; pdf?: Buffer; error?: string }> {
  const accessToken = await ensureValidToken();
  if (!accessToken) {
    return { success: false, error: 'Token não disponível' };
  }

  if (orders.length === 0) {
    return { success: false, error: 'Nenhum pedido fornecido' };
  }

  const shopId = currentTokens?.shop_id || String(SHOP_ID);
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/logistics/download_shipping_document';
  const sign = generateSign(path, timestamp, accessToken, shopId);
  const url = `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&access_token=${accessToken}&shop_id=${shopId}`;

  // Monta order_list com o tipo correto de cada pedido
  const orderList = orders.map(o => ({
    order_sn: o.order_sn,
    shipping_document_type: o.docType || 'THERMAL_AIR_WAYBILL',
  }));

  console.log(`[SHOPEE] download_shipping_document batch: ${orderList.length} pedidos`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_list: orderList }),
    });

    const contentType = res.headers.get('content-type') || '';
    console.log(`[SHOPEE] download batch: status=${res.status} content-type=${contentType}`);

    if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
      const arrayBuffer = await res.arrayBuffer();
      console.log(`[SHOPEE] download batch: PDF ${arrayBuffer.byteLength} bytes`);
      return { success: true, pdf: Buffer.from(arrayBuffer) };
    }

    const rawText = await res.text();
    try {
      const json = JSON.parse(rawText);
      return { success: false, error: `${json.error || 'unknown'}: ${json.message || rawText.slice(0, 200)}` };
    } catch {
      return { success: false, error: `Status ${res.status}: ${rawText.slice(0, 200)}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// === Public API: Get Shopee order list (for batch operations) ===
export async function getOrderList(options: {
  timeRangeField?: string;
  timeFrom?: number;
  timeTo?: number;
  pageSize?: number;
  orderStatus?: string;
}): Promise<{ success: boolean; orders?: string[]; error?: string }> {
  const timeFrom = options.timeFrom || Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const timeTo = options.timeTo || Math.floor(Date.now() / 1000);

  try {
    const result = await shopeeApiGet('/api/v2/order/get_order_list', {
      time_range_field: options.timeRangeField || 'create_time',
      time_from: String(timeFrom),
      time_to: String(timeTo),
      page_size: String(options.pageSize || 50),
      order_status: options.orderStatus || 'READY_TO_SHIP',
    });

    if (result.error) {
      return { success: false, error: `${result.error}: ${result.message || ''}` };
    }

    const orderList = result.response?.order_list || [];
    const orderSns = orderList.map((o: any) => o.order_sn);
    return { success: true, orders: orderSns };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// === Public API: Get ALL orders by status with cursor pagination ===
export async function getAllOrdersByStatus(
  orderStatus: string,
  lookbackDays: number = 15,
): Promise<{ success: boolean; orderSns: string[]; error?: string }> {
  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - lookbackDays * 24 * 60 * 60;
  const allOrders: string[] = [];
  let cursor = '';
  let hasMore = true;
  let page = 0;

  console.log(`[SHOPEE] getAllOrdersByStatus(${orderStatus}) — últimos ${lookbackDays} dias`);

  while (hasMore) {
    page++;
    try {
      const params: Record<string, string> = {
        time_range_field: 'update_time',
        time_from: String(timeFrom),
        time_to: String(timeTo),
        page_size: '100',
        order_status: orderStatus,
      };
      if (cursor) params.cursor = cursor;

      const result = await shopeeApiGet('/api/v2/order/get_order_list', params);

      if (result.error) {
        console.warn(`[SHOPEE] getAllOrdersByStatus página ${page} erro: ${result.error} ${result.message || ''}`);
        if (allOrders.length > 0) break; // Retorna o que já tem
        return { success: false, orderSns: [], error: `${result.error}: ${result.message || ''}` };
      }

      const response = result.response || {};
      const orderList = response.order_list || [];
      for (const o of orderList) {
        allOrders.push(o.order_sn);
      }

      hasMore = response.more === true;
      cursor = response.next_cursor || '';
      console.log(`[SHOPEE] Página ${page}: ${orderList.length} pedidos (total: ${allOrders.length}, more: ${hasMore})`);
    } catch (err: any) {
      console.warn(`[SHOPEE] getAllOrdersByStatus página ${page} exceção:`, err.message || err);
      if (allOrders.length > 0) break;
      return { success: false, orderSns: [], error: err.message || String(err) };
    }
  }

  console.log(`[SHOPEE] getAllOrdersByStatus(${orderStatus}) — total: ${allOrders.length} pedidos`);
  return { success: true, orderSns: allOrders };
}

// === Initialize: load tokens on startup ===
const initialTokens = loadTokens();
if (initialTokens) {
  console.log(`[SHOPEE] Tokens carregados — shop_id=${initialTokens.shop_id}`);
} else {
  console.log('[SHOPEE] Nenhum token encontrado. Aguardando autorização via /shopee/callback.');
}
