import * as http from 'http';
import * as crypto from 'crypto';
import * as cron from 'node-cron';
import { config } from './config';
import { processNewShopeeOrders, processMercadoLivreOrdersForDate, processMercadoLivreByCollectionDate, clearProcessedOrders, ProcessedNF } from './bot.service';
import { getLogs } from './log-buffer';
import * as ml from './ml-client';

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
    res.end(JSON.stringify({ status: 'ok', service: 'synchub-integration-platform', version: 'v3.6-payBefore', uptime: process.uptime() }));
    return;
  }

  // Public: version check (for debugging deploys)
  if (url.pathname === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 'v3.6-payBefore', deployed: startTime.toISOString() }));
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
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
      logs: getLogs().slice(0, 50),
    }));
  } else if (url.pathname === '/run' && req.method === 'POST') {
    if (isRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sincronização já em andamento. Aguarde finalizar.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Sincronização manual iniciada' }));
    runBot(undefined, undefined, true);
  } else if (url.pathname === '/reprocess' && req.method === 'POST') {
    const dataInicial = url.searchParams.get('de') || undefined;
    const dataFinal = url.searchParams.get('ate') || undefined;
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
    res.end(JSON.stringify({ message: 'Reprocessamento iniciado', de: dataInicial || 'ontem', ate: dataFinal || 'hoje' }));
    runBot(dataInicial, dataFinal, true);
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
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(config.port, () => {
  console.log(`[SERVER] Health check em http://localhost:${config.port}/health`);
});

async function runBot(dataInicial?: string, dataFinal?: string, skipBlockCheck = false) {
  if (isRunning) return;
  isRunning = true;
  const mode = dataInicial ? `reprocessamento ${dataInicial} a ${dataFinal}` : 'verificação';
  if (skipBlockCheck) console.log(`[BOT] Execucao manual - ignorando bloqueio de horario`);
  console.log(`\n[${new Date().toLocaleString('pt-BR')}] Iniciando ${mode}...`);

  try {
    const result = await processNewShopeeOrders(dataInicial, dataFinal, skipBlockCheck);
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
    <div class="footer">SyncHub v3.2 — Integrador de Marketplaces e ERPs</div>
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
      <a href="#sync"><span class="icon">⚡</span> Sincronização</a>
      <a href="#ml-sync"><span class="icon">🏪</span> Mercado Livre</a>
      <a href="#nfs"><span class="icon">📋</span> Notas Fiscais</a>
      <div class="section-label">Sistema</div>
      <a href="#logs"><span class="icon">📄</span> Logs</a>
      <a href="#config"><span class="icon">⚙️</span> Configurações</a>
    </nav>
    <div class="sidebar-footer">SyncHub v3.2<br>Integrador ERP/HUB</div>
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
          <!-- Sync Flow Diagram -->
          <div class="sync-flow">
            <div class="flow-node">
              <div class="flow-icon">🛒</div>
              <div class="flow-label">Shopee</div>
              <div class="flow-sub">Marketplace</div>
            </div>
            <div class="flow-arrow">→</div>
            <div class="flow-node" style="border-color: #0f3460;">
              <div class="flow-icon">🔄</div>
              <div class="flow-label">SyncHub</div>
              <div class="flow-sub">Integrador</div>
            </div>
            <div class="flow-arrow">→</div>
            <div class="flow-node">
              <div class="flow-icon">📦</div>
              <div class="flow-label">Tiny ERP</div>
              <div class="flow-sub">ERP / Olist</div>
            </div>
          </div>
          <div class="sync-flow" style="margin-top:-8px;">
            <div class="flow-node">
              <div class="flow-icon">🏪</div>
              <div class="flow-label">Mercado Livre</div>
              <div class="flow-sub">Marketplace</div>
            </div>
            <div class="flow-arrow">→</div>
            <div class="flow-node" style="border-color: #0f3460;">
              <div class="flow-icon">🔄</div>
              <div class="flow-label">SyncHub</div>
              <div class="flow-sub">Integrador</div>
            </div>
            <div class="flow-arrow">→</div>
            <div class="flow-node">
              <div class="flow-icon">📋</div>
              <div class="flow-label">SEFAZ</div>
              <div class="flow-sub">Nota Fiscal</div>
            </div>
          </div>

          <!-- Integration Cards -->
          <div class="int-grid" style="margin-top: 20px;">
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

      <!-- Sync Actions -->
      <div class="card" id="sync">
        <div class="card-header">⚡ Sincronização de Pedidos</div>
        <div class="card-body">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; padding:12px 16px; background:${automationPaused ? '#fffbeb' : '#f0fdf4'}; border-radius:8px; border:1px solid ${automationPaused ? '#fde68a' : '#bbf7d0'};">
            <div>
              <strong style="font-size:14px;">${automationPaused ? '⏸ Automação Pausada' : '▶ Automação Ativa'}</strong>
              <div style="font-size:12px;color:#888;margin-top:2px;" id="autoLabel">${automationPaused ? 'Apenas sincronização manual funciona' : 'Sincronizando automaticamente a cada ' + config.pollIntervalMinutes + ' min'}</div>
            </div>
            <button class="btn ${automationPaused ? 'btn-primary' : 'btn-secondary'} btn-sm" id="btnToggle" onclick="toggleAuto()">${automationPaused ? '▶ Ativar' : '⏸ Pausar'}</button>
          </div>

          <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">
            <div style="font-size:13px;color:#666;">Última execução:</div>
            <div style="font-size:13px;font-weight:600;" id="lastSync">${lastRunText}</div>
            <div style="font-size:11px;color:#999;" id="autoStatus">${automationPaused ? '⏸ Pausada' : 'Auto a cada ' + config.pollIntervalMinutes + ' min'}</div>
          </div>

          <div id="msgToggle" class="msg msg-ok"></div>
          <div id="msgRun" class="msg msg-ok"></div>
          <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin: 16px 0;">
            <button class="btn btn-primary" id="btnSync" onclick="syncNow()">▶ Sincronizar Agora</button>
            <span style="font-size:13px; color:#999;">Busca pedidos de ontem e hoje em todos os canais</span>
          </div>

          <hr style="border:none; border-top:1px solid #f0f0f0; margin: 20px 0;">
          <p style="font-size:13px; color:#888; margin-bottom:12px; font-weight:600;">Reprocessar Período Específico</p>
          <div id="msgReprocess" class="msg msg-ok"></div>
          <div class="inline-form">
            <div class="form-sm">
              <label>Data Inicial</label>
              <input type="text" id="de" placeholder="dd/mm/aaaa" maxlength="10">
            </div>
            <div class="form-sm">
              <label>Data Final</label>
              <input type="text" id="ate" placeholder="dd/mm/aaaa" maxlength="10">
            </div>
            <button class="btn btn-secondary btn-sm" id="btnReprocess" onclick="reprocessar()">🔄 Reprocessar</button>
          </div>
        </div>
      </div>

      <!-- Mercado Livre Processing -->
      <div class="card" id="ml-sync">
        <div class="card-header">
          🏪 Mercado Livre — NF com ${config.mlDiscountPercent}% de Desconto (CPF)
          <span class="card-badge" id="mlHeaderBadge">...</span>
        </div>
        <div class="card-body">
          <div id="mlNotConnected" style="display:none; padding:16px; background:#fffbeb; border-radius:8px; border:1px solid #fde68a; margin-bottom:16px;">
            <strong style="font-size:14px;">⚠ Conta Mercado Livre não conectada</strong>
            <div style="font-size:12px;color:#888;margin:6px 0 12px;">Você precisa autorizar o SyncHub a acessar sua conta ML antes de processar pedidos.</div>
            <a href="/ml/connect" class="btn btn-primary btn-sm" style="text-decoration:none;">🔗 Conectar conta Mercado Livre</a>
          </div>
          <div id="mlConnected" style="display:none;">
            <div style="padding:12px 16px; background:#f0fdf4; border-radius:8px; border:1px solid #bbf7d0; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <strong style="font-size:14px;">✓ Conta ML conectada</strong>
                <div style="font-size:12px;color:#666;margin-top:2px;">Seller ID: <span id="mlSellerId" style="font-family:monospace;">...</span></div>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="mlDisconnect()">Desconectar</button>
            </div>

            <p style="font-size:13px; color:#666; margin-bottom:14px;">
              Gera NF para os pedidos do Mercado Livre cuja <strong>data de coleta</strong> seja o dia escolhido. Apenas <strong>CPF</strong> (Pessoa Física), com desconto de <strong>${config.mlDiscountPercent}%</strong> sobre o valor dos produtos. Pedidos que já têm NF são ignorados.
            </p>

            <div id="msgML" class="msg msg-ok"></div>

            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
              <button class="btn btn-primary btn-sm" onclick="mlQuickRun('hoje')" id="btnMLHoje">📅 Coleta Hoje</button>
              <button class="btn btn-primary btn-sm" onclick="mlQuickRun('amanha')" id="btnMLAmanha">📅 Coleta Amanhã</button>
              <button class="btn btn-secondary btn-sm" onclick="mlDebug()" id="btnMLDebug">🔍 Inspecionar API ML</button>
            </div>

            <hr style="border:none; border-top:1px solid #f0f0f0; margin: 6px 0 14px;">
            <p style="font-size:12px; color:#888; margin-bottom:10px; font-weight:600;">Ou escolha um dia específico de coleta</p>
            <div class="inline-form">
              <div class="form-sm">
                <label>Data de coleta</label>
                <input type="text" id="mlDate" placeholder="dd/mm/aaaa" maxlength="10">
              </div>
              <button class="btn btn-secondary btn-sm" id="btnML" onclick="processMLDay()">🏪 Gerar NFs</button>
            </div>

            <div id="mlLastResultBox" style="margin-top:16px; display:none;">
              <p style="font-size:12px;color:#888;font-weight:600;margin-bottom:6px;">Último processamento ML:</p>
              <pre id="mlLastResult" style="background:#f8fafc; padding:12px; border-radius:8px; font-size:12px; white-space:pre-wrap; border:1px solid #e2e8f0;"></pre>
            </div>
          </div>
        </div>
      </div>

      <!-- NFs Table -->
      <div class="card" id="nfs">
        <div class="card-header">📋 Notas Fiscais Emitidas</div>
        <div class="card-body" style="padding: 12px 16px;">
          <div id="nfTable"><p class="empty">Nenhuma NF emitida ainda nesta sessão</p></div>
        </div>
      </div>

      <!-- Sync Logs -->
      <div class="card" id="logs">
        <div class="card-header">📄 Logs de Sincronização</div>
        <div class="card-body" style="padding: 12px;">
          <div class="log-container" id="logContainer">
            <div class="empty" style="color:#666;">Aguardando logs...</div>
          </div>
        </div>
      </div>

      <!-- Last Result -->
      <div class="card" id="config">
        <div class="card-header">📊 Último Resultado Detalhado</div>
        <div class="card-body">
          <pre id="result" style="background:#f8fafc; padding:15px; border-radius:8px; font-size:12px; overflow-x:auto; white-space:pre-wrap; border:1px solid #e2e8f0;">${lastResult ? JSON.stringify(lastResult, null, 2) : 'Nenhum resultado ainda'}</pre>
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
        if (d.lastResult) document.getElementById('result').textContent = JSON.stringify(d.lastResult, null, 2);
        renderNFTable(d.nfHistory);
        renderLogs(d.logs);
      } catch(e) {}
    }, 3000);

    async function syncNow() {
      var btn = document.getElementById('btnSync');
      btn.disabled = true; btn.textContent = '⏳ Sincronizando...';
      try {
        var r = await fetch('/run', { method: 'POST', headers: authHeaders });
        if (r.status === 401) { handleAuthError(); return; }
        var d = await r.json();
        showMsg('msgRun', r.ok ? d.message : d.error, r.ok);
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
        var r = await fetch('/reprocess?de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate), { method: 'POST', headers: authHeaders });
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

    // Inicializa status ML e atualiza periodicamente
    refreshMLStatus();
    setInterval(refreshMLStatus, 5000);
  </script>
</body>
</html>`;
}
