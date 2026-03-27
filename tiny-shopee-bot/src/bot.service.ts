import {
  searchOrders,
  getOrder,
  isShopeeOrder,
  hasClientAddress,
  createAndEmitNF,
  hasMaskedClientData,
} from './tiny-client';
import { config } from './config';

// Rastreia pedidos já processados para evitar reprocessamento
const processedOrders = new Set<string>();

/**
 * Limpa o cache de pedidos processados (para forçar reprocessamento)
 */
export function clearProcessedOrders(): void {
  processedOrders.clear();
}

/**
 * Formata data atual no formato DD/MM/YYYY
 */
function formatDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

/**
 * Verifica se estamos no horário bloqueado para NF (13h-19h)
 */
function isNFBlocked(): boolean {
  const now = new Date();
  const hour = now.getHours();
  return hour >= 13 && hour < 19;
}

/**
 * Busca e processa pedidos Shopee novos
 */
export async function processNewShopeeOrders(customDataInicial?: string, customDataFinal?: string): Promise<{
  found: number;
  altered: number;
  nfGenerated: number;
  skippedNF: number;
  errors: number;
}> {
  const stats = { found: 0, altered: 0, nfGenerated: 0, skippedNF: 0, errors: 0 };

  let dataInicial: string;
  let dataFinal: string;

  if (customDataInicial && customDataFinal) {
    dataInicial = customDataInicial;
    dataFinal = customDataFinal;
  } else {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    dataInicial = formatDate(yesterday);
    dataFinal = formatDate(today);
  }

  const nfBlocked = isNFBlocked();
  if (nfBlocked) {
    console.log(`[BOT] Horario bloqueado para NF (13h-19h). Pedidos serao processados no proximo ciclo fora desse horario.`);
    return stats;
  }

  console.log(`\n[BOT] Buscando pedidos de ${dataInicial} a ${dataFinal}...`);

  try {
    // Busca todas as paginas de pedidos
    let page = 1;
    let totalPages = 1;
    const allOrders: Array<{ id: string; numero: string; numero_ecommerce: string; valor: string; situacao: string }> = [];

    while (page <= totalPages) {
      const result = await searchOrders({
        dataInicial,
        dataFinal,
        pagina: page,
      });
      totalPages = result.totalPages;
      allOrders.push(...result.orders);
      page++;

      // Rate limiting - Tiny API tem limite de 60 req/min
      await sleep(1100);
    }

    // Filtra pedidos que parecem ser da Shopee (ID alfanumerico, nao comeca com 2000)
    // Status ignorados: Cancelado, Enviado (ja foram processados completamente)
    const statusIgnorados = new Set(['Cancelado', 'Enviado']);
    const potentialShopee = allOrders.filter(o => {
      const ne = o.numero_ecommerce;
      const isShopeeFormat = ne && ne.length > 0 && !ne.startsWith('2000') && ne !== '';
      const notIgnored = !statusIgnorados.has(o.situacao);
      return isShopeeFormat && notIgnored;
    });

    console.log(`[BOT] ${allOrders.length} pedidos totais, ${potentialShopee.length} possiveis Shopee pendentes`);

    // Log status breakdown
    const statusCount: Record<string, number> = {};
    for (const o of potentialShopee) {
      statusCount[o.situacao] = (statusCount[o.situacao] || 0) + 1;
    }
    console.log(`[BOT] Status breakdown:`, statusCount);

    for (const order of potentialShopee) {
      if (processedOrders.has(order.id)) continue;

      try {
        // Rate limiting - 1s entre chamadas
        await sleep(1100);

        // Obtem detalhes completos para confirmar que é Shopee
        const detail = await getOrder(order.id);

        if (!isShopeeOrder(detail)) {
          console.log(`[BOT] Pedido ${order.id} (${order.numero}) NAO é Shopee (ecommerce: ${detail.ecommerce?.nomeEcommerce || 'N/A'}), pulando`);
          processedOrders.add(order.id);
          continue;
        }

        stats.found++;

        // Pedido com dados do cliente mascarados pela Shopee (***): nao gera NF
        if (hasMaskedClientData(detail)) {
          console.log(`[BOT] Pedido ${order.id} (${detail.numero}) dados do cliente mascarados (***) - PULANDO`);
          stats.skippedNF++;
          processedOrders.add(order.id);
          continue;
        }

        // Verifica se já tem NF gerada
        if (detail.id_nota_fiscal) {
          console.log(`[BOT] Pedido ${order.id} (${detail.numero}) ja tem NF (${detail.id_nota_fiscal}), pulando`);
          processedOrders.add(order.id);
          continue;
        }

        // Sem endereço completo: pula (não gera NF com valores errados)
        if (!hasClientAddress(detail)) {
          console.log(`[BOT] Pedido ${order.id} (${detail.numero}) sem endereco completo - PULANDO`);
          stats.skippedNF++;
          processedOrders.add(order.id);
          continue;
        }

        // Cria NF com valores das faixas e emite na SEFAZ
        console.log(`[BOT] Criando NF para pedido ${order.id} (${detail.numero}) - total original: R$${detail.total_pedido}`);
        await sleep(1100);

        const nf = await createAndEmitNF(detail);
        if (nf.success) {
          stats.altered++;
          stats.nfGenerated++;
        } else {
          stats.errors++;
        }
        processedOrders.add(order.id);
      } catch (err) {
        console.error(`[ERRO] Falha ao processar pedido ${order.id}:`, err);
        stats.errors++;
      }
    }
  } catch (err) {
    console.error('[ERRO] Falha na busca de pedidos:', err);
  }

  console.log(`[BOT] Resultado: ${stats.found} Shopee, ${stats.altered} NFs com valor alterado, ${stats.nfGenerated} NFs emitidas, ${stats.skippedNF} pulados, ${stats.errors} erros`);
  return stats;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
