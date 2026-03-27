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
