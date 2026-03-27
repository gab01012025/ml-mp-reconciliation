import * as http from 'http';
import * as cron from 'node-cron';
import { config } from './config';
import { processNewShopeeOrders, clearProcessedOrders } from './bot.service';

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${config.port}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/health' || url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'tiny-shopee-bot',
      uptime: process.uptime(),
      lastRun: lastRun?.toISOString() || null,
      lastRunText: lastRun?.toLocaleString('pt-BR') || 'Nunca',
      lastResult,
      isRunning,
      pendingReprocess: !!pendingReprocess,
    }));
  } else if (url.pathname === '/run' && req.method === 'POST') {
    if (isRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bot já está rodando. Aguarde finalizar.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Execução manual iniciada (ignora bloqueio de horário)' }));
    runBot(undefined, undefined, true);
  } else if (url.pathname === '/reprocess' && req.method === 'POST') {
    const dataInicial = url.searchParams.get('de') || undefined;
    const dataFinal = url.searchParams.get('ate') || undefined;
    // Valida formato dd/mm/yyyy
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (dataInicial && !dateRegex.test(dataInicial)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data "de" invalida. Use dd/mm/aaaa' }));
      return;
    }
    if (dataFinal && !dateRegex.test(dataFinal)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data "ate" invalida. Use dd/mm/aaaa' }));
      return;
    }
    if (isRunning) {
      // Enfileira o reprocessamento
      pendingReprocess = { de: dataInicial, ate: dataFinal };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bot rodando - reprocessamento enfileirado. Vai rodar assim que terminar.', de: dataInicial || 'ontem', ate: dataFinal || 'hoje' }));
      return;
    }
    clearProcessedOrders();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Reprocessamento iniciado (ignora bloqueio de horário)', de: dataInicial || 'ontem', ate: dataFinal || 'hoje' }));
    runBot(dataInicial, dataFinal, true);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getPageHtml());
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
    lastResult = await processNewShopeeOrders(dataInicial, dataFinal, skipBlockCheck);
    lastRun = new Date();
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

// Agenda execução a cada N minutos
const cronExpression = `*/${config.pollIntervalMinutes} * * * *`;
cron.schedule(cronExpression, () => {
  runBot();
});

// Executa imediatamente na primeira vez
runBot();

function getPageHtml(): string {
  const statusText = isRunning ? '🔄 Rodando...' : '✅ Aguardando';
  const lastRunText = lastRun?.toLocaleString('pt-BR') || 'Nunca';
  const resultJson = lastResult ? JSON.stringify(lastResult, null, 2) : 'Nenhum resultado ainda';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tiny Shopee Bot</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #1a1a2e; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; padding: 25px 30px; }
    .header h1 { font-size: 24px; margin-bottom: 5px; }
    .header p { opacity: 0.7; font-size: 14px; }
    .container { max-width: 700px; margin: 30px auto; padding: 0 20px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; overflow: hidden; }
    .card-header { padding: 15px 20px; background: #f8f9fa; border-bottom: 1px solid #e9ecef; font-weight: 600; font-size: 16px; }
    .card-body { padding: 20px; }
    .status-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; }
    .status-label { color: #666; font-size: 14px; }
    .status-value { font-weight: 600; font-size: 14px; }
    .btn { display: inline-block; padding: 12px 24px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s; width: 100%; text-align: center; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-blue { background: #4fc3f7; color: white; }
    .btn-blue:hover:not(:disabled) { background: #29b6f6; }
    .btn-green { background: #66bb6a; color: white; }
    .btn-green:hover:not(:disabled) { background: #43a047; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 5px; font-size: 14px; color: #555; font-weight: 500; }
    .form-group input { width: 100%; padding: 10px 14px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 15px; outline: none; }
    .form-group input:focus { border-color: #4fc3f7; }
    .date-row { display: flex; gap: 15px; }
    .date-row .form-group { flex: 1; }
    pre { background: #f5f5f5; padding: 15px; border-radius: 8px; font-size: 13px; overflow-x: auto; white-space: pre-wrap; }
    .msg { padding: 12px 16px; border-radius: 8px; margin-bottom: 15px; font-size: 14px; display: none; }
    .msg-ok { background: #c8e6c9; color: #2e7d32; }
    .msg-err { background: #ffcdd2; color: #c62828; }
    .separator { border: none; border-top: 1px solid #eee; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🤖 Tiny Shopee Bot</h1>
    <p>Alteração automática de valores + geração de NF</p>
  </div>
  <div class="container">
    <div class="card">
      <div class="card-header">Status</div>
      <div class="card-body">
        <div class="status-row"><span class="status-label">Estado</span><span class="status-value" id="status">${statusText}</span></div>
        <div class="status-row"><span class="status-label">Última execução</span><span class="status-value" id="lastRun">${lastRunText}</span></div>
        <div class="status-row"><span class="status-label">Intervalo automático</span><span class="status-value">A cada ${config.pollIntervalMinutes} min</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Executar Agora (pedidos de ontem/hoje)</div>
      <div class="card-body">
        <div id="msgRun" class="msg msg-ok"></div>
        <button class="btn btn-blue" id="btnRun" onclick="executar()">▶ Executar Verificação</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Reprocessar Pedidos por Data</div>
      <div class="card-body">
        <p style="font-size:13px; color:#888; margin-bottom:15px;">Rode o bot em pedidos de qualquer período. Ignora o cache — reprocessa todos.</p>
        <div class="date-row">
          <div class="form-group">
            <label>Data inicial</label>
            <input type="text" id="de" placeholder="dd/mm/aaaa" maxlength="10">
          </div>
          <div class="form-group">
            <label>Data final</label>
            <input type="text" id="ate" placeholder="dd/mm/aaaa" maxlength="10">
          </div>
        </div>
        <div id="msgReprocess" class="msg msg-ok"></div>
        <button class="btn btn-green" id="btnReprocess" onclick="reprocessar()">🔄 Reprocessar</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Último Resultado</div>
      <div class="card-body">
        <pre id="result">${resultJson}</pre>
      </div>
    </div>
  </div>

  <script>
    function showMsg(id, text, ok) {
      const el = document.getElementById(id);
      el.textContent = text;
      el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
      el.style.display = 'block';
    }

    // Polling de status a cada 3 segundos
    setInterval(async () => {
      try {
        const r = await fetch('/status');
        const d = await r.json();
        document.getElementById('status').textContent = d.isRunning ? '🔄 Rodando...' : '✅ Aguardando';
        document.getElementById('lastRun').textContent = d.lastRunText || 'Nunca';
        if (d.lastResult) document.getElementById('result').textContent = JSON.stringify(d.lastResult, null, 2);
        if (d.pendingReprocess) document.getElementById('status').textContent += ' (reprocessamento na fila)';
      } catch(e) {}
    }, 3000);

    async function executar() {
      const btn = document.getElementById('btnRun');
      btn.disabled = true;
      btn.textContent = 'Rodando...';
      try {
        const r = await fetch('/run', { method: 'POST' });
        const d = await r.json();
        if (r.ok) showMsg('msgRun', d.message, true);
        else showMsg('msgRun', d.error, false);
      } catch(e) { showMsg('msgRun', 'Erro: ' + e.message, false); }
      btn.disabled = false;
      btn.textContent = '▶ Executar Verificação';
    }

    async function reprocessar() {
      const de = document.getElementById('de').value.trim();
      const ate = document.getElementById('ate').value.trim();
      if (!de || !ate) { showMsg('msgReprocess', 'Preencha as duas datas', false); return; }
      if (!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(de) || !/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(ate)) {
        showMsg('msgReprocess', 'Formato invalido. Use dd/mm/aaaa', false); return;
      }

      const btn = document.getElementById('btnReprocess');
      btn.disabled = true;
      btn.textContent = 'Reprocessando...';
      try {
        const r = await fetch('/reprocess?de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate), { method: 'POST' });
        const d = await r.json();
        showMsg('msgReprocess', d.message || d.error, r.ok);
      } catch(e) { showMsg('msgReprocess', 'Erro: ' + e.message, false); }
      btn.disabled = false;
      btn.textContent = '🔄 Reprocessar';
    }
  </script>
</body>
</html>`;
}
