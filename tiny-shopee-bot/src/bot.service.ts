import {
  searchOrders,
  getOrder,
  searchByNumeroEcommerce,
  isShopeeOrder,
  isMercadoLivreOrder,
  isPessoaFisica,
  hasClientAddress,
  createAndEmitNF,
  createAndEmitNFDiscounted,
  hasMaskedClientData,
  NFResult,
} from './tiny-client';
import { config } from './config';
import * as ml from './ml-client';

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

export interface ProcessedNF {
  numero: string;
  nfId: string;
  chaveAcesso: string;
  clienteNome: string;
  numeroEcommerce: string;
  valorNota: number;
  dataProcessamento: string;
}

export interface BotResult {
  found: number;
  altered: number;
  nfGenerated: number;
  skippedNF: number;
  errors: number;
  nfs: ProcessedNF[];
}

/**
 * Busca e processa pedidos Shopee novos
 */
export async function processNewShopeeOrders(customDataInicial?: string, customDataFinal?: string, skipBlockCheck = false): Promise<BotResult> {
  const stats: BotResult = { found: 0, altered: 0, nfGenerated: 0, skippedNF: 0, errors: 0, nfs: [] };

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

  if (!skipBlockCheck && isNFBlocked()) {
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

        // Sem numero_ecommerce: pula (NF não será vinculada ao pedido Shopee)
        if (!detail.numero_ecommerce) {
          console.log(`[BOT] Pedido ${order.id} (${detail.numero}) sem numero_ecommerce - PULANDO (NF não linkaria com Shopee)`);
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
          if (nf.chaveAcesso) {
            stats.nfs.push({
              numero: nf.numero || '',
              nfId: nf.nfId || '',
              chaveAcesso: nf.chaveAcesso,
              clienteNome: nf.clienteNome || '',
              numeroEcommerce: nf.numeroEcommerce || '',
              valorNota: nf.valorNota || 0,
              dataProcessamento: new Date().toLocaleString('pt-BR'),
            });
          }
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

/**
 * Processa pedidos do Mercado Livre de uma data específica (dd/mm/yyyy),
 * filtrando apenas Pessoa Física (CPF) e emitindo NF com desconto configurado (default 30%).
 */
export async function processMercadoLivreOrdersForDate(dataDia: string): Promise<BotResult> {
  const stats: BotResult = { found: 0, altered: 0, nfGenerated: 0, skippedNF: 0, errors: 0, nfs: [] };
  const discount = config.mlDiscountPercent;

  console.log(`\n[BOT-ML] Buscando pedidos Mercado Livre de ${dataDia} (desconto ${discount}% apenas para CPF)...`);

  try {
    let page = 1;
    let totalPages = 1;
    const allOrders: Array<{ id: string; numero: string; numero_ecommerce: string; valor: string; situacao: string }> = [];

    while (page <= totalPages) {
      const result = await searchOrders({ dataInicial: dataDia, dataFinal: dataDia, pagina: page });
      totalPages = result.totalPages;
      allOrders.push(...result.orders);
      page++;
      await sleep(1100);
    }

    const statusIgnorados = new Set(['Cancelado']);
    const candidates = allOrders.filter(o => !statusIgnorados.has(o.situacao));
    console.log(`[BOT-ML] ${allOrders.length} pedidos no dia, ${candidates.length} não-cancelados para análise`);

    for (const order of candidates) {
      try {
        await sleep(1100);
        const detail = await getOrder(order.id);

        if (!isMercadoLivreOrder(detail)) continue;

        stats.found++;

        // Apenas CPF (Pessoa Física)
        if (!isPessoaFisica(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} NÃO é CPF (tipo=${detail.cliente.tipo_pessoa}, doc=${detail.cliente.cpf_cnpj}) - PULANDO`);
          stats.skippedNF++;
          continue;
        }

        if (hasMaskedClientData(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} dados mascarados - PULANDO`);
          stats.skippedNF++;
          continue;
        }

        if (detail.id_nota_fiscal) {
          console.log(`[BOT-ML] Pedido ${detail.numero} já tem NF (${detail.id_nota_fiscal}), pulando`);
          continue;
        }

        if (!hasClientAddress(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} sem endereço completo - PULANDO`);
          stats.skippedNF++;
          continue;
        }

        if (!detail.numero_ecommerce) {
          console.log(`[BOT-ML] Pedido ${detail.numero} sem numero_ecommerce - PULANDO`);
          stats.skippedNF++;
          continue;
        }

        console.log(`[BOT-ML] Criando NF para ML ${detail.numero_ecommerce} (pedido Tiny ${detail.numero}) - total: R$${detail.total_pedido} - aplicando ${discount}% de desconto`);
        await sleep(1100);

        const nf = await createAndEmitNFDiscounted(detail, discount);
        if (nf.success) {
          stats.altered++;
          stats.nfGenerated++;
          if (nf.chaveAcesso) {
            stats.nfs.push({
              numero: nf.numero || '',
              nfId: nf.nfId || '',
              chaveAcesso: nf.chaveAcesso,
              clienteNome: nf.clienteNome || '',
              numeroEcommerce: nf.numeroEcommerce || '',
              valorNota: nf.valorNota || 0,
              dataProcessamento: new Date().toLocaleString('pt-BR'),
            });
          }
        } else {
          stats.errors++;
        }
      } catch (err) {
        console.error(`[BOT-ML] Falha ao processar pedido ${order.id}:`, err);
        stats.errors++;
      }
    }
  } catch (err) {
    console.error('[BOT-ML] Falha na busca de pedidos:', err);
  }

  console.log(`[BOT-ML] Resultado: ${stats.found} pedidos ML, ${stats.nfGenerated} NFs emitidas com ${discount}% desconto, ${stats.skippedNF} pulados, ${stats.errors} erros`);
  return stats;
}

/**
 * Processa pedidos ML cuja DATA DE COLETA (estimated_handling_limit do shipment) seja igual à dataColeta.
 * Usa a API ML para descobrir quais pedidos têm coleta no dia, depois busca cada um no Tiny e cria NF.
 */
export async function processMercadoLivreByCollectionDate(dataColeta: string): Promise<BotResult> {
  const stats: BotResult = { found: 0, altered: 0, nfGenerated: 0, skippedNF: 0, errors: 0, nfs: [] };
  const discount = config.mlDiscountPercent;
  const isoTarget = ddmmyyyyToIsoDate(dataColeta);

  console.log(`\n[BOT-ML] Buscando pedidos com COLETA em ${dataColeta} (=${isoTarget}) — desconto ${discount}% para CPF`);

  if (!ml.isConnected()) {
    console.error('[BOT-ML] Conta Mercado Livre não conectada — abortando.');
    return stats;
  }

  let mlOrders: ml.MLOrderSummary[];
  try {
    mlOrders = await ml.searchRecentPaidOrders(45);
    console.log(`[BOT-ML] ${mlOrders.length} pedidos pagos retornados pela API ML (últimos 45 dias)`);
  } catch (err) {
    console.error('[BOT-ML] Falha ao buscar pedidos no ML:', err);
    return stats;
  }

  const matchingOrderIds: number[] = [];
  let shipChecked = 0;
  for (const o of mlOrders) {
    if (!o.shipping_id) continue;
    try {
      shipChecked++;
      await sleep(220);
      const ship = await ml.getShipment(o.shipping_id);
      if (ship.estimated_handling_limit_date === isoTarget) {
        matchingOrderIds.push(o.id);
      }
    } catch (err) {
      console.warn(`[BOT-ML] Falha ao obter shipment ${o.shipping_id}:`, (err as any)?.message || err);
    }
  }
  console.log(`[BOT-ML] ${shipChecked} shipments verificados, ${matchingOrderIds.length} com coleta em ${dataColeta}`);

  for (const mlOrderId of matchingOrderIds) {
    try {
      await sleep(1100);
      const tinyMatches = await searchByNumeroEcommerce(String(mlOrderId));
      if (tinyMatches.length === 0) {
        console.log(`[BOT-ML] Pedido ML ${mlOrderId} não encontrado no Tiny — PULANDO`);
        stats.skippedNF++;
        continue;
      }

      for (const summary of tinyMatches) {
        await sleep(1100);
        const detail = await getOrder(summary.id);

        if (!isMercadoLivreOrder(detail)) {
          console.log(`[BOT-ML] Pedido Tiny ${summary.numero} não é ML — PULANDO`);
          continue;
        }

        stats.found++;

        if (!isPessoaFisica(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} NÃO é CPF (tipo=${detail.cliente.tipo_pessoa}) - PULANDO`);
          stats.skippedNF++;
          continue;
        }
        if (hasMaskedClientData(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} dados mascarados - PULANDO`);
          stats.skippedNF++;
          continue;
        }
        if (detail.id_nota_fiscal) {
          console.log(`[BOT-ML] Pedido ${detail.numero} já tem NF (${detail.id_nota_fiscal}), pulando`);
          continue;
        }
        if (!hasClientAddress(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} sem endereço - PULANDO`);
          stats.skippedNF++;
          continue;
        }
        if (!detail.numero_ecommerce) {
          console.log(`[BOT-ML] Pedido ${detail.numero} sem numero_ecommerce - PULANDO`);
          stats.skippedNF++;
          continue;
        }

        console.log(`[BOT-ML] Criando NF p/ ML ${detail.numero_ecommerce} (Tiny ${detail.numero}) total R$${detail.total_pedido} desconto ${discount}%`);
        await sleep(1100);
        const nf = await createAndEmitNFDiscounted(detail, discount);
        if (nf.success) {
          stats.altered++;
          stats.nfGenerated++;
          if (nf.chaveAcesso) {
            stats.nfs.push({
              numero: nf.numero || '',
              nfId: nf.nfId || '',
              chaveAcesso: nf.chaveAcesso,
              clienteNome: nf.clienteNome || '',
              numeroEcommerce: nf.numeroEcommerce || '',
              valorNota: nf.valorNota || 0,
              dataProcessamento: new Date().toLocaleString('pt-BR'),
            });
          }
        } else {
          stats.errors++;
        }
      }
    } catch (err) {
      console.error(`[BOT-ML] Falha ao processar pedido ML ${mlOrderId}:`, err);
      stats.errors++;
    }
  }

  console.log(`[BOT-ML] Resultado coleta=${dataColeta}: ${stats.found} pedidos, ${stats.nfGenerated} NFs com ${discount}%, ${stats.skippedNF} pulados, ${stats.errors} erros`);
  return stats;
}

function ddmmyyyyToIsoDate(d: string): string {
  const [dd, mm, yyyy] = d.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
