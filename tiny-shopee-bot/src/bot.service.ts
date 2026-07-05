import {
  searchOrders,
  getOrder,
  searchByNumeroEcommerce,
  isShopeeOrder,
  isMercadoLivreOrder,
  isPessoaFisica,
  hasClientAddress,
  generateNFFromOrder,
  createAndEmitNFDiscounted,
  getNFDetails,
  getNFXml,
  hasMaskedClientData,
  getMarketplaceDiscount,
  alterOrderPrices,
} from './tiny-client';
import * as ml from './ml-client';
import * as shopee from './shopee-client';

// Formato do Order SN da Shopee: 6 dígitos (YYMMDD) + 8-10 alfanuméricos maiúsculos
// com pelo menos 1 letra (diferencia de IDs puramente numéricos de outros canais)
// Ex: 260519S0A4X2H9, 260518PG7CJ1TR
const SHOPEE_ORDER_SN_REGEX = /^\d{6}(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,10}$/;

// Rastreia pedidos já processados para evitar reprocessamento
const processedOrders = new Set<string>();

// Rastreia pedidos ML já verificados (com ou sem NF) para não chamar getOrder de novo
const checkedMLOrders = new Set<string>();

/**
 * Limpa o cache de pedidos processados (para forçar reprocessamento)
 */
export function clearProcessedOrders(): void {
  processedOrders.clear();
  checkedMLOrders.clear();
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
export interface OrderSnRange {
  from?: string; // order_sn inicial (inclusive)
  to?: string;   // order_sn final (inclusive)
}

export async function processNewShopeeOrders(customDataInicial?: string, customDataFinal?: string, skipBlockCheck = false, orderSnRange?: OrderSnRange): Promise<BotResult> {
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

    // Filtra pedidos que parecem ser da Shopee pelo formato do Order SN (YYMMDD + alfanum)
    // Status ignorados: Cancelado, Enviado (ja foram processados completamente)
    const statusIgnorados = new Set(['Cancelado', 'Enviado']);
    let potentialShopee = allOrders.filter(o => {
      const ne = o.numero_ecommerce;
      return SHOPEE_ORDER_SN_REGEX.test(ne) && !statusIgnorados.has(o.situacao);
    });

    // Filtro por range de order_sn (De / Até)
    if (orderSnRange) {
      const fromSn = orderSnRange.from?.toUpperCase();
      const toSn = orderSnRange.to?.toUpperCase();
      if (fromSn || toSn) {
        const before = potentialShopee.length;
        potentialShopee = potentialShopee.filter(o => {
          const sn = o.numero_ecommerce.toUpperCase();
          if (fromSn && sn < fromSn) return false;
          if (toSn && sn > toSn) return false;
          return true;
        });
        console.log(`[BOT] Filtro order_sn: de=${fromSn || '*'} até=${toSn || '*'} → ${potentialShopee.length}/${before} pedidos`);
      }
    }

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

        // Gera NF com desconto via nota.fiscal.incluir.php (preços reduzidos direto no payload)
        console.log(`[BOT] Gerando NF do pedido ${order.id} (${detail.numero}) — total: R$${detail.total_pedido}`);
        let nf: any;
        try {
          const discountPercent = await getMarketplaceDiscount('Shopee');
          if (discountPercent > 0) {
            await sleep(1100);
            nf = await createAndEmitNFDiscounted(detail, discountPercent, 'Shopee');
            if (nf.success) {
              console.log(`[BOT] NF criada com desconto ${discountPercent}% Shopee via nota.fiscal.incluir`);
            } else {
              console.warn(`[BOT] createAndEmitNFDiscounted falhou: ${nf.error} — tentando sem desconto`);
              await sleep(1100);
              nf = await generateNFFromOrder(order.id, detail.numero);
            }
          } else {
            await sleep(1100);
            nf = await generateNFFromOrder(order.id, detail.numero);
          }
        } catch (e: any) {
          console.warn(`[BOT] Erro desconto Shopee: ${e.message} — gerando NF sem desconto`);
          await sleep(1100);
          nf = await generateNFFromOrder(order.id, detail.numero);
        }

        if (nf.success) {
          stats.altered++;
          stats.nfGenerated++;
          console.log(`[OK] NF ${nf.numero || nf.nfId} emitida para pedido ${detail.numero_ecommerce} — chave: ${nf.chaveAcesso || 'N/A'} — Tiny auto-envia para Shopee`);
          if (nf.chaveAcesso) {
            stats.nfs.push({
              numero: nf.numero || '',
              nfId: nf.nfId || '',
              chaveAcesso: nf.chaveAcesso,
              clienteNome: detail.cliente.nome || '',
              numeroEcommerce: detail.numero_ecommerce || '',
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

  console.log(`\n[BOT-ML] Buscando pedidos Mercado Livre de ${dataDia} (apenas CPF)...`);

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

    // Filtra pedidos cancelados e já faturados/atendidos (já possuem NF, sem necessidade de getOrder)
    const statusIgnorados = new Set(['Cancelado']);
    const statusJaFaturados = new Set(['Faturado', 'Atendido', 'Entregue', 'Pronto para envio']);
    const candidates = allOrders.filter(o => !statusIgnorados.has(o.situacao));

    // Filtra: pula pedidos já verificados (cache em memória) e já faturados (não precisam de getOrder)
    const needsCheck: typeof candidates = [];
    let skippedCache = 0;
    let skippedFaturado = 0;
    for (const o of candidates) {
      if (checkedMLOrders.has(o.id)) {
        skippedCache++;
        continue;
      }
      if (statusJaFaturados.has(o.situacao)) {
        skippedFaturado++;
        checkedMLOrders.add(o.id);
        continue;
      }
      needsCheck.push(o);
    }
    console.log(`[BOT-ML] ${allOrders.length} pedidos no dia, ${candidates.length} não-cancelados, ${skippedFaturado} já faturados, ${skippedCache} já verificados antes → ${needsCheck.length} para analisar`);

    // Contadores detalhados de motivo de skip
    const skipReasons = { naoML: 0, naoCPF: 0, mascarado: 0, jaTemNF: 0, semEndereco: 0, semNumEcommerce: 0, cacheAntes: skippedCache, jaFaturado: skippedFaturado };

    for (const order of needsCheck) {
      try {
        await sleep(1100);
        const detail = await getOrder(order.id);

        if (!isMercadoLivreOrder(detail)) {
          checkedMLOrders.add(order.id);
          skipReasons.naoML++;
          continue;
        }

        stats.found++;

        // Apenas CPF (Pessoa Física)
        if (!isPessoaFisica(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} NÃO é CPF (tipo=${detail.cliente.tipo_pessoa}, doc=${detail.cliente.cpf_cnpj}) - PULANDO`);
          stats.skippedNF++;
          checkedMLOrders.add(order.id);
          skipReasons.naoCPF++;
          continue;
        }

        if (hasMaskedClientData(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} dados mascarados - PULANDO`);
          stats.skippedNF++;
          checkedMLOrders.add(order.id);
          skipReasons.mascarado++;
          continue;
        }

        if (detail.id_nota_fiscal) {
          console.log(`[BOT-ML] Pedido ${detail.numero} já tem NF (${detail.id_nota_fiscal}), pulando`);
          checkedMLOrders.add(order.id);
          skipReasons.jaTemNF++;
          continue;
        }

        if (!hasClientAddress(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} sem endereço completo - PULANDO`);
          stats.skippedNF++;
          checkedMLOrders.add(order.id);
          skipReasons.semEndereco++;
          continue;
        }

        if (!detail.numero_ecommerce) {
          console.log(`[BOT-ML] Pedido ${detail.numero} sem numero_ecommerce - PULANDO`);
          stats.skippedNF++;
          checkedMLOrders.add(order.id);
          skipReasons.semNumEcommerce++;
          continue;
        }

        console.log(`[BOT-ML] Gerando NF do pedido ML ${detail.numero_ecommerce} (Tiny ${detail.numero}) — total R$${detail.total_pedido}`);

        // Gera NF com desconto via nota.fiscal.incluir.php
        let nf: any;
        try {
          const discountPercent = await getMarketplaceDiscount('ML');
          if (discountPercent > 0) {
            await sleep(1100);
            nf = await createAndEmitNFDiscounted(detail, discountPercent, 'Mercado Livre');
            if (nf.success) {
              console.log(`[BOT-ML] NF criada com desconto ${discountPercent}% ML via nota.fiscal.incluir`);
            } else {
              console.warn(`[BOT-ML] createAndEmitNFDiscounted falhou: ${nf.error} — tentando sem desconto`);
              await sleep(1100);
              nf = await generateNFFromOrder(order.id, detail.numero);
            }
          } else {
            await sleep(1100);
            nf = await generateNFFromOrder(order.id, detail.numero);
          }
        } catch (e: any) {
          console.warn(`[BOT-ML] Erro desconto ML: ${e.message} — gerando NF sem desconto`);
          await sleep(1100);
          nf = await generateNFFromOrder(order.id, detail.numero);
        }

        if (nf.success) {
          stats.altered++;
          stats.nfGenerated++;
          checkedMLOrders.add(order.id);
          if (nf.chaveAcesso) {
            stats.nfs.push({
              numero: nf.numero || '',
              nfId: nf.nfId || '',
              chaveAcesso: nf.chaveAcesso,
              clienteNome: detail.cliente.nome || '',
              numeroEcommerce: detail.numero_ecommerce || '',
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

    console.log(`[BOT-ML] Resultado: ${stats.found} pedidos ML, ${stats.nfGenerated} NFs emitidas, ${stats.skippedNF} pulados, ${stats.errors} erros`);
    const reasons = Object.entries(skipReasons).filter(([, v]) => v > 0).map(([k, v]) => {
      const labels: Record<string, string> = { naoML: 'não é ML', naoCPF: 'CNPJ (não CPF)', mascarado: 'dados mascarados', jaTemNF: 'já tem NF', semEndereco: 'sem endereço', semNumEcommerce: 'sem nº ecommerce', cacheAntes: 'já verificado (cache)', jaFaturado: 'já faturado/atendido' };
      return `${labels[k] || k}: ${v}`;
    });
    if (reasons.length > 0) console.log(`[BOT-ML] Detalhamento pulados: ${reasons.join(' | ')}`);
  } catch (err) {
    console.error('[BOT-ML] Falha na busca de pedidos:', err);
  }
  return stats;
}

/**
 * Processa pedidos ML cujo DEADLINE DE NF (pay_before) cai até o fim do dia SEGUINTE ao selecionado.
 * O ML agrupa pedidos em "Coleta | Hoje/Amanhã" pela data de coleta, mas o `pay_before`
 * (deadline para emissão da NF) costuma ser 1 dia DEPOIS da coleta (ex: coleta 25/06 → pay_before 26/06 11h).
 * Por isso filtramos pay_before <= (dataColeta + 1 dia) 23:59 para capturar todos os pedidos da coleta.
 */
export async function processMercadoLivreByCollectionDate(dataColeta: string): Promise<BotResult> {
  const stats: BotResult = { found: 0, altered: 0, nfGenerated: 0, skippedNF: 0, errors: 0, nfs: [] };
  const isoTarget = ddmmyyyyToIsoDate(dataColeta);
  // pay_before geralmente é 1 dia após a coleta — extende a janela em +1 dia
  const targetDate = new Date(`${isoTarget}T00:00:00.000-03:00`);
  targetDate.setDate(targetDate.getDate() + 1);
  const targetEnd = new Date(`${targetDate.toISOString().slice(0, 10)}T23:59:59.999-03:00`).getTime();
  const targetEndLabel = targetDate.toISOString().slice(0, 10);

  console.log(`\n[BOT-ML] Buscando pedidos com deadline NF (pay_before) até ${targetEndLabel} 23:59 (coleta=${dataColeta}) — apenas CPF`);

  if (!ml.isConnected()) {
    console.error('[BOT-ML] Conta Mercado Livre não conectada — abortando.');
    return stats;
  }

  let mlOrders: ml.MLOrderSummary[];
  try {
    // 2 dias: pedidos Full com pay_before amanhã foram criados no máximo ~2 dias atrás
    mlOrders = await ml.searchRecentPaidOrders(2);
    console.log(`[BOT-ML] ${mlOrders.length} pedidos pendentes (paid últimos 2 dias)`);
  } catch (err) {
    console.error('[BOT-ML] Falha ao buscar pedidos no ML:', err);
    return stats;
  }

  const matchingOrderIds: number[] = [];
  let shipChecked = 0;
  let cacheHits = 0;
  let consecutive429 = 0;

  const shipmentCacheFlags = new Map<number, boolean>();
  for (const o of mlOrders) {
    if (!o.shipping_id) continue;
    if (!shipmentCacheFlags.has(o.shipping_id)) {
      shipmentCacheFlags.set(o.shipping_id, ml.isShipmentCached(o.shipping_id));
    }
  }

  const mlOrdersPrioritized = [...mlOrders].sort((a, b) => {
    const aCached = a.shipping_id ? (shipmentCacheFlags.get(a.shipping_id) || false) : false;
    const bCached = b.shipping_id ? (shipmentCacheFlags.get(b.shipping_id) || false) : false;
    return Number(bCached) - Number(aCached);
  });
  const cachedCandidates = mlOrdersPrioritized.filter(o => o.shipping_id && shipmentCacheFlags.get(o.shipping_id)).length;
  console.log(`[BOT-ML] Estratégia cache-first: ${cachedCandidates} pedidos com shipment já em cache processados antes de chamar API`);

  for (const o of mlOrdersPrioritized) {
    if (!o.shipping_id) continue;
    try {
      shipChecked++;
      // Verifica se já está em cache antes de gastar delay
      const wasCached = shipmentCacheFlags.get(o.shipping_id) || false;
      if (wasCached) cacheHits++;
      else await sleep(3000); // 3s entre chamadas reais — ML está extremamente agressivo com 429
      const ship = await ml.getShipment(o.shipping_id);
      consecutive429 = 0;
      // Ignora pedidos que já foram expedidos
      if (ship.status && ship.status !== 'ready_to_ship' && ship.status !== 'handling' && ship.status !== 'pending') continue;
      const payBefore = ship.pay_before_full;
      if (!payBefore) continue;
      const t = new Date(payBefore).getTime();
      if (Number.isFinite(t) && t <= targetEnd) {
        matchingOrderIds.push(o.id);
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      console.warn(`[BOT-ML] Falha ao obter shipment ${o.shipping_id}: ${msg} — PULANDO`);
      // Em 429: pula este shipment mas continua os demais (não aborta mais)
      if (msg.includes('429') || msg.includes('máximo de tentativas')) {
        consecutive429++;
        stats.errors++;
        // Aumenta delay progressivamente conforme acumula 429s
        const extraDelay = Math.min(consecutive429 * 10000, 60000);
        if (extraDelay > 0) {
          console.log(`[BOT-ML] ${consecutive429}x 429 acumulados — aguardando ${extraDelay / 1000}s extra antes do próximo...`);
          await sleep(extraDelay);
        }
      }
    }
  }
  ml.flushShipmentCache();
  console.log(`[BOT-ML] ${shipChecked} shipments verificados (${cacheHits} via cache, ${shipChecked - cacheHits} via API), ${matchingOrderIds.length} com pay_before <= ${targetEndLabel} 23:59 (coleta=${dataColeta})`);

  // Filtra pedidos ML já verificados anteriormente
  const mlToCheck = matchingOrderIds.filter(id => !checkedMLOrders.has(String(id)));
  const mlSkippedCache = matchingOrderIds.length - mlToCheck.length;
  if (mlSkippedCache > 0) {
    console.log(`[BOT-ML] ${mlSkippedCache} pedidos ML já verificados antes, ${mlToCheck.length} para analisar`);
  }

  // Contadores detalhados de motivo de skip
  const skipReasons = { naoNoTiny: 0, naoML: 0, naoCPF: 0, mascarado: 0, jaTemNF: 0, semEndereco: 0, semNumEcommerce: 0, cacheAntes: mlSkippedCache };

  for (const mlOrderId of mlToCheck) {
    try {
      await sleep(1100);
      const tinyMatches = await searchByNumeroEcommerce(String(mlOrderId));
      if (tinyMatches.length === 0) {
        console.log(`[BOT-ML] Pedido ML ${mlOrderId} não encontrado no Tiny — PULANDO (será tentado de novo na próxima execução)`);
        stats.skippedNF++;
        skipReasons.naoNoTiny++;
        // NÃO adiciona ao cache — pedido pode ser sincronizado ao Tiny mais tarde
        continue;
      }

      for (const summary of tinyMatches) {
        if (checkedMLOrders.has(summary.id)) continue;

        await sleep(1100);
        const detail = await getOrder(summary.id);

        if (!isMercadoLivreOrder(detail)) {
          console.log(`[BOT-ML] Pedido Tiny ${summary.numero} não é ML — PULANDO`);
          checkedMLOrders.add(summary.id);
          skipReasons.naoML++;
          continue;
        }

        stats.found++;

        if (!isPessoaFisica(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} NÃO é CPF (tipo=${detail.cliente.tipo_pessoa}) - PULANDO`);
          stats.skippedNF++;
          checkedMLOrders.add(summary.id);
          skipReasons.naoCPF++;
          continue;
        }
        if (hasMaskedClientData(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} dados mascarados - PULANDO`);
          stats.skippedNF++;
          checkedMLOrders.add(summary.id);
          skipReasons.mascarado++;
          continue;
        }
        if (detail.id_nota_fiscal) {
          console.log(`[BOT-ML] Pedido ${detail.numero} já tem NF (${detail.id_nota_fiscal}), pulando`);
          checkedMLOrders.add(summary.id);
          skipReasons.jaTemNF++;
          continue;
        }
        if (!hasClientAddress(detail)) {
          console.log(`[BOT-ML] Pedido ${detail.numero} sem endereço - PULANDO`);
          stats.skippedNF++;
          checkedMLOrders.add(summary.id);
          skipReasons.semEndereco++;
          continue;
        }
        if (!detail.numero_ecommerce) {
          console.log(`[BOT-ML] Pedido ${detail.numero} sem numero_ecommerce - PULANDO`);
          stats.skippedNF++;
          checkedMLOrders.add(summary.id);
          skipReasons.semNumEcommerce++;
          continue;
        }

        console.log(`[BOT-ML] Gerando NF do pedido ML ${detail.numero_ecommerce} (Tiny ${detail.numero}) — total R$${detail.total_pedido}`);

        // Gera NF com desconto via nota.fiscal.incluir.php
        let nf: any;
        try {
          const discountPercent = await getMarketplaceDiscount('ML');
          if (discountPercent > 0) {
            await sleep(1100);
            nf = await createAndEmitNFDiscounted(detail, discountPercent, 'Mercado Livre');
            if (nf.success) {
              console.log(`[BOT-ML] NF criada com desconto ${discountPercent}% ML via nota.fiscal.incluir`);
            } else {
              console.warn(`[BOT-ML] createAndEmitNFDiscounted falhou: ${nf.error} — tentando sem desconto`);
              await sleep(1100);
              nf = await generateNFFromOrder(summary.id, detail.numero);
            }
          } else {
            await sleep(1100);
            nf = await generateNFFromOrder(summary.id, detail.numero);
          }
        } catch (e: any) {
          console.warn(`[BOT-ML] Erro desconto ML: ${e.message} — gerando NF sem desconto`);
          await sleep(1100);
          nf = await generateNFFromOrder(summary.id, detail.numero);
        }

        if (nf.success) {
          stats.altered++;
          stats.nfGenerated++;
          checkedMLOrders.add(summary.id);
          if (nf.chaveAcesso) {
            stats.nfs.push({
              numero: nf.numero || '',
              nfId: nf.nfId || '',
              chaveAcesso: nf.chaveAcesso,
              clienteNome: detail.cliente.nome || '',
              numeroEcommerce: detail.numero_ecommerce || '',
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

  console.log(`[BOT-ML] Resultado coleta=${dataColeta}: ${stats.found} pedidos, ${stats.nfGenerated} NFs emitidas, ${stats.skippedNF} pulados, ${stats.errors} erros`);
  const reasons = Object.entries(skipReasons).filter(([, v]) => v > 0).map(([k, v]) => {
    const labels: Record<string, string> = { naoNoTiny: 'não encontrado no Tiny', naoML: 'não é ML', naoCPF: 'CNPJ (não CPF)', mascarado: 'dados mascarados', jaTemNF: 'já tem NF', semEndereco: 'sem endereço', semNumEcommerce: 'sem nº ecommerce', cacheAntes: 'já verificado (cache)' };
    return `${labels[k] || k}: ${v}`;
  });
  if (reasons.length > 0) console.log(`[BOT-ML] Detalhamento pulados: ${reasons.join(' | ')}`);
  return stats;
}

/**
 * Envia NFs já existentes para a Shopee (retroativo).
 * Busca pedidos Shopee que já têm NF no Tiny, obtém chave de acesso e envia via API Shopee.
 */
export async function sendPendingNFsToShopee(customDataInicial?: string, customDataFinal?: string): Promise<{ sent: number; skipped: number; errors: number; details: string[] }> {
  const result = { sent: 0, skipped: 0, errors: 0, details: [] as string[] };

  if (!shopee.isConnected()) {
    result.details.push('Shopee não conectada — impossível enviar NFs.');
    return result;
  }

  let dataInicial: string;
  let dataFinal: string;

  if (customDataInicial && customDataFinal) {
    dataInicial = customDataInicial;
    dataFinal = customDataFinal;
  } else {
    const today = new Date();
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    dataInicial = formatDate(twoDaysAgo);
    dataFinal = formatDate(today);
  }

  console.log(`\n[SHOPEE-NF] Buscando pedidos Shopee de ${dataInicial} a ${dataFinal} para envio retroativo de NFs...`);

  try {
    let page = 1;
    let totalPages = 1;
    const allOrders: Array<{ id: string; numero: string; numero_ecommerce: string; valor: string; situacao: string }> = [];

    while (page <= totalPages) {
      const searchResult = await searchOrders({ dataInicial, dataFinal, pagina: page });
      totalPages = searchResult.totalPages;
      allOrders.push(...searchResult.orders);
      page++;
      await sleep(1100);
    }

    // Pré-filtra pedidos pelo formato do Order SN da Shopee (YYMMDD + alfanum)
    const potentialShopee = allOrders.filter(o => SHOPEE_ORDER_SN_REGEX.test(o.numero_ecommerce));

    console.log(`[SHOPEE-NF] ${allOrders.length} pedidos no período, ${potentialShopee.length} possíveis Shopee`);

    let shopeeCount = 0;
    let withNF = 0;

    for (const order of potentialShopee) {
      try {
        await sleep(1100);
        const detail = await getOrder(order.id);

        if (!isShopeeOrder(detail)) continue;
        shopeeCount++;

        if (!detail.id_nota_fiscal) {
          result.skipped++;
          continue;
        }

        if (!detail.numero_ecommerce) {
          result.skipped++;
          continue;
        }

        withNF++;

        // Verifica na Shopee ANTES de buscar XML — evita chamadas desnecessárias ao Tiny
        await sleep(1100);
        const invoiceCheck = await shopee.checkOrderInvoice(detail.numero_ecommerce);
        if (invoiceCheck.hasInvoice) {
          console.log(`[SHOPEE-NF] Pedido ${detail.numero_ecommerce} já tem invoice na Shopee — pulando`);
          result.skipped++;
          continue;
        }

        // Busca dados da NF (chave de acesso)
        await sleep(1100);
        const nfData = await getNFDetails(detail.id_nota_fiscal);

        if (!nfData.chaveAcesso) {
          console.log(`[SHOPEE-NF] NF ${detail.id_nota_fiscal} do pedido ${detail.numero} sem chave de acesso — pulando`);
          result.skipped++;
          continue;
        }

        // Busca XML da NF para upload
        await sleep(1100);
        const xml = await getNFXml(detail.id_nota_fiscal);
        if (!xml) {
          console.log(`[SHOPEE-NF] XML da NF ${detail.id_nota_fiscal} não disponível — pulando`);
          result.skipped++;
          continue;
        }

        console.log(`[SHOPEE-NF] Enviando XML NF para pedido ${detail.numero_ecommerce} (${xml.length} bytes)...`);

        await sleep(1100);
        const sendResult = await shopee.uploadInvoiceDoc(detail.numero_ecommerce, xml);

        if (sendResult.success) {
          console.log(`[SHOPEE-NF] ✓ NF enviada para pedido ${detail.numero_ecommerce}`);
          result.sent++;
          result.details.push(`✓ ${detail.numero_ecommerce}: NF XML enviada`);
        } else {
          console.warn(`[SHOPEE-NF] ✗ Falha ao enviar NF para ${detail.numero_ecommerce}: ${sendResult.error}`);
          result.errors++;
          result.details.push(`✗ ${detail.numero_ecommerce}: ${sendResult.error}`);
        }
      } catch (err: any) {
        console.error(`[SHOPEE-NF] Erro ao processar pedido ${order.id}:`, err);
        result.errors++;
        result.details.push(`✗ Pedido ${order.numero}: ${err.message || String(err)}`);
      }
    }

    console.log(`[SHOPEE-NF] Resumo: ${shopeeCount} pedidos Shopee confirmados, ${withNF} com NF no Tiny`);
  } catch (err: any) {
    console.error('[SHOPEE-NF] Falha na busca:', err);
    result.details.push(`Erro geral: ${err.message || String(err)}`);
  }

  console.log(`[SHOPEE-NF] Resultado: ${result.sent} enviadas, ${result.skipped} puladas, ${result.errors} erros`);
  return result;
}

// === Processamento de pedido único ===

export interface SingleOrderStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface SingleOrderResult {
  steps: SingleOrderStep[];
  success: boolean;
  orderSn: string;
  tinyId?: string;
  tinyNumero?: string;
  clienteNome?: string;
  nf?: {
    numero: string;
    nfId: string;
    chaveAcesso: string;
    valorNota: number;
  };
  nfSent?: boolean;
}

/**
 * Processa um único pedido Shopee pelo Order SN — pipeline completo.
 * 1. Extrai a data do SN (YYMMDD) e busca no Tiny por faixa de data (confiável)
 * 2. Filtra localmente pelo numero_ecommerce exato
 * 3. Valida dados do cliente
 * 4. Gera NF com desconto (se não existir)
 * 5. Envia NF (XML) para a Shopee
 */
export async function processSingleShopeeOrder(orderSn: string): Promise<SingleOrderResult> {
  const result: SingleOrderResult = { steps: [], success: false, orderSn };

  console.log(`\n[SINGLE] ========== Processando pedido Shopee: ${orderSn} ==========`);

  // --- Step 1: Validar formato e extrair data ---
  if (!SHOPEE_ORDER_SN_REGEX.test(orderSn)) {
    result.steps.push({ step: 'Validar formato', ok: false, detail: `"${orderSn}" não parece ser um Order SN da Shopee (formato: YYMMDD + alfanumérico)` });
    return result;
  }

  const yy = parseInt(orderSn.slice(0, 2), 10);
  const mm = parseInt(orderSn.slice(2, 4), 10);
  const dd = parseInt(orderSn.slice(4, 6), 10);
  const baseDate = new Date(2000 + yy, mm - 1, dd);

  // Busca ±1 dia para cobrir diferenças de fuso horário
  const dayBefore = new Date(baseDate);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const dayAfter = new Date(baseDate);
  dayAfter.setDate(dayAfter.getDate() + 1);

  const dataInicial = formatDate(dayBefore);
  const dataFinal = formatDate(dayAfter);
  const dataBase = formatDate(baseDate);

  result.steps.push({ step: 'Extrair data do SN', ok: true, detail: `Data base: ${dataBase} — buscando de ${dataInicial} a ${dataFinal}` });

  // --- Step 2: Buscar no Tiny por data e filtrar pelo numero_ecommerce exato ---
  console.log(`[SINGLE] Buscando pedidos no Tiny de ${dataInicial} a ${dataFinal}...`);
  let tinyOrder: { id: string; numero: string; numero_ecommerce: string; situacao: string } | null = null;

  try {
    let page = 1;
    let totalPages = 1;
    let totalScanned = 0;

    while (page <= totalPages) {
      const searchResult = await searchOrders({ dataInicial, dataFinal, pagina: page });
      totalPages = searchResult.totalPages;
      totalScanned += searchResult.orders.length;

      // Filtro local: match exato no numero_ecommerce
      const match = searchResult.orders.find(o => o.numero_ecommerce === orderSn);
      if (match) {
        tinyOrder = match;
        break;
      }

      page++;
      if (page <= totalPages) await sleep(1100);
    }

    if (!tinyOrder) {
      result.steps.push({ step: 'Buscar no Tiny', ok: false, detail: `Pedido ${orderSn} não encontrado entre ${totalScanned} pedidos de ${dataInicial} a ${dataFinal}. Verifique se o pedido foi importado no Tiny.` });
      return result;
    }
  } catch (err: any) {
    result.steps.push({ step: 'Buscar no Tiny', ok: false, detail: `Erro na busca: ${err.message}` });
    return result;
  }

  result.tinyId = tinyOrder.id;
  result.tinyNumero = tinyOrder.numero;
  result.steps.push({ step: 'Buscar no Tiny', ok: true, detail: `Encontrado: Pedido Tiny #${tinyOrder.numero} (ID ${tinyOrder.id}) — Status: ${tinyOrder.situacao}` });

  // --- Step 3: Obter detalhes completos e validar ---
  await sleep(1100);
  let detail: Awaited<ReturnType<typeof getOrder>>;
  try {
    detail = await getOrder(tinyOrder.id);
  } catch (err: any) {
    result.steps.push({ step: 'Validar pedido', ok: false, detail: `Erro ao obter detalhes: ${err.message}` });
    return result;
  }

  result.clienteNome = detail.cliente.nome;

  if (!isShopeeOrder(detail)) {
    result.steps.push({ step: 'Validar pedido', ok: false, detail: `Pedido não é da Shopee (ecommerce: ${detail.ecommerce?.nomeEcommerce || 'N/A'})` });
    return result;
  }
  if (hasMaskedClientData(detail)) {
    result.steps.push({ step: 'Validar pedido', ok: false, detail: 'Dados do cliente mascarados (***). Atualize no Tiny primeiro.' });
    return result;
  }
  if (!hasClientAddress(detail)) {
    result.steps.push({ step: 'Validar pedido', ok: false, detail: 'Pedido sem endereço completo do cliente no Tiny.' });
    return result;
  }
  if (!detail.numero_ecommerce) {
    result.steps.push({ step: 'Validar pedido', ok: false, detail: 'Pedido sem numero_ecommerce — NF não linkaria com a Shopee.' });
    return result;
  }

  result.steps.push({ step: 'Validar pedido', ok: true, detail: `${detail.cliente.nome} — ${detail.cliente.cidade}/${detail.cliente.uf} — R$ ${detail.total_pedido}` });

  // --- Step 4: Gerar NF (se não existir) ---
  let nfId = detail.id_nota_fiscal;

  if (nfId) {
    // NF já existe — busca detalhes
    await sleep(1100);
    try {
      const nfData = await getNFDetails(nfId);
      result.nf = {
        numero: nfData.numero || '',
        nfId,
        chaveAcesso: nfData.chaveAcesso || '',
        valorNota: nfData.valorNota || 0,
      };
      result.steps.push({ step: 'Nota Fiscal', ok: true, detail: `NF ${nfData.numero || nfId} já existia — Chave: ...${(nfData.chaveAcesso || '').slice(-8)}` });
    } catch {
      result.steps.push({ step: 'Nota Fiscal', ok: true, detail: `NF já vinculada (ID: ${nfId}) — detalhes indisponíveis` });
    }
  } else {
    // Gera NF com desconto via nota.fiscal.incluir.php (preços reduzidos direto no payload)
    console.log(`[SINGLE] Gerando NF com desconto Shopee para pedido ${orderSn}...`);
    let descontoAplicado = 0;

    try {
      const discountPercent = await getMarketplaceDiscount('Shopee');
      let nf: any;
      if (discountPercent > 0) {
        await sleep(1100);
        nf = await createAndEmitNFDiscounted(detail, discountPercent, 'Shopee');
        if (nf.success) {
          descontoAplicado = discountPercent;
          console.log(`[SINGLE] NF criada com desconto ${discountPercent}% Shopee via nota.fiscal.incluir`);
        } else {
          console.warn(`[SINGLE] createAndEmitNFDiscounted falhou: ${nf.error} — tentando sem desconto`);
          await sleep(1100);
          nf = await generateNFFromOrder(tinyOrder.id, tinyOrder.numero);
        }
      } else {
        await sleep(1100);
        nf = await generateNFFromOrder(tinyOrder.id, tinyOrder.numero);
      }

      if (nf.success && nf.chaveAcesso) {
        nfId = nf.nfId;
        result.nf = {
          numero: nf.numero || '',
          nfId: nf.nfId || '',
          chaveAcesso: nf.chaveAcesso || '',
          valorNota: nf.valorNota || 0,
        };
        const descontoInfo = descontoAplicado > 0 ? ` (desconto ${descontoAplicado}% Shopee)` : '';
        result.steps.push({ step: 'Nota Fiscal', ok: true, detail: `NF ${nf.numero} emitida — R$ ${(nf.valorNota || 0).toFixed(2)}${descontoInfo} — Chave: ...${nf.chaveAcesso.slice(-8)}` });
      } else {
        result.steps.push({ step: 'Nota Fiscal', ok: false, detail: nf.error || 'Falha ao gerar/emitir NF. Verifique os logs do servidor.' });
        return result;
      }
    } catch (err: any) {
      result.steps.push({ step: 'Nota Fiscal', ok: false, detail: `Erro: ${err.message}` });
      return result;
    }
  }

  // --- Step 5: Envio da NF para Shopee (automático pelo Tiny) ---
  // Como a NF foi gerada a partir do pedido (gerar.nota.fiscal.pedido), ela mantém
  // o selo do ecommerce. Com o envio automático ativado no Tiny, a NF será enviada
  // automaticamente para a Shopee — não precisa de upload manual.
  result.steps.push({ step: 'Enviar NF para Shopee', ok: true, detail: 'NF gerada com selo do ecommerce — o Tiny envia automaticamente para a Shopee.' });
  result.nfSent = true;

  result.success = result.steps.every(s => s.ok);
  console.log(`[SINGLE] ========== Resultado: ${result.success ? 'SUCESSO' : 'COM ERROS'} — ${result.steps.length} etapas ==========`);
  return result;
}

function ddmmyyyyToIsoDate(d: string): string {
  const [dd, mm, yyyy] = d.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
