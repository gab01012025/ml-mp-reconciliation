import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as cron from 'node-cron';
import * as XLSX from 'xlsx';
import { config } from './config';
import { processNewShopeeOrders, processMercadoLivreOrdersForDate, processMercadoLivreByCollectionDate, clearProcessedOrders, sendPendingNFsToShopee, ProcessedNF, processSingleShopeeOrder, OrderSnRange } from './bot.service';
import { getLogs } from './log-buffer';
import * as ml from './ml-client';
import * as shopeeClient from './shopee-client';
import * as tinyClient from './tiny-client';

console.log('===========================================');
console.log('  Tiny Shopee Bot - Alteracao de Valores');
console.log('===========================================');
console.log(`Token: ${config.tinyToken.slice(0, 8)}...`);
console.log(`Faixas: >=R$${config.faixaMuitoAlta}=R$${config.valorMuitoAlto} | R$${config.faixaAlta}-R$99=R$${config.valorAlto} | R$${config.faixaBaixa}-R$59=R$${config.valorMedio} | <R$${config.faixaBaixa}=R$${config.valorBaixo}`);
console.log(`Intervalo: a cada ${config.pollIntervalMinutes} minutos`);
console.log('');

// State
let lastRun: Date | null = null;
let lastResult: any = null;
let isRunning = false;
let pendingReprocess: { de?: string; ate?: string } | null = null;
const nfHistory: ProcessedNF[] = [];
const MAX_NF_HISTORY = 100;
let totalOrdersSynced = 0;
let totalNFsEmitted = 0;
const startTime = new Date();
let automationPaused = config.automationPausedDefault;

// CSV path for Shopee bulk NF upload
const SHOPEE_CSV_PATH = '/app/data/shopee_nfs.csv';

// Checklist de pedidos — persistido em disco
const CHECKLIST_PATH = '/app/data/checklist.json';

interface ChecklistItem {
  nfNumero: string;
  nfId: string;
  chaveAcesso: string;
  clienteNome: string;
  numeroPedido: string;
  valor: number;
  canal: string; // 'Shopee' | 'Mercado Livre'
  dataEmissao: string;
  checked: boolean;
  checkedAt?: string;
}

function loadChecklist(): ChecklistItem[] {
  try {
    if (fs.existsSync(CHECKLIST_PATH)) {
      return JSON.parse(fs.readFileSync(CHECKLIST_PATH, 'utf-8'));
    }
  } catch (err) {
    console.warn('[CHECKLIST] Falha ao carregar:', err);
  }
  return [];
}

function saveChecklist(items: ChecklistItem[]): void {
  try {
    fs.writeFileSync(CHECKLIST_PATH, JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[CHECKLIST] Falha ao salvar:', err);
  }
}

function addToChecklist(nfs: ProcessedNF[], canal: string): void {
  if (!nfs || nfs.length === 0) return;
  const items = loadChecklist();
  const existingKeys = new Set(items.map(i => i.nfId || i.nfNumero));

  let added = 0;
  for (const nf of nfs) {
    const key = nf.nfId || nf.numero;
    if (existingKeys.has(key)) continue;
    items.push({
      nfNumero: nf.numero,
      nfId: nf.nfId,
      chaveAcesso: nf.chaveAcesso,
      clienteNome: nf.clienteNome,
      numeroPedido: nf.numeroEcommerce,
      valor: nf.valorNota,
      canal,
      dataEmissao: nf.dataProcessamento,
      checked: false,
    });
    added++;
  }

  if (added > 0) {
    saveChecklist(items);
    console.log(`[CHECKLIST] ${added} pedidos adicionados (${canal})`);
  }
}

/**
 * Salva/atualiza CSV com dados de NFs para upload em massa na Shopee.
 * Formato interno: "ID do pedido","Chave de Acesso","NF ID"
 * (terceira coluna = nfId do Tiny, usada para relatório de separação)
 */
function appendToShopeeCSV(nfs: ProcessedNF[]) {
  if (!nfs || nfs.length === 0) return;
  const newRows = nfs
    .filter(n => n.chaveAcesso && n.numeroEcommerce)
    .map(n => `${n.numeroEcommerce},${n.chaveAcesso},${n.nfId || ''}`);
  if (newRows.length === 0) return;

  let existing = '';
  try { existing = fs.readFileSync(SHOPEE_CSV_PATH, 'utf-8'); } catch {}

  // Se arquivo vazio, escreve o cabeçalho no arquivo
  if (!existing.trim()) {
    existing = 'ID do pedido,Chave de Acesso,NF ID\n';
    try { fs.writeFileSync(SHOPEE_CSV_PATH, existing); } catch {}
  }

  // Migra header antigo (sem coluna NF ID) para novo formato
  const headerLine = existing.split('\n')[0].toLowerCase();
  if ((headerLine.includes('pedido') || headerLine.includes('chave')) && !headerLine.includes('nf id')) {
    const lines = existing.split('\n').filter(l => l.trim());
    lines[0] = 'ID do pedido,Chave de Acesso,NF ID';
    existing = lines.join('\n') + '\n';
    try { fs.writeFileSync(SHOPEE_CSV_PATH, existing); } catch {}
  }

  // Migra header antigo com ;
  if (existing.startsWith('numero_pedido;') || existing.startsWith('numero_pedido,')) {
    const lines = existing.split('\n').filter(l => l.trim());
    lines[0] = 'ID do pedido,Chave de Acesso,NF ID';
    existing = lines.map(l => l.replace(/;/g, ',')).join('\n') + '\n';
    try { fs.writeFileSync(SHOPEE_CSV_PATH, existing); } catch {}
  }

  // Evita duplicatas (por numero_pedido)
  const existingOrders = new Set(existing.split('\n').map(l => l.split(',')[0]));
  const uniqueRows = newRows.filter(r => !existingOrders.has(r.split(',')[0]));

  if (uniqueRows.length > 0) {
    fs.appendFileSync(SHOPEE_CSV_PATH, uniqueRows.join('\n') + '\n');
    console.log(`[CSV] ${uniqueRows.length} NFs adicionadas ao CSV (${SHOPEE_CSV_PATH})`);
  }
}

/**
 * Gera arquivo XLSX no formato exato do template Shopee para upload em massa.
 * Colunas: "ID do pedido" | "Chave de Acesso"
 */
function generateShopeeXLSX(): Buffer | null {
  let csv = '';
  try { csv = fs.readFileSync(SHOPEE_CSV_PATH, 'utf-8'); } catch { return null; }
  if (!csv.trim()) return null;

  const lines = csv.trim().split('\n');
  if (lines.length === 0) return null;

  const rows: string[][] = [];
  rows.push(['ID do pedido', 'Chave de Acesso']); // header XLSX

  // Detecta se a primeira linha é cabeçalho (contém "pedido" ou "chave")
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('pedido') || firstLine.includes('chave') || firstLine.includes('numero');
  const startIdx = hasHeader ? 1 : 0;

  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(/[,;]/);
    if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
      rows.push([parts[0].trim(), parts[1].trim()]);
    }
  }

  if (rows.length <= 1) return null;

  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Ajusta largura das colunas
  ws['!cols'] = [{ wch: 20 }, { wch: 50 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'NFs');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// ML state
let mlIsRunning = false;
let mlLastResult: any = null;
const mlOauthStates = new Set<string>();

// Session management
const sessions = new Map<string, { user: string; created: Date }>();

function createSession(user: string): string {
  const token = crypto.randomUUID();
  sessions.set(token, { user, created: new Date() });
  return token;
}

function getAuthToken(req: http.IncomingMessage, url: URL): string | null {
  // Check Authorization header: Bearer <token>
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  // Check query param ?token=
  const qToken = url.searchParams.get('token');
  if (qToken) return qToken;
  // Check cookie fallback
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  if (match) return match[1];
  return null;
}

function isAuthenticated(req: http.IncomingMessage, url: URL): boolean {
  const token = getAuthToken(req, url);
  if (!token) return false;
  return sessions.has(token);
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${config.port}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Public: health
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'synchub-integration-platform', version: 'v3.98', uptime: process.uptime() }));
    return;
  }

  // Public: version check (for debugging deploys)
  if (url.pathname === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 'v3.98', build: '2026-07-04T12:00Z', deployed: startTime.toISOString() }));
    return;
  }

  // Public: login page
  if (url.pathname === '/login') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getLoginHtml());
      return;
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      let user = '', pass = '';
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        try { const j = JSON.parse(body); user = (j.username || '').trim(); pass = (j.password || '').trim(); } catch {}
      } else {
        const params = new URLSearchParams(body);
        user = (params.get('username') || '').trim();
        pass = (params.get('password') || '').trim();
      }

      console.log(`[SERVER] Login attempt: user='${user}' (expected='${config.demoUser}')`);
      if (user === config.demoUser && pass === config.demoPass) {
        const token = createSession(user);
        console.log(`[SERVER] Login OK — token created`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Usuário ou senha inválidos' }));
      }
      return;
    }
  }

  // Public: logout (just clears localStorage via JS)
  if (url.pathname === '/logout') {
    const token = getAuthToken(req, url);
    if (token) sessions.delete(token);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><script>localStorage.removeItem('auth_token');window.location.href='/login';</script></body></html>`);
    return;
  }

  // Public: dashboard page (auth is checked client-side via JS)
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(getDashboardHtml());
    return;
  }

  // Public: Shopee OAuth callback — captura code e shop_id
  // Aceita /shopee/callback e paths truncados como /shopee/callb, /shopee/call etc.
  if (url.pathname.startsWith('/shopee/call') && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const shopId = url.searchParams.get('shop_id');

    if (!code || !shopId) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>❌ Parâmetros ausentes</h2><p>code ou shop_id não recebidos.</p><p>Query: ${url.search}</p><a href="/">Voltar</a></body></html>`);
      return;
    }

    console.log(`[SHOPEE] Callback recebido — code=${code.slice(0, 10)}... shop_id=${shopId}`);

    // Tenta trocar o code por access_token
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const partnerId = config.shopeePartnerId;
      const partnerKey = config.shopeePartnerKey;
      const path = '/api/v2/auth/token/get';
      const baseString = `${partnerId}${path}${timestamp}`;
      const sign = crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');

      const tokenUrl = `https://partner.shopeemobile.com${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;
      const body = JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(partnerId) });

      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const tokenData = await tokenRes.json() as any;

      if (tokenData.error) {
        console.error('[SHOPEE] Token exchange error:', tokenData);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shopee - Code Recebido</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;text-align:center;background:#f0f2f5;"><div style="max-width:580px;margin:60px auto;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);"><h1 style="color:#f59e0b;font-size:48px;margin-bottom:10px;">⚠️</h1><h2 style="color:#1a1a2e;margin-bottom:16px;">Code recebido, token falhou</h2><p style="color:#666;font-size:14px;">Dados capturados com sucesso:</p><div style="text-align:left;background:#f8fafc;padding:16px;border-radius:8px;margin:16px 0;font-family:monospace;font-size:13px;word-break:break-all;"><strong>shop_id:</strong> ${shopId}<br><strong>code:</strong> ${code}<br><br><strong>Erro token:</strong> ${JSON.stringify(tokenData)}</div><a href="/" style="display:inline-block;padding:12px 28px;background:#0f3460;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Voltar ao painel</a></div></body></html>`);
      } else {
        const { access_token, refresh_token, expire_in } = tokenData;
        console.log(`[SHOPEE] Token obtido! shop_id=${shopId} access_token=${access_token?.slice(0, 15)}... refresh_token=${refresh_token?.slice(0, 15)}... expires_in=${expire_in}`);

        // Salva tokens para persistência e recarrega na memória do shopee-client
        const tokenInfo = { shop_id: shopId, access_token, refresh_token, expire_in, obtained_at: new Date().toISOString() };
        fs.writeFileSync(config.shopeeTokenStorePath, JSON.stringify(tokenInfo, null, 2));
        shopeeClient.reloadTokens();

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shopee Conectada!</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;text-align:center;background:#f0f2f5;"><div style="max-width:580px;margin:60px auto;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);"><h1 style="color:#16a34a;font-size:48px;margin-bottom:10px;">✅</h1><h2 style="color:#1a1a2e;margin-bottom:16px;">Shopee conectada com sucesso!</h2><p style="color:#666;font-size:14px;">Loja autorizada no SyncHub.</p><div style="text-align:left;background:#f8fafc;padding:16px;border-radius:8px;margin:16px 0;font-family:monospace;font-size:13px;word-break:break-all;"><strong>shop_id:</strong> ${shopId}<br><strong>access_token:</strong> ${access_token?.slice(0, 20)}...<br><strong>refresh_token:</strong> ${refresh_token?.slice(0, 20)}...<br><strong>expira em:</strong> ${expire_in}s</div><a href="/" style="display:inline-block;padding:12px 28px;background:#0f3460;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Voltar ao painel</a></div></body></html>`);
      }
    } catch (err: any) {
      console.error('[SHOPEE] Callback error:', err);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shopee - Code Recebido</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;text-align:center;background:#f0f2f5;"><div style="max-width:580px;margin:60px auto;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);"><h1 style="color:#f59e0b;font-size:48px;margin-bottom:10px;">⚠️</h1><h2 style="color:#1a1a2e;margin-bottom:16px;">Code recebido!</h2><p style="color:#666;font-size:14px;">Capturamos os dados, mas erro ao trocar por token:</p><div style="text-align:left;background:#f8fafc;padding:16px;border-radius:8px;margin:16px 0;font-family:monospace;font-size:13px;word-break:break-all;"><strong>shop_id:</strong> ${shopId}<br><strong>code:</strong> ${code}<br><br><strong>Erro:</strong> ${String(err.message || err)}</div><a href="/" style="display:inline-block;padding:12px 28px;background:#0f3460;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Voltar ao painel</a></div></body></html>`);
    }
    return;
  }

  // Public: Shopee OAuth callback fallback — captura na raiz se vier com code+shop_id
  if (url.pathname === '/' && req.method === 'GET' && url.searchParams.has('code') && url.searchParams.has('shop_id')) {
    // Redireciona para /shopee/callback com os mesmos params
    res.writeHead(302, { Location: `/shopee/callback${url.search}` });
    res.end();
    return;
  }

  // Fallback: qualquer path /shopee/* com code e shop_id que não foi pego acima
  if (url.pathname.startsWith('/shopee/') && req.method === 'GET' && url.searchParams.has('code') && url.searchParams.has('shop_id')) {
    res.writeHead(302, { Location: `/shopee/callback${url.search}` });
    res.end();
    return;
  }

  // Public: ML OAuth start — redireciona usuário para ML authorize
  if (url.pathname === '/ml/connect' && req.method === 'GET') {
    const state = crypto.randomUUID();
    mlOauthStates.add(state);
    // Expira o state em 10 min
    setTimeout(() => mlOauthStates.delete(state), 10 * 60 * 1000);
    const authUrl = ml.buildAuthorizeUrl(state);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // Public: ML OAuth callback — recebe code e troca por tokens
  if (url.pathname === '/ml/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';
    const errParam = url.searchParams.get('error');

    if (errParam) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>❌ Autorização cancelada</h2><p>${errParam}</p><a href="/">Voltar</a></body></html>`);
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>❌ Código ausente</h2><a href="/">Voltar</a></body></html>`);
      return;
    }
    if (!mlOauthStates.has(state)) {
      console.warn(`[ML] state inválido ou expirado: ${state}`);
    } else {
      mlOauthStates.delete(state);
    }

    try {
      const tokens = await ml.exchangeCodeForTokens(code);
      console.log(`[ML] Conectado com sucesso — user_id=${tokens.user_id}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mercado Livre Conectado</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;text-align:center;background:#f0f2f5;"><div style="max-width:480px;margin:60px auto;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);"><h1 style="color:#16a34a;font-size:48px;margin-bottom:10px;">✅</h1><h2 style="color:#1a1a2e;margin-bottom:16px;">Mercado Livre conectado!</h2><p style="color:#666;font-size:14px;margin-bottom:24px;">Seller ID: <strong>${tokens.user_id}</strong></p><a href="/" style="display:inline-block;padding:12px 28px;background:#0f3460;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Voltar ao painel</a></div></body></html>`);
    } catch (err: any) {
      console.error('[ML] Erro no callback:', err);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>❌ Falha ao conectar</h2><pre style="background:#f5f5f5;padding:15px;text-align:left;max-width:600px;margin:20px auto;overflow:auto;">${String(err.message || err)}</pre><a href="/">Voltar</a></body></html>`);
    }
    return;
  }

  // ---------- All API routes below require auth via Authorization header ----------
  if (!isAuthenticated(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Não autenticado' }));
    return;
  }

  if (url.pathname === '/status') {
    let csvCount = 0;
    try {
      const csvContent = fs.readFileSync(SHOPEE_CSV_PATH, 'utf-8');
      csvCount = Math.max(0, csvContent.trim().split('\n').length - 1);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'synchub-integration-platform',
      uptime: process.uptime(),
      lastRun: lastRun?.toISOString() || null,
      lastRunText: lastRun?.toLocaleString('pt-BR') || 'Nunca',
      lastResult,
      isRunning,
      pendingReprocess: !!pendingReprocess,
      nfHistory,
      totalOrdersSynced,
      totalNFsEmitted,
      automationPaused,
      csvCount,
      logs: getLogs().slice(0, 50),
    }));
  } else if (url.pathname === '/api/list-orders' && req.method === 'GET') {
    // Lista pedidos do Tiny por período SEM processar — apenas consulta
    const dataInicial = url.searchParams.get('de') || '';
    const dataFinal = url.searchParams.get('ate') || '';
    const marketplace = (url.searchParams.get('marketplace') || '').toLowerCase(); // 'shopee' | 'ml' | ''
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;

    if (!dataInicial || !dateRegex.test(dataInicial)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data inicial (de) inválida. Use dd/mm/aaaa' }));
      return;
    }
    if (!dataFinal || !dateRegex.test(dataFinal)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data final (ate) inválida. Use dd/mm/aaaa' }));
      return;
    }

    try {
      // Busca todas as páginas de pedidos no Tiny
      let page = 1;
      let totalPages = 1;
      const allOrders: Array<{ id: string; numero: string; numero_ecommerce: string; data_pedido: string; nome: string; valor: string; situacao: string }> = [];

      while (page <= totalPages) {
        const result = await tinyClient.searchOrders({ dataInicial, dataFinal, pagina: page });
        totalPages = result.totalPages;
        allOrders.push(...result.orders);
        page++;
        if (page <= totalPages) await new Promise(r => setTimeout(r, 1100));
      }

      // Regex Shopee: 6 dígitos (YYMMDD) + 8-10 alfanuméricos maiúsculos com pelo menos 1 letra
      const SHOPEE_SN = /^\d{6}(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,10}$/;
      const statusIgnorados = new Set(['Cancelado']);

      // Classifica cada pedido
      type OrderRow = {
        id: string; numero: string; numero_ecommerce: string; data_pedido: string;
        nome: string; valor: string; situacao: string; canal: string;
        temNF: boolean;
      };
      const orders: OrderRow[] = [];

      for (const o of allOrders) {
        if (statusIgnorados.has(o.situacao)) continue;

        const ne = o.numero_ecommerce;
        let canal = 'Outro';
        if (SHOPEE_SN.test(ne)) canal = 'Shopee';
        else if (/^\d{10,}$/.test(ne)) canal = 'Mercado Livre';

        if (marketplace === 'shopee' && canal !== 'Shopee') continue;
        if (marketplace === 'ml' && canal !== 'Mercado Livre') continue;

        const statusComNF = new Set(['Faturado', 'Atendido', 'Entregue', 'Pronto para envio']);
        const temNF = statusComNF.has(o.situacao) || o.situacao === 'Enviado';

        orders.push({ ...o, canal, temNF });
      }

      // Resumo
      const totalShopee = orders.filter(o => o.canal === 'Shopee').length;
      const totalML = orders.filter(o => o.canal === 'Mercado Livre').length;
      const totalOutro = orders.filter(o => o.canal === 'Outro').length;
      const pendentes = orders.filter(o => !o.temNF).length;
      const comNF = orders.filter(o => o.temNF).length;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        periodo: { de: dataInicial, ate: dataFinal },
        resumo: { total: orders.length, shopee: totalShopee, ml: totalML, outro: totalOutro, pendentes, comNF },
        pedidos: orders,
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  } else if (url.pathname === '/run' && req.method === 'POST') {
    if (isRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sincronização já em andamento. Aguarde finalizar.' }));
      return;
    }
    // Filtro opcional por range de order_sn
    const fromSn = url.searchParams.get('from_sn') || undefined;
    const toSn = url.searchParams.get('to_sn') || undefined;
    const snRange: OrderSnRange | undefined = (fromSn || toSn) ? { from: fromSn, to: toSn } : undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Sincronização manual iniciada', from_sn: fromSn || '*', to_sn: toSn || '*' }));
    runBot(undefined, undefined, true, snRange);
  } else if (url.pathname === '/reprocess' && req.method === 'POST') {
    const dataInicial = url.searchParams.get('de') || undefined;
    const dataFinal = url.searchParams.get('ate') || undefined;
    const fromSn = url.searchParams.get('from_sn') || undefined;
    const toSn = url.searchParams.get('to_sn') || undefined;
    const snRange: OrderSnRange | undefined = (fromSn || toSn) ? { from: fromSn, to: toSn } : undefined;
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (dataInicial && !dateRegex.test(dataInicial)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data "de" inválida. Use dd/mm/aaaa' }));
      return;
    }
    if (dataFinal && !dateRegex.test(dataFinal)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data "ate" inválida. Use dd/mm/aaaa' }));
      return;
    }
    if (isRunning) {
      pendingReprocess = { de: dataInicial, ate: dataFinal };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Sincronização em andamento — reprocessamento enfileirado.', de: dataInicial || 'ontem', ate: dataFinal || 'hoje' }));
      return;
    }
    clearProcessedOrders();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Reprocessamento iniciado', de: dataInicial || 'ontem', ate: dataFinal || 'hoje', from_sn: fromSn || '*', to_sn: toSn || '*' }));
    runBot(dataInicial, dataFinal, true, snRange);
  } else if (url.pathname === '/toggle-automation' && req.method === 'POST') {
    automationPaused = !automationPaused;
    console.log(`[SERVER] Automação ${automationPaused ? 'PAUSADA' : 'ATIVADA'} pelo painel`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ automationPaused, message: automationPaused ? 'Automação pausada. Apenas sincronização manual funciona.' : 'Automação reativada. Sincronização automática a cada ' + config.pollIntervalMinutes + ' min.' }));
  } else if (url.pathname === '/ml/status' && req.method === 'GET') {
    const info = ml.getConnectionInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: info.connected,
      userId: info.userId,
      expiresAt: info.expiresAt,
      discountPercent: config.mlDiscountPercent,
      isRunning: mlIsRunning,
      lastResult: mlLastResult,
    }));
  } else if (url.pathname === '/tiny/test-lista-preco' && req.method === 'POST') {
    // Preview: mostra como ficaria a NF com desconto da lista de preço
    let pedidoId = (url.searchParams.get('pedido_id') || '').trim();
    const listaId = parseInt(url.searchParams.get('lista_id') || '0', 10);
    const criarNF = url.searchParams.get('criar') === '1'; // flag para realmente criar
    if (!pedidoId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Informe pedido_id' }));
      return;
    }
    try {
      // Resolve ID do pedido
      let resolvedId = pedidoId;
      let resolveNote = '';
      let resolved = false;

      try { await tinyClient.getOrder(resolvedId); resolved = true; } catch {}

      if (!resolved) {
        try {
          const byNumero = await tinyClient.searchByNumero(pedidoId);
          if (byNumero.length > 0) { resolvedId = byNumero[0].id; resolveNote = `#${byNumero[0].numero} → id=${resolvedId}`; resolved = true; }
        } catch {}
      }
      if (!resolved) {
        try {
          const byEcom = await tinyClient.searchByNumeroEcommerce(pedidoId);
          if (byEcom.length > 0) { resolvedId = byEcom[0].id; resolveNote = `ecommerce → id=${resolvedId}`; resolved = true; }
        } catch {}
      }
      if (!resolved) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Pedido "${pedidoId}" não encontrado no Tiny` }));
        return;
      }

      // Busca pedido e lista de preço
      const order = await tinyClient.getOrder(resolvedId);
      const listas = await tinyClient.getPriceLists();
      const lista = listas.find(l => l.id === listaId);

      if (!lista && listaId !== 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Lista ${listaId} não encontrada. Disponíveis: ${listas.map(l => `${l.descricao}(${l.id})`).join(', ')}` }));
        return;
      }

      const descontoPct = lista ? -lista.acrescimo_desconto : 0;
      const factor = (100 - descontoPct) / 100;

      // Preview dos itens com desconto
      const preview = order.itens.map(i => {
        const vuOrig = parseFloat(i.valor_unitario);
        const vuDesc = Math.max(0.01, +(vuOrig * factor).toFixed(3));
        const qty = parseFloat(i.quantidade);
        return {
          descricao: i.descricao,
          quantidade: i.quantidade,
          valor_original: vuOrig.toFixed(3),
          valor_desconto: vuDesc.toFixed(3),
          subtotal_original: (vuOrig * qty).toFixed(2),
          subtotal_desconto: (vuDesc * qty).toFixed(2),
        };
      });

      const totalOrig = preview.reduce((s, i) => s + parseFloat(i.subtotal_original), 0);
      const totalDesc = preview.reduce((s, i) => s + parseFloat(i.subtotal_desconto), 0);

      let nfResult: any = null;
      if (criarNF) {
        // Cria NF de verdade (sem emitir na SEFAZ por segurança)
        const nota: any = {
          nota_fiscal: {
            tipo_nota: 'N',
            natureza_operacao: 'Venda de mercadorias',
            numero_pedido_ecommerce: order.numero_ecommerce,
            frete_por_conta: 'R',
            cliente: {
              nome: order.cliente.nome,
              tipo_pessoa: order.cliente.tipo_pessoa,
              cpf_cnpj: order.cliente.cpf_cnpj,
              ie: order.cliente.ie,
              endereco: order.cliente.endereco,
              numero: order.cliente.numero,
              complemento: order.cliente.complemento,
              bairro: order.cliente.bairro,
              cep: order.cliente.cep,
              cidade: order.cliente.cidade,
              uf: order.cliente.uf,
            },
            itens: order.itens.map(item => {
              const vuOrig = parseFloat(item.valor_unitario);
              const vuDesc = Math.max(0.01, +(vuOrig * factor).toFixed(3));
              return {
                item: {
                  id_produto: item.id_produto,
                  descricao: item.descricao,
                  unidade: item.unidade,
                  quantidade: item.quantidade,
                  valor_unitario: vuDesc.toFixed(3),
                },
              };
            }),
          },
        };

        console.log(`[TESTE] Criando NF teste para pedido ${resolvedId} com ${descontoPct}% desconto...`);
        const data = await tinyClient.tinyPostPublic('nota.fiscal.incluir.php', { nota: JSON.stringify(nota) });
        const retorno = data.retorno;
        const reg = Array.isArray(retorno.registros?.registro) ? retorno.registros.registro[0] : retorno.registros?.registro;

        if (retorno.status === 'OK' && reg?.status === 'OK') {
          nfResult = { ok: true, nfId: reg.id, numero: reg.numero, serie: reg.serie };
          console.log(`[OK] NF teste criada: ID=${reg.id}, numero=${reg.numero}`);
        } else {
          const erros = reg?.erros || retorno.erros;
          const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || 'Erro';
          nfResult = { ok: false, error: errList, raw: retorno };
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        resolveNote: resolveNote || undefined,
        pedidoId: resolvedId,
        pedidoNumero: order.numero,
        numeroEcommerce: order.numero_ecommerce,
        situacao: order.situacao,
        lista: lista ? { id: lista.id, descricao: lista.descricao, acrescimo_desconto: lista.acrescimo_desconto } : null,
        descontoPct,
        totalOriginal: totalOrig.toFixed(2),
        totalComDesconto: totalDesc.toFixed(2),
        economia: (totalOrig - totalDesc).toFixed(2),
        itens: preview,
        nfCriada: nfResult,
      }, null, 2));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  } else if (url.pathname === '/tiny/diag-alterar' && req.method === 'POST') {
    // Diagnóstico: testa diferentes formatos de pedido.alterar.php
    const pedidoTinyId = (url.searchParams.get('id') || '').trim();
    if (!pedidoTinyId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Informe ?id=ID_INTERNO_TINY (ex: 907214870)' }));
      return;
    }
    const tinyToken = config.tinyToken;
    const tinyUrl = config.tinyApiUrl;
    const results: Array<{ name: string; sent: string; status: string; response: any }> = [];

    // Helper para testar um formato
    const tryFormat = async (name: string, bodyStr: string) => {
      try {
        const resp = await fetch(`${tinyUrl}/pedido.alterar.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: bodyStr,
        });
        const text = await resp.text();
        const json = JSON.parse(text);
        results.push({ name, sent: bodyStr.replace(tinyToken, 'TOKEN'), status: json.retorno?.status || '?', response: json.retorno });
      } catch (e: any) {
        results.push({ name, sent: bodyStr.replace(tinyToken, 'TOKEN'), status: 'EXCEPTION', response: e.message });
      }
    };

    // Primeiro resolve o ID: se não for numérico puro, busca
    let resolvedId = pedidoTinyId;
    let resolveNote = '';
    if (!/^\d+$/.test(pedidoTinyId) || pedidoTinyId.length < 8) {
      // Tenta buscar por numero do pedido Tiny
      try {
        const byNumero = await tinyClient.searchByNumero(pedidoTinyId);
        if (byNumero.length > 0) {
          resolvedId = byNumero[0].id;
          resolveNote = `Resolvido: #${byNumero[0].numero} → id=${resolvedId}`;
        }
      } catch {}
      if (resolvedId === pedidoTinyId) {
        try {
          const byEcom = await tinyClient.searchByNumeroEcommerce(pedidoTinyId);
          if (byEcom.length > 0) {
            resolvedId = byEcom[0].id;
            resolveNote = `Resolvido: ecommerce ${pedidoTinyId} → id=${resolvedId}`;
          }
        } catch {}
      }
    }

    const obsTest = 'teste API ' + Date.now();

    // 1. dados_pedido encoded (padrão URLSearchParams)
    await tryFormat('dados_pedido encoded', `token=${tinyToken}&formato=json&id=${resolvedId}&dados_pedido=${encodeURIComponent(JSON.stringify({ dados_pedido: { obs: obsTest } }))}`);
    await new Promise(r => setTimeout(r, 1000));

    // 2. dados_pedido SEM encode (como PHP faz: concatenação direta)
    const rawJson2 = JSON.stringify({ dados_pedido: { obs: obsTest } });
    await tryFormat('dados_pedido RAW (sem encode)', `token=${tinyToken}&formato=json&id=${resolvedId}&dados_pedido=${rawJson2}`);
    await new Promise(r => setTimeout(r, 1000));

    // 3. dados_pedido flat SEM encode
    const rawJson3 = JSON.stringify({ obs: obsTest });
    await tryFormat('dados_pedido flat RAW', `token=${tinyToken}&formato=json&id=${resolvedId}&dados_pedido=${rawJson3}`);
    await new Promise(r => setTimeout(r, 1000));

    // 4. pedido SEM encode (formato PHP estilo pedido.incluir)
    const rawJson4 = JSON.stringify({ pedido: { obs: obsTest } });
    await tryFormat('pedido RAW', `token=${tinyToken}&formato=json&id=${resolvedId}&pedido=${rawJson4}`);
    await new Promise(r => setTimeout(r, 1000));

    // 5. SEM formato=json (talvez o formato= interfere)
    const rawJson5 = JSON.stringify({ dados_pedido: { obs: obsTest } });
    await tryFormat('sem formato=json + dados_pedido RAW', `token=${tinyToken}&id=${resolvedId}&dados_pedido=${rawJson5}`);
    await new Promise(r => setTimeout(r, 1000));

    // 6. Content-Type JSON body
    try {
      const jsonBody = JSON.stringify({ token: tinyToken, id: resolvedId, formato: 'json', dados_pedido: { obs: obsTest } });
      const resp = await fetch(`${tinyUrl}/pedido.alterar.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody,
      });
      const text = await resp.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
      results.push({ name: 'JSON body (application/json)', sent: jsonBody.replace(tinyToken, 'TOKEN'), status: json.retorno?.status || '?', response: json.retorno || json });
    } catch (e: any) {
      results.push({ name: 'JSON body', sent: '...', status: 'EXCEPTION', response: e.message });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pedidoId: pedidoTinyId, resolvedId, resolveNote: resolveNote || undefined, results }, null, 2));
  } else if (url.pathname === '/ml/clear-cache' && req.method === 'POST') {
    clearProcessedOrders();
    console.log('[ML] Cache de pedidos verificados limpo manualmente');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Cache limpo. Próxima execução ML vai reverificar todos os pedidos.' }));
  } else if (url.pathname === '/ml/inspect' && req.method === 'GET') {
    const mlOrderId = (url.searchParams.get('order_id') || '').trim();
    if (!mlOrderId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Informe order_id (número do pedido ML)' }));
      return;
    }
    try {
      const steps: Array<{ step: string; ok: boolean; detail: string }> = [];

      // 1. Buscar no ML API (shipment)
      let mlFound = false;
      let payBefore: string | undefined;
      let shipStatus: string | undefined;
      if (ml.isConnected()) {
        try {
          const mlOrders = await ml.searchRecentPaidOrders(7);
          const match = mlOrders.find(o => String(o.id) === mlOrderId);
          if (match) {
            mlFound = true;
            steps.push({ step: 'Buscar no ML API', ok: true, detail: `Pedido encontrado. Status: ${match.status}, shipping_id: ${match.shipping_id || 'N/A'}` });
            if (match.shipping_id) {
              try {
                const ship = await ml.getShipment(match.shipping_id);
                payBefore = ship.pay_before_full || undefined;
                shipStatus = ship.status;
                steps.push({ step: 'Verificar shipment', ok: true, detail: `Status: ${ship.status}, pay_before: ${payBefore || 'N/A'}, logistic_type: ${ship.logistic_type || 'N/A'}` });
              } catch (e: any) {
                steps.push({ step: 'Verificar shipment', ok: false, detail: `Erro ao buscar shipment ${match.shipping_id}: ${e.message}` });
              }
            } else {
              steps.push({ step: 'Verificar shipment', ok: false, detail: 'Pedido sem shipping_id' });
            }
          } else {
            steps.push({ step: 'Buscar no ML API', ok: false, detail: `Pedido ${mlOrderId} NÃO encontrado entre ${mlOrders.length} pedidos paid dos últimos 7 dias` });
          }
        } catch (e: any) {
          steps.push({ step: 'Buscar no ML API', ok: false, detail: `Erro: ${e.message}` });
        }
      } else {
        steps.push({ step: 'Buscar no ML API', ok: false, detail: 'Conta ML não conectada' });
      }

      // 2. Buscar no Tiny
      let tinyDetail: any = null;
      try {
        const tinyMatches = await tinyClient.searchByNumeroEcommerce(mlOrderId);
        if (tinyMatches.length === 0) {
          steps.push({ step: 'Buscar no Tiny', ok: false, detail: `Pedido ${mlOrderId} NÃO encontrado no Tiny (numero_ecommerce). O pedido pode não ter sido importado ainda.` });
        } else {
          steps.push({ step: 'Buscar no Tiny', ok: true, detail: `${tinyMatches.length} registro(s): ${tinyMatches.map(t => `#${t.numero} (${t.situacao})`).join(', ')}` });
          // Pega o primeiro match para inspecionar
          const firstMatch = tinyMatches[0];
          try {
            tinyDetail = await tinyClient.getOrder(firstMatch.id);
            const isML = tinyClient.isMercadoLivreOrder(tinyDetail);
            const isCPF = tinyClient.isPessoaFisica(tinyDetail);
            const hasNF = !!tinyDetail.id_nota_fiscal;
            const hasAddr = tinyClient.hasClientAddress(tinyDetail);
            const isMasked = tinyClient.hasMaskedClientData(tinyDetail);
            const hasNumEC = !!tinyDetail.numero_ecommerce;

            const checks = [
              `É ML: ${isML ? 'SIM' : 'NÃO'}`,
              `É CPF: ${isCPF ? 'SIM' : `NÃO (tipo=${tinyDetail.cliente?.tipo_pessoa})`}`,
              `Já tem NF: ${hasNF ? `SIM (id=${tinyDetail.id_nota_fiscal})` : 'NÃO'}`,
              `Tem endereço: ${hasAddr ? 'SIM' : 'NÃO'}`,
              `Dados mascarados: ${isMasked ? 'SIM' : 'NÃO'}`,
              `numero_ecommerce: ${hasNumEC ? tinyDetail.numero_ecommerce : 'VAZIO'}`,
              `Situação: ${tinyDetail.situacao || 'N/A'}`,
              `Total: R$${tinyDetail.total_pedido || '?'}`,
            ];
            steps.push({ step: 'Verificar detalhes Tiny', ok: true, detail: checks.join(' | ') });

            // 3. Diagnóstico final
            if (!isML) {
              steps.push({ step: 'Diagnóstico', ok: false, detail: 'Pedido NÃO identificado como ML no Tiny. O bot vai ignorar.' });
            } else if (hasNF) {
              steps.push({ step: 'Diagnóstico', ok: false, detail: 'Pedido JÁ TEM NF no Tiny. O bot vai pular.' });
            } else if (!isCPF) {
              steps.push({ step: 'Diagnóstico', ok: false, detail: `Pedido é CNPJ/PJ (tipo=${tinyDetail.cliente?.tipo_pessoa}). O bot só gera NF para CPF.` });
            } else if (isMasked) {
              steps.push({ step: 'Diagnóstico', ok: false, detail: 'Dados do cliente mascarados. O bot vai pular.' });
            } else if (!hasAddr) {
              steps.push({ step: 'Diagnóstico', ok: false, detail: 'Sem endereço completo no Tiny. O bot vai pular.' });
            } else {
              steps.push({ step: 'Diagnóstico', ok: true, detail: 'APTO para gerar NF! Se o pay_before estiver dentro da data de coleta escolhida, a NF será gerada.' });
            }
          } catch (e: any) {
            steps.push({ step: 'Verificar detalhes Tiny', ok: false, detail: `Erro ao buscar detalhes: ${e.message}` });
          }
        }
      } catch (e: any) {
        steps.push({ step: 'Buscar no Tiny', ok: false, detail: `Erro Tiny: ${e.message}` });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mlOrderId, steps }, null, 2));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  } else if (url.pathname === '/ml/disconnect' && req.method === 'POST') {
    ml.disconnect();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Conta ML desconectada' }));
  } else if (url.pathname === '/ml/debug' && req.method === 'GET') {
    try {
      const sample = await ml.debugSampleShipments(12);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sample }, null, 2));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  } else if (url.pathname === '/ml/process-day' && req.method === 'POST') {
    const date = url.searchParams.get('date') || '';
    const mode = (url.searchParams.get('mode') || 'coleta').toLowerCase();
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(date)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data inválida. Use dd/mm/aaaa' }));
      return;
    }
    if (mode !== 'coleta' && mode !== 'pedido') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mode inválido. Use coleta ou pedido' }));
      return;
    }
    if (mlIsRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Processamento ML já em andamento. Aguarde finalizar.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `Processamento ML iniciado para ${date} (${mode})`, date, mode }));
    runMLBot(date, mode as 'coleta' | 'pedido');
  } else if (url.pathname === '/shopee/send-nfs' && req.method === 'POST') {
    const de = url.searchParams.get('de') || undefined;
    const ate = url.searchParams.get('ate') || undefined;
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (de && !dateRegex.test(de)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data "de" inválida. Use dd/mm/aaaa' }));
      return;
    }
    if (ate && !dateRegex.test(ate)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data "ate" inválida. Use dd/mm/aaaa' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Envio retroativo de NFs para Shopee iniciado', de: de || 'últimos 2 dias', ate: ate || 'hoje' }));
    sendPendingNFsToShopee(de, ate).then(result => {
      console.log(`[SHOPEE-NF] Envio retroativo concluído:`, result);
    });
  } else if (url.pathname === '/shopee/csv' && req.method === 'GET') {
    // Download CSV para upload em massa na Shopee
    try {
      const csv = fs.readFileSync(SHOPEE_CSV_PATH, 'utf-8');
      const lines = csv.trim().split('\n');
      const count = Math.max(0, lines.length - 1); // subtract header
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="shopee_nfs_${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      res.end(csv);
      console.log(`[CSV] Download do CSV (${count} NFs)`);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nenhum CSV disponível. Processe pedidos Shopee primeiro.' }));
    }
  } else if (url.pathname === '/shopee/csv' && req.method === 'DELETE') {
    // Limpa CSV (ex: após upload na Shopee)
    try { fs.unlinkSync(SHOPEE_CSV_PATH); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'CSV limpo com sucesso' }));
  } else if (url.pathname === '/shopee/xlsx' && req.method === 'GET') {
    // Download XLSX no formato Shopee para upload em massa
    const xlsx = generateShopeeXLSX();
    if (xlsx) {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="shopee_nfs_${new Date().toISOString().slice(0, 10)}.xlsx"`,
        'Content-Length': String(xlsx.length),
      });
      res.end(xlsx);
      console.log(`[XLSX] Download da planilha Shopee`);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nenhuma NF disponível. Processe pedidos Shopee primeiro.' }));
    }
  } else if (url.pathname === '/shopee/test-logistics' && req.method === 'GET') {
    const orderSn = url.searchParams.get('order_sn') || '';
    if (!orderSn) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parâmetro order_sn obrigatório' }));
      return;
    }
    try {
      console.log(`[SHOPEE] Testando API logistics para pedido ${orderSn}...`);
      const result = await shopeeClient.getShippingParameter(orderSn);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: result.success, orderSn, ...result }, null, 2));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  } else if (url.pathname === '/shopee/shipping-label' && req.method === 'GET') {
    const orderSn = url.searchParams.get('order_sn') || '';
    if (!orderSn) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parâmetro order_sn obrigatório' }));
      return;
    }
    try {
      console.log(`[SHOPEE] Baixando etiqueta para pedido ${orderSn}...`);
      const result = await shopeeClient.getShippingLabel(orderSn);
      if (result.success && result.pdf) {
        const buf = result.pdf;
        const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B;
        const contentType = isZip ? 'application/zip' : 'application/pdf';
        const ext = isZip ? 'zip' : 'pdf';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="etiqueta_${orderSn}.${ext}"`,
          'Content-Length': String(buf.length),
        });
        res.end(buf);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: result.error, orderSn, steps: result.steps }, null, 2));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  } else if (url.pathname === '/shopee/diagnose-label' && req.method === 'GET') {
    const orderSn = url.searchParams.get('order_sn') || '';
    if (!orderSn) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parâmetro order_sn obrigatório' }));
      return;
    }
    try {
      console.log(`[SHOPEE] Diagnóstico etiqueta para pedido ${orderSn}...`);
      const diag = await shopeeClient.diagnoseShippingLabel(orderSn);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(diag, null, 2));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  } else if (url.pathname === '/shopee/labels-available' && req.method === 'GET') {
    // Lista pedidos disponíveis para etiqueta (READY_TO_SHIP e PROCESSED) com status de NF
    try {
      const fromSn = url.searchParams.get('from_sn')?.toUpperCase() || '';
      const toSn = url.searchParams.get('to_sn')?.toUpperCase() || '';
      let results: any[] = [];
      for (const status of ['READY_TO_SHIP', 'PROCESSED']) {
        const listResult = await shopeeClient.getOrderList({ orderStatus: status });
        if (listResult.success && listResult.orders) {
          for (const sn of listResult.orders) {
            results.push({ order_sn: sn, status });
          }
        }
      }
      // Filtro por range de order_sn
      if (fromSn || toSn) {
        results = results.filter(o => {
          const sn = o.order_sn.toUpperCase();
          if (fromSn && sn < fromSn) return false;
          if (toSn && sn > toSn) return false;
          return true;
        });
      }
      // Verifica NF de cada pedido (em paralelo, max 5 por vez)
      const enriched: any[] = [];
      for (let i = 0; i < results.length; i += 5) {
        const batch = results.slice(i, i + 5);
        const checks = await Promise.all(
          batch.map(async (o) => {
            const inv = await shopeeClient.checkOrderInvoice(o.order_sn);
            return { ...o, hasNF: inv.hasInvoice, orderStatus: inv.orderStatus || o.status };
          })
        );
        enriched.push(...checks);
      }
      const readyCount = enriched.filter(o => o.hasNF).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: enriched.length, readyForLabel: readyCount, orders: enriched, fromSn: fromSn || '*', toSn: toSn || '*' }, null, 2));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  } else if (url.pathname === '/shopee/status' && req.method === 'GET') {
    const info = shopeeClient.getConnectionInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: info.connected,
      shopId: info.shopId,
      expiresAt: info.expiresAt,
      discountPercent: config.shopeeDiscountPercent,
    }));

  // === Shopee: batch download all labels (PDF único) ===
  } else if (url.pathname === '/shopee/labels-batch' && req.method === 'GET') {
    try {
      const fromSn = url.searchParams.get('from_sn')?.toUpperCase() || '';
      const toSn = url.searchParams.get('to_sn')?.toUpperCase() || '';
      console.log(`[SHOPEE] Download em lote de etiquetas (PDF único) iniciado... (from_sn: ${fromSn || '*'}, to_sn: ${toSn || '*'})`);

      // 1) Lista todos os pedidos READY_TO_SHIP + PROCESSED
      let allOrders: Array<{ order_sn: string; status: string }> = [];
      for (const status of ['READY_TO_SHIP', 'PROCESSED']) {
        const listResult = await shopeeClient.getOrderList({ orderStatus: status });
        if (listResult.success && listResult.orders) {
          for (const sn of listResult.orders) {
            allOrders.push({ order_sn: sn, status });
          }
        }
      }

      // Filtro por range de order_sn
      if (fromSn || toSn) {
        allOrders = allOrders.filter(o => {
          const sn = o.order_sn.toUpperCase();
          if (fromSn && sn < fromSn) return false;
          if (toSn && sn > toSn) return false;
          return true;
        });
        console.log(`[SHOPEE] Batch: ${allOrders.length} pedidos no range ${fromSn || '*'} a ${toSn || '*'}`);
      }

      if (allOrders.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Nenhum pedido disponível para etiqueta' }));
        return;
      }

      // 2) Pré-filtra: verifica NF antes de preparar (em batches de 5 em paralelo)
      console.log(`[SHOPEE] Batch: verificando NF de ${allOrders.length} pedidos...`);
      const withNF: Array<{ order_sn: string; status: string }> = [];
      for (let i = 0; i < allOrders.length; i += 5) {
        const batch = allOrders.slice(i, i + 5);
        const checks = await Promise.all(
          batch.map(async (o) => {
            const inv = await shopeeClient.checkOrderInvoice(o.order_sn);
            return { ...o, hasNF: inv.hasInvoice, orderStatus: inv.orderStatus || o.status };
          })
        );
        for (const c of checks) {
          if (c.hasNF) withNF.push({ order_sn: c.order_sn, status: c.orderStatus });
        }
      }
      console.log(`[SHOPEE] Batch: ${withNF.length}/${allOrders.length} pedidos com NF`);

      if (withNF.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Nenhum pedido com NF encontrado' }));
        return;
      }

      // 3) Prepara apenas pedidos com NF (ship_order + create_shipping_document)
      const prepareResults: shopeeClient.PrepareResult[] = [];
      for (const order of withNF) {
        const prepResult = await shopeeClient.prepareShippingLabel(order.order_sn);
        prepareResults.push(prepResult);
        if (prepResult.success) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      const prepared = prepareResults.filter(r => r.success);
      const failed = prepareResults.filter(r => !r.success);
      console.log(`[SHOPEE] Batch: ${prepared.length} preparados, ${failed.length} falharam`);

      if (prepared.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Nenhum pedido elegível para etiqueta', details: prepareResults }));
        return;
      }

      // 4) Aguarda documentos ficarem prontos
      console.log(`[SHOPEE] Batch: aguardando documentos ficarem prontos...`);
      await new Promise(r => setTimeout(r, 5000));

      // 5) Download único de todos os pedidos preparados → PDF combinado
      //    Shopee aceita até 50 por chamada; se tiver mais, faz em chunks
      const BATCH_DL_SIZE = 50;
      const allPdfs: Buffer[] = [];
      for (let i = 0; i < prepared.length; i += BATCH_DL_SIZE) {
        const chunk = prepared.slice(i, i + BATCH_DL_SIZE);
        const batchResult = await shopeeClient.downloadShippingDocumentBatch(
          chunk.map(p => ({ order_sn: p.order_sn, docType: p.docType }))
        );
        if (batchResult.success && batchResult.pdf) {
          allPdfs.push(batchResult.pdf);
        } else {
          console.log(`[SHOPEE] Batch chunk ${i}..${i + chunk.length} falhou: ${batchResult.error}`);
        }
      }

      if (allPdfs.length > 0) {
        // Se só tem um chunk, retorna direto; se múltiplos, concatena os buffers
        const finalPdf = allPdfs.length === 1 ? allPdfs[0] : Buffer.concat(allPdfs);
        const filename = `etiquetas_shopee_${new Date().toISOString().slice(0, 10)}.pdf`;
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(finalPdf.length),
        });
        res.end(finalPdf);
        console.log(`[SHOPEE] Batch: PDF único ${finalPdf.length} bytes (${prepared.length} etiquetas)`);
      } else {
        // Fallback: tenta download individual e retorna o primeiro
        console.log(`[SHOPEE] Batch download falhou, tentando individual...`);
        const pdfs: Buffer[] = [];
        for (const p of prepared) {
          const dlResult = await shopeeClient.downloadShippingDocument(p.order_sn, p.docType);
          if (dlResult.success && dlResult.pdf) pdfs.push(dlResult.pdf);
        }
        if (pdfs.length > 0) {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="etiqueta_shopee_${prepared[0].order_sn}.pdf"`,
            'Content-Length': String(pdfs[0].length),
          });
          res.end(pdfs[0]);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: `Batch e individual falharam.`,
            prepared: prepared.length,
            failed: failed.length,
            details: prepareResults,
          }));
        }
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  // === ML: list paid orders with shipping (for labels) ===
  } else if (url.pathname === '/ml/labels-available' && req.method === 'GET') {
    try {
      const daysBack = Math.min(parseInt(url.searchParams.get('days') || '3', 10), 7);
      const startTime = Date.now();
      console.log(`[ML] Listando pedidos pagos com envio (${daysBack} dias)...`);
      const result = await ml.getOrdersReadyForLabels(daysBack);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[ML] Listagem concluída em ${elapsed}s: ${result.orders.length} pedidos`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        count: result.orders.length,
        daysBack,
        elapsedSeconds: parseFloat(elapsed),
        totalPaidOrders: result.totalPaidOrders,
        orders: result.orders,
      }, null, 2));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  // === ML: download single label by shipment_id ===
  } else if (url.pathname === '/ml/shipping-label' && req.method === 'GET') {
    const shipmentId = url.searchParams.get('shipment_id');
    if (!shipmentId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parâmetro shipment_id obrigatório' }));
      return;
    }
    try {
      console.log(`[ML] Baixando etiqueta para shipment ${shipmentId}...`);
      const result = await ml.downloadShippingLabels([parseInt(shipmentId, 10)]);
      if (result.success && result.pdf) {
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="etiqueta_ml_${shipmentId}.pdf"`,
          'Content-Length': String(result.pdf.length),
        });
        res.end(result.pdf);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: result.error }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  // === ML: download label by order ID ===
  } else if (url.pathname === '/ml/label-by-order' && req.method === 'GET') {
    const orderId = url.searchParams.get('order_id');
    if (!orderId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parâmetro order_id obrigatório' }));
      return;
    }
    try {
      console.log(`[ML] Baixando etiqueta para pedido ${orderId}...`);
      const result = await ml.downloadLabelByOrderId(parseInt(orderId, 10));
      if (result.success && result.pdf) {
        console.log(`[ML] Etiqueta pedido ${orderId} (shipment ${result.shipmentId}): ${result.pdf.length} bytes`);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="etiqueta_ml_${orderId}.pdf"`,
          'Content-Length': String(result.pdf.length),
        });
        res.end(result.pdf);
      } else {
        console.warn(`[ML] Etiqueta pedido ${orderId} falhou: ${result.error}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: result.error, shipmentId: result.shipmentId }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  // === ML: batch download all available labels ===
  } else if (url.pathname === '/ml/labels-batch' && req.method === 'GET') {
    try {
      const daysBack = Math.min(parseInt(url.searchParams.get('days') || '3', 10), 7);
      console.log(`[ML] Download em lote de etiquetas ML (${daysBack} dias)...`);
      const labelsResult = await ml.getOrdersReadyForLabels(daysBack);

      if (labelsResult.orders.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Nenhum pedido ML pago com envio pendente encontrado' }));
        return;
      }

      // Usa downloadShippingLabelsBatch que tenta batch primeiro, depois individual como fallback
      const shipmentIds = labelsResult.orders.map(o => o.shipmentId);
      console.log(`[ML] Baixando etiquetas para ${shipmentIds.length} pedidos...`);
      const result = await ml.downloadShippingLabelsBatch(shipmentIds);

      if (result.success && result.pdf) {
        const failedCount = result.failedIds?.length || 0;
        console.log(`[ML] ${result.count || 0} etiquetas baixadas` + (failedCount > 0 ? ` (${failedCount} indisponíveis)` : ''));
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="etiquetas_ml_${new Date().toISOString().slice(0, 10)}.pdf"`,
          'Content-Length': String(result.pdf.length),
          'X-ML-Labels-Downloaded': String(result.count || 0),
          'X-ML-Labels-Failed': String(failedCount),
        });
        res.end(result.pdf);
      } else {
        // Nenhuma etiqueta disponível — retornar detalhes dos erros
        const details = (result.failedDetails || []).map(d => `${d.shipment_id}: ${d.error_code} — ${d.message.slice(0, 80)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: result.error,
          details: details.slice(0, 10), // primeiros 10 erros
          totalFailed: result.failedIds?.length || 0,
          orderCount: labelsResult.orders.length,
        }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  // === Checklist: list items ===
  } else if (url.pathname === '/checklist' && req.method === 'GET') {
    const items = loadChecklist();
    const showChecked = url.searchParams.get('show_checked') !== 'false';
    const filtered = showChecked ? items : items.filter(i => !i.checked);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      total: items.length,
      checked: items.filter(i => i.checked).length,
      unchecked: items.filter(i => !i.checked).length,
      items: filtered,
    }));

  // === Checklist: toggle item ===
  } else if (url.pathname === '/checklist/toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk; });
    req.on('end', () => {
      try {
        const { nfId, checked } = JSON.parse(body);
        if (!nfId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'nfId obrigatório' }));
          return;
        }
        const items = loadChecklist();
        const item = items.find(i => i.nfId === nfId || i.nfNumero === nfId);
        if (!item) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Item não encontrado' }));
          return;
        }
        item.checked = checked !== undefined ? !!checked : !item.checked;
        item.checkedAt = item.checked ? new Date().toISOString() : undefined;
        saveChecklist(items);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, nfId: item.nfId, checked: item.checked }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JSON inválido' }));
      }
    });

  // === Checklist: toggle all ===
  } else if (url.pathname === '/checklist/toggle-all' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk; });
    req.on('end', () => {
      try {
        const { checked } = JSON.parse(body);
        const items = loadChecklist();
        const now = new Date().toISOString();
        for (const item of items) {
          item.checked = !!checked;
          item.checkedAt = checked ? now : undefined;
        }
        saveChecklist(items);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, total: items.length, checked: !!checked }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JSON inválido' }));
      }
    });

  // === Checklist: clear checked items ===
  } else if (url.pathname === '/checklist/clear-checked' && req.method === 'DELETE') {
    const items = loadChecklist();
    const remaining = items.filter(i => !i.checked);
    const removed = items.length - remaining.length;
    saveChecklist(remaining);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, removed, remaining: remaining.length }));

  // === Gerar etiquetas em lote para pedidos específicos (do relatório de separação) ===
  } else if (url.pathname === '/shopee/labels-batch-csv' && req.method === 'GET') {
    try {
      const orderSnsParam = url.searchParams.get('order_sns') || '';
      const orderSns = orderSnsParam.split(',').map(s => s.trim()).filter(Boolean);
      if (orderSns.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Nenhum pedido informado' }));
        return;
      }

      console.log(`[SHOPEE-LABELS-CSV] Gerando etiquetas para ${orderSns.length} pedidos do relatório...`);

      // Prepara cada pedido (ship_order + create_document)
      const prepareResults: shopeeClient.PrepareResult[] = [];
      for (const sn of orderSns) {
        const prepResult = await shopeeClient.prepareShippingLabel(sn);
        prepareResults.push(prepResult);
        if (prepResult.success) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      const prepared = prepareResults.filter(r => r.success);
      const failed = prepareResults.filter(r => !r.success);
      console.log(`[SHOPEE-LABELS-CSV] ${prepared.length} preparados, ${failed.length} falharam`);

      if (prepared.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Nenhum pedido elegível para etiqueta (${failed.length} falharam)`, details: failed.map(f => ({ order_sn: f.order_sn, error: f.error })) }));
        return;
      }

      // Aguarda documentos ficarem prontos
      await new Promise(r => setTimeout(r, 5000));

      // Download batch PDF
      const batchResult = await shopeeClient.downloadShippingDocumentBatch(
        prepared.map(p => ({ order_sn: p.order_sn, docType: p.docType }))
      );

      if (batchResult.success && batchResult.pdf) {
        const filename = `etiquetas_separacao_${new Date().toISOString().slice(0, 10)}.pdf`;
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(batchResult.pdf.length),
        });
        res.end(batchResult.pdf);
        console.log(`[SHOPEE-LABELS-CSV] PDF gerado: ${batchResult.pdf.length} bytes (${prepared.length} etiquetas)`);
      } else {
        // Fallback individual
        console.log(`[SHOPEE-LABELS-CSV] Batch falhou, tentando individual...`);
        const pdfs: Buffer[] = [];
        for (const p of prepared) {
          const dlResult = await shopeeClient.downloadShippingDocument(p.order_sn, p.docType);
          if (dlResult.success && dlResult.pdf) pdfs.push(dlResult.pdf);
        }
        if (pdfs.length > 0) {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="etiqueta_${prepared[0].order_sn}.pdf"`,
            'Content-Length': String(pdfs[0].length),
          });
          res.end(pdfs[0]);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Não foi possível gerar nenhuma etiqueta' }));
        }
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  // === Relatório de separação: busca pedidos READY_TO_SHIP + PROCESSED da Shopee API ===
  } else if (url.pathname === '/shopee/picking-list' && req.method === 'GET') {
    try {
      // Parâmetros opcionais
      const statusFilter = url.searchParams.get('status') || 'all';
      const fromSn = url.searchParams.get('from_sn')?.toUpperCase() || '';
      const toSn = url.searchParams.get('to_sn')?.toUpperCase() || '';
      console.log(`[PICKING] Buscando pedidos na Shopee API (filtro: ${statusFilter}, from_sn: ${fromSn || '*'}, to_sn: ${toSn || '*'})...`);

      const allOrderSns: string[] = [];

      // Busca READY_TO_SHIP (pedidos aguardando envio)
      if (statusFilter === 'all' || statusFilter === 'ready') {
        const rtsResult = await shopeeClient.getAllOrdersByStatus('READY_TO_SHIP', 15);
        if (rtsResult.success && rtsResult.orderSns.length > 0) {
          allOrderSns.push(...rtsResult.orderSns);
        }
      }

      // Busca PROCESSED (pedidos com envio já agendado)
      if (statusFilter === 'all' || statusFilter === 'processed') {
        const procResult = await shopeeClient.getAllOrdersByStatus('PROCESSED', 15);
        if (procResult.success && procResult.orderSns.length > 0) {
          const existing = new Set(allOrderSns);
          for (const sn of procResult.orderSns) {
            if (!existing.has(sn)) allOrderSns.push(sn);
          }
        }
      }

      if (allOrderSns.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'Nenhum pedido READY_TO_SHIP ou PROCESSED encontrado na Shopee nos últimos 15 dias',
        }));
        return;
      }

      console.log(`[PICKING] Total de pedidos encontrados: ${allOrderSns.length}`);

      // 1b) Filtro por range de order_sn (De / Até)
      let filteredOrderSns = allOrderSns;
      if (fromSn || toSn) {
        filteredOrderSns = allOrderSns.filter(sn => {
          const snUpper = sn.toUpperCase();
          if (fromSn && snUpper < fromSn) return false;
          if (toSn && snUpper > toSn) return false;
          return true;
        });
        console.log(`[PICKING] Filtro order_sn: ${filteredOrderSns.length}/${allOrderSns.length} pedidos no range`);
      }

      if (filteredOrderSns.length === 0) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h2>Nenhum pedido encontrado no range ${fromSn || '*'} a ${toSn || '*'}</h2></body></html>`);
        return;
      }

      // 2) Busca detalhes (itens + invoice_data) em batches de 50
      const allDetails = await shopeeClient.getOrdersDetail(filteredOrderSns);
      const withInvoice = allDetails.filter(d => d.has_invoice).length;
      const withoutInvoice = allDetails.length - withInvoice;
      console.log(`[PICKING] ${allDetails.length} pedidos: ${withInvoice} com NF, ${withoutInvoice} sem NF`);

      if (allDetails.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Nenhum detalhe retornado pela Shopee API' }));
        return;
      }

      // 3) Monta linhas do relatório — TODOS os pedidos (sem filtro has_invoice)
      interface PickingRow {
        order_sn: string;
        sku: string;
        product: string;
        quantity: number;
        hasNF: boolean;
        orderStatus: string;
      }
      const rows: PickingRow[] = [];
      const returnedSns = new Set<string>();
      for (const order of allDetails) {
        if (order.items.length > 0) {
          returnedSns.add(order.order_sn);
          for (const item of order.items) {
            const sku = item.model_sku || item.item_sku || '-';
            rows.push({
              order_sn: order.order_sn,
              sku,
              product: item.item_name + (item.model_name ? ` (${item.model_name})` : ''),
              quantity: item.quantity,
              hasNF: order.has_invoice,
              orderStatus: order.order_status,
            });
          }
        } else {
          rows.push({ order_sn: order.order_sn, sku: '⚠', product: 'Sem itens retornados pela Shopee', quantity: 0, hasNF: order.has_invoice, orderStatus: order.order_status });
        }
      }

      // Resumo por produto/SKU (para filtro)
      const skuSummary = new Map<string, { product: string; totalQty: number }>();
      for (const r of rows) {
        const key = r.sku + '||' + r.product;
        const cur = skuSummary.get(key);
        if (cur) { cur.totalQty += r.quantity; }
        else { skuSummary.set(key, { product: r.product, totalQty: r.quantity }); }
      }
      let summaryOptions = '';
      for (const [key, val] of skuSummary) {
        const sku = key.split('||')[0];
        const label = (sku !== '-' ? sku + ' — ' : '') + val.product + ' (total: ' + val.totalQty + ')';
        summaryOptions += '<option value="' + key.replace(/"/g, '&quot;') + '">' + label.replace(/</g, '&lt;') + '</option>';
      }

      // Gera HTML do relatório A4
      const now = new Date().toLocaleDateString('pt-BR');
      let tableRows = '';
      let seq = 0;
      for (const r of rows) {
        seq++;
        const notAvailable = !returnedSns.has(r.order_sn);
        const nfIcon = r.hasNF ? '✓' : '—';
        const nfColor = r.hasNF ? 'color:#16a34a;' : 'color:#999;';
        const statusLabel = r.orderStatus === 'PROCESSED' ? 'ENV' : 'RTS';
        tableRows += '<tr data-sku="' + (r.sku + '||' + r.product).replace(/"/g, '&quot;') + '" data-qty="' + r.quantity + '" data-nf="' + (r.hasNF ? '1' : '0') + '" data-status="' + r.orderStatus + '"' + (notAvailable ? ' style="color:#999;"' : '') + '>' +
          '<td style="text-align:center;">' + seq + '</td>' +
          '<td>' + r.order_sn + '</td>' +
          '<td>' + r.sku + '</td>' +
          '<td>' + r.product + '</td>' +
          '<td style="text-align:center;">' + r.quantity + '</td>' +
          '<td style="text-align:center;' + nfColor + '" title="' + r.orderStatus + '">' + nfIcon + '</td>' +
          '<td style="text-align:center;">☐</td>' +
          '</tr>';
      }

      // Token para o botão de etiquetas
      const tokenParam = url.searchParams.get('token') || '';

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Relatório de Separação — ${now}</title>
<style>
  @page { size: A4; margin: 15mm; }
  body { font-family: Arial, sans-serif; font-size: 11px; margin: 0; padding: 15mm; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .subtitle { font-size: 11px; color: #666; margin-bottom: 8px; }
  .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; padding: 8px 12px; background: #f8f9fa; border-radius: 6px; border: 1px solid #e2e8f0; }
  .toolbar select, .toolbar input { font-size: 11px; padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; }
  .toolbar button { font-size: 11px; padding: 5px 14px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; }
  .btn-label { background: #16a34a; color: #fff; }
  .btn-label:hover { background: #15803d; }
  .btn-print { background: #2563eb; color: #fff; }
  .btn-print:hover { background: #1d4ed8; }
  .btn-reset { background: #e2e8f0; color: #333; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
  th { background: #f0f0f0; font-weight: bold; font-size: 10px; text-transform: uppercase; }
  tr:nth-child(even) { background: #fafafa; }
  tr.hidden-row { display: none; }
  .footer { margin-top: 12px; font-size: 10px; color: #999; text-align: right; }
  .msg-box { margin: 8px 0; padding: 8px 12px; border-radius: 4px; font-size: 11px; display: none; }
  .msg-ok { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
  .msg-err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  @media print { .toolbar, .msg-box { display: none !important; } body { padding: 0; } }
</style></head><body>
<h1>Relatório de Separação</h1>
<div class="subtitle">Data: ${now} — <span id="visibleCount">${seq}</span> itens de <span id="visibleOrders">${allDetails.length}</span> pedidos (Shopee API: ${allDetails.length} total, ${withInvoice} com NF, ${withoutInvoice} sem NF)</div>

<div class="toolbar">
  <label>Filtrar produto:</label>
  <select id="filterSku" onchange="applyFilters()">
    <option value="">— Todos —</option>
    ${summaryOptions}
  </select>
  <label>Qtd mínima:</label>
  <input type="number" id="filterQtyMin" min="0" value="" placeholder="0" style="width:60px;" onchange="applyFilters()">
  <label>Qtd máxima:</label>
  <input type="number" id="filterQtyMax" min="0" value="" placeholder="∞" style="width:60px;" onchange="applyFilters()">
  <label>NF:</label>
  <select id="filterNF" onchange="applyFilters()">
    <option value="">— Todos —</option>
    <option value="1">Com NF</option>
    <option value="0">Sem NF</option>
  </select>
  <button class="btn-reset" onclick="resetFilters()">Limpar filtros</button>
  <span style="flex:1;"></span>
  <button class="btn-label" onclick="downloadAllLabels()">🏷️ Gerar Etiquetas dos Pedidos</button>
  <button class="btn-print" onclick="window.print()">🖨️ Imprimir</button>
</div>
<div id="msgLabels" class="msg-box"></div>

<table>
  <thead><tr>
    <th style="width:30px;">#</th>
    <th>ID Pedido</th>
    <th>SKU</th>
    <th>Produto</th>
    <th style="width:40px;">Qtd</th>
    <th style="width:35px;">NF</th>
    <th style="width:40px;">✓</th>
  </tr></thead>
  <tbody id="pickingBody">${tableRows}</tbody>
</table>
<div class="footer">SyncHub — Relatório gerado em ${now}</div>

<script>
  var authToken = '${tokenParam}';
  var authHeaders = { 'Authorization': 'Bearer ' + authToken };

  function applyFilters() {
    var skuFilter = document.getElementById('filterSku').value;
    var qtyMin = parseInt(document.getElementById('filterQtyMin').value) || 0;
    var qtyMax = parseInt(document.getElementById('filterQtyMax').value) || 999999;
    var nfFilter = document.getElementById('filterNF').value;
    var rows = document.querySelectorAll('#pickingBody tr');
    var visible = 0;
    var visibleOrders = new Set();
    var seq = 0;
    rows.forEach(function(row) {
      var sku = row.getAttribute('data-sku') || '';
      var qty = parseInt(row.getAttribute('data-qty')) || 0;
      var nf = row.getAttribute('data-nf') || '';
      var show = true;
      if (skuFilter && sku !== skuFilter) show = false;
      if (qty < qtyMin || qty > qtyMax) show = false;
      if (nfFilter && nf !== nfFilter) show = false;
      if (show) {
        row.classList.remove('hidden-row');
        visible++;
        seq++;
        row.cells[0].textContent = seq;
        visibleOrders.add(row.cells[1].textContent);
      } else {
        row.classList.add('hidden-row');
      }
    });
    document.getElementById('visibleCount').textContent = visible;
    document.getElementById('visibleOrders').textContent = visibleOrders.size;
  }

  function resetFilters() {
    document.getElementById('filterSku').value = '';
    document.getElementById('filterQtyMin').value = '';
    document.getElementById('filterQtyMax').value = '';
    document.getElementById('filterNF').value = '';
    applyFilters();
  }

  function showMsg(ok, text) {
    var el = document.getElementById('msgLabels');
    el.className = 'msg-box ' + (ok ? 'msg-ok' : 'msg-err');
    el.textContent = text;
    el.style.display = 'block';
  }

  async function downloadAllLabels() {
    // Coleta order_sn visíveis (não filtrados)
    var rows = document.querySelectorAll('#pickingBody tr:not(.hidden-row)');
    var sns = [];
    rows.forEach(function(r) { var sn = r.cells[1].textContent; if (sn && sns.indexOf(sn) === -1) sns.push(sn); });
    if (sns.length === 0) { showMsg(false, 'Nenhum pedido visível para gerar etiquetas'); return; }
    showMsg(true, 'Gerando etiquetas de ' + sns.length + ' pedidos... aguarde');
    try {
      var r = await fetch('/shopee/labels-batch-csv?order_sns=' + encodeURIComponent(sns.join(',')) + '&token=' + encodeURIComponent(authToken));
      if (r.status === 401) { showMsg(false, 'Não autenticado — faça login novamente'); return; }
      var contentType = r.headers.get('content-type') || '';
      if (contentType.includes('application/pdf')) {
        var blob = await r.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = 'etiquetas_separacao.pdf'; a.click();
        URL.revokeObjectURL(url);
        showMsg(true, 'Etiquetas geradas com sucesso! (' + sns.length + ' pedidos)');
      } else {
        var d = await r.json();
        showMsg(false, d.error || 'Erro ao gerar etiquetas');
      }
    } catch(e) { showMsg(false, 'Erro: ' + e.message); }
  }
</script>
</body></html>`;

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `inline; filename="relatorio_separacao_${new Date().toISOString().slice(0, 10)}.html"`,
      });
      res.end(html);
      console.log(`[PICKING] Relatório gerado: ${seq} itens de ${allDetails.length} pedidos (via Shopee API)`);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  // ========== PAINEL DE PROCESSAMENTO MANUAL ==========

  } else if (url.pathname === '/pedido/processar-unico' && req.method === 'POST') {
    // Processa pedido Shopee único — pipeline completo automático
    try {
      const body = await parseBody(req);
      const { orderSn } = JSON.parse(body);
      if (!orderSn || !orderSn.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'orderSn é obrigatório' }));
        return;
      }

      const sn = orderSn.trim().toUpperCase();
      console.log(`[SINGLE] Requisição para processar pedido: ${sn}`);

      // Pausa automação durante processamento manual
      const wasAutoPaused = automationPaused;
      if (!automationPaused) automationPaused = true;

      try {
        const result = await processSingleShopeeOrder(sn);

        // Sempre adiciona ao CSV/checklist quando NF existe (nova ou pré-existente)
        let csvAdded = false;
        let checklistAdded = false;
        if (result.nf && (result.nf.chaveAcesso || result.nf.nfId)) {
          const processedNF: ProcessedNF = {
            numero: result.nf.numero,
            nfId: result.nf.nfId,
            chaveAcesso: result.nf.chaveAcesso || '',
            clienteNome: result.clienteNome || '',
            numeroEcommerce: sn,
            valorNota: result.nf.valorNota,
            dataProcessamento: new Date().toLocaleString('pt-BR'),
          };
          nfHistory.unshift(processedNF);
          if (nfHistory.length > MAX_NF_HISTORY) nfHistory.splice(MAX_NF_HISTORY);
          totalNFsEmitted++;

          // CSV — com logging detalhado
          try {
            const csvBefore = (() => { try { return fs.readFileSync(SHOPEE_CSV_PATH, 'utf-8'); } catch { return ''; } })();
            const linesBefore = csvBefore.trim().split('\n').filter(l => l.trim()).length;
            appendToShopeeCSV([processedNF]);
            const csvAfter = (() => { try { return fs.readFileSync(SHOPEE_CSV_PATH, 'utf-8'); } catch { return ''; } })();
            const linesAfter = csvAfter.trim().split('\n').filter(l => l.trim()).length;
            csvAdded = linesAfter > linesBefore;
            console.log(`[SINGLE] CSV: antes=${linesBefore} linhas, depois=${linesAfter} linhas, adicionado=${csvAdded}`);
            if (!csvAdded) {
              // Pode ser duplicata — verifica se já existe
              const alreadyInCSV = csvAfter.includes(sn);
              console.log(`[SINGLE] CSV: pedido ${sn} ${alreadyInCSV ? 'JÁ ESTAVA no CSV' : 'NÃO está no CSV (possível erro de escrita)'}`);
              if (alreadyInCSV) csvAdded = true; // já existia = OK
            }
          } catch (csvErr: any) {
            console.error(`[SINGLE] ERRO ao escrever CSV: ${csvErr.message}`);
          }

          // Checklist
          try {
            addToChecklist([processedNF], 'Shopee');
            checklistAdded = true;
          } catch (clErr: any) {
            console.error(`[SINGLE] ERRO ao escrever checklist: ${clErr.message}`);
          }
        }

        // Adiciona flags ao resultado para a UI mostrar
        const responseData = {
          ...result,
          csvAdded,
          checklistAdded,
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
      } finally {
        if (!wasAutoPaused) automationPaused = false;
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  } else if (url.pathname === '/pedido/buscar' && req.method === 'POST') {
    // Busca pedido — Shopee API primeiro (rápida), Tiny depois (para NF)
    try {
      const body = await parseBody(req);
      const { numero } = JSON.parse(body);
      if (!numero || !numero.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Número do pedido é obrigatório' }));
        return;
      }
      const q = numero.trim();
      console.log(`[MANUAL] Buscando pedido: ${q}`);

      // Detecta formato do input
      const isShopeeFormat = /^\d{6}[A-Z0-9]{8,10}$/.test(q);
      const isNumericOnly = /^\d+$/.test(q);

      // ======== SHOPEE: busca direto na API da Shopee (rápido, confiável) ========
      if (isShopeeFormat) {
        console.log(`[MANUAL] Formato Shopee detectado — buscando na API Shopee...`);
        const shopeeOrders = await shopeeClient.getOrdersDetail([q]);

        if (shopeeOrders.length > 0) {
          const so = shopeeOrders[0];
          console.log(`[MANUAL] Shopee retornou pedido ${so.order_sn} (${so.order_status})`);

          // Verifica NF na Shopee
          let nfEnviada = false;
          try {
            const inv = await shopeeClient.checkOrderInvoice(q);
            nfEnviada = inv.hasInvoice;
          } catch {}

          // Tenta achar no Tiny (UMA tentativa rápida, não bloqueia se falhar)
          let tinyDetail: Awaited<ReturnType<typeof tinyClient.getOrder>> | null = null;
          let nfStatus: any = null;
          const wasAutoPaused = automationPaused;
          if (!automationPaused) { automationPaused = true; }

          try {
            const tinyResults = await tinyClient.searchByNumeroEcommerce(q);
            const exact = tinyResults.filter(r => r.numero_ecommerce === q);
            if (exact.length > 0) {
              await new Promise(r => setTimeout(r, 1200));
              tinyDetail = await tinyClient.getOrder(exact[0].id);
            }
          } catch (e: any) {
            console.log(`[MANUAL] Tiny não respondeu para ${q} (normal se API instável): ${e.message}`);
          }

          if (!wasAutoPaused) { automationPaused = false; }

          // Se encontrou no Tiny, busca dados da NF
          if (tinyDetail?.id_nota_fiscal) {
            try {
              await new Promise(r => setTimeout(r, 1200));
              const nf = await tinyClient.getNFDetails(tinyDetail.id_nota_fiscal);
              nfStatus = {
                nfId: tinyDetail.id_nota_fiscal,
                numero: nf.numero || '(sem número)',
                chaveAcesso: nf.chaveAcesso,
                situacao: nf.situacao || 'Emitida',
                valorNota: nf.valorNota,
                itens: nf.itens,
              };
            } catch {
              nfStatus = { nfId: tinyDetail.id_nota_fiscal, numero: '(detalhes indisponíveis)', situacao: 'NF vinculada' };
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            pedido: {
              id: tinyDetail?.id || '',
              numero: tinyDetail?.numero || '',
              numero_ecommerce: so.order_sn,
              data_pedido: tinyDetail?.data_pedido || '',
              situacao: tinyDetail?.situacao || so.order_status,
              canal: 'Shopee',
              fonte: tinyDetail ? 'shopee+tiny' : 'shopee',
              cliente: {
                nome: so.recipient_name || tinyDetail?.cliente?.nome || so.buyer_username,
                cpf_cnpj: tinyDetail?.cliente?.cpf_cnpj || '',
                cidade: tinyDetail?.cliente?.cidade || '',
                uf: tinyDetail?.cliente?.uf || '',
              },
              itens: so.items.map(it => ({
                codigo: it.model_sku || it.item_sku || '-',
                descricao: it.item_name + (it.model_name ? ` (${it.model_name})` : ''),
                quantidade: String(it.quantity),
                valor_unitario: String(it.price),
              })),
              total_pedido: String(so.total_amount),
              total_produtos: String(so.total_amount),
              temNF: !!(tinyDetail?.id_nota_fiscal),
              nf: nfStatus,
              nfEnviada,
              tinyEncontrado: !!tinyDetail,
            },
          }));
          return;
        }
        // Shopee não encontrou — pode ser número errado ou pedido antigo
        console.log(`[MANUAL] Shopee não encontrou pedido ${q}`);
      }

      // ======== TINY: busca direta (para ML ou quando Shopee não encontrou) ========
      console.log(`[MANUAL] Buscando no Tiny...`);
      const wasAutoPaused = automationPaused;
      if (!automationPaused) { automationPaused = true; }

      let detail: Awaited<ReturnType<typeof tinyClient.getOrder>> | null = null;
      let tinyErr = '';

      // Tenta busca por numero_ecommerce (1 tentativa)
      try {
        const results = await tinyClient.searchByNumeroEcommerce(q);
        const exact = results.filter(r => r.numero_ecommerce === q);
        if (exact.length > 0) {
          await new Promise(r => setTimeout(r, 1200));
          detail = await tinyClient.getOrder(exact[0].id);
        }
      } catch (e: any) { tinyErr = e.message; }

      // Tenta busca por numero Tiny
      if (!detail) {
        try {
          await new Promise(r => setTimeout(r, 1200));
          const results = await tinyClient.searchByNumero(q);
          if (results.length > 0) {
            const match = results.find(r => r.numero === q) || results[0];
            await new Promise(r => setTimeout(r, 1200));
            detail = await tinyClient.getOrder(match.id);
          }
        } catch (e: any) { if (!tinyErr) tinyErr = e.message; }
      }

      // Tenta por ID direto
      if (!detail && isNumericOnly) {
        try {
          await new Promise(r => setTimeout(r, 1200));
          detail = await tinyClient.getOrder(q);
        } catch {}
      }

      if (!wasAutoPaused) { automationPaused = false; }

      if (!detail) {
        const isTrans = tinyErr && (tinyErr.includes('transitório') || tinyErr.includes('Tente novamente') || tinyErr.includes('Bloqueada'));
        const msg = isTrans
          ? 'O Tiny está temporariamente sobrecarregado. Aguarde alguns segundos e tente novamente.'
          : isShopeeFormat
            ? `Pedido "${q}" não encontrado na Shopee nem no Tiny. Verifique se o número está correto.`
            : `Pedido "${q}" não encontrado no Tiny. Use o número do pedido (e-commerce), número Tiny, ou ID Tiny.`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
        return;
      }

      // Detecta canal
      let canal = 'Desconhecido';
      if (tinyClient.isShopeeOrder(detail)) canal = 'Shopee';
      else if (tinyClient.isMercadoLivreOrder(detail)) canal = 'Mercado Livre';
      else {
        const ne = detail.numero_ecommerce || '';
        if (/^\d{6}(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,10}$/.test(ne)) canal = 'Shopee';
        else if (/^\d{10,13}$/.test(ne)) canal = 'Mercado Livre';
      }

      // NF
      let nfStatus: any = null;
      if (detail.id_nota_fiscal) {
        try {
          await new Promise(r => setTimeout(r, 1200));
          const nf = await tinyClient.getNFDetails(detail.id_nota_fiscal);
          nfStatus = { nfId: detail.id_nota_fiscal, numero: nf.numero || '(sem número)', chaveAcesso: nf.chaveAcesso, situacao: nf.situacao || 'Emitida', valorNota: nf.valorNota, itens: nf.itens };
        } catch {
          nfStatus = { nfId: detail.id_nota_fiscal, numero: '(detalhes indisponíveis)', situacao: 'NF vinculada' };
        }
      }

      let nfEnviada = false;
      if (canal === 'Shopee' && detail.numero_ecommerce) {
        try { nfEnviada = (await shopeeClient.checkOrderInvoice(detail.numero_ecommerce)).hasInvoice; } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        pedido: {
          id: detail.id,
          numero: detail.numero,
          numero_ecommerce: detail.numero_ecommerce,
          data_pedido: detail.data_pedido,
          situacao: detail.situacao,
          canal,
          fonte: 'tiny',
          cliente: { nome: detail.cliente.nome, cpf_cnpj: detail.cliente.cpf_cnpj, cidade: detail.cliente.cidade, uf: detail.cliente.uf },
          itens: detail.itens.map(it => ({ codigo: it.codigo, descricao: it.descricao, quantidade: it.quantidade, valor_unitario: it.valor_unitario })),
          total_pedido: detail.total_pedido,
          total_produtos: detail.total_produtos,
          temNF: !!detail.id_nota_fiscal,
          nf: nfStatus,
          nfEnviada,
          tinyEncontrado: true,
        },
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  } else if (url.pathname === '/pedido/gerar-nf' && req.method === 'POST') {
    // Gera NF para um pedido específico
    try {
      const body = await parseBody(req);
      const { orderId, canal } = JSON.parse(body);
      if (!orderId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'orderId é obrigatório' }));
        return;
      }

      console.log(`[MANUAL] Gerando NF para pedido ${orderId} (canal: ${canal})`);

      // Busca pedido no Tiny — tenta por ID direto primeiro (mais rápido), depois por número, depois por ecommerce
      let detail: Awaited<ReturnType<typeof tinyClient.getOrder>> | null = null;
      let tinyOrderId = orderId;
      const isNumericOnly = /^\d+$/.test(orderId);
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

      if (isNumericOnly) {
        // Input numérico: provavelmente ID Tiny ou número Tiny
        // 1) Tenta por ID direto (mais rápido, sem busca)
        try {
          detail = await tinyClient.getOrder(orderId);
          tinyOrderId = orderId;
        } catch {
          console.log(`[MANUAL] getOrder(${orderId}) por ID direto falhou`);
        }

        // 2) Tenta por numero Tiny
        if (!detail) {
          try {
            await sleep(1200);
            const results = await tinyClient.searchByNumero(orderId);
            if (results.length > 0) {
              const match = results.find(r => r.numero === orderId) || results[0];
              tinyOrderId = match.id;
              await sleep(1200);
              detail = await tinyClient.getOrder(tinyOrderId);
            }
          } catch (e: any) {
            console.log(`[MANUAL] searchByNumero(${orderId}) falhou: ${e.message}`);
          }
        }

        // 3) Tenta por numero_ecommerce (ML usa IDs numéricos longos)
        if (!detail) {
          try {
            await sleep(1200);
            const matches = await tinyClient.searchByNumeroEcommerce(orderId);
            if (matches.length > 0) {
              tinyOrderId = matches[0].id;
              await sleep(1200);
              detail = await tinyClient.getOrder(tinyOrderId);
            }
          } catch (e: any) {
            console.log(`[MANUAL] searchByNumeroEcommerce(${orderId}) falhou: ${e.message}`);
          }
        }
      } else {
        // Input não-numérico: provavelmente Order SN Shopee ou nº ecommerce
        // 1) Tenta por numero_ecommerce
        try {
          const matches = await tinyClient.searchByNumeroEcommerce(orderId);
          if (matches.length > 0) {
            tinyOrderId = matches[0].id;
            await sleep(1200);
            detail = await tinyClient.getOrder(tinyOrderId);
          }
        } catch (e: any) {
          console.log(`[MANUAL] searchByNumeroEcommerce(${orderId}) falhou: ${e.message}`);
        }

        // 2) Tenta por numero Tiny
        if (!detail) {
          try {
            await sleep(1200);
            const results = await tinyClient.searchByNumero(orderId);
            if (results.length > 0) {
              const match = results.find(r => r.numero === orderId) || results[0];
              tinyOrderId = match.id;
              await sleep(1200);
              detail = await tinyClient.getOrder(tinyOrderId);
            }
          } catch (e: any) {
            console.log(`[MANUAL] searchByNumero(${orderId}) falhou: ${e.message}`);
          }
        }
      }

      if (!detail) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, found: false, error: `Pedido "${orderId}" não encontrado no Tiny. Verifique se o número está correto.` }));
        return;
      }

      if (detail.id_nota_fiscal) {
        const nf = await tinyClient.getNFDetails(detail.id_nota_fiscal);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          found: true,
          jaExistia: true,
          clienteNome: detail.cliente?.nome || '',
          tinyNumero: detail.numero || '',
          tinyId: tinyOrderId,
          nfId: detail.id_nota_fiscal,
          numero: nf.numero,
          chaveAcesso: nf.chaveAcesso,
          situacao: nf.situacao,
          valorNota: nf.valorNota,
        }));
        return;
      }

      // Info do pedido para exibir no frontend
      const pedidoInfo = { clienteNome: detail.cliente?.nome || '', tinyNumero: detail.numero || '', tinyId: tinyOrderId };

      // Validações
      if (!tinyClient.hasClientAddress(detail)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, found: true, ...pedidoInfo, error: 'Pedido sem endereço completo do cliente' }));
        return;
      }
      if (tinyClient.hasMaskedClientData(detail)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, found: true, ...pedidoInfo, error: 'Dados do cliente mascarados (***). Atualize no Tiny antes.' }));
        return;
      }

      // Detecta marketplace — usa canal do request se disponível (mais confiável),
      // senão tenta via ecommerce field da API Tiny, senão por regex do numero_ecommerce
      let detectedCanal: 'Shopee' | 'ML' | null = null;
      if (canal === 'Shopee') detectedCanal = 'Shopee';
      else if (canal === 'Mercado Livre' || canal === 'ML') detectedCanal = 'ML';
      // Fallback: API Tiny
      if (!detectedCanal) {
        if (tinyClient.isShopeeOrder(detail)) detectedCanal = 'Shopee';
        else if (tinyClient.isMercadoLivreOrder(detail)) detectedCanal = 'ML';
      }
      // Fallback: regex no numero_ecommerce
      if (!detectedCanal && detail.numero_ecommerce) {
        const ne = detail.numero_ecommerce;
        if (/^\d{6}(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,10}$/.test(ne)) detectedCanal = 'Shopee';
        else if (/^\d{10,}$/.test(ne)) detectedCanal = 'ML';
      }

      let descontoAplicado = 0;
      const discountDebug: string[] = [`canal=${detectedCanal || 'nenhum'}`, `itens=${detail.itens?.length || 0}`, `total=${detail.total_pedido}`];
      if (detectedCanal) {
        try {
          const discountPercent = await tinyClient.getMarketplaceDiscount(detectedCanal);
          discountDebug.push(`desconto=${discountPercent}%`);
          if (discountPercent > 0) {
            console.log(`[MANUAL] Aplicando desconto ${discountPercent}% (${detectedCanal}) ao pedido ${tinyOrderId}`);
            await sleep(1200);
            const alterResult = await tinyClient.alterOrderPrices(tinyOrderId, detail, discountPercent);
            discountDebug.push(`alter=${alterResult.success ? 'OK' : 'FALHA: ' + (alterResult.error || '?')}`);
            if (alterResult.success) {
              descontoAplicado = discountPercent;
              console.log(`[MANUAL] Desconto ${discountPercent}% aplicado com sucesso`);
              // Re-fetch order para pegar preços atualizados
              await sleep(1200);
              detail = await tinyClient.getOrder(tinyOrderId);
              discountDebug.push(`novoTotal=${detail.total_pedido}`);
            } else {
              console.warn(`[MANUAL] Falha ao aplicar desconto: ${alterResult.error} — gerando NF sem desconto`);
            }
          } else {
            discountDebug.push('desconto=0, nada a fazer');
          }
        } catch (e: any) {
          discountDebug.push(`erro=${e.message}`);
          console.warn(`[MANUAL] Erro ao aplicar desconto: ${e.message} — gerando NF sem desconto`);
        }
      } else {
        discountDebug.push('sem marketplace detectado');
        console.log(`[MANUAL] Pedido ${tinyOrderId} sem marketplace detectado — gerando NF sem desconto`);
      }

      // Gera NF a partir do pedido (preserva selo ecommerce → Tiny auto-envia)
      await sleep(1200);
      const nf = await tinyClient.generateNFFromOrder(tinyOrderId, detail.numero);

      if (nf.success) {
        // Adiciona ao histórico e CSV
        const processedNF: ProcessedNF = {
          numero: nf.numero || '',
          nfId: nf.nfId || '',
          chaveAcesso: nf.chaveAcesso || '',
          clienteNome: detail.cliente.nome || '',
          numeroEcommerce: detail.numero_ecommerce || '',
          valorNota: nf.valorNota || 0,
          dataProcessamento: new Date().toLocaleDateString('pt-BR'),
        };
        nfHistory.unshift(processedNF);
        if (nfHistory.length > MAX_NF_HISTORY) nfHistory.splice(MAX_NF_HISTORY);
        if (canal === 'Shopee' || detectedCanal === 'Shopee') appendToShopeeCSV([processedNF]);
        addToChecklist([processedNF], canal || detectedCanal || 'Manual');
        totalNFsEmitted++;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          found: true,
          ...pedidoInfo,
          nfId: nf.nfId,
          numero: nf.numero,
          chaveAcesso: nf.chaveAcesso,
          valorNota: nf.valorNota,
          descontoAplicado,
          canal: detectedCanal,
          discountDebug: discountDebug.join(' | '),
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, found: true, ...pedidoInfo, error: nf.error || 'Falha ao gerar NF. Verifique os logs.', discountDebug: discountDebug.join(' | ') }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  } else if (url.pathname === '/batch/processar' && req.method === 'POST') {
    // Processa pedidos em lote (gerar NF + enviar) com progresso via SSE
    try {
      const body = await parseBody(req);
      const { pedidos, acoes } = JSON.parse(body) as {
        pedidos: Array<{ id: string; numero: string; numero_ecommerce: string; canal: string }>;
        acoes: string[];
      };
      if (!pedidos || pedidos.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Nenhum pedido selecionado' }));
        return;
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const sendSSE = (data: any) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

      const doNF = acoes.includes('nf');
      const doEnviar = acoes.includes('enviar');
      const resumo = { total: pedidos.length, nfGeradas: 0, nfErros: 0, nfJaExistiam: 0, descontosAplicados: 0, enviadas: 0, envioErros: 0 };
      let aborted = false;
      req.on('close', () => { aborted = true; });

      for (let i = 0; i < pedidos.length; i++) {
        if (aborted) break;
        const p = pedidos[i];
        const label = `${p.numero || p.id} (${p.canal === 'Mercado Livre' ? 'ML' : p.canal || '?'})`;

        // ---- GERAR NF ----
        if (doNF) {
          sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'working', detail: 'Buscando pedido...' });
          try {
            await sleep(1200);
            const detail = await tinyClient.getOrder(p.id);

            // Já tem NF?
            if (detail.id_nota_fiscal) {
              const nfInfo = await tinyClient.getNFDetails(detail.id_nota_fiscal);
              sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'ok', detail: `NF ${nfInfo.numero || detail.id_nota_fiscal} já existia` });
              resumo.nfJaExistiam++;
              // Guarda nfId no pedido para o envio
              (p as any)._nfId = detail.id_nota_fiscal;
              (p as any)._nfNumero = nfInfo.numero;
              (p as any)._chaveAcesso = nfInfo.chaveAcesso;
            } else {
              // Validações
              if (!tinyClient.hasClientAddress(detail)) {
                sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'erro', detail: 'Sem endereço completo' });
                resumo.nfErros++;
                continue;
              }
              if (tinyClient.hasMaskedClientData(detail)) {
                sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'erro', detail: 'Dados mascarados (***)' });
                resumo.nfErros++;
                continue;
              }

              // Aplicar desconto — usa canal do frontend (baseado em regex do numero_ecommerce)
              // pois isShopeeOrder() depende de campo ecommerce que a API Tiny nem sempre retorna
              let detectedCanal: 'Shopee' | 'ML' | null = null;
              if (p.canal === 'Shopee') detectedCanal = 'Shopee';
              else if (p.canal === 'Mercado Livre') detectedCanal = 'ML';
              // Fallback: tenta detectar pela API se canal não veio do frontend
              if (!detectedCanal) {
                if (tinyClient.isShopeeOrder(detail)) detectedCanal = 'Shopee';
                else if (tinyClient.isMercadoLivreOrder(detail)) detectedCanal = 'ML';
              }

              let descontoAplicado = 0;
              if (detectedCanal) {
                sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'working', detail: `Aplicando desconto ${detectedCanal}...` });
                try {
                  const discountPercent = await tinyClient.getMarketplaceDiscount(detectedCanal);
                  console.log(`[BATCH] Pedido ${label}: canal=${detectedCanal}, desconto=${discountPercent}%`);
                  if (discountPercent > 0) {
                    await sleep(1200);
                    const alterResult = await tinyClient.alterOrderPrices(p.id, detail, discountPercent);
                    if (alterResult.success) {
                      descontoAplicado = discountPercent;
                      resumo.descontosAplicados++;
                      console.log(`[BATCH] Pedido ${label}: desconto ${discountPercent}% aplicado OK`);
                    } else {
                      console.warn(`[BATCH] Pedido ${label}: alterOrderPrices FALHOU: ${alterResult.error}`);
                      sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'working', detail: `Desconto falhou: ${alterResult.error} — gerando NF sem desconto` });
                    }
                  }
                } catch (discErr: any) {
                  console.warn(`[BATCH] Pedido ${label}: erro desconto: ${discErr.message}`);
                  sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'working', detail: `Erro desconto: ${discErr.message} — gerando NF sem desconto` });
                }
              }

              // Gerar NF
              sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'working', detail: 'Gerando NF...' });
              await sleep(1200);
              const nf = await tinyClient.generateNFFromOrder(p.id, detail.numero);
              if (nf.success) {
                const descontoInfo = descontoAplicado > 0 ? ` (desconto ${descontoAplicado}% ${detectedCanal})` : '';
                sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'ok', detail: `NF ${nf.numero || nf.nfId} gerada — R$ ${(nf.valorNota || 0).toFixed(2)}${descontoInfo}` });
                resumo.nfGeradas++;
                (p as any)._nfId = nf.nfId;
                (p as any)._nfNumero = nf.numero;
                (p as any)._chaveAcesso = nf.chaveAcesso;

                // Registra no histórico
                const processedNF: ProcessedNF = {
                  numero: nf.numero || '', nfId: nf.nfId || '', chaveAcesso: nf.chaveAcesso || '',
                  clienteNome: detail.cliente.nome || '', numeroEcommerce: detail.numero_ecommerce || '',
                  valorNota: nf.valorNota || 0, dataProcessamento: new Date().toLocaleDateString('pt-BR'),
                };
                nfHistory.unshift(processedNF);
                if (nfHistory.length > MAX_NF_HISTORY) nfHistory.splice(MAX_NF_HISTORY);
                if (detectedCanal === 'Shopee') appendToShopeeCSV([processedNF]);
                addToChecklist([processedNF], detectedCanal || 'Manual');
                totalNFsEmitted++;
              } else {
                sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'erro', detail: nf.error || 'Falha ao gerar NF' });
                resumo.nfErros++;
                continue; // sem NF, não faz sentido enviar
              }
            }
          } catch (e: any) {
            sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'nf', status: 'erro', detail: e.message || 'Erro inesperado' });
            resumo.nfErros++;
            continue;
          }
        }

        // ---- ENVIAR NF ----
        if (doEnviar && p.canal === 'Shopee' && p.numero_ecommerce) {
          const nfId = (p as any)._nfId;
          const chaveAcesso = (p as any)._chaveAcesso;
          if (!nfId) {
            sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'enviar', status: 'erro', detail: 'Sem NF para enviar' });
            resumo.envioErros++;
          } else {
            sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'enviar', status: 'working', detail: 'Enviando NF para Shopee...' });
            try {
              // Verifica se já foi enviada
              const check = await shopeeClient.checkOrderInvoice(p.numero_ecommerce);
              if (check.hasInvoice) {
                sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'enviar', status: 'ok', detail: 'NF já estava na Shopee' });
                resumo.enviadas++;
              } else {
                await sleep(1200);
                const xml = await tinyClient.getNFXml(nfId);
                if (xml) {
                  const sendResult = await shopeeClient.uploadInvoiceDoc(p.numero_ecommerce, xml);
                  if (sendResult.success) {
                    sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'enviar', status: 'ok', detail: 'NF enviada para Shopee' });
                    resumo.enviadas++;
                  } else {
                    sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'enviar', status: 'erro', detail: sendResult.error || 'Falha no envio' });
                    resumo.envioErros++;
                  }
                } else {
                  sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'enviar', status: 'erro', detail: 'XML da NF não disponível' });
                  resumo.envioErros++;
                }
              }
            } catch (e: any) {
              sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'enviar', status: 'erro', detail: e.message });
              resumo.envioErros++;
            }
          }
        } else if (doEnviar && p.canal === 'Mercado Livre') {
          sendSSE({ type: 'progress', current: i + 1, total: pedidos.length, pedido: label, step: 'enviar', status: 'ok', detail: 'Tiny envia automaticamente (ML)' });
          resumo.enviadas++;
        }
      }

      sendSSE({ type: 'done', resumo });
      res.end();
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  } else if (url.pathname === '/batch/etiquetas' && req.method === 'GET') {
    // Download de etiquetas dos pedidos selecionados
    try {
      const snsParam = url.searchParams.get('sns') || '';
      const canal = url.searchParams.get('canal') || '';
      const sns = snsParam.split(',').map(s => s.trim()).filter(Boolean);

      if (sns.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Nenhum order SN fornecido' }));
        return;
      }

      console.log(`[BATCH] Etiquetas para ${sns.length} pedidos (canal: ${canal || 'misto'})`);

      // Separar Shopee e ML
      // Para identificar canal de cada SN, verificamos se tem padrão ML ou foi informado
      const shopeeSns: string[] = [];
      const mlSns: string[] = [];

      if (canal === 'Shopee') {
        shopeeSns.push(...sns);
      } else if (canal === 'Mercado Livre') {
        mlSns.push(...sns);
      } else {
        // Canal misto — pedidos Shopee geralmente começam com letras maiúsculas seguidas de números
        for (const sn of sns) {
          // ML orders tipicamente são numéricos puros
          if (/^\d+$/.test(sn)) {
            mlSns.push(sn);
          } else {
            shopeeSns.push(sn);
          }
        }
      }

      const pdfBuffers: Buffer[] = [];
      const errors: string[] = [];

      // Etiquetas Shopee
      if (shopeeSns.length > 0) {
        console.log(`[BATCH] Processando ${shopeeSns.length} etiquetas Shopee...`);
        for (const sn of shopeeSns) {
          try {
            const result = await shopeeClient.getShippingLabel(sn);
            if (result.success && result.pdf) {
              pdfBuffers.push(result.pdf);
            } else {
              errors.push(`${sn}: ${result.error || 'Falha'}`);
            }
            await new Promise(r => setTimeout(r, 1500));
          } catch (e: any) {
            errors.push(`${sn}: ${e.message}`);
          }
        }
      }

      // Etiquetas ML
      if (mlSns.length > 0) {
        console.log(`[BATCH] Processando ${mlSns.length} etiquetas ML...`);
        for (const sn of mlSns) {
          try {
            // numero_ecommerce do ML é o order_id — usar downloadLabelByOrderId
            const orderId = parseInt(sn, 10);
            if (isNaN(orderId)) {
              errors.push(`ML ${sn}: ID inválido`);
              continue;
            }
            const result = await ml.downloadLabelByOrderId(orderId);
            if (result.success && result.pdf) {
              pdfBuffers.push(result.pdf);
            } else {
              errors.push(`ML ${sn}: ${result.error || 'Falha'}`);
            }
            await new Promise(r => setTimeout(r, 1500));
          } catch (e: any) {
            errors.push(`ML ${sn}: ${e.message}`);
          }
        }
      }

      if (pdfBuffers.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Nenhuma etiqueta disponível', details: errors }));
        return;
      }

      // Retorna o primeiro PDF (ou concatenados se possível)
      // Para simplificar, retorna PDFs individuais concatenados como download
      if (pdfBuffers.length === 1) {
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="etiquetas_batch_${new Date().toISOString().slice(0, 10)}.pdf"`,
          'Content-Length': String(pdfBuffers[0].length),
        });
        res.end(pdfBuffers[0]);
      } else {
        // Concatena buffers — cada um é um PDF válido; na prática retorna o primeiro
        // e informa que há mais para download individual
        const combined = Buffer.concat(pdfBuffers);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="etiquetas_batch_${new Date().toISOString().slice(0, 10)}.pdf"`,
          'Content-Length': String(combined.length),
          'X-Labels-Count': String(pdfBuffers.length),
          'X-Labels-Errors': String(errors.length),
        });
        res.end(combined);
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  } else if (url.pathname === '/batch/picking-list' && req.method === 'GET') {
    // Lista de separação dos pedidos selecionados
    try {
      const idsParam = url.searchParams.get('ids') || '';
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);

      if (ids.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Nenhum ID de pedido fornecido' }));
        return;
      }

      console.log(`[BATCH] Picking list para ${ids.length} pedidos...`);

      // Busca detalhes de cada pedido no Tiny
      interface BatchPickItem { order_sn: string; numero: string; canal: string; clienteNome: string; sku: string; produto: string; quantidade: number; }
      const items: BatchPickItem[] = [];
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

      for (const id of ids) {
        try {
          await sleep(1200);
          const detail = await tinyClient.getOrder(id);
          const orderSn = detail.numero_ecommerce || '';
          const canal = tinyClient.isShopeeOrder(detail) ? 'Shopee' : (tinyClient.isMercadoLivreOrder(detail) ? 'ML' : 'Outro');
          const clienteNome = detail.cliente?.nome || '';

          if (detail.itens && detail.itens.length > 0) {
            for (const item of detail.itens) {
              items.push({
                order_sn: orderSn,
                numero: detail.numero || id,
                canal,
                clienteNome,
                sku: item.codigo || '-',
                produto: item.descricao || 'Sem nome',
                quantidade: parseInt(item.quantidade, 10) || 1,
              });
            }
          }
        } catch (e: any) {
          console.log(`[BATCH] Picking: erro ao buscar pedido ${id}: ${e.message}`);
        }
      }

      // Agrupar por SKU para separação
      const skuMap: Record<string, { sku: string; produto: string; total: number; pedidos: string[] }> = {};
      for (const item of items) {
        const key = item.sku;
        if (!skuMap[key]) {
          skuMap[key] = { sku: key, produto: item.produto, total: 0, pedidos: [] };
        }
        skuMap[key].total += item.quantidade;
        skuMap[key].pedidos.push(item.numero);
      }

      const skuList = Object.values(skuMap).sort((a, b) => a.sku.localeCompare(b.sku));

      // Gerar HTML de separação
      const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Lista de Separação — ${ids.length} pedidos</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 900px; margin: 20px auto; padding: 0 20px; color: #333; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { font-size: 12px; color: #888; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
  th { background: #1e293b; color: white; padding: 10px 12px; text-align: left; font-size: 13px; }
  td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
  tr:nth-child(even) { background: #f8fafc; }
  .qty { font-weight: 700; font-size: 16px; text-align: center; }
  .sku { font-family: monospace; font-weight: 600; }
  .check { width: 30px; text-align: center; }
  h2 { font-size: 16px; margin-top: 30px; color: #475569; }
  @media print { body { max-width: 100%; } button { display: none; } }
</style>
</head>
<body>
<h1>📦 Lista de Separação</h1>
<div class="meta">${new Date().toLocaleDateString('pt-BR')} — ${ids.length} pedidos, ${items.length} itens, ${skuList.length} SKUs distintos</div>
<button onclick="window.print()" style="background:#1e293b;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;margin-bottom:16px;">🖨 Imprimir</button>

<h2>Por SKU (para separar)</h2>
<table>
<thead><tr><th class="check">✓</th><th>SKU</th><th>Produto</th><th style="text-align:center;">Qtd Total</th><th>Pedidos</th></tr></thead>
<tbody>
${skuList.map(s => `<tr><td class="check"><input type="checkbox"></td><td class="sku">${s.sku}</td><td>${s.produto}</td><td class="qty">${s.total}</td><td style="font-size:11px;color:#888;">${s.pedidos.join(', ')}</td></tr>`).join('\n')}
</tbody>
</table>

<h2>Por Pedido (para conferência)</h2>
<table>
<thead><tr><th class="check">✓</th><th>Pedido</th><th>Canal</th><th>Cliente</th><th>SKU</th><th>Produto</th><th style="text-align:center;">Qtd</th></tr></thead>
<tbody>
${items.map(i => `<tr><td class="check"><input type="checkbox"></td><td style="font-family:monospace;">${i.numero}</td><td>${i.canal}</td><td>${i.clienteNome}</td><td class="sku">${i.sku}</td><td>${i.produto}</td><td class="qty">${i.quantidade}</td></tr>`).join('\n')}
</tbody>
</table>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  } else if (url.pathname === '/pedido/enviar-nf' && req.method === 'POST') {
    // Envia NF para o marketplace (Shopee ou ML)
    try {
      const body = await parseBody(req);
      const { orderSn, nfId, canal } = JSON.parse(body);
      if (!nfId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'nfId é obrigatório' }));
        return;
      }

      console.log(`[MANUAL] Enviando NF ${nfId} para ${canal} (pedido: ${orderSn})`);

      if (canal === 'Shopee') {
        if (!orderSn) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'orderSn é obrigatório para Shopee' }));
          return;
        }
        // Verifica se já foi enviada
        const check = await shopeeClient.checkOrderInvoice(orderSn);
        if (check.hasInvoice) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, jaEnviada: true, message: 'NF já estava registrada na Shopee' }));
          return;
        }
        // Busca XML da NF
        const xml = await tinyClient.getNFXml(nfId);
        if (!xml) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Não foi possível obter o XML da NF no Tiny' }));
          return;
        }
        // Envia para Shopee
        const result = await shopeeClient.uploadInvoiceDoc(orderSn, xml);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: result.success,
          message: result.success ? 'NF enviada com sucesso para a Shopee' : undefined,
          error: result.error,
        }));
      } else if (canal === 'Mercado Livre') {
        // ML: NF é vinculada automaticamente pelo Tiny se numero_pedido_ecommerce estiver correto
        // Mas podemos tentar via API do ML se disponível
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          message: 'Para Mercado Livre, a NF é vinculada automaticamente pelo Tiny. Verifique no painel do ML se apareceu.',
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Canal "${canal}" não suportado para envio de NF` }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  } else if (url.pathname === '/pedido/enviar-nf-individual' && req.method === 'POST') {
    // Envio individual de NF — busca pedido no Tiny, encontra NF, envia ao marketplace
    try {
      const body = await parseBody(req);
      const { orderNumber } = JSON.parse(body);
      if (!orderNumber || !orderNumber.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Número do pedido é obrigatório' }));
        return;
      }
      const num = orderNumber.trim();
      console.log(`[ENVIO-INDIVIDUAL] Enviando NF do pedido ${num}...`);

      // Busca pedido no Tiny por ecommerce number
      const matches = await tinyClient.searchByNumeroEcommerce(num);
      if (matches.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Pedido "${num}" não encontrado no Tiny` }));
        return;
      }
      const tinyOrder = matches[0];
      const tinyOrderId = tinyOrder.id;
      console.log(`[ENVIO-INDIVIDUAL] Pedido Tiny #${tinyOrder.numero} (ID ${tinyOrderId})`);

      // Busca detalhes do pedido para pegar id_nota_fiscal
      const detail = await tinyClient.getOrder(tinyOrderId);
      if (!detail.id_nota_fiscal) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Pedido ${num} encontrado no Tiny (#${detail.numero}) mas sem NF vinculada. Gere a NF primeiro.` }));
        return;
      }
      const nfId = detail.id_nota_fiscal;
      const nfDetail = await tinyClient.getNFDetails(nfId);
      const nfNumero = nfDetail.numero || nfId;
      console.log(`[ENVIO-INDIVIDUAL] NF encontrada: ${nfNumero} (ID ${nfId})`);

      // Determina canal pelo formato
      const isShopeeFormat = /^\d{6}(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,10}$/.test(num.toUpperCase());

      if (isShopeeFormat) {
        // Verifica se já enviada
        const check = await shopeeClient.checkOrderInvoice(num);
        if (check.hasInvoice) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: `NF já estava registrada na Shopee (pedido ${num})` }));
          return;
        }
        // Busca XML e envia
        const xml = await tinyClient.getNFXml(nfId);
        if (!xml) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Não foi possível obter o XML da NF no Tiny' }));
          return;
        }
        const result = await shopeeClient.uploadInvoiceDoc(num, xml);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: result.success,
          message: result.success ? `NF ${nfNumero} enviada com sucesso para a Shopee (pedido ${num})` : undefined,
          error: result.success ? undefined : result.error,
        }));
      } else {
        // ML: Tiny envia automaticamente
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          message: `Pedido ML ${num} — NF ${nfNumero} encontrada. O Tiny envia automaticamente para o Mercado Livre quando a NF tem o selo ecommerce.`,
        }));
      }
    } catch (err: any) {
      console.error(`[ENVIO-INDIVIDUAL] Erro: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
    }

  } else if (url.pathname === '/pedido/etiqueta' && req.method === 'POST') {
    // Gera etiqueta de envio
    try {
      const body = await parseBody(req);
      const { orderSn, canal, shipmentId } = JSON.parse(body);

      console.log(`[MANUAL] Gerando etiqueta para pedido ${orderSn} (canal: ${canal})`);

      if (canal === 'Shopee') {
        if (!orderSn) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'orderSn é obrigatório para Shopee' }));
          return;
        }
        const result = await shopeeClient.getShippingLabel(orderSn);
        if (result.success && result.pdf) {
          const buf = result.pdf;
          const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B;
          const contentType = isZip ? 'application/zip' : 'application/pdf';
          const ext = isZip ? 'zip' : 'pdf';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="etiqueta_${orderSn}.${ext}"`,
          });
          res.end(buf);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: result.error || 'Não foi possível gerar a etiqueta',
            steps: result.steps,
          }));
        }
      } else if (canal === 'Mercado Livre') {
        if (!shipmentId) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'shipmentId necessário para ML. Consulte o ID do envio no painel do ML.' }));
          return;
        }
        const result = await ml.downloadShippingLabels([parseInt(shipmentId)]);
        if (result.success && result.pdf) {
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="etiqueta_ml_${shipmentId}.pdf"`,
          });
          res.end(result.pdf);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: result.error || 'Não foi possível gerar a etiqueta' }));
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Canal "${canal}" não suportado` }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }

  } else if (url.pathname === '/pedido/processar' && req.method === 'GET') {
    // Página HTML do painel de processamento manual
    const tokenParam = url.searchParams.get('token') || '';
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SyncHub — Processar Pedido</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 13px; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 10px; border: 1px solid #e2e8f0; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 14px; text-transform: uppercase; color: #64748b; margin-bottom: 12px; letter-spacing: 0.5px; }
  .search-row { display: flex; gap: 10px; }
  .search-row input { flex: 1; padding: 10px 14px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; outline: none; }
  .search-row input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
  .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 6px; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-blue { background: #3b82f6; color: #fff; }
  .btn-blue:hover:not(:disabled) { background: #2563eb; }
  .btn-green { background: #16a34a; color: #fff; }
  .btn-green:hover:not(:disabled) { background: #15803d; }
  .btn-orange { background: #ea580c; color: #fff; }
  .btn-orange:hover:not(:disabled) { background: #c2410c; }
  .btn-sm { padding: 7px 14px; font-size: 13px; }
  .msg { padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; display: none; }
  .msg-ok { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
  .msg-err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .msg-info { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-blue { background: #dbeafe; color: #1d4ed8; }
  .badge-green { background: #dcfce7; color: #166534; }
  .badge-orange { background: #ffedd5; color: #c2410c; }
  .badge-gray { background: #f1f5f9; color: #64748b; }
  .badge-purple { background: #f3e8ff; color: #7c3aed; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f1f5f9; }
  th { color: #64748b; font-size: 11px; text-transform: uppercase; font-weight: 600; }
  .steps { display: flex; flex-direction: column; gap: 0; }
  .step { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #f1f5f9; position: relative; }
  .step:last-child { border-bottom: none; }
  .step-num { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; flex-shrink: 0; }
  .step-pending .step-num { background: #f1f5f9; color: #94a3b8; }
  .step-done .step-num { background: #dcfce7; color: #16a34a; }
  .step-active .step-num { background: #dbeafe; color: #2563eb; }
  .step-error .step-num { background: #fef2f2; color: #dc2626; }
  .step-info { flex: 1; }
  .step-title { font-weight: 600; font-size: 14px; }
  .step-detail { font-size: 12px; color: #64748b; margin-top: 2px; }
  .step-action { flex-shrink: 0; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #e2e8f0; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .hidden { display: none !important; }
  .back-link { display: inline-block; margin-bottom: 16px; color: #3b82f6; text-decoration: none; font-size: 13px; font-weight: 500; }
  .back-link:hover { text-decoration: underline; }
</style></head><body>
<a href="/?token=${tokenParam}" class="back-link">\u2190 Voltar ao Dashboard</a>
<h1>Processar Pedido</h1>
<p class="subtitle">Insira o Order SN (Shopee) ou n\u00ba do pedido (ML/Tiny) para buscar e gerar NF.</p>

<div class="card">
  <h2>Processar Pedido Individual</h2>
  <div class="search-row">
    <input type="text" id="inputNumero" placeholder="Order SN Shopee ou n\u00ba pedido ML/Tiny" onkeydown="if(event.key==='Enter')processarAuto()">
    <button class="btn btn-green" id="btnProcessar" onclick="processarAuto()" style="min-width:180px;">Processar Pedido</button>
    <button class="btn btn-blue btn-sm" id="btnBuscar" onclick="buscar()" title="Buscar sem processar (modo manual)">Buscar</button>
  </div>
  <p style="margin-top:8px;font-size:12px;color:#94a3b8;">Processar = busca no Tiny + gera NF (Tiny envia automaticamente para o marketplace)</p>
  <div id="msgBusca" class="msg" style="margin-top:12px;"></div>
</div>

<div id="autoResult" class="card hidden">
  <h2>Resultado do Processamento</h2>
  <div id="autoResultContent"></div>
</div>

<div id="pedidoInfo" class="card hidden">
  <h2>Dados do Pedido</h2>
  <div id="pedidoDetalhes"></div>
</div>

<div id="pedidoSteps" class="card hidden">
  <h2>Etapas do Processamento</h2>
  <div class="steps" id="stepsContainer"></div>
</div>

<script>
var authToken = '${tokenParam}';
var authHeaders = { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' };
var pedidoAtual = null;

function showMsg(id, text, type) {
  var el = document.getElementById(id);
  el.className = 'msg msg-' + type;
  el.textContent = text;
  el.style.display = 'block';
}
function hideMsg(id) { document.getElementById(id).style.display = 'none'; }

var searchCache = {};
var autoRetryTimer = null;

async function processarAuto() {
  var input = document.getElementById('inputNumero').value.trim();
  if (!input) { showMsg('msgBusca', 'Insira o Order SN (Shopee) ou nº do pedido (ML/Tiny)', 'err'); return; }
  hideMsg('msgBusca');
  document.getElementById('pedidoInfo').classList.add('hidden');
  document.getElementById('pedidoSteps').classList.add('hidden');

  var btn = document.getElementById('btnProcessar');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Processando...';
  document.getElementById('btnBuscar').disabled = true;

  var resultDiv = document.getElementById('autoResult');
  var contentDiv = document.getElementById('autoResultContent');

  var isShopee = /^\\d{6}[A-Z0-9]{8,10}$/.test(input.toUpperCase());

  if (isShopee) {
    // Shopee: pipeline completo via processar-unico
    var orderSn = input.toUpperCase();
    contentDiv.innerHTML = '<div style="text-align:center;padding:20px;"><span class="spinner" style="width:24px;height:24px;"></span><p style="margin-top:8px;color:#64748b;font-size:13px;">Processando pedido ' + orderSn + '...<br>Buscando no Tiny, gerando NF, enviando para Shopee...</p></div>';
    resultDiv.classList.remove('hidden');
    try {
      var r = await fetch('/pedido/processar-unico', { method: 'POST', headers: authHeaders, body: JSON.stringify({ orderSn: orderSn }) });
      var d = await r.json();
    } catch(e) {
      contentDiv.innerHTML = '<div class="msg msg-err" style="display:block;">Erro de conexão: ' + e.message + '</div>';
      btn.disabled = false; btn.innerHTML = 'Processar Pedido'; document.getElementById('btnBuscar').disabled = false;
      return;
    }
  } else {
    // ML / Tiny ID: busca no Tiny + gera NF via gerar-nf
    contentDiv.innerHTML = '<div style="text-align:center;padding:20px;"><span class="spinner" style="width:24px;height:24px;"></span><p style="margin-top:8px;color:#64748b;font-size:13px;">Processando pedido ' + input + '...<br>Buscando no Tiny e gerando NF...</p></div>';
    resultDiv.classList.remove('hidden');
    try {
      var r2 = await fetch('/pedido/gerar-nf', { method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: input }) });
      var d2 = await r2.json();
      // Adapta resposta de /pedido/gerar-nf para o formato de steps
      // Backend retorna { ok, found, nfId, numero, chaveAcesso, valorNota, clienteNome, tinyNumero } no nível raiz
      var d = { steps: [], success: false, nf: null, tinyNumero: d2.tinyNumero, tinyId: d2.tinyId, clienteNome: d2.clienteNome };
      var wasFound = d2.found || d2.ok || d2.nfId;
      var foundDetail = 'Pedido encontrado' + (d2.tinyNumero ? ' — #' + d2.tinyNumero : '') + (d2.canal ? ' (' + d2.canal + ')' : '');
      d.steps.push({ step: 'Buscar no Tiny', ok: !!wasFound, detail: wasFound ? foundDetail : (d2.error || 'Não encontrado') });
      if (d2.ok && (d2.nfId || d2.numero)) {
        d.success = true;
        d.nf = { nfId: d2.nfId, numero: d2.numero, chaveAcesso: d2.chaveAcesso, valorNota: d2.valorNota };
        var nfLabel = d2.numero || d2.nfId;
        var nfDetail = 'NF ' + nfLabel + (d2.jaExistia ? ' (já existia)' : ' gerada e emitida');
        if (d2.descontoAplicado > 0) nfDetail += ' (desconto ' + d2.descontoAplicado + '% ' + (d2.canal || '') + ')';
        d.steps.push({ step: 'Nota Fiscal (NF-e)', ok: true, detail: nfDetail });
        d.steps.push({ step: 'Enviar NF ao Marketplace', ok: true, detail: 'Tiny envia automaticamente com selo ecommerce' });
        if (d2.discountDebug) d.steps.push({ step: 'Debug Desconto', ok: d2.descontoAplicado > 0, detail: d2.discountDebug });
      } else if (d2.error && wasFound) {
        d.steps.push({ step: 'Nota Fiscal (NF-e)', ok: false, detail: d2.error });
      } else if (d2.error) {
        // Não encontrou — o erro já aparece no step 1
      }
    } catch(e) {
      contentDiv.innerHTML = '<div class="msg msg-err" style="display:block;">Erro de conexão: ' + e.message + '</div>';
      btn.disabled = false; btn.innerHTML = 'Processar Pedido'; document.getElementById('btnBuscar').disabled = false;
      return;
    }
  }

  // Renderizar resultado (d foi definido em ambos os paths acima)
  try {
    if (d.error && !d.steps) {
      contentDiv.innerHTML = '<div class="msg msg-err" style="display:block;">' + d.error + '</div>';
      return;
    }

    var h = '';
    var nfGerada = d.nf && (d.nf.chaveAcesso || d.nf.nfId);
    var envioFalhou = !d.nfSent && nfGerada;

    if (d.success) {
      h += '<div class="msg msg-ok" style="display:block;margin-bottom:14px;">Pedido processado com sucesso!</div>';
    } else if (nfGerada && envioFalhou) {
      h += '<div class="msg msg-info" style="display:block;margin-bottom:14px;">NF gerada com sucesso, mas o envio autom\u00e1tico para o marketplace falhou. Use a planilha XLSX no dashboard para enviar em lote.</div>';
    } else {
      h += '<div class="msg msg-err" style="display:block;margin-bottom:14px;">Processamento parou com erro. Veja os detalhes abaixo.</div>';
    }

    if (d.tinyNumero || d.clienteNome) {
      h += '<div style="margin-bottom:12px;font-size:13px;color:#64748b;">';
      if (d.tinyNumero) h += 'Pedido Tiny: <strong>#' + d.tinyNumero + '</strong> (ID ' + d.tinyId + ')';
      if (d.clienteNome) h += ' &mdash; ' + d.clienteNome;
      h += '</div>';
    }

    h += '<div class="steps">';
    (d.steps || []).forEach(function(s, i) {
      var cls = s.ok ? 'step-done' : 'step-error';
      var icon = s.ok ? '\\u2705' : '\\u274C';
      h += '<div class="step ' + cls + '">';
      h += '<div class="step-num">' + (i + 1) + '</div>';
      h += '<div class="step-info"><div class="step-title">' + icon + ' ' + s.step + '</div><div class="step-detail">' + s.detail + '</div></div>';
      h += '</div>';
    });
    h += '</div>';

    if (nfGerada) {
      h += '<div style="margin-top:14px;padding:12px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;font-size:13px;">';
      h += '<strong>NF:</strong> ' + (d.nf.numero || d.nf.nfId) + ' &mdash; R$ ' + (d.nf.valorNota || 0).toFixed(2);
      if (d.nf.chaveAcesso) {
        h += '<br><strong>Chave:</strong> <span style="font-family:monospace;font-size:11px;word-break:break-all;">' + d.nf.chaveAcesso + '</span>';
      }
      h += '</div>';
    }

    if (nfGerada) {
      h += '<div style="margin-top:10px;padding:10px 12px;background:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;font-size:12px;color:#1e40af;">';
      h += '<strong>Integra\u00e7\u00e3o:</strong> ';
      if (d.csvAdded) {
        h += 'Planilha CSV/XLSX atualizada &mdash; ';
      } else {
        h += '<span style="color:#dc2626;">CSV N\u00c3O atualizado (verifique logs)</span> &mdash; ';
      }
      if (d.checklistAdded) {
        h += 'Checklist atualizado';
      }
      if (d.nfSent) {
        h += ' &mdash; Relat\u00f3rio de separa\u00e7\u00e3o dispon\u00edvel';
      } else {
        h += ' &mdash; <span style="color:#dc2626;">NF n\u00e3o enviada para marketplace \u2014 envie antes de gerar etiqueta</span>';
      }
      h += '</div>';
    }

    contentDiv.innerHTML = h;
  } catch(e) {
    contentDiv.innerHTML = '<div class="msg msg-err" style="display:block;">Erro: ' + e.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Processar Pedido';
    document.getElementById('btnBuscar').disabled = false;
  }
}

async function buscar(isAutoRetry) {
  var numero = document.getElementById('inputNumero').value.trim();
  if (!numero) return;
  if (autoRetryTimer) { clearInterval(autoRetryTimer); autoRetryTimer = null; }
  hideMsg('msgBusca');

  // Cache local: se já buscou esse pedido com sucesso, usa o cache
  if (searchCache[numero] && !isAutoRetry) {
    pedidoAtual = searchCache[numero];
    renderPedido(pedidoAtual);
    renderSteps(pedidoAtual);
    return;
  }

  document.getElementById('btnBuscar').disabled = true;
  document.getElementById('btnBuscar').innerHTML = '<span class="spinner"></span> Buscando no Tiny...';
  document.getElementById('pedidoInfo').classList.add('hidden');
  document.getElementById('pedidoSteps').classList.add('hidden');
  try {
    var r = await fetch('/pedido/buscar', { method: 'POST', headers: authHeaders, body: JSON.stringify({ numero: numero }) });
    var d = await r.json();
    if (!d.ok) {
      var isTiny = (d.error || '').indexOf('sobrecarregado') >= 0 || (d.error || '').indexOf('Tiny') >= 0;
      if (isTiny) {
        // Auto-retry com countdown de 10 segundos
        var secs = 10;
        showMsg('msgBusca', 'Tiny temporariamente indisponível. Tentando novamente em ' + secs + 's...', 'info');
        autoRetryTimer = setInterval(function() {
          secs--;
          if (secs <= 0) {
            clearInterval(autoRetryTimer); autoRetryTimer = null;
            buscar(true);
          } else {
            showMsg('msgBusca', 'Tiny temporariamente indisponível. Tentando novamente em ' + secs + 's...', 'info');
          }
        }, 1000);
      } else {
        showMsg('msgBusca', d.error || 'Pedido não encontrado', 'err');
      }
      return;
    }
    pedidoAtual = d.pedido;
    searchCache[numero] = d.pedido; // Cacheia resultado
    renderPedido(d.pedido);
    renderSteps(d.pedido);
  } catch(e) { showMsg('msgBusca', 'Erro: ' + e.message, 'err'); }
  finally {
    document.getElementById('btnBuscar').disabled = false;
    document.getElementById('btnBuscar').innerHTML = 'Buscar';
  }
}

function renderPedido(p) {
  var canalBadge = p.canal === 'Shopee' ? 'badge-blue' : p.canal === 'Mercado Livre' ? 'badge-orange' : 'badge-gray';
  var h = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">';
  h += '<span class="badge ' + canalBadge + '">' + p.canal + '</span>';
  h += '<span class="badge badge-purple">' + p.situacao + '</span>';
  h += '<span style="font-size:12px;color:#94a3b8;">ID Tiny: ' + p.numero + '</span>';
  h += '</div>';
  h += '<table>';
  h += '<tr><td style="width:140px;color:#64748b;font-weight:500;">N\u00ba E-commerce</td><td><strong>' + (p.numero_ecommerce || '-') + '</strong></td></tr>';
  h += '<tr><td style="color:#64748b;font-weight:500;">Cliente</td><td>' + p.cliente.nome + '</td></tr>';
  h += '<tr><td style="color:#64748b;font-weight:500;">Localidade</td><td>' + p.cliente.cidade + '/' + p.cliente.uf + '</td></tr>';
  h += '<tr><td style="color:#64748b;font-weight:500;">Data</td><td>' + p.data_pedido + '</td></tr>';
  h += '<tr><td style="color:#64748b;font-weight:500;">Total</td><td>R$ ' + parseFloat(p.total_pedido).toFixed(2) + '</td></tr>';
  h += '</table>';
  if (p.itens && p.itens.length > 0) {
    h += '<div style="margin-top:12px;"><strong style="font-size:12px;color:#64748b;">ITENS:</strong></div>';
    h += '<table style="margin-top:4px;">';
    h += '<thead><tr><th>SKU</th><th>Produto</th><th style="text-align:center;">Qtd</th><th style="text-align:right;">Valor Unit.</th></tr></thead><tbody>';
    p.itens.forEach(function(it) {
      h += '<tr><td>' + (it.codigo || '-') + '</td><td>' + it.descricao + '</td><td style="text-align:center;">' + it.quantidade + '</td><td style="text-align:right;">R$ ' + parseFloat(it.valor_unitario).toFixed(2) + '</td></tr>';
    });
    h += '</tbody></table>';
  }
  document.getElementById('pedidoDetalhes').innerHTML = h;
  document.getElementById('pedidoInfo').classList.remove('hidden');
}

function renderSteps(p) {
  var steps = [
    { id: 'step1', num: 1, title: 'Pedido encontrado', detail: '', done: true },
    { id: 'step2', num: 2, title: 'Nota Fiscal (NF-e)', detail: '', done: p.temNF, actionLabel: 'Gerar NF', actionFn: 'gerarNF' },
    { id: 'step3', num: 3, title: 'Enviar NF ao Marketplace', detail: '', done: p.nfEnviada, actionLabel: 'Enviar NF', actionFn: 'enviarNF' },
    { id: 'step4', num: 4, title: 'Etiqueta de Envio', detail: '', done: false, actionLabel: 'Gerar Etiqueta', actionFn: 'gerarEtiqueta' },
  ];

  // Step 1 details
  steps[0].detail = 'Pedido ' + (p.numero_ecommerce || p.numero) + ' — ' + p.canal;

  // Step 2 details
  if (p.temNF && p.nf) {
    steps[1].detail = 'NF ' + (p.nf.numero || '') + ' — ' + (p.nf.situacao || '') + (p.nf.chaveAcesso ? ' — Chave: ...' + p.nf.chaveAcesso.slice(-8) : '');
  } else if (!p.id && p.canal === 'Shopee') {
    steps[1].detail = 'Pedido não encontrado no Tiny — clique para buscar e gerar NF';
  } else {
    steps[1].detail = 'Nenhuma NF vinculada a este pedido';
  }

  // Step 3 details
  if (p.nfEnviada) {
    steps[2].detail = 'NF j\u00e1 registrada no marketplace';
  } else if (!p.temNF) {
    steps[2].detail = 'Gere a NF primeiro (etapa 2)';
  } else {
    // NF gerada via gerar.nota.fiscal.pedido preserva o selo — Tiny auto-envia
    steps[2].detail = 'Tiny envia NF automaticamente para ' + p.canal;
    steps[2].done = true;
  }

  // Step 4
  steps[3].detail = 'Gera e baixa o PDF da etiqueta de envio';

  var h = '';
  steps.forEach(function(s) {
    var cls = s.done ? 'step-done' : 'step-pending';
    var icon = s.done ? '\u2705' : '\u2B1C';
    h += '<div class="step ' + cls + '" id="' + s.id + '">';
    h += '<div class="step-num">' + s.num + '</div>';
    h += '<div class="step-info"><div class="step-title">' + icon + ' ' + s.title + '</div><div class="step-detail" id="' + s.id + '-detail">' + s.detail + '</div></div>';
    if (s.actionFn) {
      var disabled = '';
      if (s.id === 'step3' && !p.temNF) disabled = ' disabled';
      if (s.id === 'step2' && p.temNF) disabled = ' disabled';
      var btnClass = s.id === 'step2' ? 'btn-green' : s.id === 'step3' ? 'btn-orange' : 'btn-blue';
      h += '<div class="step-action"><button class="btn ' + btnClass + ' btn-sm" id="btn-' + s.id + '" onclick="' + s.actionFn + '()"' + disabled + '>' + s.actionLabel + '</button></div>';
    }
    h += '</div>';
  });
  document.getElementById('stepsContainer').innerHTML = h;
  document.getElementById('pedidoSteps').classList.remove('hidden');
}

function setStepState(stepId, state, detail) {
  var el = document.getElementById(stepId);
  el.className = 'step step-' + state;
  var titleEl = el.querySelector('.step-title');
  var icon = state === 'done' ? '\u2705' : state === 'error' ? '\u274C' : state === 'active' ? '\u23F3' : '\u2B1C';
  titleEl.innerHTML = icon + ' ' + titleEl.textContent.replace(/^[\\S]+ /, '');
  if (detail) document.getElementById(stepId + '-detail').textContent = detail;
}

function setStepLoading(stepId, label) {
  var btn = document.getElementById('btn-' + stepId);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + label; }
  setStepState(stepId, 'active', 'Processando...');
}

function setStepDone(stepId, detail) {
  var btn = document.getElementById('btn-' + stepId);
  if (btn) { btn.disabled = true; btn.innerHTML = '\\u2705 Conclu\\u00eddo'; }
  setStepState(stepId, 'done', detail);
}

function setStepError(stepId, detail) {
  var btn = document.getElementById('btn-' + stepId);
  if (btn) { btn.disabled = false; btn.innerHTML = 'Tentar novamente'; }
  setStepState(stepId, 'error', detail);
}

var _nfBusy = false;
async function gerarNF() {
  if (_nfBusy) return;
  if (!pedidoAtual) return;
  if (pedidoAtual.temNF) {
    setStepDone('step2', 'NF já gerada — ' + (pedidoAtual.nf ? pedidoAtual.nf.numero : ''));
    return;
  }
  _nfBusy = true;
  var btn2 = document.getElementById('btn-step2');
  if (btn2) btn2.disabled = true;
  try { await _gerarNFInternal(); } finally { _nfBusy = false; }
}
async function _gerarNFInternal() {
  // Se não tem ID do Tiny mas tem numero_ecommerce
  if (!pedidoAtual.id && pedidoAtual.numero_ecommerce) {
    // Shopee: pipeline completo via processar-unico (busca no Tiny por data + gera NF)
    if (pedidoAtual.canal === 'Shopee') {
      setStepLoading('step2', 'Buscando no Tiny + gerando NF...');
      try {
        var r2 = await fetch('/pedido/processar-unico', { method: 'POST', headers: authHeaders, body: JSON.stringify({ orderSn: pedidoAtual.numero_ecommerce }) });
        var d2 = await r2.json();
        if (d2.nf) {
          var nfMsg = 'NF ' + (d2.nf.numero || '') + ' — Chave: ...' + (d2.nf.chaveAcesso || '').slice(-8) + (d2.nf.valorNota ? ' — R$ ' + d2.nf.valorNota.toFixed(2) : '');
          setStepDone('step2', nfMsg);
          pedidoAtual.temNF = true;
          pedidoAtual.id = d2.tinyId || '';
          pedidoAtual.nf = d2.nf;
          // Step 3: Tiny auto-envia
          setStepDone('step3', 'NF gerada com selo ecommerce — Tiny envia automaticamente.');
        } else {
          var errDetail = 'Falha ao gerar NF';
          if (d2.steps) {
            var failedStep = d2.steps.filter(function(s) { return !s.ok; });
            if (failedStep.length > 0) errDetail = failedStep[failedStep.length - 1].detail;
          } else if (d2.error) {
            errDetail = d2.error;
          }
          setStepError('step2', errDetail);
        }
      } catch(e) { setStepError('step2', 'Erro: ' + e.message); }
      return;
    }
    // ML e outros: tenta gerar-nf com numero_ecommerce (busca por ecommerce no backend)
    setStepLoading('step2', 'Gerando NF...');
    try {
      var r3 = await fetch('/pedido/gerar-nf', { method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: pedidoAtual.numero_ecommerce, canal: pedidoAtual.canal }) });
      var d3 = await r3.json();
      if (d3.ok) {
        var msg3 = 'NF ' + (d3.numero || '') + (d3.jaExistia ? ' (j\u00e1 existia)' : ' gerada') + (d3.chaveAcesso ? ' — Chave: ...' + d3.chaveAcesso.slice(-8) : '') + (d3.valorNota ? ' — R$ ' + d3.valorNota.toFixed(2) : '');
        setStepDone('step2', msg3);
        pedidoAtual.temNF = true;
        pedidoAtual.nf = { nfId: d3.nfId, numero: d3.numero, chaveAcesso: d3.chaveAcesso, valorNota: d3.valorNota };
        if (pedidoAtual.canal === 'Mercado Livre') {
          setStepDone('step3', 'ML: Tiny envia NF automaticamente.');
        }
      } else {
        setStepError('step2', d3.error || 'Erro ao gerar NF');
      }
    } catch(e) { setStepError('step2', 'Erro: ' + e.message); }
    return;
  }
  if (!pedidoAtual.id) {
    setStepError('step2', 'Pedido não encontrado no Tiny. Verifique se foi importado.');
    return;
  }
  setStepLoading('step2', 'Gerando...');
  try {
    var r = await fetch('/pedido/gerar-nf', { method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: pedidoAtual.id, canal: pedidoAtual.canal }) });
    var d = await r.json();
    if (d.ok) {
      var msg = 'NF ' + (d.numero || '') + (d.jaExistia ? ' (j\u00e1 existia)' : ' gerada') + ' — ' + (d.chaveAcesso ? 'Chave: ...' + d.chaveAcesso.slice(-8) : '') + (d.valorNota ? ' — R$ ' + d.valorNota.toFixed(2) : '');
      setStepDone('step2', msg);
      pedidoAtual.temNF = true;
      pedidoAtual.nf = { nfId: d.nfId, numero: d.numero, chaveAcesso: d.chaveAcesso, situacao: d.situacao || 'Autorizada', valorNota: d.valorNota };
      // NF gerada via gerar.nota.fiscal.pedido → Tiny auto-envia
      setStepDone('step3', 'NF gerada com selo ecommerce — Tiny envia automaticamente.');
    } else {
      setStepError('step2', d.error || 'Erro ao gerar NF');
    }
  } catch(e) { setStepError('step2', 'Erro: ' + e.message); }
}

async function enviarNF() {
  if (!pedidoAtual || !pedidoAtual.nf) return;
  setStepLoading('step3', 'Enviando...');
  try {
    var r = await fetch('/pedido/enviar-nf', { method: 'POST', headers: authHeaders, body: JSON.stringify({
      orderSn: pedidoAtual.numero_ecommerce,
      nfId: pedidoAtual.nf.nfId,
      canal: pedidoAtual.canal,
    })});
    var d = await r.json();
    if (d.ok) {
      setStepDone('step3', d.message || 'NF enviada com sucesso');
      pedidoAtual.nfEnviada = true;
    } else {
      setStepError('step3', d.error || 'Erro ao enviar NF');
    }
  } catch(e) { setStepError('step3', 'Erro: ' + e.message); }
}

async function gerarEtiqueta() {
  if (!pedidoAtual) return;
  setStepLoading('step4', 'Gerando...');
  try {
    var r = await fetch('/pedido/etiqueta', { method: 'POST', headers: authHeaders, body: JSON.stringify({
      orderSn: pedidoAtual.numero_ecommerce,
      canal: pedidoAtual.canal,
    })});
    var contentType = r.headers.get('content-type') || '';
    if (contentType.includes('application/pdf')) {
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'etiqueta_' + (pedidoAtual.numero_ecommerce || 'pedido') + '.pdf'; a.click();
      URL.revokeObjectURL(url);
      setStepDone('step4', 'Etiqueta gerada e baixada com sucesso');
    } else {
      var d = await r.json();
      var errMsg = d.error || 'Erro ao gerar etiqueta';
      if (d.steps) {
        errMsg += ' | Passos: ' + d.steps.map(function(s){ return s.step + '(' + (s.ok?'OK':'ERRO') + ')'; }).join(', ');
      }
      setStepError('step4', errMsg);
    }
  } catch(e) { setStepError('step4', 'Erro: ' + e.message); }
}
</script>
</body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(config.port, () => {
  console.log(`[SERVER] Health check em http://localhost:${config.port}/health`);
});

async function runBot(dataInicial?: string, dataFinal?: string, skipBlockCheck = false, orderSnRange?: OrderSnRange) {
  if (isRunning) return;
  isRunning = true;
  const mode = dataInicial ? `reprocessamento ${dataInicial} a ${dataFinal}` : 'verificação';
  if (skipBlockCheck) console.log(`[BOT] Execucao manual - ignorando bloqueio de horario`);
  if (orderSnRange) console.log(`[BOT] Filtro order_sn: de=${orderSnRange.from || '*'} até=${orderSnRange.to || '*'}`);
  console.log(`\n[${new Date().toLocaleString('pt-BR')}] Iniciando ${mode}...`);

  try {
    const result = await processNewShopeeOrders(dataInicial, dataFinal, skipBlockCheck, orderSnRange);
    lastResult = result;
    lastRun = new Date();
    totalOrdersSynced += result.found;
    totalNFsEmitted += result.nfGenerated;
    // Acumula NFs no histórico
    if (result.nfs && result.nfs.length > 0) {
      nfHistory.unshift(...result.nfs);
      if (nfHistory.length > MAX_NF_HISTORY) {
        nfHistory.splice(MAX_NF_HISTORY);
      }
      // Salva CSV para upload em massa na Shopee
      appendToShopeeCSV(result.nfs);
      // Adiciona ao checklist
      addToChecklist(result.nfs, 'Shopee');
    }
  } catch (err) {
    console.error('[ERRO] Falha na execução:', err);
    lastResult = { error: String(err) };
  } finally {
    isRunning = false;
    // Processa fila de reprocessamento
    if (pendingReprocess) {
      const { de, ate } = pendingReprocess;
      pendingReprocess = null;
      console.log(`[BOT] Processando reprocessamento enfileirado: ${de || 'ontem'} a ${ate || 'hoje'}`);
      clearProcessedOrders();
      runBot(de, ate);
    }
  }
}

async function runMLBot(date: string, mode: 'coleta' | 'pedido' = 'coleta') {
  if (mlIsRunning) return;
  mlIsRunning = true;
  console.log(`\n[${new Date().toLocaleString('pt-BR')}] Iniciando processamento ML — modo=${mode} data=${date}...`);
  try {
    const result = mode === 'coleta'
      ? await processMercadoLivreByCollectionDate(date)
      : await processMercadoLivreOrdersForDate(date);
    mlLastResult = { date, mode, ...result };
    totalOrdersSynced += result.found;
    totalNFsEmitted += result.nfGenerated;
    if (result.nfs && result.nfs.length > 0) {
      const tagged = result.nfs.map(n => ({ ...n, _canal: 'Mercado Livre' } as any));
      nfHistory.unshift(...tagged);
      if (nfHistory.length > MAX_NF_HISTORY) nfHistory.splice(MAX_NF_HISTORY);
      // Adiciona ao checklist
      addToChecklist(result.nfs, 'Mercado Livre');
    }
  } catch (err) {
    console.error('[ML-BOT] Falha na execução:', err);
    mlLastResult = { date, mode, error: String(err) };
  } finally {
    mlIsRunning = false;
  }
}

// Agenda execução a cada N minutos (respects pause)
const cronExpression = `*/${config.pollIntervalMinutes} * * * *`;
cron.schedule(cronExpression, () => {
  if (automationPaused) {
    console.log('[BOT] Automação pausada — ciclo automático ignorado');
    return;
  }
  runBot();
});

// Agenda ML automático: a cada 10 minutos, processa pedidos ML do dia (modo pedido, data de hoje)
const ML_AUTO_INTERVAL = 10; // minutos
cron.schedule(`*/${ML_AUTO_INTERVAL} * * * *`, () => {
  if (automationPaused) return;
  // Usa data de hoje no formato DD/MM/YYYY
  const now = new Date();
  const today = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  console.log(`[ML-AUTO] Execução automática — processando pedidos ML de ${today}`);
  runMLBot(today, 'pedido');
});

// Executa imediatamente na primeira vez (se não pausado)
if (automationPaused) {
  console.log('[BOT] Automação iniciada em modo PAUSADO — painel ativo, sync automático desligado');
} else {
  runBot();
}

function getLoginHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — SyncHub Integrações</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-card { background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 50px 40px; width: 440px; max-width: 90vw; }
    .login-logo { text-align: center; margin-bottom: 30px; }
    .login-logo .icon { font-size: 48px; margin-bottom: 10px; }
    .login-logo h1 { font-size: 24px; color: #1a1a2e; font-weight: 800; letter-spacing: -0.5px; }
    .login-logo .subtitle { font-size: 13px; color: #0f3460; margin-top: 4px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; }
    .login-logo p { font-size: 14px; color: #888; margin-top: 8px; }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    .form-group input { width: 100%; padding: 14px 16px; border: 2px solid #e8e8e8; border-radius: 10px; font-size: 15px; outline: none; transition: border-color 0.2s; }
    .form-group input:focus { border-color: #0f3460; }
    .btn-login { width: 100%; padding: 15px; background: linear-gradient(135deg, #0f3460, #1a1a2e); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; transition: transform 0.1s, box-shadow 0.2s; }
    .btn-login:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(15,52,96,0.4); }
    .btn-login:active { transform: translateY(0); }
    .error { background: #fff3f0; border: 1px solid #ffccc7; color: #cf1322; padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 20px; text-align: center; }
    .footer { text-align: center; margin-top: 25px; font-size: 11px; color: #bbb; }
    .integrations-preview { display: flex; justify-content: center; gap: 18px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #f0f0f0; }
    .integrations-preview .int-badge { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #888; background: #f8f9fa; padding: 6px 12px; border-radius: 20px; }
    .integrations-preview .int-badge .dot { width: 8px; height: 8px; border-radius: 50%; background: #52c41a; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="login-logo">
      <div class="icon">🔄</div>
      <h1>SyncHub</h1>
      <div class="subtitle">Hub de Integrações ERP</div>
      <p>Plataforma de integração para marketplaces e ERPs</p>
    </div>
    <div id="errorBox" class="error" style="display:none;"></div>
    <form id="loginForm" onsubmit="doLogin(event)">
      <div class="form-group">
        <label>Usuário</label>
        <input type="text" id="username" placeholder="Digite seu usuário" required autofocus>
      </div>
      <div class="form-group">
        <label>Senha</label>
        <input type="password" id="password" placeholder="Digite sua senha" required>
      </div>
      <button type="submit" class="btn-login" id="btnLogin">Entrar</button>
    </form>
    <div class="integrations-preview">
      <div class="int-badge"><span class="dot"></span> Shopee</div>
      <div class="int-badge"><span class="dot"></span> Mercado Livre</div>
      <div class="int-badge"><span class="dot"></span> Tiny ERP</div>
    </div>
    <div class="footer">SyncHub v3.98 — Integrador de Marketplaces e ERPs</div>
  </div>
  <script>
    if (localStorage.getItem('auth_token')) { window.location.href = '/'; }
    async function doLogin(e) {
      e.preventDefault();
      var btn = document.getElementById('btnLogin');
      var errBox = document.getElementById('errorBox');
      errBox.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Entrando...';
      try {
        var r = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        var d = await r.json();
        if (d.ok && d.token) {
          localStorage.setItem('auth_token', d.token);
          window.location.href = '/';
        } else {
          errBox.textContent = d.error || 'Login falhou';
          errBox.style.display = 'block';
        }
      } catch(err) {
        errBox.textContent = 'Erro de conexão: ' + err.message;
        errBox.style.display = 'block';
      }
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  </script>
</body>
</html>`;
}

function getDashboardHtml(): string {
  const statusText = isRunning ? 'Sincronizando...' : 'Operacional';
  const statusIcon = isRunning ? '🔄' : '🟢';
  const lastRunText = lastRun?.toLocaleString('pt-BR') || 'Aguardando primeira execução';
  const uptimeHours = Math.floor(process.uptime() / 3600);
  const uptimeMin = Math.floor((process.uptime() % 3600) / 60);
  const startDateStr = startTime.toLocaleDateString('pt-BR');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SyncHub — Hub de Integrações ERP</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #1a1a2e; min-height: 100vh; }

    /* Sidebar */
    .sidebar { position: fixed; top: 0; left: 0; width: 240px; height: 100vh; background: #1a1a2e; color: white; padding: 0; overflow-y: auto; z-index: 100; }
    .sidebar .logo { padding: 24px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .sidebar .logo h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
    .sidebar .logo .sub { font-size: 11px; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1.5px; margin-top: 3px; }
    .sidebar nav { padding: 16px 0; }
    .sidebar nav a { display: flex; align-items: center; gap: 12px; padding: 12px 20px; color: rgba(255,255,255,0.6); text-decoration: none; font-size: 14px; font-weight: 500; transition: all 0.15s; border-left: 3px solid transparent; }
    .sidebar nav a:hover { background: rgba(255,255,255,0.05); color: white; }
    .sidebar nav a.active { background: rgba(255,255,255,0.08); color: white; border-left-color: #4fc3f7; }
    .sidebar nav a .icon { font-size: 18px; width: 24px; text-align: center; }
    .sidebar nav .section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(255,255,255,0.3); padding: 20px 20px 8px; font-weight: 700; }
    .sidebar .sidebar-footer { position: absolute; bottom: 0; left: 0; right: 0; padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 11px; color: rgba(255,255,255,0.3); }

    /* Main content */
    .main { margin-left: 240px; min-height: 100vh; }
    .topbar { background: white; border-bottom: 1px solid #e4e7eb; padding: 0 32px; display: flex; align-items: center; height: 60px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .topbar .page-title { font-size: 16px; font-weight: 700; color: #1a1a2e; }
    .topbar .nav-right { margin-left: auto; display: flex; align-items: center; gap: 20px; }
    .topbar .nav-right .user { font-size: 13px; color: #666; display: flex; align-items: center; gap: 6px; }
    .topbar .nav-right a { font-size: 13px; color: #e74c3c; text-decoration: none; font-weight: 600; }

    .container { padding: 28px 32px; max-width: 1200px; }

    /* Stats */
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 28px; }
    .stat-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .stat-card .stat-icon { font-size: 28px; margin-bottom: 8px; }
    .stat-card .stat-value { font-size: 26px; font-weight: 800; color: #1a1a2e; }
    .stat-card .stat-label { font-size: 12px; color: #999; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .stat-card .stat-sub { font-size: 11px; color: #bbb; margin-top: 4px; }

    /* Cards */
    .card { background: white; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); margin-bottom: 24px; overflow: hidden; }
    .card-header { padding: 18px 24px; border-bottom: 1px solid #f0f0f0; font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 10px; color: #1a1a2e; }
    .card-header .card-badge { margin-left: auto; font-size: 11px; font-weight: 600; padding: 4px 12px; border-radius: 20px; }
    .card-body { padding: 24px; }

    /* Integrations Grid */
    .int-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
    .int-card { border: 1px solid #e8ecf0; border-radius: 12px; padding: 24px; transition: box-shadow 0.2s; position: relative; }
    .int-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
    .int-card .int-header { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
    .int-card .int-logo { width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
    .int-card .int-logo.shopee { background: #fff1ee; }
    .int-card .int-logo.ml { background: #fff8e1; }
    .int-card .int-logo.tiny { background: #e8f5e9; }
    .int-card .int-name { font-size: 16px; font-weight: 700; }
    .int-card .int-type { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .int-card .int-status-badge { position: absolute; top: 16px; right: 16px; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 20px; }
    .int-card .int-status-badge.active { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
    .int-card .int-features { list-style: none; margin-top: 12px; }
    .int-card .int-features li { font-size: 13px; color: #555; padding: 5px 0; display: flex; align-items: center; gap: 8px; }
    .int-card .int-features li .check { color: #16a34a; font-weight: bold; }
    .int-card .int-meta { display: flex; gap: 16px; margin-top: 14px; padding-top: 14px; border-top: 1px solid #f0f0f0; }
    .int-card .int-meta-item { font-size: 11px; color: #999; }
    .int-card .int-meta-item strong { color: #555; }

    /* Buttons */
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: #0f3460; color: white; }
    .btn-primary:hover:not(:disabled) { background: #0a2647; }
    .btn-secondary { background: #f0f0f0; color: #555; }
    .btn-secondary:hover:not(:disabled) { background: #e0e0e0; }
    .btn-sm { padding: 6px 14px; font-size: 13px; }

    /* Forms */
    .inline-form { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
    .form-sm label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; font-weight: 500; }
    .form-sm input { padding: 9px 12px; border: 2px solid #e8e8e8; border-radius: 8px; font-size: 14px; width: 140px; outline: none; }
    .form-sm input:focus { border-color: #0f3460; }

    /* Table */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #fafafa; text-align: left; padding: 10px 12px; border-bottom: 2px solid #f0f0f0; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; }
    td { padding: 10px 12px; border-bottom: 1px solid #f5f5f5; }
    tr:hover { background: #fafafa; }
    .chave { font-family: 'Courier New', monospace; font-size: 11px; word-break: break-all; max-width: 200px; color: #555; }
    .btn-copy { padding: 4px 12px; font-size: 12px; border: 1px solid #0f3460; background: white; color: #0f3460; border-radius: 6px; cursor: pointer; font-weight: 500; }
    .btn-copy:hover { background: #f0f4ff; }
    .btn-copy.copied { background: #f0fdf4; border-color: #16a34a; color: #16a34a; }

    /* Logs */
    .log-container { max-height: 280px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 12px; background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 16px; }
    .log-entry { padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .log-time { color: #64748b; }
    .log-info { color: #38bdf8; }
    .log-warn { color: #fbbf24; }
    .log-error { color: #f87171; }

    /* Messages */
    .msg { padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; display: none; }
    .msg-ok { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
    .msg-err { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
    .empty { text-align: center; color: #ccc; padding: 30px; font-size: 14px; }

    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
    .badge-orange { background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa; }
    .badge-blue { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }

    /* Sync flow diagram */
    .sync-flow { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 20px; background: #f8fafc; border-radius: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .sync-flow .flow-node { background: white; border: 2px solid #e2e8f0; border-radius: 10px; padding: 12px 18px; text-align: center; min-width: 120px; }
    .sync-flow .flow-node .flow-icon { font-size: 24px; margin-bottom: 4px; }
    .sync-flow .flow-node .flow-label { font-size: 12px; font-weight: 700; color: #1a1a2e; }
    .sync-flow .flow-node .flow-sub { font-size: 10px; color: #999; }
    .sync-flow .flow-arrow { font-size: 20px; color: #94a3b8; }

    .step-number { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: #0f3460; color: white; font-size: 12px; font-weight: 700; margin-right: 6px; }
    .tab-bar { display: flex; gap: 0; border-bottom: 2px solid #e8ecf0; margin-bottom: 20px; }
    .tab-bar .tab-btn { padding: 10px 20px; font-size: 14px; font-weight: 600; color: #888; background: none; border: none; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.15s; }
    .tab-bar .tab-btn:hover { color: #555; }
    .tab-bar .tab-btn.active { color: #0f3460; border-bottom-color: #0f3460; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    @media (max-width: 900px) {
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .stats { grid-template-columns: 1fr 1fr; }
      .int-grid { grid-template-columns: 1fr; }
      .sync-flow { flex-direction: column; }
    }
  </style>
</head>
<body>
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="logo">
      <h1>🔄 SyncHub</h1>
      <div class="sub">Hub de Integrações ERP</div>
    </div>
    <nav>
      <a href="#" class="active"><span class="icon">📊</span> Dashboard</a>
      <a href="#integracoes"><span class="icon">🔗</span> Integrações</a>
      <div class="section-label">Fluxo Operacional</div>
      <a href="#step-pedidos"><span class="icon">📦</span> 1. Listar Pedidos</a>
      <a href="#step-emitir"><span class="icon">📄</span> 2. Emitir Notas</a>
      <a href="#step-enviar"><span class="icon">📤</span> 3. Enviar Notas</a>
      <a href="#step-etiquetas"><span class="icon">🏷️</span> 4. Etiquetas</a>
      <div class="section-label">Consultas</div>
      <a href="#nfs"><span class="icon">📋</span> Histórico NFs</a>
      <a href="#checklist"><span class="icon">✅</span> Checklist</a>
      <div class="section-label">Sistema</div>
      <a href="#logs"><span class="icon">📄</span> Logs</a>
    </nav>
    <div class="sidebar-footer">SyncHub v3.98<br>Integrador ERP/HUB</div>
  </div>

  <!-- Main -->
  <div class="main">
    <div class="topbar">
      <div class="page-title">Dashboard</div>
      <div class="nav-right">
        <span class="user">👤 ${config.demoUser}</span>
        <a href="#" onclick="localStorage.removeItem('auth_token');window.location.href='/logout';return false;">Sair</a>
      </div>
    </div>

    <div class="container">
      <!-- Stats -->
      <div class="stats">
        <div class="stat-card">
          <div class="stat-icon">${statusIcon}</div>
          <div class="stat-value" id="statusText" style="font-size:16px;">${statusText}</div>
          <div class="stat-label">Status do Serviço</div>
          <div class="stat-sub">Uptime: ${uptimeHours}h ${uptimeMin}m</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🔗</div>
          <div class="stat-value">3</div>
          <div class="stat-label">Integrações Ativas</div>
          <div class="stat-sub">Shopee · Mercado Livre · Tiny ERP</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📦</div>
          <div class="stat-value" id="totalOrders">${totalOrdersSynced}</div>
          <div class="stat-label">Pedidos Sincronizados</div>
          <div class="stat-sub">Marketplaces → ERP</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📋</div>
          <div class="stat-value" id="totalNFs">${totalNFsEmitted}</div>
          <div class="stat-label">Notas Fiscais</div>
          <div class="stat-sub">Emitidas na SEFAZ</div>
        </div>
      </div>

      <!-- Integrations Section -->
      <div class="card" id="integracoes">
        <div class="card-header">
          🔗 Integrações
          <span class="card-badge badge-green">3 ativas</span>
        </div>
        <div class="card-body">
          <div class="int-grid">
            <!-- Shopee -->
            <div class="int-card">
              <div class="int-status-badge active"><span>●</span> Ativo</div>
              <div class="int-header">
                <div class="int-logo shopee">🛒</div>
                <div>
                  <div class="int-name">Shopee</div>
                  <div class="int-type">Marketplace</div>
                </div>
              </div>
              <ul class="int-features">
                <li><span class="check">✓</span> Importação automática de pedidos</li>
                <li><span class="check">✓</span> Sincronização de status</li>
                <li><span class="check">✓</span> Emissão automática de NF-e</li>
                <li><span class="check">✓</span> Captura de chave de acesso SEFAZ</li>
              </ul>
              <div class="int-meta">
                <div class="int-meta-item">Tipo: <strong>API REST</strong></div>
                <div class="int-meta-item">Sync: <strong>A cada ${config.pollIntervalMinutes} min</strong></div>
                <div class="int-meta-item">Desde: <strong>${startDateStr}</strong></div>
              </div>
            </div>

            <!-- Mercado Livre -->
            <div class="int-card" id="mlCard">
              <div class="int-status-badge active" id="mlStatusBadge"><span>●</span> Ativo</div>
              <div class="int-header">
                <div class="int-logo ml">🏪</div>
                <div>
                  <div class="int-name">Mercado Livre</div>
                  <div class="int-type">Marketplace</div>
                </div>
              </div>
              <ul class="int-features">
                <li><span class="check">✓</span> OAuth 2.0 autenticado</li>
                <li><span class="check">✓</span> NF-e com ${config.mlDiscountPercent}% de desconto (CPF)</li>
                <li><span class="check">✓</span> Processamento por data específica</li>
                <li><span class="check">✓</span> Filtro automático Pessoa Física</li>
              </ul>
              <div class="int-meta">
                <div class="int-meta-item">Tipo: <strong>API REST / OAuth</strong></div>
                <div class="int-meta-item">Desconto: <strong>${config.mlDiscountPercent}%</strong></div>
                <div class="int-meta-item" id="mlConnMeta">Status: <strong>...</strong></div>
              </div>
              <div style="margin-top:14px;" id="mlActionBox">
                <a href="/ml/connect" class="btn btn-primary btn-sm" id="btnMLConnect" style="text-decoration:none;display:none;">🔗 Conectar conta Mercado Livre</a>
              </div>
            </div>

            <!-- Tiny ERP -->
            <div class="int-card">
              <div class="int-status-badge active"><span>●</span> Ativo</div>
              <div class="int-header">
                <div class="int-logo tiny">📦</div>
                <div>
                  <div class="int-name">Tiny ERP (Olist)</div>
                  <div class="int-type">ERP / Gestão</div>
                </div>
              </div>
              <ul class="int-features">
                <li><span class="check">✓</span> Gestão centralizada de pedidos</li>
                <li><span class="check">✓</span> Emissão de notas fiscais (NF-e)</li>
                <li><span class="check">✓</span> Controle de estoque unificado</li>
                <li><span class="check">✓</span> Cadastro de produtos multi-canal</li>
              </ul>
              <div class="int-meta">
                <div class="int-meta-item">Tipo: <strong>API V2</strong></div>
                <div class="int-meta-item">Token: <strong>${config.tinyToken.slice(0, 6)}...${config.tinyToken.slice(-4)}</strong></div>
                <div class="int-meta-item">Desde: <strong>${startDateStr}</strong></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== PASSO 1: LISTAR PEDIDOS ===== -->
      <div class="card" id="step-pedidos">
        <div class="card-header"><span class="step-number">1</span> Listar Pedidos <span class="card-badge badge-blue">Shopee + ML</span></div>
        <div class="card-body">
          <span id="sync"></span>
          <span id="ml-sync"></span>
          <p style="font-size:13px; color:#64748b; margin-bottom:16px;">Consulte os pedidos do período antes de processar. Visualize o status de cada pedido e decida quando gerar as NFs.</p>

          <!-- Filtros de data -->
          <div style="padding:14px 18px; background:#f8fafc; border-radius:10px; border:1px solid #e2e8f0; margin-bottom:16px;">
            <p style="font-size:13px; color:#475569; margin-bottom:10px; font-weight:600;">Período de Consulta</p>
            <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end;">
              <div class="form-sm">
                <label>Data Inicial</label>
                <input type="text" id="listDe" placeholder="dd/mm/aaaa" maxlength="10">
              </div>
              <div class="form-sm">
                <label>Data Final</label>
                <input type="text" id="listAte" placeholder="dd/mm/aaaa" maxlength="10">
              </div>
              <div class="form-sm">
                <label>Marketplace</label>
                <select id="listMarketplace" style="padding:6px 10px; border:1px solid #e2e8f0; border-radius:6px; font-size:13px; background:#fff;">
                  <option value="">Todos</option>
                  <option value="shopee">Shopee</option>
                  <option value="ml">Mercado Livre</option>
                </select>
              </div>
              <button class="btn btn-primary" id="btnListOrders" onclick="listarPedidos()">📋 Listar Pedidos</button>
            </div>
            <div style="font-size:11px; color:#94a3b8; margin-top:8px;">Dica: deixe as datas em branco para listar pedidos de ontem e hoje</div>
          </div>

          <div id="msgListOrders" class="msg msg-ok"></div>

          <!-- Resumo (aparece após listar) -->
          <div id="listOrdersResumo" style="display:none; margin-bottom:16px;">
            <div style="display:flex; gap:12px; flex-wrap:wrap;" id="listResumoCards"></div>
          </div>

          <!-- Tabela de pedidos -->
          <div id="listOrdersTableWrap" style="display:none; margin-bottom:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
              <div style="display:flex; gap:6px;">
                <button class="tab-btn active" onclick="filtrarTabelaPedidos('todos')" id="filtroTodos">Todos</button>
                <button class="tab-btn" onclick="filtrarTabelaPedidos('shopee')" id="filtroShopee">🛒 Shopee</button>
                <button class="tab-btn" onclick="filtrarTabelaPedidos('ml')" id="filtroML">🏪 ML</button>
                <button class="tab-btn" onclick="filtrarTabelaPedidos('pendentes')" id="filtroPendentes">Pendentes</button>
              </div>
              <span style="font-size:12px; color:#94a3b8;" id="listOrdersCount"></span>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; padding:8px 12px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0;">
              <button id="btnSelectAll" onclick="selecionarTodosVisiveis()" style="background:#1e293b; color:white; border:none; padding:6px 14px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">☑ Selecionar Todos</button>
              <button onclick="clearSelection()" style="background:none; border:1px solid #cbd5e1; padding:6px 14px; border-radius:6px; font-size:12px; cursor:pointer; color:#64748b;">✕ Limpar</button>
              <span id="selectionCount" style="font-size:12px; color:#64748b; margin-left:auto;"></span>
            </div>
            <div style="max-height:500px; overflow-y:auto; border:1px solid #e2e8f0; border-radius:8px;">
              <table style="width:100%; border-collapse:collapse; font-size:13px;">
                <thead style="position:sticky; top:0; background:#f8fafc; z-index:1;">
                  <tr>
                    <th style="padding:10px 8px; text-align:center; border-bottom:2px solid #e2e8f0; width:36px;"><input type="checkbox" id="selectAllCheck" onchange="toggleSelectAll(this)" title="Selecionar todos"></th>
                    <th style="padding:10px 12px; text-align:left; border-bottom:2px solid #e2e8f0; font-weight:600; color:#475569;">Canal</th>
                    <th style="padding:10px 12px; text-align:left; border-bottom:2px solid #e2e8f0; font-weight:600; color:#475569;">Pedido Ecommerce</th>
                    <th style="padding:10px 12px; text-align:left; border-bottom:2px solid #e2e8f0; font-weight:600; color:#475569;">N° Tiny</th>
                    <th style="padding:10px 12px; text-align:left; border-bottom:2px solid #e2e8f0; font-weight:600; color:#475569;">Data</th>
                    <th style="padding:10px 12px; text-align:left; border-bottom:2px solid #e2e8f0; font-weight:600; color:#475569;">Cliente</th>
                    <th style="padding:10px 12px; text-align:right; border-bottom:2px solid #e2e8f0; font-weight:600; color:#475569;">Valor</th>
                    <th style="padding:10px 12px; text-align:center; border-bottom:2px solid #e2e8f0; font-weight:600; color:#475569;">Status</th>
                    <th style="padding:10px 12px; text-align:center; border-bottom:2px solid #e2e8f0; font-weight:600; color:#475569;">NF</th>
                  </tr>
                </thead>
                <tbody id="listOrdersBody"></tbody>
              </table>
            </div>
          </div>

          <!-- Barra de ações batch (aparece ao selecionar pedidos) -->
          <div id="batchBar" style="display:none; position:sticky; bottom:0; z-index:10; background:linear-gradient(135deg,#1e293b,#0f172a); color:white; padding:12px 20px; border-radius:10px; margin-top:12px; align-items:center; gap:12px; box-shadow:0 -4px 20px rgba(0,0,0,0.15);">
            <span id="batchCount" style="font-weight:700; font-size:14px; min-width:120px;">0 selecionados</span>
            <button class="btn btn-sm" onclick="batchGerarNF()" style="background:#16a34a; color:white; border:none; padding:8px 16px; border-radius:6px; font-weight:600; font-size:12px; cursor:pointer;">📝 Gerar NFs</button>
            <button class="btn btn-sm" onclick="batchGerarEEnviar()" style="background:#2563eb; color:white; border:none; padding:8px 16px; border-radius:6px; font-weight:600; font-size:12px; cursor:pointer;">📝📤 NFs + Enviar</button>
            <button class="btn btn-sm" onclick="batchEtiquetas()" style="background:#7c3aed; color:white; border:none; padding:8px 16px; border-radius:6px; font-weight:600; font-size:12px; cursor:pointer;">🏷 Etiquetas</button>
            <button class="btn btn-sm" onclick="batchSeparacao()" style="background:#d97706; color:white; border:none; padding:8px 16px; border-radius:6px; font-weight:600; font-size:12px; cursor:pointer;">📦 Separação</button>
            <button onclick="clearSelection()" style="background:none; border:1px solid rgba(255,255,255,0.3); color:white; padding:6px 12px; border-radius:6px; font-size:11px; cursor:pointer; margin-left:auto;">✕ Limpar</button>
          </div>

          <!-- Modal de progresso batch -->
          <div id="batchModal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
            <div style="background:white; border-radius:16px; padding:30px; width:600px; max-width:90vw; max-height:80vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.3);">
              <h3 style="margin:0 0 8px 0; font-size:18px;" id="batchModalTitle">Processando...</h3>
              <div style="margin-bottom:16px;">
                <div style="background:#e2e8f0; border-radius:8px; height:8px; overflow:hidden;">
                  <div id="batchProgressBar" style="background:linear-gradient(90deg,#16a34a,#22c55e); height:100%; width:0%; transition:width 0.3s;"></div>
                </div>
                <div style="font-size:12px; color:#64748b; margin-top:4px;" id="batchProgressText">0/0</div>
              </div>
              <div id="batchProgressList" style="font-size:13px; line-height:1.8;"></div>
              <div id="batchResumo" style="display:none; margin-top:16px; padding:12px; background:#f0fdf4; border-radius:8px; border:1px solid #bbf7d0;"></div>
              <div style="margin-top:16px; text-align:right;">
                <button id="batchModalClose" onclick="closeBatchModal()" style="background:#f1f5f9; border:1px solid #e2e8f0; padding:8px 20px; border-radius:8px; font-size:13px; cursor:pointer; font-weight:600;">Fechar</button>
              </div>
            </div>
          </div>

          <!-- Ações após listar (aparecem após listar) -->
          <div id="listOrdersActions" style="display:none;">
            <hr style="border:none; border-top:1px solid #e2e8f0; margin: 16px 0;">
            <details style="margin-bottom:12px;">
            <summary style="font-size:13px; color:#475569; font-weight:600; cursor:pointer; padding:8px 0;">⚙ Controles Avançados (automação, sync manual)</summary>

            <div class="tab-bar" style="margin-bottom:14px;">
              <button class="tab-btn active" onclick="switchTab('processar','shopee')">🛒 Shopee</button>
              <button class="tab-btn" onclick="switchTab('processar','ml')">🏪 Mercado Livre</button>
            </div>

            <!-- Processar Shopee -->
            <div class="tab-pane active" id="processar-shopee">
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; padding:10px 14px; background:${automationPaused ? '#fffbeb' : '#f0fdf4'}; border-radius:8px; border:1px solid ${automationPaused ? '#fde68a' : '#bbf7d0'};">
                <div>
                  <strong style="font-size:13px;">${automationPaused ? '⏸ Automação Pausada' : '▶ Automação Ativa'}</strong>
                  <div style="font-size:11px;color:#888;margin-top:2px;" id="autoLabel">${automationPaused ? 'Apenas sincronização manual' : 'Auto a cada ' + config.pollIntervalMinutes + ' min'}</div>
                </div>
                <button class="btn ${automationPaused ? 'btn-primary' : 'btn-secondary'} btn-sm" id="btnToggle" onclick="toggleAuto()" style="font-size:12px;">${automationPaused ? '▶ Ativar' : '⏸ Pausar'}</button>
              </div>
              <div id="msgToggle" class="msg msg-ok"></div>
              <div id="msgRun" class="msg msg-ok"></div>
              <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">
                <button class="btn btn-primary" id="btnSync" onclick="syncNow()">▶ Gerar NFs Shopee</button>
                <span style="font-size:12px; color:#999;">Processa pedidos pendentes do período e emite NF com desconto da lista de preço</span>
              </div>
              <div style="padding:10px 14px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:10px;">
                <p style="font-size:11px; color:#64748b; margin-bottom:6px; font-weight:600;">Filtro por N° do Pedido (opcional)</p>
                <div class="inline-form" style="margin-bottom:0;">
                  <div class="form-sm">
                    <label>De (Order SN)</label>
                    <input type="text" id="syncFromSn" placeholder="Ex: 260621MFN2GF8A" style="width:170px; text-transform:uppercase;">
                  </div>
                  <div class="form-sm">
                    <label>Até (Order SN)</label>
                    <input type="text" id="syncToSn" placeholder="Ex: 260623NNQ35E3G" style="width:170px; text-transform:uppercase;">
                  </div>
                </div>
              </div>
              <div id="msgReprocess" class="msg msg-ok"></div>
              <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                <button class="btn btn-secondary btn-sm" id="btnReprocess" onclick="reprocessar()">🔄 Reprocessar Período</button>
                <div class="form-sm" style="margin:0;">
                  <input type="text" id="de" placeholder="De dd/mm/aaaa" maxlength="10" style="width:120px;">
                </div>
                <div class="form-sm" style="margin:0;">
                  <input type="text" id="ate" placeholder="Até dd/mm/aaaa" maxlength="10" style="width:120px;">
                </div>
              </div>
              <div id="shopeeConnStatus" style="margin-top:10px; font-size:12px; color:#888;"></div>
            </div>

            <!-- Processar ML -->
            <div class="tab-pane" id="processar-ml">
              <span id="mlHeaderBadge" style="display:none;"></span>
              <div id="mlNotConnected" style="display:none; padding:14px; background:#fffbeb; border-radius:8px; border:1px solid #fde68a; margin-bottom:14px;">
                <strong style="font-size:13px;">⚠ Conta ML não conectada</strong>
                <div style="font-size:11px;color:#888;margin:4px 0 10px;">Autorize o SyncHub a acessar sua conta ML.</div>
                <a href="/ml/connect" class="btn btn-primary btn-sm" style="text-decoration:none;">🔗 Conectar</a>
              </div>
              <div id="mlConnected" style="display:none;">
                <div style="padding:10px 14px; background:#f0fdf4; border-radius:8px; border:1px solid #bbf7d0; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
                  <div>
                    <strong style="font-size:13px;">✓ Conta ML conectada</strong>
                    <div style="font-size:11px;color:#666;margin-top:2px;">Seller ID: <span id="mlSellerId" style="font-family:monospace;">...</span></div>
                  </div>
                  <button class="btn btn-secondary btn-sm" onclick="mlDisconnect()" style="font-size:12px;">Desconectar</button>
                </div>
                <p style="font-size:12px; color:#666; margin-bottom:12px;">
                  Gera NF por <strong>data de coleta</strong>. Apenas <strong>CPF</strong> (Pessoa Física), desconto da <strong>lista de preço</strong>.
                </p>
                <div id="msgML" class="msg msg-ok"></div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
                  <button class="btn btn-primary btn-sm" onclick="mlQuickRun('hoje')" id="btnMLHoje">📅 Coleta Hoje</button>
                  <button class="btn btn-primary btn-sm" onclick="mlQuickRun('amanha')" id="btnMLAmanha">📅 Coleta Amanhã</button>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px;">
                  <div class="form-sm" style="margin:0;">
                    <label>Data de coleta</label>
                    <input type="text" id="mlDate" placeholder="dd/mm/aaaa" maxlength="10">
                  </div>
                  <button class="btn btn-secondary btn-sm" id="btnML" onclick="processMLDay()">🏪 Gerar NFs</button>
                  <button class="btn btn-secondary btn-sm" onclick="mlDebug()" id="btnMLDebug">🔍 Inspecionar API</button>
                </div>
                <div id="mlLastResultBox" style="margin-top:12px; display:none;">
                  <p style="font-size:11px;color:#888;font-weight:600;margin-bottom:4px;">Último processamento ML:</p>
                  <pre id="mlLastResult" style="background:#f8fafc; padding:10px; border-radius:8px; font-size:11px; white-space:pre-wrap; border:1px solid #e2e8f0;"></pre>
                </div>
                <hr style="border:none; border-top:1px solid #f0f0f0; margin: 12px 0;">
                <p style="font-size:11px; color:#888; margin-bottom:8px; font-weight:600;">Inspecionar pedido ML</p>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <input type="text" id="mlInspectOrderId" placeholder="Nº pedido ML" style="width:220px; padding:6px 10px; border:1px solid #e2e8f0; border-radius:6px; font-size:12px; font-family:monospace;">
                  <button class="btn btn-secondary btn-sm" onclick="mlInspectOrder()" id="btnMLInspect">🔍 Inspecionar</button>
                </div>
                <div id="mlInspectResult" style="display:none; margin-top:8px;">
                  <pre id="mlInspectPre" style="background:#f8fafc; padding:10px; border-radius:8px; font-size:11px; white-space:pre-wrap; border:1px solid #e2e8f0; max-height:250px; overflow-y:auto;"></pre>
                </div>
              </div>
            </div>

            <hr style="border:none; border-top:1px solid #f0f0f0; margin: 16px 0;">
            <button class="btn btn-primary" onclick="openProcessarPedido()" style="background:#3b82f6;">Processar Pedido Individual</button>
            <span style="font-size:11px; color:#999; margin-left:8px;">Busca no Tiny + gera NF + envia para Shopee</span>
            </details>
          </div>

          <!-- Última execução -->
          <div style="display:flex; align-items:center; gap:12px; margin-top:12px; font-size:12px; color:#94a3b8;">
            <span>Última execução:</span>
            <span style="font-weight:600;" id="lastSync">${lastRunText}</span>
            <span id="autoStatus">${automationPaused ? '⏸ Pausada' : 'Auto a cada ' + config.pollIntervalMinutes + ' min'}</span>
          </div>
        </div>
      </div>

      <!-- ===== PASSO 2: EMITIR NOTAS ===== -->
      <div class="card" id="step-emitir">
        <div class="card-header"><span class="step-number">2</span> Emitir Notas Fiscais</div>
        <div class="card-body">
          <p style="font-size:13px; color:#64748b; margin-bottom:16px;">NFs são emitidas automaticamente ao sincronizar pedidos no Passo 1. O desconto é aplicado pela lista de preço do Tiny.</p>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
            <div style="padding:14px 18px; background:#fff1ee; border-radius:10px; border:1px solid #fed7aa;">
              <div style="font-size:14px; font-weight:700; margin-bottom:4px;">🛒 Shopee</div>
              <div style="font-size:12px; color:#666;">Desconto: <strong>${config.shopeeDiscountPercent}%</strong> (Lista de Preço SHOPEE)</div>
              <div style="font-size:11px; color:#999; margin-top:2px;">Emissão automática ao sincronizar no Passo 1</div>
            </div>
            <div style="padding:14px 18px; background:#fff8e1; border-radius:10px; border:1px solid #fde68a;">
              <div style="font-size:14px; font-weight:700; margin-bottom:4px;">🏪 Mercado Livre</div>
              <div style="font-size:12px; color:#666;">Desconto: <strong>${config.mlDiscountPercent}%</strong> (CPF, Lista de Preço ML)</div>
              <div style="font-size:11px; color:#999; margin-top:2px;">Emissão via Coleta Hoje/Amanhã no Passo 1</div>
            </div>
          </div>

          <hr style="border:none; border-top:1px solid #f0f0f0; margin: 16px 0;">
          <p style="font-size:13px; color:#888; margin-bottom:10px; font-weight:600;">Emitir NF Manual (por pedido)</p>
          <p style="font-size:12px; color:#aaa; margin-bottom:10px;">Gera NF a partir do pedido (preserva selo ecommerce). Aceita ID Tiny ou nº ecommerce (Shopee/ML).</p>
          <div id="msgTestLP" class="msg msg-ok"></div>
          <div style="display:flex; gap:8px; align-items:end; flex-wrap:wrap;">
            <div class="form-sm">
              <label>Nº Pedido (Tiny ou Ecommerce)</label>
              <input type="text" id="testLPPedidoId" placeholder="ex: 243787 ou 58466..." style="width:200px;">
            </div>
            <div class="form-sm">
              <label>Lista de Preço</label>
              <select id="testLPListaId" style="padding:6px 8px; border:1px solid #e2e8f0; border-radius:6px; font-size:13px;">
                <option value="0">Padrão (0)</option>
                <option value="418">SHOPEE (418)</option>
                <option value="419">ML (419)</option>
              </select>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="testListaPreco(false)" id="btnTestLP">🔍 Preview</button>
            <button class="btn btn-secondary btn-sm" onclick="testListaPreco(true)" id="btnCriarNF" style="background:#16a34a;">📄 Criar NF</button>
          </div>
          <div id="testLPResult" style="display:none; margin-top:10px;">
            <div id="testLPPreview"></div>
          </div>
        </div>
      </div>

      <!-- ===== PASSO 3: ENVIAR NOTAS ===== -->
      <div class="card" id="step-enviar">
        <div class="card-header"><span class="step-number">3</span> Enviar Notas para Marketplaces</div>
        <div class="card-body">
          <p style="font-size:13px; color:#64748b; margin-bottom:16px;">Envie as NFs emitidas para os marketplaces via API ou planilha.</p>

          <div class="tab-bar">
            <button class="tab-btn active" onclick="switchTab('enviar','shopee')">🛒 Shopee</button>
            <button class="tab-btn" onclick="switchTab('enviar','ml')">🏪 Mercado Livre</button>
          </div>

          <!-- Shopee Send Tab -->
          <div class="tab-pane active" id="enviar-shopee">
            <p style="font-size:13px; color:#888; margin-bottom:12px; font-weight:600;">Enviar NF Individual</p>
            <p style="font-size:12px; color:#aaa; margin-bottom:12px;">Insira o Order SN da Shopee para enviar a NF desse pedido.</p>
            <div id="msgEnvioIndividual" class="msg msg-ok"></div>
            <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin-bottom:16px;">
              <div class="form-sm">
                <label>Order SN / Nº Ecommerce</label>
                <input type="text" id="inputEnvioIndividual" placeholder="Ex: 260703MKBQ194J" style="min-width:200px;">
              </div>
              <button class="btn btn-primary btn-sm" id="btnEnvioIndividual" onclick="enviarNFIndividual()">📤 Enviar NF</button>
            </div>

            <hr style="border:none; border-top:1px solid #f0f0f0; margin: 16px 0;">
            <p style="font-size:13px; color:#888; margin-bottom:12px; font-weight:600;">Enviar NFs para a Shopee (retroativo / lote)</p>
            <p style="font-size:12px; color:#aaa; margin-bottom:12px;">Busca pedidos Shopee que já possuem NF emitida no Tiny e envia a chave de acesso via API.</p>
            <div id="msgShopeeNF" class="msg msg-ok"></div>
            <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin-bottom:16px;">
              <button class="btn btn-primary btn-sm" id="btnShopeeNF" onclick="sendNFsToShopee()">📤 Enviar NFs para Shopee</button>
              <div class="form-sm">
                <label>De (opcional)</label>
                <input type="text" id="shopeeNfDe" placeholder="dd/mm/aaaa" maxlength="10">
              </div>
              <div class="form-sm">
                <label>Até (opcional)</label>
                <input type="text" id="shopeeNfAte" placeholder="dd/mm/aaaa" maxlength="10">
              </div>
            </div>

            <hr style="border:none; border-top:1px solid #f0f0f0; margin: 16px 0;">
            <p style="font-size:13px; color:#888; margin-bottom:12px; font-weight:600;">Planilha para Upload em Massa</p>
            <p style="font-size:12px; color:#aaa; margin-bottom:12px;">Baixe a planilha com "ID do pedido" + "Chave de Acesso" para upload na aba "Enviar nota em massa" da Shopee.</p>
            <div id="msgCSV" class="msg msg-ok"></div>
            <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
              <button class="btn btn-primary btn-sm" onclick="downloadXLSX()" style="background:#16a34a;">📥 Baixar Planilha (.xlsx)</button>
              <button class="btn btn-secondary btn-sm" onclick="downloadCSV()">📥 Baixar CSV</button>
              <button class="btn btn-secondary btn-sm" onclick="clearCSV()">🗑 Limpar</button>
              <span id="csvInfo" style="font-size:12px; color:#888;"></span>
            </div>
          </div>

          <!-- ML Send Tab -->
          <div class="tab-pane" id="enviar-ml">
            <div style="padding:14px 18px; background:#f8fafc; border-radius:10px; border:1px solid #e2e8f0;">
              <p style="font-size:13px; color:#555;">O Tiny envia automaticamente a NF para o Mercado Livre quando o campo <strong>"Ecommerce"</strong> da nota está preenchido.</p>
              <p style="font-size:12px; color:#888; margin-top:6px;">A NF criada pelo SyncHub já inclui o campo ecommerce. Verifique no painel do Tiny se a integração com ML está ativa.</p>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== PASSO 4: ETIQUETAS & SEPARAÇÃO ===== -->
      <div class="card" id="step-etiquetas">
        <div class="card-header"><span class="step-number">4</span> Etiquetas & Separação</div>
        <div class="card-body">
          <div class="tab-bar">
            <button class="tab-btn active" onclick="switchTab('etiquetas','shopee')">🛒 Shopee</button>
            <button class="tab-btn" onclick="switchTab('etiquetas','ml')">🏪 Mercado Livre</button>
            <button class="tab-btn" onclick="switchTab('etiquetas','separacao')">📋 Separação</button>
          </div>

          <!-- Shopee Labels Tab -->
          <div class="tab-pane active" id="etiquetas-shopee">
            <span id="shopee-labels"></span>
            <p style="font-size:12px; color:#aaa; margin-bottom:12px;">Gere e baixe etiquetas de envio da Shopee.</p>
            <div id="msgLabel" class="msg msg-ok"></div>

            <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin-bottom:12px;">
              <div class="form-sm">
                <label>Order SN</label>
                <input type="text" id="labelOrderSn" placeholder="Ex: 260519S0A4X2H9" style="width:180px;">
              </div>
              <button class="btn btn-primary btn-sm" id="btnDownloadLabel" onclick="downloadLabel()">📦 Baixar Etiqueta</button>
              <button class="btn btn-secondary btn-sm" id="btnDiagnoseLabel" onclick="diagnoseLabel()">🔍 Diagnosticar</button>
              <button class="btn btn-secondary btn-sm" id="btnTestLogistics" onclick="testLogistics()">🧪 Testar API</button>
            </div>

            <div style="padding:12px 16px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:12px;">
              <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin-bottom:10px;">
                <div class="form-sm">
                  <label>De (Order SN)</label>
                  <input type="text" id="labelFromSn" placeholder="Ex: 260621..." style="width:170px; text-transform:uppercase;">
                </div>
                <div class="form-sm">
                  <label>Até (Order SN)</label>
                  <input type="text" id="labelToSn" placeholder="Ex: 260623..." style="width:170px; text-transform:uppercase;">
                </div>
                <span style="font-size:11px; color:#94a3b8; align-self:center;">Vazio = todos</span>
              </div>
              <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
                <button class="btn btn-primary btn-sm" id="btnListLabels" onclick="listAvailableLabels()">📋 Listar Pedidos</button>
                <button class="btn btn-primary btn-sm" id="btnBatchShopee" onclick="batchDownloadShopee()" style="background:#16a34a;">📥 Baixar Todas (PDF único)</button>
                <span id="labelsAvailableInfo" style="font-size:12px; color:#888;"></span>
              </div>
            </div>

            <div id="labelsListBox" style="display:none; margin-top:8px; max-height:300px; overflow-y:auto;">
              <table id="labelsTable"><thead><tr><th>Order SN</th><th>Status</th><th>NF</th><th>Ação</th></tr></thead><tbody id="labelsTableBody"></tbody></table>
            </div>

            <div id="logisticsResult" style="display:none; margin-top:8px;">
              <pre id="logisticsResultPre" style="background:#f8fafc; padding:12px; border-radius:8px; font-size:12px; white-space:pre-wrap; border:1px solid #e2e8f0; max-height:250px; overflow-y:auto;"></pre>
            </div>
          </div>

          <!-- ML Labels Tab -->
          <div class="tab-pane" id="etiquetas-ml">
            <span id="ml-labels"></span>
            <div id="mlLabelsNotConnected" style="display:none; padding:16px; background:#fffbeb; border-radius:8px; border:1px solid #fde68a; margin-bottom:16px;">
              <strong style="font-size:14px;">⚠ Conta ML não conectada</strong>
              <div style="font-size:12px;color:#888;margin:6px 0 12px;">Conecte a conta ML no Passo 1 para baixar etiquetas.</div>
            </div>
            <div id="mlLabelsConnected" style="display:none;">
              <p style="font-size:12px; color:#aaa; margin-bottom:12px;">Baixe etiquetas de envio dos pedidos do Mercado Livre.</p>
              <div id="msgMLLabel" class="msg msg-ok"></div>

              <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:12px; padding:12px 16px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0;">
                <label style="font-size:12px; color:#666;">Pedido:</label>
                <input type="text" id="mlLabelOrderId" placeholder="Nº do pedido ML" style="width:180px; padding:4px 8px; border:1px solid #e2e8f0; border-radius:4px; font-size:12px;">
                <button class="btn btn-primary btn-sm" id="btnMLLabelByOrder" onclick="downloadMLLabelByOrder()">📦 Baixar Etiqueta</button>
                <span style="color:#ccc; font-size:12px;">|</span>
                <label style="font-size:12px; color:#666;">Período:</label>
                <select id="mlDaysBack" style="padding:4px 8px; border:1px solid #e2e8f0; border-radius:4px; font-size:12px;">
                  <option value="1">1 dia</option>
                  <option value="3" selected>3 dias</option>
                  <option value="7">7 dias</option>
                </select>
                <button class="btn btn-primary btn-sm" id="btnListMLLabels" onclick="listMLLabels()">📋 Listar</button>
                <button class="btn btn-primary btn-sm" id="btnBatchML" onclick="batchDownloadML()" style="background:#16a34a;">📥 Baixar Todas</button>
                <span id="mlLabelsInfo" style="font-size:12px; color:#888;"></span>
              </div>

              <div id="mlLabelsListBox" style="display:none; margin-top:8px; max-height:300px; overflow-y:auto;">
                <table id="mlLabelsTable"><thead><tr><th>Pedido</th><th>Shipment</th><th>Status</th><th>Valor</th><th>Ação</th></tr></thead><tbody id="mlLabelsTableBody"></tbody></table>
              </div>

              <div id="mlLabelResult" style="display:none; margin-top:8px;">
                <pre id="mlLabelResultPre" style="background:#f8fafc; padding:12px; border-radius:8px; font-size:12px; white-space:pre-wrap; border:1px solid #e2e8f0; max-height:250px; overflow-y:auto;"></pre>
              </div>
            </div>
          </div>

          <!-- Separação Tab -->
          <div class="tab-pane" id="etiquetas-separacao">
            <p style="font-size:13px; color:#888; margin-bottom:12px; font-weight:600;">Relatório de Separação (Picking List)</p>
            <p style="font-size:12px; color:#aaa; margin-bottom:12px;">Puxa da Shopee API todos os pedidos prontos para envio. Mostra SKU, produto e quantidade para separação no estoque.</p>
            <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;">
              <div class="form-sm">
                <label>De (Order SN)</label>
                <input type="text" id="pickFromSn" placeholder="Ex: 260621..." style="width:170px; text-transform:uppercase;">
              </div>
              <div class="form-sm">
                <label>Até (Order SN)</label>
                <input type="text" id="pickToSn" placeholder="Ex: 260623..." style="width:170px; text-transform:uppercase;">
              </div>
              <button class="btn btn-primary btn-sm" onclick="openPickingList()" style="background:#7c3aed;">📋 Gerar Relatório de Separação</button>
              <span style="font-size:11px; color:#94a3b8; align-self:center;">Vazio = todos os pedidos</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== CONSULTAS ===== -->

      <!-- NFs Table -->
      <div class="card" id="nfs">
        <div class="card-header">📋 Histórico de Notas Fiscais</div>
        <div class="card-body" style="padding: 12px 16px;">
          <div id="nfTable"><p class="empty">Nenhuma NF emitida ainda nesta sessão</p></div>
        </div>
      </div>

      <!-- Checklist -->
      <div class="card" id="checklist">
        <div class="card-header">✅ Checklist de Pedidos</div>
        <div class="card-body" style="padding: 12px 16px;">
          <p style="font-size:12px; color:#aaa; margin-bottom:12px;">Lista de conferência dos pedidos com NF emitida. Marque conforme for separando/enviando.</p>
          <div id="msgChecklist" class="msg msg-ok"></div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
            <button class="btn btn-primary btn-sm" onclick="loadChecklist()">🔄 Atualizar</button>
            <button class="btn btn-secondary btn-sm" onclick="toggleAllChecklist(true)">☑ Marcar Todos</button>
            <button class="btn btn-secondary btn-sm" onclick="toggleAllChecklist(false)">☐ Desmarcar Todos</button>
            <button class="btn btn-secondary btn-sm" onclick="clearCheckedItems()" style="background:#ef4444;color:#fff;">🗑 Limpar Marcados</button>
            <button class="btn btn-secondary btn-sm" onclick="printChecklist()">🖨 Imprimir</button>
            <label style="font-size:12px; color:#666; margin-left:8px;">
              <input type="checkbox" id="chkShowChecked" checked onchange="loadChecklist()"> Mostrar marcados
            </label>
            <span id="checklistInfo" style="font-size:12px; color:#888; margin-left:auto;"></span>
          </div>
          <div id="checklistTableBox" style="max-height:500px; overflow-y:auto;">
            <table id="checklistTable">
              <thead>
                <tr>
                  <th style="width:40px;">✓</th>
                  <th>NF</th>
                  <th>Pedido</th>
                  <th>Canal</th>
                  <th>Cliente</th>
                  <th>Valor</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody id="checklistTableBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ===== SISTEMA ===== -->

      <!-- Sync Logs -->
      <div class="card" id="logs">
        <div class="card-header">📄 Logs de Sincronização</div>
        <div class="card-body" style="padding: 12px;">
          <div class="log-container" id="logContainer">
            <div class="empty" style="color:#666;">Aguardando logs...</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    var authToken = localStorage.getItem('auth_token');
    if (!authToken) { window.location.href = '/login'; }
    var authHeaders = { 'Authorization': 'Bearer ' + authToken };

    function handleAuthError() {
      localStorage.removeItem('auth_token');
      window.location.href = '/login';
    }

    function showMsg(id, text, ok) {
      var el = document.getElementById(id);
      el.textContent = text;
      el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
      el.style.display = 'block';
      setTimeout(function() { el.style.display = 'none'; }, 8000);
    }

    function renderNFTable(nfs) {
      var c = document.getElementById('nfTable');
      if (!nfs || nfs.length === 0) { c.innerHTML = '<p class="empty">Nenhuma NF emitida ainda nesta sessão</p>'; return; }
      var h = '<table><thead><tr><th>NF</th><th>Pedido</th><th>Canal</th><th>Cliente</th><th>Valor</th><th>Chave de Acesso</th><th></th><th>Data</th></tr></thead><tbody>';
      for (var i = 0; i < nfs.length; i++) {
        var n = nfs[i];
        var canal = n._canal || 'Shopee';
        var canalBadge = canal === 'Mercado Livre' ? 'badge-orange' : 'badge-blue';
        h += '<tr>';
        h += '<td><strong>' + (n.numero || n.nfId) + '</strong></td>';
        h += '<td><span class="badge badge-orange">' + (n.numeroEcommerce || '-') + '</span></td>';
        h += '<td><span class="badge ' + canalBadge + '">' + canal + '</span></td>';
        h += '<td>' + (n.clienteNome || '-') + '</td>';
        h += '<td>R$ ' + (n.valorNota ? n.valorNota.toFixed(2) : '-') + '</td>';
        h += '<td class="chave">' + (n.chaveAcesso || 'N/A') + '</td>';
        h += '<td><button class="btn-copy" onclick="copiar(this,\\'' + (n.chaveAcesso || '') + '\\')">Copiar</button></td>';
        h += '<td style="font-size:11px;color:#999;">' + (n.dataProcessamento || '') + '</td>';
        h += '</tr>';
      }
      h += '</tbody></table>';
      c.innerHTML = h;
    }

    function renderLogs(logs) {
      var c = document.getElementById('logContainer');
      if (!logs || logs.length === 0) { c.innerHTML = '<div class="empty" style="color:#666;">Aguardando logs...</div>'; return; }
      var h = '';
      for (var i = 0; i < logs.length; i++) {
        var l = logs[i];
        var cls = l.level === 'error' ? 'log-error' : l.level === 'warn' ? 'log-warn' : 'log-info';
        h += '<div class="log-entry"><span class="log-time">[' + l.timestamp + ']</span> <span class="' + cls + '">' + escapeHtml(l.message) + '</span></div>';
      }
      c.innerHTML = h;
    }

    function escapeHtml(t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    function copiar(btn, text) {
      if (!text) return;
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = '✅ Copiado!';
        btn.classList.add('copied');
        setTimeout(function() { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 2000);
      });
    }

    function switchTab(group, tab) {
      var panes = document.querySelectorAll('[id^="' + group + '-"]');
      for (var i = 0; i < panes.length; i++) {
        if (panes[i].classList.contains('tab-pane')) panes[i].classList.remove('active');
      }
      var target = document.getElementById(group + '-' + tab);
      if (target) target.classList.add('active');
      var card = target ? target.closest('.card') : null;
      if (card) {
        var btns = card.querySelectorAll('.tab-bar .tab-btn');
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
      }
      if (event && event.target) event.target.classList.add('active');
    }

    // ===== LISTAR PEDIDOS (Passo 1) =====
    var _listOrdersData = []; // cache dos pedidos listados
    var _listOrdersFilter = 'todos';
    var _selectedOrders = {}; // Map: id → {id, numero, numero_ecommerce, canal}
    var _batchEventSource = null; // SSE connection for batch processing

    function _todayStr() {
      var d = new Date(); return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
    }
    function _yesterdayStr() {
      var d = new Date(); d.setDate(d.getDate()-1); return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
    }

    async function listarPedidos() {
      var de = (document.getElementById('listDe').value || '').trim() || _yesterdayStr();
      var ate = (document.getElementById('listAte').value || '').trim() || _todayStr();
      var mkt = document.getElementById('listMarketplace').value;
      if (!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(de) || !/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(ate)) {
        showMsg('msgListOrders', 'Formato de data inválido. Use dd/mm/aaaa', false); return;
      }
      var btn = document.getElementById('btnListOrders');
      btn.disabled = true; btn.textContent = '⏳ Consultando Tiny...';
      try {
        var qs = '?de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate);
        if (mkt) qs += '&marketplace=' + mkt;
        var r = await fetch('/api/list-orders' + qs, { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        if (!r.ok) { showMsg('msgListOrders', d.error || 'Erro ao listar', false); return; }

        _listOrdersData = d.pedidos || [];
        _selectedOrders = {}; // Limpar seleção ao listar novos pedidos
        var s = d.resumo;

        // Resumo cards
        var resumoHtml = '<div style="padding:10px 16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;min-width:100px;text-align:center;">'
          + '<div style="font-size:22px;font-weight:700;color:#16a34a;">' + s.total + '</div><div style="font-size:11px;color:#666;">Total</div></div>'
          + '<div style="padding:10px 16px;background:#fff1ee;border-radius:8px;border:1px solid #fed7aa;min-width:100px;text-align:center;">'
          + '<div style="font-size:22px;font-weight:700;color:#ea580c;">' + s.shopee + '</div><div style="font-size:11px;color:#666;">Shopee</div></div>'
          + '<div style="padding:10px 16px;background:#fff8e1;border-radius:8px;border:1px solid #fde68a;min-width:100px;text-align:center;">'
          + '<div style="font-size:22px;font-weight:700;color:#d97706;">' + s.ml + '</div><div style="font-size:11px;color:#666;">Mercado Livre</div></div>'
          + '<div style="padding:10px 16px;background:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;min-width:100px;text-align:center;">'
          + '<div style="font-size:22px;font-weight:700;color:#2563eb;">' + s.pendentes + '</div><div style="font-size:11px;color:#666;">Pendentes (sem NF)</div></div>'
          + '<div style="padding:10px 16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;min-width:100px;text-align:center;">'
          + '<div style="font-size:22px;font-weight:700;color:#16a34a;">' + s.comNF + '</div><div style="font-size:11px;color:#666;">Com NF</div></div>';
        document.getElementById('listResumoCards').innerHTML = resumoHtml;
        document.getElementById('listOrdersResumo').style.display = 'block';

        // Renderizar tabela
        _listOrdersFilter = 'todos';
        renderTabelaPedidos();
        document.getElementById('listOrdersTableWrap').style.display = 'block';
        document.getElementById('listOrdersActions').style.display = 'block';

        // Atualizar filtro buttons active
        document.querySelectorAll('#listOrdersTableWrap .tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.getElementById('filtroTodos').classList.add('active');

        showMsg('msgListOrders', 'Período ' + d.periodo.de + ' a ' + d.periodo.ate + ' — ' + s.total + ' pedidos encontrados (' + s.pendentes + ' pendentes)', true);
      } catch(e) { showMsg('msgListOrders', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '📋 Listar Pedidos';
    }

    function filtrarTabelaPedidos(filtro) {
      _listOrdersFilter = filtro;
      renderTabelaPedidos();
      updateBatchBar();
      document.querySelectorAll('#listOrdersTableWrap .tab-btn').forEach(function(b) { b.classList.remove('active'); });
      var btnId = { todos: 'filtroTodos', shopee: 'filtroShopee', ml: 'filtroML', pendentes: 'filtroPendentes' }[filtro];
      if (btnId) document.getElementById(btnId).classList.add('active');
    }

    function renderTabelaPedidos() {
      var data = _listOrdersData;
      if (_listOrdersFilter === 'shopee') data = data.filter(function(o) { return o.canal === 'Shopee'; });
      else if (_listOrdersFilter === 'ml') data = data.filter(function(o) { return o.canal === 'Mercado Livre'; });
      else if (_listOrdersFilter === 'pendentes') data = data.filter(function(o) { return !o.temNF; });

      document.getElementById('listOrdersCount').textContent = data.length + ' pedidos';
      var selectBtn = document.getElementById('btnSelectAll');
      if (selectBtn) selectBtn.textContent = '☑ Selecionar Todos (' + data.length + ')';

      var html = '';
      for (var i = 0; i < data.length; i++) {
        var o = data[i];
        var canalBadge = o.canal === 'Shopee'
          ? '<span style="background:#fff1ee;color:#ea580c;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">🛒 Shopee</span>'
          : o.canal === 'Mercado Livre'
          ? '<span style="background:#fff8e1;color:#d97706;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">🏪 ML</span>'
          : '<span style="background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:4px;font-size:11px;">Outro</span>';
        var statusColor = o.temNF ? '#16a34a' : (o.situacao === 'Pendente' ? '#d97706' : '#64748b');
        var nfBadge = o.temNF
          ? '<span style="color:#16a34a;font-weight:600;">✓ Sim</span>'
          : '<span style="color:#94a3b8;">—</span>';
        var rowBg = i % 2 === 0 ? '#fff' : '#fafbfc';
        var isChecked = _selectedOrders[o.id] ? ' checked' : '';
        html += '<tr style="background:' + rowBg + ';">'
          + '<td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:center;"><input type="checkbox" class="order-check" data-id="' + o.id + '" data-numero="' + o.numero + '" data-sn="' + (o.numero_ecommerce || '') + '" data-canal="' + (o.canal || '') + '" onchange="onOrderCheck(this)"' + isChecked + '></td>'
          + '<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">' + canalBadge + '</td>'
          + '<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:12px;">' + (o.numero_ecommerce || '—') + '</td>'
          + '<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:12px;">' + o.numero + '</td>'
          + '<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">' + o.data_pedido + '</td>'
          + '<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + o.nome + '</td>'
          + '<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-family:monospace;">R$ ' + parseFloat(o.valor).toFixed(2) + '</td>'
          + '<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center;color:' + statusColor + ';font-size:12px;">' + o.situacao + '</td>'
          + '<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">' + nfBadge + '</td>'
          + '</tr>';
      }
      if (data.length === 0) {
        html = '<tr><td colspan="9" style="padding:24px;text-align:center;color:#94a3b8;">Nenhum pedido encontrado com esse filtro</td></tr>';
      }
      document.getElementById('listOrdersBody').innerHTML = html;
      updateSelectAllState();
    }

    // ===== BATCH SELECTION & ACTIONS =====

    function onOrderCheck(cb) {
      var id = cb.getAttribute('data-id');
      if (cb.checked) {
        _selectedOrders[id] = {
          id: id,
          numero: cb.getAttribute('data-numero'),
          numero_ecommerce: cb.getAttribute('data-sn'),
          canal: cb.getAttribute('data-canal')
        };
      } else {
        delete _selectedOrders[id];
      }
      updateBatchBar();
      updateSelectAllState();
    }

    function toggleSelectAll(cb) {
      var checks = document.querySelectorAll('#listOrdersBody .order-check');
      for (var i = 0; i < checks.length; i++) {
        checks[i].checked = cb.checked;
        var id = checks[i].getAttribute('data-id');
        if (cb.checked) {
          _selectedOrders[id] = {
            id: id,
            numero: checks[i].getAttribute('data-numero'),
            numero_ecommerce: checks[i].getAttribute('data-sn'),
            canal: checks[i].getAttribute('data-canal')
          };
        } else {
          delete _selectedOrders[id];
        }
      }
      updateBatchBar();
    }

    function updateSelectAllState() {
      var checks = document.querySelectorAll('#listOrdersBody .order-check');
      var allCheck = document.getElementById('selectAllCheck');
      if (!allCheck || checks.length === 0) return;
      var checkedCount = 0;
      for (var i = 0; i < checks.length; i++) { if (checks[i].checked) checkedCount++; }
      allCheck.checked = checkedCount === checks.length;
      allCheck.indeterminate = checkedCount > 0 && checkedCount < checks.length;
    }

    function updateBatchBar() {
      var keys = Object.keys(_selectedOrders);
      var bar = document.getElementById('batchBar');
      var countEl = document.getElementById('selectionCount');
      if (keys.length > 0) {
        bar.style.display = 'flex';
        document.getElementById('batchCount').textContent = keys.length + ' selecionado' + (keys.length > 1 ? 's' : '');
        if (countEl) countEl.textContent = keys.length + ' selecionado' + (keys.length > 1 ? 's' : '');
      } else {
        bar.style.display = 'none';
        if (countEl) countEl.textContent = '';
      }
    }

    function selecionarTodosVisiveis() {
      var checks = document.querySelectorAll('#listOrdersBody .order-check');
      for (var i = 0; i < checks.length; i++) {
        checks[i].checked = true;
        var id = checks[i].getAttribute('data-id');
        _selectedOrders[id] = {
          id: id,
          numero: checks[i].getAttribute('data-numero'),
          numero_ecommerce: checks[i].getAttribute('data-sn'),
          canal: checks[i].getAttribute('data-canal')
        };
      }
      var allCheck = document.getElementById('selectAllCheck');
      if (allCheck) { allCheck.checked = true; allCheck.indeterminate = false; }
      updateBatchBar();
    }

    function clearSelection() {
      _selectedOrders = {};
      var checks = document.querySelectorAll('#listOrdersBody .order-check');
      for (var i = 0; i < checks.length; i++) checks[i].checked = false;
      var allCheck = document.getElementById('selectAllCheck');
      if (allCheck) { allCheck.checked = false; allCheck.indeterminate = false; }
      updateBatchBar();
    }

    function getSelectedArray() {
      var arr = [];
      var keys = Object.keys(_selectedOrders);
      for (var i = 0; i < keys.length; i++) arr.push(_selectedOrders[keys[i]]);
      return arr;
    }

    function batchGerarNF() { runBatch(['nf'], '📝 Gerando NFs...'); }
    function batchGerarEEnviar() { runBatch(['nf', 'enviar'], '📝📤 Gerando NFs e Enviando...'); }

    function runBatch(acoes, title) {
      var pedidos = getSelectedArray();
      if (pedidos.length === 0) return;

      // Abrir modal
      var modal = document.getElementById('batchModal');
      modal.style.display = 'flex';
      document.getElementById('batchModalTitle').textContent = title;
      document.getElementById('batchProgressBar').style.width = '0%';
      document.getElementById('batchProgressText').textContent = '0/' + pedidos.length;
      document.getElementById('batchResumo').style.display = 'none';
      document.getElementById('batchModalClose').textContent = 'Cancelar';

      // Lista de pedidos no modal
      var listHtml = '';
      for (var i = 0; i < pedidos.length; i++) {
        var p = pedidos[i];
        var canalLabel = p.canal === 'Mercado Livre' ? 'ML' : (p.canal || '?');
        listHtml += '<div id="batchItem_' + p.id + '" style="padding:4px 0; border-bottom:1px solid #f0f0f0;">'
          + '<span class="batch-icon" style="display:inline-block;width:20px;">⬜</span> '
          + '<strong>' + (p.numero || p.id) + '</strong> '
          + '<span style="color:#94a3b8;">(' + canalLabel + ')</span> '
          + '<span class="batch-detail" style="color:#64748b;"></span>'
          + '</div>';
      }
      document.getElementById('batchProgressList').innerHTML = listHtml;

      // Iniciar SSE
      var body = JSON.stringify({ pedidos: pedidos, acoes: acoes });
      fetch('/batch/processar', {
        method: 'POST',
        headers: Object.assign({}, authHeaders, { 'Content-Type': 'application/json' }),
        body: body
      }).then(function(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function pump() {
          reader.read().then(function(result) {
            if (result.done) return;
            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (line.startsWith('data: ')) {
                try {
                  var evt = JSON.parse(line.substring(6));
                  handleBatchEvent(evt, pedidos);
                } catch(e) {}
              }
            }
            pump();
          }).catch(function(err) {
            console.error('Batch stream error:', err);
          });
        }
        pump();
      }).catch(function(err) {
        document.getElementById('batchModalTitle').textContent = 'Erro: ' + err.message;
      });
    }

    function handleBatchEvent(evt, pedidos) {
      if (evt.type === 'progress') {
        // Atualizar barra de progresso
        var pct = Math.round((evt.current / evt.total) * 100);
        document.getElementById('batchProgressBar').style.width = pct + '%';
        document.getElementById('batchProgressText').textContent = evt.current + '/' + evt.total;

        // Encontrar o pedido pelo índice
        var p = pedidos[evt.current - 1];
        if (p) {
          var item = document.getElementById('batchItem_' + p.id);
          if (item) {
            var icon = item.querySelector('.batch-icon');
            var detail = item.querySelector('.batch-detail');
            if (evt.status === 'ok') {
              icon.textContent = '✅';
              detail.textContent = evt.detail || '';
              detail.style.color = '#16a34a';
            } else if (evt.status === 'erro') {
              icon.textContent = '❌';
              detail.textContent = evt.detail || 'Erro';
              detail.style.color = '#dc2626';
            } else if (evt.status === 'working') {
              icon.textContent = '⏳';
              detail.textContent = evt.detail || '...';
              detail.style.color = '#d97706';
            }
          }
        }
      } else if (evt.type === 'done') {
        document.getElementById('batchProgressBar').style.width = '100%';
        document.getElementById('batchModalTitle').textContent = 'Processamento concluído';
        document.getElementById('batchModalClose').textContent = 'Fechar';

        var r = evt.resumo || {};
        var resumoHtml = '<div style="font-size:14px; font-weight:600; margin-bottom:8px;">📊 Resumo</div>'
          + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:13px;">'
          + '<div>Total processados: <strong>' + (r.total || 0) + '</strong></div>'
          + '<div>NFs geradas: <strong style="color:#16a34a;">' + (r.nfGeradas || 0) + '</strong></div>'
          + '<div>Descontos aplicados: <strong style="color:#7c3aed;">' + (r.descontosAplicados || 0) + '</strong></div>'
          + '<div>NFs já existiam: <strong style="color:#2563eb;">' + (r.nfJaExistiam || 0) + '</strong></div>'
          + '<div>Erros NF: <strong style="color:#dc2626;">' + (r.nfErros || 0) + '</strong></div>'
          + (r.enviadas !== undefined ? '<div>NFs enviadas: <strong style="color:#16a34a;">' + (r.enviadas || 0) + '</strong></div>' : '')
          + (r.envioErros !== undefined ? '<div>Erros envio: <strong style="color:#dc2626;">' + (r.envioErros || 0) + '</strong></div>' : '')
          + '</div>';
        document.getElementById('batchResumo').innerHTML = resumoHtml;
        document.getElementById('batchResumo').style.display = 'block';
      }
    }

    function closeBatchModal() {
      document.getElementById('batchModal').style.display = 'none';
    }

    function batchEtiquetas() {
      var pedidos = getSelectedArray();
      if (pedidos.length === 0) return;
      var sns = [];
      var canal = '';
      for (var i = 0; i < pedidos.length; i++) {
        if (pedidos[i].numero_ecommerce) sns.push(pedidos[i].numero_ecommerce);
        if (!canal && pedidos[i].canal) canal = pedidos[i].canal;
      }
      if (sns.length === 0) { alert('Nenhum pedido selecionado tem número ecommerce'); return; }
      window.open('/batch/etiquetas?sns=' + encodeURIComponent(sns.join(',')) + '&canal=' + encodeURIComponent(canal) + '&token=' + encodeURIComponent(authToken), '_blank');
    }

    function batchSeparacao() {
      var pedidos = getSelectedArray();
      if (pedidos.length === 0) return;
      var ids = [];
      for (var i = 0; i < pedidos.length; i++) ids.push(pedidos[i].id);
      window.open('/batch/picking-list?ids=' + encodeURIComponent(ids.join(',')) + '&token=' + encodeURIComponent(authToken), '_blank');
    }

    // Sidebar nav scroll
    document.querySelectorAll('.sidebar nav a[href^="#"]').forEach(function(a) {
      a.addEventListener('click', function(e) {
        var href = a.getAttribute('href');
        if (href && href !== '#') {
          e.preventDefault();
          var target = document.querySelector(href);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    setInterval(async function() {
      try {
        var r = await fetch('/status', { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        document.getElementById('statusText').textContent = d.isRunning ? 'Sincronizando...' : 'Operacional';
        document.getElementById('lastSync').textContent = d.lastRunText || 'Aguardando';
        document.getElementById('totalOrders').textContent = d.totalOrdersSynced || '0';
        document.getElementById('totalNFs').textContent = d.totalNFsEmitted || '0';
        document.getElementById('autoStatus').textContent = d.automationPaused ? '⏸ Pausada' : 'Auto a cada ${config.pollIntervalMinutes} min';
        if (d.lastResult) { var rEl = document.getElementById('result'); if (rEl) rEl.textContent = JSON.stringify(d.lastResult, null, 2); }
        var csvEl = document.getElementById('csvInfo');
        if (csvEl) csvEl.textContent = (d.csvCount || 0) + ' NFs no CSV';
        renderNFTable(d.nfHistory);
        renderLogs(d.logs);
      } catch(e) {}
    }, 3000);

    async function syncNow() {
      var btn = document.getElementById('btnSync');
      btn.disabled = true; btn.textContent = '⏳ Sincronizando...';
      try {
        var params = '';
        var fromSn = (document.getElementById('syncFromSn').value || '').trim().toUpperCase();
        var toSn = (document.getElementById('syncToSn').value || '').trim().toUpperCase();
        if (fromSn || toSn) {
          var p = [];
          if (fromSn) p.push('from_sn=' + encodeURIComponent(fromSn));
          if (toSn) p.push('to_sn=' + encodeURIComponent(toSn));
          params = '?' + p.join('&');
        }
        var r = await fetch('/run' + params, { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        var msg = r.ok ? d.message : d.error;
        if (fromSn || toSn) msg += ' (Filtro: ' + (fromSn || '*') + ' a ' + (toSn || '*') + ')';
        showMsg('msgRun', msg, r.ok);
      } catch(e) { showMsg('msgRun', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '▶ Sincronizar Agora';
    }

    async function toggleAuto() {
      var btn = document.getElementById('btnToggle');
      btn.disabled = true;
      try {
        var r = await fetch('/toggle-automation', { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        showMsg('msgToggle', d.message, true);
        setTimeout(function() { location.reload(); }, 1000);
      } catch(e) { showMsg('msgToggle', 'Erro: ' + e.message, false); }
      btn.disabled = false;
    }

    async function enviarNFIndividual() {
      var input = document.getElementById('inputEnvioIndividual').value.trim();
      if (!input) { showMsg('msgEnvioIndividual', 'Insira o Order SN ou nº do pedido', false); return; }
      var btn = document.getElementById('btnEnvioIndividual');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Enviando...';
      hideMsg('msgEnvioIndividual');
      try {
        var r = await fetch('/pedido/enviar-nf-individual', { method: 'POST', headers: authHeaders, body: JSON.stringify({ orderNumber: input }) });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        showMsg('msgEnvioIndividual', d.message || d.error || 'Resposta inesperada', d.ok);
      } catch(e) { showMsg('msgEnvioIndividual', 'Erro: ' + e.message, false); }
      finally { btn.disabled = false; btn.innerHTML = '📤 Enviar NF'; }
    }

    async function sendNFsToShopee() {
      var de = document.getElementById('shopeeNfDe').value.trim();
      var ate = document.getElementById('shopeeNfAte').value.trim();
      var qs = '';
      if (de) qs += '?de=' + encodeURIComponent(de);
      if (ate) qs += (qs ? '&' : '?') + 'ate=' + encodeURIComponent(ate);
      var btn = document.getElementById('btnShopeeNF');
      btn.disabled = true; btn.textContent = '⏳ Enviando NFs...';
      try {
        var r = await fetch('/shopee/send-nfs' + qs, { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        showMsg('msgShopeeNF', d.message || d.error, r.ok);
      } catch(e) { showMsg('msgShopeeNF', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '📤 Enviar NFs para Shopee';
    }

    async function refreshShopeeStatus() {
      try {
        var r = await fetch('/shopee/status', { headers: authHeaders });
        if (r.status === 401) return;
        var d = await r.json();
        var el = document.getElementById('shopeeConnStatus');
        if (d.connected) {
          el.innerHTML = '✓ Shopee conectada (shop_id: ' + d.shopId + ', expira: ' + (d.expiresAt || 'N/A') + ')';
          el.style.color = '#16a34a';
        } else {
          el.innerHTML = '⚠ Shopee não conectada — NFs não serão enviadas';
          el.style.color = '#ea580c';
        }
      } catch(e) {}
    }
    refreshShopeeStatus();
    setInterval(refreshShopeeStatus, 10000);

    async function reprocessar() {
      var de = document.getElementById('de').value.trim();
      var ate = document.getElementById('ate').value.trim();
      if (!de || !ate) { showMsg('msgReprocess', 'Preencha as duas datas', false); return; }
      if (!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(de) || !/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(ate)) {
        showMsg('msgReprocess', 'Formato inválido. Use dd/mm/aaaa', false); return;
      }
      var btn = document.getElementById('btnReprocess');
      btn.disabled = true; btn.textContent = '⏳ Reprocessando...';
      try {
        var params = 'de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate);
        var fromSn = (document.getElementById('syncFromSn').value || '').trim().toUpperCase();
        var toSn = (document.getElementById('syncToSn').value || '').trim().toUpperCase();
        if (fromSn) params += '&from_sn=' + encodeURIComponent(fromSn);
        if (toSn) params += '&to_sn=' + encodeURIComponent(toSn);
        var r = await fetch('/reprocess?' + params, { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        showMsg('msgReprocess', d.message || d.error, r.ok);
      } catch(e) { showMsg('msgReprocess', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '🔄 Reprocessar';
    }

    async function refreshMLStatus() {
      try {
        var r = await fetch('/ml/status', { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        var notConn = document.getElementById('mlNotConnected');
        var conn = document.getElementById('mlConnected');
        var badge = document.getElementById('mlHeaderBadge');
        var connMeta = document.getElementById('mlConnMeta');
        var btnConnect = document.getElementById('btnMLConnect');
        if (d.connected) {
          notConn.style.display = 'none';
          conn.style.display = 'block';
          document.getElementById('mlSellerId').textContent = d.userId || '-';
          badge.className = 'card-badge badge-green';
          badge.textContent = 'Conectado';
          connMeta.innerHTML = 'Status: <strong style="color:#16a34a;">Conectado</strong>';
          if (btnConnect) btnConnect.style.display = 'none';
        } else {
          notConn.style.display = 'block';
          conn.style.display = 'none';
          badge.className = 'card-badge badge-orange';
          badge.textContent = 'Desconectado';
          connMeta.innerHTML = 'Status: <strong style="color:#ea580c;">Desconectado</strong>';
          if (btnConnect) btnConnect.style.display = 'inline-flex';
        }
        if (d.lastResult) {
          var box = document.getElementById('mlLastResultBox');
          if (box) {
            box.style.display = 'block';
            document.getElementById('mlLastResult').textContent = JSON.stringify(d.lastResult, null, 2);
          }
        }
      } catch(e) {}
    }

    async function processMLDay() {
      var date = document.getElementById('mlDate').value.trim();
      if (!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(date)) {
        showMsg('msgML', 'Formato inválido. Use dd/mm/aaaa', false); return;
      }
      await runMLProcess(date, 'coleta', 'btnML', '🏪 Gerar NFs');
    }

    async function mlQuickRun(when) {
      var d = new Date();
      if (when === 'amanha') d.setDate(d.getDate() + 1);
      var dd = String(d.getDate()).padStart(2,'0');
      var mm = String(d.getMonth()+1).padStart(2,'0');
      var yyyy = d.getFullYear();
      var date = dd + '/' + mm + '/' + yyyy;
      var btnId = when === 'amanha' ? 'btnMLAmanha' : 'btnMLHoje';
      var label = when === 'amanha' ? '📅 Coleta Amanhã' : '📅 Coleta Hoje';
      await runMLProcess(date, 'coleta', btnId, label);
    }

    async function runMLProcess(date, mode, btnId, btnLabel) {
      var btn = document.getElementById(btnId);
      btn.disabled = true; btn.textContent = '⏳ Processando...';
      try {
        var qs = '?date=' + encodeURIComponent(date) + '&mode=' + encodeURIComponent(mode);
        var r = await fetch('/ml/process-day' + qs, { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        showMsg('msgML', d.message || d.error, r.ok);
      } catch(e) { showMsg('msgML', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = btnLabel;
    }

    async function mlDisconnect() {
      if (!confirm('Desconectar a conta Mercado Livre? Você precisará autorizar novamente depois.')) return;
      try {
        var r = await fetch('/ml/disconnect', { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        await r.json();
        refreshMLStatus();
      } catch(e) {}
    }

    async function mlClearCache() {
      if (!confirm('Limpar o cache de pedidos ML verificados? A próxima execução vai reverificar todos os pedidos.')) return;
      var btn = document.getElementById('btnMLClearCache');
      btn.disabled = true; btn.textContent = '⏳ Limpando...';
      try {
        var r = await fetch('/ml/clear-cache', { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        showMsg('msgML', '✓ ' + d.message, true);
      } catch(e) { showMsg('msgML', 'Erro ao limpar cache: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '🗑 Limpar Cache ML';
    }

    async function mlInspectOrder() {
      var orderId = document.getElementById('mlInspectOrderId').value.trim();
      if (!orderId) { showMsg('msgML', 'Informe o número do pedido ML.', false); return; }
      var btn = document.getElementById('btnMLInspect');
      btn.disabled = true; btn.textContent = '⏳ Inspecionando...';
      try {
        var r = await fetch('/ml/inspect?order_id=' + encodeURIComponent(orderId), { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        var box = document.getElementById('mlInspectResult');
        box.style.display = 'block';
        if (d.steps) {
          var html = d.steps.map(function(s) {
            var icon = s.ok ? '✅' : '❌';
            return icon + ' <strong>' + s.step + '</strong>: ' + s.detail;
          }).join('\\n');
          document.getElementById('mlInspectPre').innerHTML = html;
        } else {
          document.getElementById('mlInspectPre').textContent = JSON.stringify(d, null, 2);
        }
      } catch(e) { showMsg('msgML', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '🔍 Inspecionar';
    }

    async function testListaPreco(criar) {
      var pedidoId = document.getElementById('testLPPedidoId').value.trim();
      if (!pedidoId) { showMsg('msgTestLP', 'Informe o nº do pedido.', false); return; }
      var listaId = document.getElementById('testLPListaId').value;
      var btnP = document.getElementById('btnTestLP');
      var btnC = document.getElementById('btnCriarNF');

      if (criar && !confirm('Criar NF com desconto para o pedido ' + pedidoId + '?')) return;

      btnP.disabled = true; btnC.disabled = true;
      btnP.textContent = '⏳ ...'; btnC.textContent = '⏳ ...';

      try {
        var qry = '/tiny/test-lista-preco?pedido_id=' + encodeURIComponent(pedidoId) + '&lista_id=' + listaId;
        if (criar) qry += '&criar=1';
        var r = await fetch(qry, { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        var box = document.getElementById('testLPResult');
        box.style.display = 'block';
        var container = document.getElementById('testLPPreview');

        if (d.ok) {
          var h = '';
          if (d.resolveNote) h += '<div style="color:#6366f1;font-size:12px;margin-bottom:6px;">ℹ️ ' + escapeHtml(d.resolveNote) + '</div>';
          h += '<div style="font-size:13px;margin-bottom:8px;"><strong>Pedido #' + escapeHtml(d.pedidoNumero || d.pedidoId) + '</strong>';
          if (d.numeroEcommerce) h += ' <span class="badge badge-blue">' + escapeHtml(d.numeroEcommerce) + '</span>';
          h += ' <span class="badge badge-orange">' + escapeHtml(d.situacao || '?') + '</span>';
          h += '</div>';

          if (d.lista) {
            h += '<div style="font-size:12px;color:#666;margin-bottom:8px;">Lista: <strong>' + escapeHtml(d.lista.descricao) + '</strong> (desconto ' + d.descontoPct + '%)</div>';
          }

          h += '<table style="font-size:12px;width:100%;"><thead><tr><th style="text-align:left;">Item</th><th>Qtd</th><th>V.Original</th><th>V.Desconto</th><th>Sub.Orig</th><th>Sub.Desc</th></tr></thead><tbody>';
          for (var i = 0; i < d.itens.length; i++) {
            var it = d.itens[i];
            h += '<tr><td style="text-align:left;">' + escapeHtml(it.descricao) + '</td>';
            h += '<td style="text-align:center;">' + it.quantidade + '</td>';
            h += '<td style="text-align:right;">R$' + it.valor_original + '</td>';
            h += '<td style="text-align:right;color:#16a34a;font-weight:bold;">R$' + it.valor_desconto + '</td>';
            h += '<td style="text-align:right;">R$' + it.subtotal_original + '</td>';
            h += '<td style="text-align:right;color:#16a34a;">R$' + it.subtotal_desconto + '</td></tr>';
          }
          h += '</tbody></table>';

          h += '<div style="margin-top:8px;padding:8px 12px;background:#f0fdf4;border-radius:6px;border:1px solid #bbf7d0;font-size:13px;">';
          h += '<strong>Total original:</strong> R$ ' + d.totalOriginal + ' → <strong>Com desconto:</strong> R$ ' + d.totalComDesconto;
          h += ' <span style="color:#16a34a;font-weight:bold;">(economia: R$ ' + d.economia + ')</span></div>';

          if (d.nfCriada) {
            if (d.nfCriada.ok) {
              h += '<div style="margin-top:8px;padding:8px 12px;background:#dbeafe;border-radius:6px;border:1px solid #93c5fd;font-size:13px;">✅ <strong>NF criada!</strong> ID: ' + d.nfCriada.nfId + ', Número: ' + (d.nfCriada.numero || '-') + ', Série: ' + (d.nfCriada.serie || '-') + '<br><span style="font-size:11px;color:#666;">NF criada sem emissão na SEFAZ (modo teste). Emita manualmente no Tiny se desejar.</span></div>';
              showMsg('msgTestLP', 'NF criada com sucesso! ID: ' + d.nfCriada.nfId, true);
            } else {
              h += '<div style="margin-top:8px;padding:8px 12px;background:#fef2f2;border-radius:6px;border:1px solid #fca5a5;font-size:13px;">❌ <strong>Erro ao criar NF:</strong> ' + escapeHtml(d.nfCriada.error || 'Erro desconhecido') + '</div>';
              showMsg('msgTestLP', 'Erro ao criar NF: ' + (d.nfCriada.error || 'erro'), false);
            }
          } else {
            showMsg('msgTestLP', 'Preview OK! Clique "Criar NF" para gerar a nota fiscal.', true);
          }

          container.innerHTML = h;
        } else {
          container.innerHTML = '<pre style="background:#fef2f2;padding:12px;border-radius:8px;font-size:12px;white-space:pre-wrap;border:1px solid #fca5a5;">ERRO: ' + escapeHtml(d.error || 'Erro desconhecido') + '</pre>';
          showMsg('msgTestLP', 'Falha: ' + (d.error || 'erro'), false);
        }
      } catch(e) { showMsg('msgTestLP', 'Erro: ' + e.message, false); }
      btnP.disabled = false; btnP.textContent = '🔍 Preview';
      btnC.disabled = false; btnC.textContent = '📄 Criar NF';
    }

    async function mlDebug() {
      var btn = document.getElementById('btnMLDebug');
      btn.disabled = true; btn.textContent = '⏳ Inspecionando...';
      try {
        var r = await fetch('/ml/debug', { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        var box = document.getElementById('mlLastResultBox');
        box.style.display = 'block';
        document.getElementById('mlLastResult').textContent = JSON.stringify(d, null, 2);
        showMsg('msgML', 'Debug: amostra de ' + (d.sample ? d.sample.length : 0) + ' shipments exibida abaixo. Verifique os campos de data.', true);
      } catch(e) { showMsg('msgML', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '🔍 Inspecionar API ML';
    }

    async function downloadCSV() {
      try {
        var r = await fetch('/shopee/csv', { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        if (r.status === 404) { showMsg('msgCSV', 'Nenhum CSV disponível ainda. Processe pedidos Shopee primeiro.', false); return; }
        var blob = await r.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'shopee_nfs_' + new Date().toISOString().slice(0,10) + '.csv';
        a.click();
        URL.revokeObjectURL(url);
        showMsg('msgCSV', 'CSV baixado com sucesso!', true);
      } catch(e) { showMsg('msgCSV', 'Erro: ' + e.message, false); }
    }

    async function downloadXLSX() {
      try {
        var r = await fetch('/shopee/xlsx', { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        if (r.status === 404) { showMsg('msgCSV', 'Nenhuma NF disponível. Processe pedidos Shopee primeiro.', false); return; }
        var blob = await r.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'shopee_nfs_' + new Date().toISOString().slice(0,10) + '.xlsx';
        a.click();
        URL.revokeObjectURL(url);
        showMsg('msgCSV', 'Planilha XLSX baixada! Faça upload direto na Shopee.', true);
      } catch(e) { showMsg('msgCSV', 'Erro: ' + e.message, false); }
    }

    async function clearCSV() {
      if (!confirm('Limpar o CSV? Faça isso após fazer o upload na Shopee.')) return;
      try {
        var r = await fetch('/shopee/csv', { method: 'DELETE', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        showMsg('msgCSV', 'CSV limpo com sucesso', true);
        document.getElementById('csvInfo').textContent = '0 NFs no CSV';
      } catch(e) { showMsg('msgCSV', 'Erro: ' + e.message, false); }
    }

    function openPickingList() {
      var urlParts = '/shopee/picking-list?token=' + encodeURIComponent(authToken);
      var fromSn = (document.getElementById('pickFromSn').value || '').trim().toUpperCase();
      var toSn = (document.getElementById('pickToSn').value || '').trim().toUpperCase();
      if (fromSn) urlParts += '&from_sn=' + encodeURIComponent(fromSn);
      if (toSn) urlParts += '&to_sn=' + encodeURIComponent(toSn);
      window.open(urlParts, '_blank');
    }

    function openProcessarPedido() {
      window.open('/pedido/processar?token=' + encodeURIComponent(authToken), '_blank');
    }

    async function testLogistics() {
      var orderSn = document.getElementById('labelOrderSn').value.trim();
      if (!orderSn) { showMsg('msgLabel', 'Informe o Order SN do pedido Shopee', false); return; }
      var btn = document.getElementById('btnTestLogistics');
      btn.disabled = true; btn.textContent = '⏳ Testando...';
      try {
        var r = await fetch('/shopee/test-logistics?order_sn=' + encodeURIComponent(orderSn), { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        document.getElementById('logisticsResult').style.display = 'block';
        document.getElementById('logisticsResultPre').textContent = JSON.stringify(d, null, 2);
        if (d.ok) {
          showMsg('msgLabel', 'API de logística acessível! Permissão OK.', true);
        } else {
          showMsg('msgLabel', 'Erro: ' + (d.error || 'Sem permissão ou pedido inválido'), false);
        }
      } catch(e) { showMsg('msgLabel', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '🧪 Testar API';
    }

    async function diagnoseLabel() {
      var orderSn = document.getElementById('labelOrderSn').value.trim();
      if (!orderSn) { showMsg('msgLabel', 'Informe o Order SN do pedido Shopee', false); return; }
      var btn = document.getElementById('btnDiagnoseLabel');
      btn.disabled = true; btn.textContent = '⏳ Diagnosticando...';
      try {
        var r = await fetch('/shopee/diagnose-label?order_sn=' + encodeURIComponent(orderSn), { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        document.getElementById('logisticsResult').style.display = 'block';
        document.getElementById('logisticsResultPre').textContent = JSON.stringify(d, null, 2);
        if (d.finalSuccess) {
          showMsg('msgLabel', 'Diagnóstico OK — etiqueta gerada com sucesso (' + (d.pdfSize || 0) + ' bytes)', true);
        } else {
          var failedSteps = (d.steps || []).filter(function(s) { return !s.success; }).map(function(s) { return s.step + ': ' + s.detail; }).join(' | ');
          showMsg('msgLabel', 'Falha: ' + failedSteps, false);
        }
      } catch(e) { showMsg('msgLabel', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '🔍 Diagnosticar';
    }

    async function downloadLabel(orderSnParam) {
      var orderSn = orderSnParam || document.getElementById('labelOrderSn').value.trim();
      if (!orderSn) { showMsg('msgLabel', 'Informe o Order SN do pedido Shopee', false); return; }
      var btn = orderSnParam ? null : document.getElementById('btnDownloadLabel');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando etiqueta...'; }
      try {
        var r = await fetch('/shopee/shipping-label?order_sn=' + encodeURIComponent(orderSn), { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var ct = r.headers.get('content-type') || '';
        if (ct.includes('application/pdf')) {
          var blob = await r.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'etiqueta_' + orderSn + '.pdf';
          a.click();
          URL.revokeObjectURL(url);
          showMsg('msgLabel', 'Etiqueta ' + orderSn + ' baixada!', true);
        } else {
          var d = await r.json();
          document.getElementById('logisticsResult').style.display = 'block';
          document.getElementById('logisticsResultPre').textContent = JSON.stringify(d, null, 2);
          showMsg('msgLabel', 'Erro ' + orderSn + ': ' + (d.error || 'Falha ao gerar etiqueta'), false);
        }
      } catch(e) { showMsg('msgLabel', 'Erro: ' + e.message, false); }
      if (btn) { btn.disabled = false; btn.textContent = '📦 Baixar Etiqueta'; }
    }

    function getLabelSnFilter() {
      var fromSn = (document.getElementById('labelFromSn').value || '').trim().toUpperCase();
      var toSn = (document.getElementById('labelToSn').value || '').trim().toUpperCase();
      var params = '';
      if (fromSn) params += '&from_sn=' + encodeURIComponent(fromSn);
      if (toSn) params += '&to_sn=' + encodeURIComponent(toSn);
      return params;
    }

    async function listAvailableLabels() {
      var btn = document.getElementById('btnListLabels');
      btn.disabled = true; btn.textContent = '⏳ Buscando...';
      try {
        var r = await fetch('/shopee/labels-available?' + getLabelSnFilter(), { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        document.getElementById('labelsAvailableInfo').textContent = (d.count || 0) + ' pedidos encontrados (' + (d.readyForLabel || 0) + ' com NF — prontos para etiqueta)';
        if (d.orders && d.orders.length > 0) {
          var tbody = document.getElementById('labelsTableBody');
          var h = '';
          for (var i = 0; i < d.orders.length; i++) {
            var o = d.orders[i];
            var statusBadge = o.status === 'READY_TO_SHIP' ? 'badge-orange' : 'badge-green';
            var nfBadge = o.hasNF ? '<span class="badge badge-green">✓ Sim</span>' : '<span class="badge badge-orange">✗ Não</span>';
            var canDownload = o.hasNF;
            h += '<tr>';
            h += '<td><strong>' + o.order_sn + '</strong></td>';
            h += '<td><span class="badge ' + statusBadge + '">' + (o.orderStatus || o.status) + '</span></td>';
            h += '<td>' + nfBadge + '</td>';
            if (canDownload) {
              h += '<td><button class="btn btn-primary btn-sm" onclick="downloadLabel(\\'' + o.order_sn + '\\')">📦 Baixar</button></td>';
            } else {
              h += '<td><span style="color:#94a3b8; font-size:12px;">Aguardando NF</span></td>';
            }
            h += '</tr>';
          }
          tbody.innerHTML = h;
          document.getElementById('labelsListBox').style.display = 'block';
        } else {
          document.getElementById('labelsListBox').style.display = 'none';
          showMsg('msgLabel', 'Nenhum pedido pendente encontrado', false);
        }
      } catch(e) { showMsg('msgLabel', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '📋 Listar Pedidos Disponíveis';
    }

    // === Shopee batch download (PDF único) ===
    async function batchDownloadShopee() {
      var btn = document.getElementById('btnBatchShopee');
      btn.disabled = true; btn.textContent = '⏳ Preparando etiquetas...';
      showMsg('msgLabel', 'Gerando PDF único com todas as etiquetas... isso pode levar alguns minutos.', true);
      try {
        var r = await fetch('/shopee/labels-batch?' + getLabelSnFilter(), { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var ct = r.headers.get('content-type') || '';
        if (ct.includes('application/pdf')) {
          var blob = await r.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'etiquetas_shopee_' + new Date().toISOString().slice(0, 10) + '.pdf';
          a.click();
          URL.revokeObjectURL(url);
          var sizeKB = Math.round(blob.size / 1024);
          showMsg('msgLabel', 'PDF único baixado com sucesso (' + sizeKB + ' KB)', true);
        } else {
          var d = await r.json();
          showMsg('msgLabel', 'Erro: ' + (d.error || 'Não foi possível gerar o PDF'), false);
        }
      } catch(e) { showMsg('msgLabel', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '📥 Baixar Todas Etiquetas (PDF único)';
    }

    // === ML Labels ===
    async function downloadMLLabelByOrder() {
      var orderId = document.getElementById('mlLabelOrderId').value.trim();
      if (!orderId) { showMsg('msgMLLabel', 'Informe o número do pedido ML', false); return; }
      var btn = document.getElementById('btnMLLabelByOrder');
      btn.disabled = true; btn.textContent = '⏳ Buscando...';
      try {
        var r = await fetch('/ml/label-by-order?order_id=' + encodeURIComponent(orderId), { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var ct = r.headers.get('content-type') || '';
        if (ct.includes('application/pdf')) {
          var blob = await r.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'etiqueta_ml_' + orderId + '.pdf'; a.click();
          URL.revokeObjectURL(url);
          showMsg('msgMLLabel', 'Etiqueta do pedido ' + orderId + ' baixada!', true);
        } else {
          var d = await r.json();
          showMsg('msgMLLabel', 'Erro: ' + (d.error || 'Etiqueta não disponível para este pedido'), false);
          if (d.shipmentId || d.error) {
            document.getElementById('mlLabelResult').style.display = 'block';
            document.getElementById('mlLabelResultPre').textContent = JSON.stringify(d, null, 2);
          }
        }
      } catch(e) { showMsg('msgMLLabel', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '📦 Baixar Etiqueta';
    }

    async function refreshMLLabelsStatus() {
      try {
        var r = await fetch('/ml/status', { headers: authHeaders });
        if (r.status === 401) return;
        var d = await r.json();
        var notConn = document.getElementById('mlLabelsNotConnected');
        var conn = document.getElementById('mlLabelsConnected');
        if (d.connected) {
          if (notConn) notConn.style.display = 'none';
          if (conn) conn.style.display = 'block';
        } else {
          if (notConn) notConn.style.display = 'block';
          if (conn) conn.style.display = 'none';
        }
      } catch(e) {}
    }

    async function listMLLabels() {
      var btn = document.getElementById('btnListMLLabels');
      btn.disabled = true; btn.textContent = '⏳ Buscando...';
      var days = document.getElementById('mlDaysBack').value || '3';
      try {
        var r = await fetch('/ml/labels-available?days=' + days, { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        var infoText = (d.count || 0) + ' pedidos pagos com envio (' + (d.daysBack || '?') + ' dias, ' + (d.elapsedSeconds || '?') + 's)';
        document.getElementById('mlLabelsInfo').textContent = infoText;
        if (d.orders && d.orders.length > 0) {
          var tbody = document.getElementById('mlLabelsTableBody');
          var h = '';
          for (var i = 0; i < d.orders.length; i++) {
            var o = d.orders[i];
            var statusText = o.cachedSubstatus || o.cachedStatus || 'paid';
            var badgeClass = o.cachedStatus === 'ready_to_ship' ? 'badge-green' : 'badge-orange';
            h += '<tr>';
            h += '<td><strong>' + o.orderId + '</strong></td>';
            h += '<td>' + o.shipmentId + '</td>';
            h += '<td><span class="badge ' + badgeClass + '">' + statusText + '</span></td>';
            h += '<td>R$ ' + (o.totalAmount ? o.totalAmount.toFixed(2) : '-') + '</td>';
            h += '<td><button class="btn btn-primary btn-sm" onclick="downloadMLLabel(' + o.shipmentId + ')">📦 Baixar</button></td>';
            h += '</tr>';
          }
          tbody.innerHTML = h;
          document.getElementById('mlLabelsListBox').style.display = 'block';
        } else {
          document.getElementById('mlLabelsListBox').style.display = 'none';
          showMsg('msgMLLabel', 'Nenhum pedido ML pago com envio pendente', false);
        }
      } catch(e) { showMsg('msgMLLabel', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '📋 Listar Pedidos';
    }

    async function downloadMLLabel(shipmentId) {
      try {
        showMsg('msgMLLabel', 'Baixando etiqueta ML #' + shipmentId + '...', true);
        var r = await fetch('/ml/shipping-label?shipment_id=' + shipmentId, { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var ct = r.headers.get('content-type') || '';
        if (ct.includes('application/pdf')) {
          var blob = await r.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'etiqueta_ml_' + shipmentId + '.pdf'; a.click();
          URL.revokeObjectURL(url);
          showMsg('msgMLLabel', 'Etiqueta ML #' + shipmentId + ' baixada!', true);
        } else {
          var d = await r.json();
          document.getElementById('mlLabelResult').style.display = 'block';
          document.getElementById('mlLabelResultPre').textContent = JSON.stringify(d, null, 2);
          showMsg('msgMLLabel', 'Erro: ' + (d.error || 'Falha ao gerar etiqueta'), false);
        }
      } catch(e) { showMsg('msgMLLabel', 'Erro: ' + e.message, false); }
    }

    async function batchDownloadML() {
      var btn = document.getElementById('btnBatchML');
      btn.disabled = true; btn.textContent = '⏳ Baixando...';
      var days = document.getElementById('mlDaysBack').value || '3';
      try {
        var r = await fetch('/ml/labels-batch?days=' + days, { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var ct = r.headers.get('content-type') || '';
        if (ct.includes('application/pdf')) {
          var downloaded = r.headers.get('x-ml-labels-downloaded') || '?';
          var failed = r.headers.get('x-ml-labels-failed') || '0';
          var blob = await r.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'etiquetas_ml_' + new Date().toISOString().slice(0,10) + '.pdf'; a.click();
          URL.revokeObjectURL(url);
          var msg = downloaded + ' etiquetas baixadas em PDF';
          if (parseInt(failed) > 0) msg += ' (' + failed + ' indisponíveis — pendentes ou Fulfillment)';
          showMsg('msgMLLabel', msg, true);
        } else {
          var d = await r.json();
          var errMsg = d.error || 'Nenhuma etiqueta disponível';
          if (d.details && d.details.length > 0) {
            errMsg += '\\n' + d.details.slice(0, 5).join('\\n');
          }
          showMsg('msgMLLabel', errMsg, false);
          document.getElementById('mlLabelResult').style.display = 'block';
          document.getElementById('mlLabelResultPre').textContent = JSON.stringify(d, null, 2);
        }
      } catch(e) { showMsg('msgMLLabel', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '📥 Baixar Todas';
    }

    // === Checklist ===
    async function loadChecklist() {
      try {
        var showChecked = document.getElementById('chkShowChecked').checked;
        var r = await fetch('/checklist?show_checked=' + showChecked, { headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        document.getElementById('checklistInfo').textContent =
          d.unchecked + ' pendentes / ' + d.checked + ' conferidos / ' + d.total + ' total';
        var tbody = document.getElementById('checklistTableBody');
        if (!d.items || d.items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px;">Nenhum pedido no checklist</td></tr>';
          return;
        }
        var h = '';
        for (var i = 0; i < d.items.length; i++) {
          var it = d.items[i];
          var rowStyle = it.checked ? 'background:#f0fdf4; opacity:0.7;' : '';
          var canalBadge = it.canal === 'Mercado Livre' ? 'badge-orange' : 'badge-blue';
          h += '<tr style="' + rowStyle + '">';
          h += '<td style="text-align:center;"><input type="checkbox" ' + (it.checked ? 'checked' : '') + ' onchange="toggleChecklistItem(\\'' + (it.nfId || it.nfNumero) + '\\', this.checked)"></td>';
          h += '<td><strong>' + (it.nfNumero || it.nfId || '-') + '</strong></td>';
          h += '<td><span class="badge badge-orange">' + (it.numeroPedido || '-') + '</span></td>';
          h += '<td><span class="badge ' + canalBadge + '">' + (it.canal || '-') + '</span></td>';
          h += '<td>' + (it.clienteNome || '-') + '</td>';
          h += '<td>R$ ' + (it.valor ? it.valor.toFixed(2) : '-') + '</td>';
          h += '<td style="font-size:11px;color:#999;">' + (it.dataEmissao || '-') + '</td>';
          h += '</tr>';
        }
        tbody.innerHTML = h;
      } catch(e) { showMsg('msgChecklist', 'Erro: ' + e.message, false); }
    }

    async function toggleChecklistItem(nfId, checked) {
      try {
        await fetch('/checklist/toggle', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nfId: nfId, checked: checked })
        });
        loadChecklist();
      } catch(e) { showMsg('msgChecklist', 'Erro: ' + e.message, false); }
    }

    async function toggleAllChecklist(checked) {
      try {
        await fetch('/checklist/toggle-all', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ checked: checked })
        });
        loadChecklist();
        showMsg('msgChecklist', checked ? 'Todos marcados' : 'Todos desmarcados', true);
      } catch(e) { showMsg('msgChecklist', 'Erro: ' + e.message, false); }
    }

    async function clearCheckedItems() {
      if (!confirm('Remover todos os itens marcados do checklist?')) return;
      try {
        var r = await fetch('/checklist/clear-checked', { method: 'DELETE', headers: authHeaders });
        var d = await r.json();
        showMsg('msgChecklist', d.removed + ' itens removidos', true);
        loadChecklist();
      } catch(e) { showMsg('msgChecklist', 'Erro: ' + e.message, false); }
    }

    function printChecklist() {
      var table = document.getElementById('checklistTable');
      if (!table) return;
      var w = window.open('', '_blank');
      w.document.write('<html><head><title>Checklist de Pedidos</title>');
      w.document.write('<style>');
      w.document.write('body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; }');
      w.document.write('h2 { margin-bottom: 10px; }');
      w.document.write('table { border-collapse: collapse; width: 100%; }');
      w.document.write('th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }');
      w.document.write('th { background: #f0f0f0; font-weight: bold; }');
      w.document.write('tr:nth-child(even) { background: #fafafa; }');
      w.document.write('.check-col { width: 30px; text-align: center; }');
      w.document.write('</style></head><body>');
      w.document.write('<h2>Checklist de Pedidos — ' + new Date().toLocaleDateString('pt-BR') + '</h2>');
      w.document.write('<table><thead><tr>');
      w.document.write('<th class="check-col">☐</th><th>NF</th><th>Pedido</th><th>Canal</th><th>Cliente</th><th>Valor</th><th>Data</th>');
      w.document.write('</tr></thead><tbody>');
      var rows = document.getElementById('checklistTableBody').querySelectorAll('tr');
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll('td');
        if (cells.length < 7) continue;
        var isChecked = cells[0].querySelector('input') && cells[0].querySelector('input').checked;
        w.document.write('<tr>');
        w.document.write('<td class="check-col">' + (isChecked ? '✓' : '☐') + '</td>');
        for (var j = 1; j < cells.length; j++) {
          w.document.write('<td>' + cells[j].textContent + '</td>');
        }
        w.document.write('</tr>');
      }
      w.document.write('</tbody></table></body></html>');
      w.document.close();
      w.print();
    }

    // Carrega checklist ao abrir
    loadChecklist();

    // Inicializa status ML e atualiza periodicamente
    refreshMLStatus();
    refreshMLLabelsStatus();
    setInterval(refreshMLStatus, 5000);
    setInterval(refreshMLLabelsStatus, 5000);
  </script>
</body>
</html>`;
}
