import * as http from 'http';
import * as crypto from 'crypto';
import * as cron from 'node-cron';
import { config } from './config';
import { processNewShopeeOrders, clearProcessedOrders, ProcessedNF } from './bot.service';
import { getLogs } from './log-buffer';

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

// Session management
const sessions = new Map<string, { user: string; created: Date }>();

function createSession(user: string): string {
  const token = crypto.randomUUID();
  sessions.set(token, { user, created: new Date() });
  return token;
}

function isAuthenticated(req: http.IncomingMessage): boolean {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return false;
  return sessions.has(match[1]);
}

function parseCookieSession(req: http.IncomingMessage): string | null {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  return match ? match[1] : null;
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

  // Public endpoints
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'shopee-integration-platform', uptime: process.uptime() }));
    return;
  }

  // Login page
  if (url.pathname === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getLoginHtml());
    return;
  }

  // Login action
  if (url.pathname === '/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const params = new URLSearchParams(body);
    const user = (params.get('username') || '').trim();
    const pass = (params.get('password') || '').trim();

    console.log(`[SERVER] Login attempt: user='${user}' (expected='${config.demoUser}') passLen=${pass.length} (expectedLen=${config.demoPass.length})`);
    if (user === config.demoUser && pass === config.demoPass) {
      const token = createSession(user);
      console.log(`[SERVER] Login OK — session token created`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Entrando...</title></head><body><script>document.cookie="session=${token}; path=/; max-age=86400; samesite=lax"; window.location.href="/";</script><p>Redirecionando...</p></body></html>`);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getLoginHtml('Usuário ou senha inválidos'));
      return;
    }
    return;
  }

  // Logout
  if (url.pathname === '/logout') {
    const token = parseCookieSession(req);
    if (token) sessions.delete(token);
    res.writeHead(302, {
      'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0; Secure',
      'Location': '/login',
    });
    res.end();
    return;
  }

  // All routes below require auth
  if (!isAuthenticated(req)) {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'shopee-integration-platform',
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
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
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
  <title>Login — Shopee Integration Platform</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #ee4d2d 0%, #ff6633 50%, #f7941e 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-card { background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.15); padding: 50px 40px; width: 420px; max-width: 90vw; }
    .login-logo { text-align: center; margin-bottom: 30px; }
    .login-logo .icon { font-size: 48px; margin-bottom: 10px; }
    .login-logo h1 { font-size: 22px; color: #333; font-weight: 700; }
    .login-logo p { font-size: 14px; color: #888; margin-top: 5px; }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    .form-group input { width: 100%; padding: 14px 16px; border: 2px solid #e8e8e8; border-radius: 10px; font-size: 15px; outline: none; transition: border-color 0.2s; }
    .form-group input:focus { border-color: #ee4d2d; }
    .btn-login { width: 100%; padding: 15px; background: linear-gradient(135deg, #ee4d2d, #ff6633); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; transition: transform 0.1s, box-shadow 0.2s; }
    .btn-login:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(238,77,45,0.4); }
    .btn-login:active { transform: translateY(0); }
    .error { background: #fff3f0; border: 1px solid #ffccc7; color: #cf1322; padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 20px; text-align: center; }
    .footer { text-align: center; margin-top: 25px; font-size: 12px; color: #bbb; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="login-logo">
      <div class="icon">🛒</div>
      <h1>Shopee Integration Platform</h1>
      <p>Sincronização automática de pedidos e notas fiscais</p>
    </div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <div class="form-group">
        <label>Usuário</label>
        <input type="text" name="username" placeholder="Digite seu usuário" required autofocus>
      </div>
      <div class="form-group">
        <label>Senha</label>
        <input type="password" name="password" placeholder="Digite sua senha" required>
      </div>
      <button type="submit" class="btn-login">Entrar</button>
    </form>
    <div class="footer">v2.0 — Integração Shopee + Tiny ERP</div>
  </div>
</body>
</html>`;
}

function getDashboardHtml(): string {
  const statusText = isRunning ? 'Sincronizando...' : 'Conectado';
  const statusIcon = isRunning ? '🔄' : '🟢';
  const lastRunText = lastRun?.toLocaleString('pt-BR') || 'Aguardando primeira execução';
  const uptimeHours = Math.floor(process.uptime() / 3600);
  const uptimeMin = Math.floor((process.uptime() % 3600) / 60);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — Shopee Integration Platform</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6fa; color: #2d3436; min-height: 100vh; }

    /* Top nav */
    .topnav { background: white; border-bottom: 1px solid #e1e4e8; padding: 0 30px; display: flex; align-items: center; height: 60px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .topnav .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; color: #ee4d2d; }
    .topnav .brand span { font-size: 24px; }
    .topnav .nav-right { margin-left: auto; display: flex; align-items: center; gap: 20px; }
    .topnav .nav-right .user { font-size: 14px; color: #666; }
    .topnav .nav-right a { font-size: 13px; color: #ee4d2d; text-decoration: none; font-weight: 600; }
    .topnav .nav-right a:hover { text-decoration: underline; }

    /* Layout */
    .container { max-width: 1100px; margin: 0 auto; padding: 30px 20px; }

    /* Stats grid */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { background: white; border-radius: 12px; padding: 22px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); border-left: 4px solid #ee4d2d; }
    .stat-card.green { border-left-color: #00b894; }
    .stat-card.blue { border-left-color: #0984e3; }
    .stat-card.purple { border-left-color: #6c5ce7; }
    .stat-card .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; color: #999; font-weight: 600; margin-bottom: 6px; }
    .stat-card .stat-value { font-size: 28px; font-weight: 700; color: #2d3436; }
    .stat-card .stat-sub { font-size: 12px; color: #999; margin-top: 4px; }

    /* Cards */
    .card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); margin-bottom: 24px; overflow: hidden; }
    .card-header { padding: 16px 22px; border-bottom: 1px solid #f0f0f0; font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px; color: #2d3436; }
    .card-body { padding: 20px 22px; }

    /* Integration status */
    .integrations { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .integration { display: flex; align-items: center; gap: 14px; padding: 16px; background: #f8faf8; border-radius: 10px; border: 1px solid #e8f5e9; }
    .integration .int-icon { font-size: 32px; }
    .integration .int-info h3 { font-size: 15px; font-weight: 600; }
    .integration .int-info .int-status { font-size: 13px; color: #00b894; font-weight: 500; }
    .integration .int-info .int-detail { font-size: 12px; color: #999; }

    /* Buttons */
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: #ee4d2d; color: white; }
    .btn-primary:hover:not(:disabled) { background: #d44425; }
    .btn-secondary { background: #f0f0f0; color: #555; }
    .btn-secondary:hover:not(:disabled) { background: #e0e0e0; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }

    /* Forms */
    .inline-form { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
    .form-sm label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; font-weight: 500; }
    .form-sm input { padding: 9px 12px; border: 2px solid #e8e8e8; border-radius: 8px; font-size: 14px; width: 140px; outline: none; }
    .form-sm input:focus { border-color: #ee4d2d; }

    /* Table */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #fafafa; text-align: left; padding: 10px 12px; border-bottom: 2px solid #f0f0f0; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; }
    td { padding: 10px 12px; border-bottom: 1px solid #f5f5f5; }
    tr:hover { background: #fafafa; }
    .chave { font-family: 'Courier New', monospace; font-size: 11px; word-break: break-all; max-width: 220px; color: #555; }
    .btn-copy { padding: 4px 12px; font-size: 12px; border: 1px solid #ee4d2d; background: white; color: #ee4d2d; border-radius: 6px; cursor: pointer; font-weight: 500; }
    .btn-copy:hover { background: #fff3f0; }
    .btn-copy.copied { background: #f6ffed; border-color: #52c41a; color: #52c41a; }

    /* Logs */
    .log-container { max-height: 300px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 12px; background: #1a1a2e; color: #e0e0e0; border-radius: 8px; padding: 15px; }
    .log-entry { padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .log-time { color: #888; }
    .log-info { color: #81ecec; }
    .log-warn { color: #ffeaa7; }
    .log-error { color: #fab1a0; }

    /* Messages */
    .msg { padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; display: none; }
    .msg-ok { background: #f6ffed; color: #389e0d; border: 1px solid #b7eb8f; }
    .msg-err { background: #fff2f0; color: #cf1322; border: 1px solid #ffa39e; }
    .empty { text-align: center; color: #ccc; padding: 30px; font-size: 14px; }

    /* Badge */
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #f6ffed; color: #52c41a; border: 1px solid #b7eb8f; }
    .badge-orange { background: #fff7e6; color: #fa8c16; border: 1px solid #ffd591; }
    .badge-blue { background: #e6f7ff; color: #1890ff; border: 1px solid #91d5ff; }

    @media (max-width: 768px) {
      .integrations { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr 1fr; }
      .inline-form { flex-direction: column; }
      .form-sm input { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="topnav">
    <div class="brand"><span>🛒</span> Shopee Integration Platform</div>
    <div class="nav-right">
      <span class="user">👤 ${config.demoUser}</span>
      <a href="/logout">Sair</a>
    </div>
  </div>

  <div class="container">
    <!-- Stats -->
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Status do Serviço</div>
        <div class="stat-value" id="statusText" style="font-size:18px;">${statusIcon} ${statusText}</div>
        <div class="stat-sub">Uptime: ${uptimeHours}h ${uptimeMin}m</div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">Pedidos Sincronizados</div>
        <div class="stat-value" id="totalOrders">${totalOrdersSynced}</div>
        <div class="stat-sub">Shopee → Tiny ERP</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-label">Notas Fiscais Emitidas</div>
        <div class="stat-value" id="totalNFs">${totalNFsEmitted}</div>
        <div class="stat-sub">Emitidas na SEFAZ</div>
      </div>
      <div class="stat-card purple">
        <div class="stat-label">Última Sincronização</div>
        <div class="stat-value" id="lastSync" style="font-size:14px;">${lastRunText}</div>
        <div class="stat-sub" id="autoStatus">${automationPaused ? '⏸ Automação pausada' : 'Automático a cada ' + config.pollIntervalMinutes + ' min'}</div>
      </div>
    </div>

    <!-- Integrations -->
    <div class="card">
      <div class="card-header">🔗 Integrações Conectadas</div>
      <div class="card-body">
        <div class="integrations">
          <div class="integration">
            <div class="int-icon">🛒</div>
            <div class="int-info">
              <h3>Shopee</h3>
              <div class="int-status">✓ Conectado</div>
              <div class="int-detail">Importação automática de pedidos</div>
            </div>
          </div>
          <div class="integration">
            <div class="int-icon">📦</div>
            <div class="int-info">
              <h3>Tiny ERP (Olist)</h3>
              <div class="int-status">✓ Conectado</div>
              <div class="int-detail">Token: ${config.tinyToken.slice(0, 8)}...${config.tinyToken.slice(-4)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Sync Actions -->
    <div class="card">
      <div class="card-header">⚡ Importar Pedidos da Shopee</div>
      <div class="card-body">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; padding:12px 16px; background:${automationPaused ? '#fff7e6' : '#f6ffed'}; border-radius:8px; border:1px solid ${automationPaused ? '#ffd591' : '#b7eb8f'};">
          <div>
            <strong style="font-size:14px;">${automationPaused ? '⏸ Automação Pausada' : '▶ Automação Ativa'}</strong>
            <div style="font-size:12px;color:#888;margin-top:2px;" id="autoLabel">${automationPaused ? 'Apenas sincronização manual funciona' : 'Sincronizando automaticamente a cada ' + config.pollIntervalMinutes + ' min'}</div>
          </div>
          <button class="btn ${automationPaused ? 'btn-primary' : 'btn-secondary'}" id="btnToggle" onclick="toggleAuto()" style="width:auto;padding:8px 18px;">${automationPaused ? '▶ Ativar' : '⏸ Pausar'}</button>
        </div>
        <div id="msgToggle" class="msg msg-ok"></div>
        <div id="msgRun" class="msg msg-ok"></div>
        <div class="actions" style="margin-bottom: 20px;">
          <button class="btn btn-primary" id="btnSync" onclick="syncNow()">▶ Sincronizar Agora</button>
          <span style="font-size:13px; color:#999;">Busca pedidos de ontem e hoje</span>
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
          <button class="btn btn-secondary" id="btnReprocess" onclick="reprocessar()">🔄 Reprocessar</button>
        </div>
      </div>
    </div>

    <!-- NFs Table -->
    <div class="card">
      <div class="card-header">📋 Notas Fiscais Emitidas</div>
      <div class="card-body" style="padding: 12px 16px;">
        <div id="nfTable"><p class="empty">Nenhuma NF emitida ainda nesta sessão</p></div>
      </div>
    </div>

    <!-- Sync Logs -->
    <div class="card">
      <div class="card-header">📄 Logs de Sincronização</div>
      <div class="card-body" style="padding: 12px;">
        <div class="log-container" id="logContainer">
          <div class="empty" style="color:#666;">Aguardando logs...</div>
        </div>
      </div>
    </div>

    <!-- Last Result -->
    <div class="card">
      <div class="card-header">📊 Último Resultado Detalhado</div>
      <div class="card-body">
        <pre id="result" style="background:#f8f9fa; padding:15px; border-radius:8px; font-size:12px; overflow-x:auto; white-space:pre-wrap; border:1px solid #f0f0f0;">${lastResult ? JSON.stringify(lastResult, null, 2) : 'Nenhum resultado ainda'}</pre>
      </div>
    </div>
  </div>

  <script>
    function showMsg(id, text, ok) {
      const el = document.getElementById(id);
      el.textContent = text;
      el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 8000);
    }

    function renderNFTable(nfs) {
      const c = document.getElementById('nfTable');
      if (!nfs || nfs.length === 0) { c.innerHTML = '<p class="empty">Nenhuma NF emitida ainda nesta sessão</p>'; return; }
      let h = '<table><thead><tr><th>NF</th><th>Pedido Shopee</th><th>Cliente</th><th>Valor</th><th>Chave de Acesso</th><th></th><th>Data</th></tr></thead><tbody>';
      for (const n of nfs) {
        h += '<tr>';
        h += '<td><strong>' + (n.numero || n.nfId) + '</strong></td>';
        h += '<td><span class="badge badge-orange">' + (n.numeroEcommerce || '-') + '</span></td>';
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
      const c = document.getElementById('logContainer');
      if (!logs || logs.length === 0) { c.innerHTML = '<div class="empty" style="color:#666;">Aguardando logs...</div>'; return; }
      let h = '';
      for (const l of logs) {
        const cls = l.level === 'error' ? 'log-error' : l.level === 'warn' ? 'log-warn' : 'log-info';
        h += '<div class="log-entry"><span class="log-time">[' + l.timestamp + ']</span> <span class="' + cls + '">' + escapeHtml(l.message) + '</span></div>';
      }
      c.innerHTML = h;
    }

    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    function copiar(btn, text) {
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✅ Copiado!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 2000);
      });
    }

    setInterval(async () => {
      try {
        const r = await fetch('/status');
        if (r.status === 302 || r.redirected) { window.location = '/login'; return; }
        const d = await r.json();
        document.getElementById('statusText').innerHTML = d.isRunning ? '🔄 Sincronizando...' : '🟢 Conectado';
        document.getElementById('lastSync').textContent = d.lastRunText || 'Aguardando';
        document.getElementById('totalOrders').textContent = d.totalOrdersSynced || '0';
        document.getElementById('totalNFs').textContent = d.totalNFsEmitted || '0';
        document.getElementById('autoStatus').textContent = d.automationPaused ? '⏸ Automação pausada' : 'Automático a cada ${config.pollIntervalMinutes} min';
        if (d.lastResult) document.getElementById('result').textContent = JSON.stringify(d.lastResult, null, 2);
        renderNFTable(d.nfHistory);
        renderLogs(d.logs);
      } catch(e) {}
    }, 3000);

    async function syncNow() {
      const btn = document.getElementById('btnSync');
      btn.disabled = true; btn.textContent = '⏳ Sincronizando...';
      try {
        const r = await fetch('/run', { method: 'POST' });
        const d = await r.json();
        showMsg('msgRun', r.ok ? d.message : d.error, r.ok);
      } catch(e) { showMsg('msgRun', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '▶ Sincronizar Agora';
    }

    async function toggleAuto() {
      const btn = document.getElementById('btnToggle');
      btn.disabled = true;
      try {
        const r = await fetch('/toggle-automation', { method: 'POST' });
        const d = await r.json();
        showMsg('msgToggle', d.message, true);
        setTimeout(() => location.reload(), 1000);
      } catch(e) { showMsg('msgToggle', 'Erro: ' + e.message, false); }
      btn.disabled = false;
    }

    async function reprocessar() {
      const de = document.getElementById('de').value.trim();
      const ate = document.getElementById('ate').value.trim();
      if (!de || !ate) { showMsg('msgReprocess', 'Preencha as duas datas', false); return; }
      if (!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(de) || !/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(ate)) {
        showMsg('msgReprocess', 'Formato inválido. Use dd/mm/aaaa', false); return;
      }
      const btn = document.getElementById('btnReprocess');
      btn.disabled = true; btn.textContent = '⏳ Reprocessando...';
      try {
        const r = await fetch('/reprocess?de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate), { method: 'POST' });
        const d = await r.json();
        showMsg('msgReprocess', d.message || d.error, r.ok);
      } catch(e) { showMsg('msgReprocess', 'Erro: ' + e.message, false); }
      btn.disabled = false; btn.textContent = '🔄 Reprocessar';
    }
  </script>
</body>
</html>`;
}
