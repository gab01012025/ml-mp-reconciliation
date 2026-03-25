import http from 'node:http';
import { config } from './config';
import { getOrdersByProduct } from './tiny-client';

// Cache para não bater na API a cada refresh
let cache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function todayStr(): string {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = now.getFullYear();
  return `${d}/${m}/${y}`;
}

async function fetchData(dateStr?: string) {
  const date = dateStr || todayStr();
  const cacheKey = date;

  if (cache && cache.data._date === cacheKey && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const result = await getOrdersByProduct(date, date);
  const data = { ...result, _date: cacheKey };
  cache = { data, timestamp: Date.now() };
  return data;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${config.port}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url.pathname === '/api/orders' && req.method === 'GET') {
      const dateParam = url.searchParams.get('date') || undefined;
      // Validate date format dd/mm/yyyy
      if (dateParam && !/^\d{2}\/\d{2}\/\d{4}$/.test(dateParam)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Data invalida. Use dd/mm/aaaa' }));
        return;
      }
      const data = await fetchData(dateParam);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      cache = null;
      const dateParam = url.searchParams.get('date') || undefined;
      if (dateParam && !/^\d{2}\/\d{2}\/\d{4}$/.test(dateParam)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Data invalida. Use dd/mm/aaaa' }));
        return;
      }
      const data = await fetchData(dateParam);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtml());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err: any) {
    console.error('Request error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(config.port, () => {
  console.log(`Painel de etiquetas rodando em http://localhost:${config.port}`);
});

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Painel de Etiquetas - MCS Brasil</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #1a1a2e; }
    
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white; padding: 20px 30px;
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 15px;
    }
    .header h1 { font-size: 22px; }
    .header .stats { display: flex; gap: 20px; flex-wrap: wrap; }
    .header .stat { text-align: center; }
    .header .stat .num { font-size: 28px; font-weight: bold; color: #4fc3f7; }
    .header .stat .label { font-size: 12px; opacity: 0.8; }

    .controls {
      padding: 15px 30px; background: white;
      border-bottom: 1px solid #e0e0e0;
      display: flex; gap: 15px; align-items: center; flex-wrap: wrap;
    }
    .controls input[type="text"] {
      flex: 1; min-width: 200px; padding: 10px 15px;
      border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px;
      outline: none; transition: border-color 0.2s;
    }
    .controls input[type="text"]:focus { border-color: #4fc3f7; }
    .controls input[type="date"] {
      padding: 10px 15px; border: 2px solid #e0e0e0;
      border-radius: 8px; font-size: 14px;
    }
    .controls button {
      padding: 10px 20px; border: none; border-radius: 8px;
      font-size: 14px; cursor: pointer; font-weight: 600;
      transition: all 0.2s;
    }
    .btn-refresh { background: #4fc3f7; color: white; }
    .btn-refresh:hover { background: #29b6f6; }
    .btn-print { background: #66bb6a; color: white; }
    .btn-print:hover { background: #43a047; }

    .content { padding: 20px 30px; }
    .loading { text-align: center; padding: 60px; font-size: 18px; color: #666; }
    .loading .spinner {
      width: 40px; height: 40px; border: 4px solid #e0e0e0;
      border-top-color: #4fc3f7; border-radius: 50%;
      animation: spin 0.8s linear infinite; margin: 0 auto 15px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 15px; }

    .product-card {
      background: white; border-radius: 12px; overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s;
    }
    .product-card:hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); }
    .product-card .card-header {
      padding: 15px 20px; background: #f8f9fa;
      border-bottom: 1px solid #e9ecef;
      display: flex; justify-content: space-between; align-items: center;
    }
    .product-card .card-header h3 { font-size: 16px; color: #1a1a2e; }
    .product-card .card-header .badge {
      background: #4fc3f7; color: white; padding: 4px 12px;
      border-radius: 20px; font-size: 13px; font-weight: 600;
    }
    .product-card .card-header .codigo { font-size: 12px; color: #888; margin-top: 2px; }
    .product-card .card-body { padding: 15px 20px; }

    .order-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 0; border-bottom: 1px solid #f0f0f0;
      font-size: 14px;
    }
    .order-row:last-child { border-bottom: none; }
    .order-row .cliente { flex: 1; color: #333; }
    .order-row .qty {
      background: #e3f2fd; color: #1565c0; padding: 2px 10px;
      border-radius: 12px; font-weight: 600; font-size: 13px;
      white-space: nowrap; margin-left: 10px;
    }
    .order-row .pedido-num { font-size: 12px; color: #888; margin-left: 8px; white-space: nowrap; }
    .order-row .sit {
      font-size: 11px; padding: 2px 8px; border-radius: 10px;
      margin-left: 8px; white-space: nowrap;
    }
    .sit-faturado { background: #c8e6c9; color: #2e7d32; }
    .sit-pronto { background: #fff9c4; color: #f57f17; }
    .sit-preparando { background: #ffe0b2; color: #e65100; }
    .sit-aberto { background: #e3f2fd; color: #1565c0; }
    .sit-outro { background: #f5f5f5; color: #666; }

    .card-footer {
      padding: 10px 20px; background: #fafafa;
      border-top: 1px solid #f0f0f0;
      display: flex; justify-content: space-between;
      font-size: 13px; color: #666;
    }
    .card-footer strong { color: #1a1a2e; }

    .no-results { text-align: center; padding: 40px; color: #888; font-size: 16px; }

    @media print {
      .header, .controls { display: none !important; }
      .content { padding: 10px; }
      .product-card { break-inside: avoid; box-shadow: none; border: 1px solid #ddd; margin-bottom: 10px; }
      .product-grid { display: block; }
    }

    @media (max-width: 600px) {
      .header { padding: 15px; }
      .header h1 { font-size: 18px; }
      .controls { padding: 10px 15px; }
      .content { padding: 10px 15px; }
      .product-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Painel de Etiquetas</h1>
      <div style="font-size:13px; opacity:0.7; margin-top:4px;" id="lastUpdate"></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="num" id="totalProducts">-</div><div class="label">Produtos</div></div>
      <div class="stat"><div class="num" id="totalOrders">-</div><div class="label">Pedidos</div></div>
      <div class="stat"><div class="num" id="totalUnits">-</div><div class="label">Unidades</div></div>
    </div>
  </div>

  <div class="controls">
    <input type="text" id="searchInput" placeholder="Filtrar por produto... (ex: borrifador)" autofocus>
    <input type="date" id="dateInput">
    <button class="btn-refresh" id="btnRefresh">Atualizar</button>
    <button class="btn-print" onclick="window.print()">Imprimir</button>
  </div>

  <div class="content">
    <div id="loading" class="loading">
      <div class="spinner"></div>
      Carregando pedidos do dia...
    </div>
    <div id="productGrid" class="product-grid" style="display:none;"></div>
    <div id="noResults" class="no-results" style="display:none;">Nenhum produto encontrado com esse filtro</div>
  </div>

  <script>
    let allData = null;

    const searchInput = document.getElementById('searchInput');
    const dateInput = document.getElementById('dateInput');
    const btnRefresh = document.getElementById('btnRefresh');
    const loading = document.getElementById('loading');
    const productGrid = document.getElementById('productGrid');
    const noResults = document.getElementById('noResults');

    // Set today's date
    const today = new Date();
    dateInput.value = today.toISOString().split('T')[0];

    function getDateParam() {
      const val = dateInput.value;
      if (!val) return '';
      const [y, m, d] = val.split('-');
      return d + '/' + m + '/' + y;
    }

    function sitClass(sit) {
      const s = sit.toLowerCase();
      if (s.includes('faturado')) return 'sit-faturado';
      if (s.includes('pronto')) return 'sit-pronto';
      if (s.includes('preparando')) return 'sit-preparando';
      if (s.includes('aberto') || s.includes('aprovado')) return 'sit-aberto';
      return 'sit-outro';
    }

    function renderProducts(filter) {
      if (!allData) return;
      const query = (filter || '').toLowerCase().trim();
      const filtered = allData.products.filter(p => {
        if (!query) return true;
        return p.produto.toLowerCase().includes(query)
            || p.codigo.toLowerCase().includes(query);
      });

      // Update stats for filtered view
      const filteredOrders = filtered.reduce((a, p) => a + p.totalPedidos, 0);
      const filteredUnits = filtered.reduce((a, p) => a + p.totalUnidades, 0);
      document.getElementById('totalProducts').textContent = filtered.length;
      document.getElementById('totalOrders').textContent = filteredOrders;
      document.getElementById('totalUnits').textContent = filteredUnits;

      if (filtered.length === 0) {
        productGrid.style.display = 'none';
        noResults.style.display = 'block';
        return;
      }

      noResults.style.display = 'none';
      productGrid.style.display = 'grid';

      productGrid.innerHTML = filtered.map(product => {
        const ordersHtml = product.pedidos.map(o => {
          const qtyLabel = o.quantidade === 1 ? '1 un' : o.quantidade + ' un';
          return '<div class="order-row">'
            + '<span class="cliente">' + escHtml(o.cliente || 'Cliente') + '</span>'
            + '<span class="qty">' + qtyLabel + '</span>'
            + '<span class="pedido-num">#' + escHtml(o.numero) + '</span>'
            + '<span class="sit ' + sitClass(o.situacao) + '">' + escHtml(o.situacao) + '</span>'
            + '</div>';
        }).join('');

        const codigoLine = product.codigo ? '<div class="codigo">SKU: ' + escHtml(product.codigo) + '</div>' : '';

        return '<div class="product-card">'
          + '<div class="card-header">'
          + '<div><h3>' + escHtml(product.produto) + '</h3>' + codigoLine + '</div>'
          + '<span class="badge">' + product.totalPedidos + ' pedido' + (product.totalPedidos > 1 ? 's' : '') + '</span>'
          + '</div>'
          + '<div class="card-body">' + ordersHtml + '</div>'
          + '<div class="card-footer">'
          + '<span>Total: <strong>' + product.totalUnidades + ' unidade' + (product.totalUnidades > 1 ? 's' : '') + '</strong></span>'
          + '</div>'
          + '</div>';
      }).join('');
    }

    function escHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    async function loadData(refresh) {
      loading.style.display = 'block';
      productGrid.style.display = 'none';
      noResults.style.display = 'none';
      btnRefresh.disabled = true;
      btnRefresh.textContent = 'Carregando...';

      try {
        const dateParam = getDateParam();
        const endpoint = refresh ? '/api/refresh' : '/api/orders';
        const method = refresh ? 'POST' : 'GET';
        const url = endpoint + (dateParam ? '?date=' + encodeURIComponent(dateParam) : '');
        const resp = await fetch(url, { method });
        allData = await resp.json();
        loading.style.display = 'none';
        document.getElementById('lastUpdate').textContent = 'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
        renderProducts(searchInput.value);
      } catch (err) {
        loading.innerHTML = '<div style="color:#e53935;">Erro ao carregar: ' + escHtml(err.message) + '</div>';
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.textContent = 'Atualizar';
      }
    }

    searchInput.addEventListener('input', () => renderProducts(searchInput.value));
    btnRefresh.addEventListener('click', () => loadData(true));
    dateInput.addEventListener('change', () => loadData(true));

    // Load on start
    loadData(false);
  </script>
</body>
</html>`;
}
