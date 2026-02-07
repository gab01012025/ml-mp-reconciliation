/**
 * Dashboard Route
 * Serves a simple HTML dashboard for viewing sales reports
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  // Serve the dashboard HTML (no auth required for the page itself - API calls still need auth)
  fastify.get(
    '/dashboard',
    { config: { skipAuth: true } as Record<string, unknown> },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.type('text/html').send(getDashboardHTML());
    }
  );
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conciliacao ML - Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      color: #333;
    }
    .header {
      background: linear-gradient(135deg, #ffe600 0%, #ffd000 100%);
      padding: 20px 30px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .header h1 {
      font-size: 22px;
      color: #333;
      font-weight: 700;
    }
    .header p {
      font-size: 13px;
      color: #555;
      margin-top: 4px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }
    .filters {
      background: #fff;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      display: flex;
      gap: 15px;
      align-items: flex-end;
      flex-wrap: wrap;
    }
    .filter-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .filter-group label {
      font-size: 12px;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
    }
    .filter-group input, .filter-group select {
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
    }
    .filter-group input:focus, .filter-group select:focus {
      border-color: #ffe600;
      box-shadow: 0 0 0 2px rgba(255,230,0,0.3);
    }
    .btn {
      padding: 9px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #ffe600;
      color: #333;
    }
    .btn-primary:hover { background: #ffd000; }
    .btn-secondary {
      background: #e8e8e8;
      color: #333;
    }
    .btn-secondary:hover { background: #ddd; }
    .btn-export {
      background: #28a745;
      color: #fff;
    }
    .btn-export:hover { background: #218838; }
    .btn-sync {
      background: #007bff;
      color: #fff;
    }
    .btn-sync:hover { background: #0069d9; }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .card {
      background: #fff;
      border-radius: 10px;
      padding: 18px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .card .label {
      font-size: 12px;
      color: #888;
      text-transform: uppercase;
      font-weight: 600;
    }
    .card .value {
      font-size: 24px;
      font-weight: 700;
      margin-top: 5px;
      color: #333;
    }
    .card .value.green { color: #28a745; }
    .card .value.red { color: #dc3545; }
    .card .value.blue { color: #007bff; }
    .card .value.orange { color: #fd7e14; }
    .table-container {
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      overflow-x: auto;
    }
    .table-header {
      padding: 15px 20px;
      border-bottom: 1px solid #eee;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .table-header h2 {
      font-size: 16px;
      color: #333;
    }
    .table-info {
      font-size: 13px;
      color: #888;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      background: #f8f9fa;
      padding: 10px 12px;
      text-align: left;
      font-size: 12px;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
      border-bottom: 2px solid #eee;
      white-space: nowrap;
    }
    td {
      padding: 10px 12px;
      font-size: 13px;
      border-bottom: 1px solid #f0f0f0;
    }
    tr:hover { background: #fafafa; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .status-paid {
      background: #d4edda;
      color: #155724;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-cancelled {
      background: #f8d7da;
      color: #721c24;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-other {
      background: #e2e3e5;
      color: #383d41;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .loading {
      text-align: center;
      padding: 60px;
      color: #888;
    }
    .loading .spinner {
      display: inline-block;
      width: 30px;
      height: 30px;
      border: 3px solid #eee;
      border-top-color: #ffe600;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty {
      text-align: center;
      padding: 60px;
      color: #aaa;
    }
    .quick-filters {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .quick-btn {
      padding: 6px 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      background: #fff;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .quick-btn:hover, .quick-btn.active {
      border-color: #ffe600;
      background: #fffde6;
    }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      z-index: 1000;
      opacity: 0;
      transition: opacity 0.3s;
    }
    .toast.show { opacity: 1; }
    .toast.success { background: #28a745; }
    .toast.error { background: #dc3545; }
    .toast.info { background: #007bff; }
    .produto-cell {
      max-width: 250px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @media (max-width: 768px) {
      .filters { flex-direction: column; }
      .cards { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Conciliacao Mercado Livre</h1>
    <p>Relatorio de Vendas e Taxas</p>
  </div>

  <div class="container">
    <!-- Filtros -->
    <div class="filters">
      <div class="filter-group">
        <label>Data Inicio</label>
        <input type="date" id="startDate">
      </div>
      <div class="filter-group">
        <label>Data Fim</label>
        <input type="date" id="endDate">
      </div>
      <div class="filter-group">
        <label>Status</label>
        <select id="statusFilter">
          <option value="">Todos</option>
          <option value="PAID">Pagos</option>
          <option value="CANCELLED">Cancelados</option>
        </select>
      </div>
      <button class="btn btn-primary" id="btnBuscar" onclick="buscarDados()">Buscar</button>
      <button class="btn btn-export" onclick="exportarCSV()">Exportar CSV</button>
      <button class="btn btn-sync" id="btnSync" onclick="sincronizar()">Sincronizar ML</button>
      <div class="quick-filters" style="margin-left: auto;">
        <span style="font-size:12px;color:#888;">Rapido:</span>
        <button class="quick-btn" onclick="setPeriodo(0)">Hoje</button>
        <button class="quick-btn" onclick="setPeriodo(1)">Ontem</button>
        <button class="quick-btn" onclick="setPeriodo(7)">7 dias</button>
        <button class="quick-btn" onclick="setPeriodo(30)">30 dias</button>
        <button class="quick-btn" onclick="setPeriodo(90)">90 dias</button>
      </div>
    </div>

    <!-- Cards resumo -->
    <div class="cards" id="cards">
      <div class="card"><div class="label">Total Pedidos</div><div class="value" id="totalPedidos">-</div></div>
      <div class="card"><div class="label">Valor Bruto</div><div class="value blue" id="totalBruto">-</div></div>
      <div class="card"><div class="label">Taxa ML</div><div class="value red" id="totalTaxaML">-</div></div>
      <div class="card"><div class="label">Taxa MP</div><div class="value red" id="totalTaxaMP">-</div></div>
      <div class="card"><div class="label">Frete</div><div class="value orange" id="totalFrete">-</div></div>
      <div class="card"><div class="label">Total Liquido</div><div class="value green" id="totalLiquido">-</div></div>
    </div>

    <!-- Tabela -->
    <div class="table-container">
      <div class="table-header">
        <h2>Pedidos</h2>
        <span class="table-info" id="tableInfo"></span>
      </div>
      <div id="tableBody">
        <div class="empty">Selecione um periodo e clique em "Buscar"</div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const API_KEY = '';
    let dadosAtuais = [];

    // Inicializar com ultimos 7 dias
    window.onload = function() {
      setPeriodo(7);
      // Pedir API key se nao tiver
      const savedKey = localStorage.getItem('apiKey');
      if (savedKey) {
        document.getElementById('btnBuscar').click();
      }
    };

    function getApiKey() {
      let key = localStorage.getItem('apiKey');
      if (!key) {
        key = prompt('Digite a chave da API (x-api-key):');
        if (key) localStorage.setItem('apiKey', key);
      }
      return key;
    }

    function setPeriodo(dias) {
      const hoje = new Date();
      const inicio = new Date();
      if (dias === 0) {
        // Hoje
        document.getElementById('startDate').value = formatDate(hoje);
        document.getElementById('endDate').value = formatDate(new Date(hoje.getTime() + 86400000));
      } else if (dias === 1) {
        // Ontem
        inicio.setDate(inicio.getDate() - 1);
        document.getElementById('startDate').value = formatDate(inicio);
        document.getElementById('endDate').value = formatDate(hoje);
      } else {
        inicio.setDate(inicio.getDate() - dias);
        document.getElementById('startDate').value = formatDate(inicio);
        document.getElementById('endDate').value = formatDate(new Date(hoje.getTime() + 86400000));
      }
      // Destacar botao ativo
      document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
      event && event.target && event.target.classList.add('active');
      buscarDados();
    }

    function formatDate(d) {
      return d.toISOString().split('T')[0];
    }

    function formatMoney(v) {
      if (v === null || v === undefined) return 'R$ 0,00';
      return 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.');
    }

    function formatNum(v) {
      if (v === null || v === undefined) return '0,00';
      return Number(v).toFixed(2).replace('.', ',');
    }

    async function buscarDados() {
      const key = getApiKey();
      if (!key) return;

      const startDate = document.getElementById('startDate').value;
      const endDate = document.getElementById('endDate').value;
      const status = document.getElementById('statusFilter').value;

      if (!startDate || !endDate) {
        showToast('Selecione as datas', 'error');
        return;
      }

      const btn = document.getElementById('btnBuscar');
      btn.disabled = true;
      btn.textContent = 'Buscando...';

      document.getElementById('tableBody').innerHTML = '<div class="loading"><div class="spinner"></div><p style="margin-top:10px">Carregando dados...</p></div>';

      try {
        let url = window.location.origin + '/reports/orders/details?startDate=' + startDate + '&endDate=' + endDate + '&limit=2000';
        const resp = await fetch(url, {
          headers: { 'x-api-key': key }
        });

        if (resp.status === 401 || resp.status === 403) {
          localStorage.removeItem('apiKey');
          showToast('Chave API invalida. Recarregue a pagina.', 'error');
          return;
        }

        const data = await resp.json();
        if (!data.success) {
          showToast('Erro: ' + (data.message || 'Falha ao buscar dados'), 'error');
          return;
        }

        dadosAtuais = data.data || [];

        // Filtrar por status se selecionado
        if (status) {
          dadosAtuais = dadosAtuais.filter(o => o.status === status);
        }

        renderCards(dadosAtuais);
        renderTable(dadosAtuais);
        showToast(dadosAtuais.length + ' pedidos encontrados', 'success');

      } catch (err) {
        showToast('Erro de conexao: ' + err.message, 'error');
        document.getElementById('tableBody').innerHTML = '<div class="empty">Erro ao carregar dados</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Buscar';
      }
    }

    function renderCards(orders) {
      const paid = orders.filter(o => o.status === 'PAID');
      const totalBruto = paid.reduce((s, o) => s + (o.valorProduto || 0) * (o.quantidade || 1), 0);
      const totalTaxaML = paid.reduce((s, o) => s + (o.taxaML || 0), 0);
      const totalTaxaMP = paid.reduce((s, o) => s + (o.taxaMP || 0), 0);
      const totalFrete = paid.reduce((s, o) => s + (o.frete || 0), 0);
      const totalLiquido = paid.reduce((s, o) => s + (o.totalLiquido || 0), 0);

      document.getElementById('totalPedidos').textContent = paid.length;
      document.getElementById('totalBruto').textContent = formatMoney(totalBruto);
      document.getElementById('totalTaxaML').textContent = formatMoney(totalTaxaML);
      document.getElementById('totalTaxaMP').textContent = formatMoney(totalTaxaMP);
      document.getElementById('totalFrete').textContent = formatMoney(totalFrete);
      document.getElementById('totalLiquido').textContent = formatMoney(totalLiquido);
    }

    function renderTable(orders) {
      if (orders.length === 0) {
        document.getElementById('tableBody').innerHTML = '<div class="empty">Nenhum pedido encontrado nesse periodo</div>';
        document.getElementById('tableInfo').textContent = '';
        return;
      }

      document.getElementById('tableInfo').textContent = orders.length + ' registros';

      let html = '<table><thead><tr>';
      html += '<th>Pedido</th><th>Data</th><th>Status</th><th>Produto</th><th>Qtd</th>';
      html += '<th>Valor Bruto</th><th>Taxa ML</th><th>Taxa MP</th><th>Frete</th>';
      html += '<th>Total Liquido</th><th>SKU</th>';
      html += '</tr></thead><tbody>';

      for (const o of orders) {
        const statusClass = o.status === 'PAID' ? 'status-paid' : o.status === 'CANCELLED' ? 'status-cancelled' : 'status-other';
        html += '<tr>';
        html += '<td>' + o.pedidoId + '</td>';
        html += '<td>' + (o.data || '') + '</td>';
        html += '<td><span class="' + statusClass + '">' + o.status + '</span></td>';
        html += '<td class="produto-cell" title="' + (o.produto || '').replace(/"/g, '&quot;') + '">' + (o.produto || '') + '</td>';
        html += '<td class="num">' + (o.quantidade || 1) + '</td>';
        html += '<td class="num">' + formatNum(o.valorProduto) + '</td>';
        html += '<td class="num">' + formatNum(o.taxaML) + '</td>';
        html += '<td class="num">' + formatNum(o.taxaMP) + '</td>';
        html += '<td class="num">' + formatNum(o.frete) + '</td>';
        html += '<td class="num">' + formatNum(o.totalLiquido) + '</td>';
        html += '<td>' + (o.sku || '') + '</td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      document.getElementById('tableBody').innerHTML = html;
    }

    function exportarCSV() {
      if (dadosAtuais.length === 0) {
        showToast('Nenhum dado para exportar', 'error');
        return;
      }

      const headers = ['Pedido', 'Data', 'Status', 'Produto', 'Quantidade', 'Valor Bruto', 'Taxa Venda', 'Taxa ML', 'Taxa MP', 'Frete', 'Total Liquido', 'SKU'];
      let csv = headers.join(';') + '\\n';

      for (const o of dadosAtuais) {
        csv += [
          o.pedidoId,
          o.data,
          o.status,
          '"' + (o.produto || '').replace(/"/g, '""') + '"',
          o.quantidade || 1,
          formatNum(o.valorProduto),
          formatNum(o.taxaVenda),
          formatNum(o.taxaML),
          formatNum(o.taxaMP),
          formatNum(o.frete),
          formatNum(o.totalLiquido),
          o.sku || ''
        ].join(';') + '\\n';
      }

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const startDate = document.getElementById('startDate').value;
      const endDate = document.getElementById('endDate').value;
      link.download = 'relatorio-ml-' + startDate + '-a-' + endDate + '.csv';
      link.click();
      showToast('CSV exportado!', 'success');
    }

    async function sincronizar() {
      const key = getApiKey();
      if (!key) return;

      const btn = document.getElementById('btnSync');
      btn.disabled = true;
      btn.textContent = 'Sincronizando...';

      try {
        const resp = await fetch(window.location.origin + '/sync/ml/orders', {
          method: 'POST',
          headers: { 'x-api-key': key }
        });
        const data = await resp.json();
        if (data.success) {
          showToast('Sincronizacao concluida! ' + (data.data?.ordersProcessed || 0) + ' pedidos processados', 'success');
          // Recarregar dados
          setTimeout(() => buscarDados(), 2000);
        } else {
          showToast('Erro na sincronizacao: ' + (data.message || ''), 'error');
        }
      } catch (err) {
        showToast('Erro: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sincronizar ML';
      }
    }

    function showToast(msg, type) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.className = 'toast show ' + type;
      setTimeout(() => toast.className = 'toast', 3000);
    }
  </script>
</body>
</html>`;
}
