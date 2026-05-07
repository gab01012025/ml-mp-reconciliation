// Configurações do bot
export const config = {
  // Token da API do Tiny ERP (Olist)
  tinyToken: process.env.TINY_TOKEN || '4aa19f0ae99e08d9dcbd909d9c6f6b5314eca013882cc292950a69eb0ad75364',

  // Faixas de valor unitário por total do pedido original (Shopee)
  // >= R$100 = R$15.00 | R$60-R$99 = R$3.00 | R$15-R$59 = R$1.00 | < R$15 = R$0.50
  faixaMuitoAlta: 100,    // limite para valor muito alto
  valorMuitoAlto: 15.00,  // pedidos acima de R$100
  faixaAlta: 60,           // limite para valor alto
  valorAlto: 3.00,         // pedidos de R$60 a R$99
  faixaBaixa: 15,          // limite para valor baixo
  valorMedio: 1.00,        // pedidos de R$15 a R$59
  valorBaixo: 0.50,        // pedidos abaixo de R$15

  // Intervalo de polling em minutos
  pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL || '30', 10),

  // Base URL da API do Tiny
  tinyApiUrl: 'https://api.tiny.com.br/api2',

  // Porta do servidor HTTP para health check
  port: parseInt(process.env.PORT || '3001', 10),

  // Demo credentials for Shopee Open Platform reviewer
  demoUser: process.env.DEMO_USER || 'admin',
  demoPass: process.env.DEMO_PASS || 'shopee2026',

  // Start with automation paused (true = only manual sync works)
  automationPausedDefault: process.env.AUTOMATION_PAUSED !== 'false',

  // Mercado Livre OAuth (App MLCheck)
  mlClientId: process.env.ML_CLIENT_ID || '7462399727089965',
  mlClientSecret: process.env.ML_CLIENT_SECRET || 'hkDcv4NWZOeyLSAm293dL5rJ0gNi6FYJ',
  mlRedirectUri: process.env.ML_REDIRECT_URI || 'https://synchub.webmedula.com.br/ml/callback',
  mlTokenStorePath: process.env.ML_TOKEN_STORE || '/tmp/ml-tokens.json',
  mlShipmentCachePath: process.env.ML_SHIPMENT_CACHE || '/tmp/ml-shipments-cache.json',
  mlShipmentCacheTtlMs: parseInt(process.env.ML_SHIPMENT_CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10),

  // Mercado Livre: desconto aplicado sobre o valor dos produtos (ex: 30 = 30% off → NF emitida com 70% do valor)
  mlDiscountPercent: parseFloat(process.env.ML_DISCOUNT_PERCENT || '30'),

  // Shopee: desconto aplicado sobre o valor dos produtos (ex: 95 = 95% off → NF emitida com 5% do valor)
  shopeeDiscountPercent: parseFloat(process.env.SHOPEE_DISCOUNT_PERCENT || '95'),
};

/**
 * Calcula o valor unitário com base no total original do pedido
 */
export function calcularValorUnitario(totalPedido: number): number {
  if (totalPedido >= config.faixaMuitoAlta) return config.valorMuitoAlto;
  if (totalPedido >= config.faixaAlta) return config.valorAlto;
  if (totalPedido >= config.faixaBaixa) return config.valorMedio;
  return config.valorBaixo;
}
