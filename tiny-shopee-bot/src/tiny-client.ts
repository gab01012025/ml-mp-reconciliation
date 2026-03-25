import { config, calcularValorUnitario } from './config';

interface TinyOrderSummary {
  id: string;
  numero: string;
  numero_ecommerce: string;
  data_pedido: string;
  nome: string;
  valor: string;
  situacao: string;
}

interface TinyOrderItem {
  id_produto: string;
  codigo: string;
  descricao: string;
  unidade: string;
  quantidade: string;
  valor_unitario: string;
}

interface TinyOrderDetail {
  id: string;
  numero: string;
  numero_ecommerce: string;
  data_pedido: string;
  situacao: string;
  itens: { item: TinyOrderItem | TinyOrderItem[] };
  ecommerce?: {
    nomeEcommerce?: string;
  };
  total_produtos: string;
  total_pedido: string;
  id_nota_fiscal?: string;
}

async function tinyPost(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  const body = new URLSearchParams({
    token: config.tinyToken,
    formato: 'json',
    ...params,
  });

  const response = await fetch(`${config.tinyApiUrl}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await response.text();
  return JSON.parse(text);
}

/**
 * Faz POST com query params na URL e JSON body (formato usado por pedido.alterar)
 */
async function tinyPostJson(endpoint: string, queryParams: Record<string, string>, jsonBody: any): Promise<any> {
  const urlParams = new URLSearchParams({
    token: config.tinyToken,
    formato: 'json',
    ...queryParams,
  });

  const response = await fetch(`${config.tinyApiUrl}/${endpoint}?${urlParams.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(jsonBody),
  });

  const text = await response.text();
  return JSON.parse(text);
}

function ensureArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Busca pedidos por data e situacao
 */
export async function searchOrders(params: {
  dataInicial?: string;
  dataFinal?: string;
  situacao?: string;
  pagina?: number;
}): Promise<{ orders: TinyOrderSummary[]; totalPages: number }> {
  const queryParams: Record<string, string> = {};
  if (params.dataInicial) queryParams.dataInicial = params.dataInicial;
  if (params.dataFinal) queryParams.dataFinal = params.dataFinal;
  if (params.situacao) queryParams.situacao = params.situacao;
  queryParams.pagina = String(params.pagina || 1);

  const data = await tinyPost('pedidos.pesquisa.php', queryParams);
  const retorno = data.retorno;

  if (retorno.status !== 'OK') {
    const erro = retorno.erros?.[0]?.erro || retorno.erros?.erro || 'Erro desconhecido';
    if (String(erro).includes('não retornou registros')) {
      return { orders: [], totalPages: 0 };
    }
    throw new Error(`Tiny API error: ${erro}`);
  }

  // JSON format: pedidos is array of {pedido: {...}}
  const rawPedidos = ensureArray(retorno.pedidos);
  const orders = rawPedidos.map((p: any) => {
    const ped = p.pedido || p;
    return {
      id: String(ped.id),
      numero: String(ped.numero),
      numero_ecommerce: String(ped.numero_ecommerce || ''),
      data_pedido: String(ped.data_pedido),
      nome: String(ped.nome),
      valor: String(ped.valor),
      situacao: String(ped.situacao),
    };
  });

  return {
    orders,
    totalPages: parseInt(String(retorno.numero_paginas || '1'), 10),
  };
}

/**
 * Obtém detalhes completos de um pedido
 */
export async function getOrder(id: string): Promise<TinyOrderDetail> {
  const data = await tinyPost('pedido.obter.php', { id });
  const retorno = data.retorno;

  if (retorno.status !== 'OK') {
    throw new Error(`Tiny API error getting order ${id}: ${retorno.erros?.[0]?.erro || retorno.erros?.erro}`);
  }

  const p = retorno.pedido;
  return {
    id: String(p.id),
    numero: String(p.numero),
    numero_ecommerce: String(p.numero_ecommerce || ''),
    data_pedido: String(p.data_pedido),
    situacao: String(p.situacao),
    itens: p.itens,
    ecommerce: p.ecommerce,
    total_produtos: String(p.total_produtos),
    total_pedido: String(p.total_pedido),
    id_nota_fiscal: p.id_nota_fiscal && String(p.id_nota_fiscal) !== '0' ? String(p.id_nota_fiscal) : undefined,
  };
}

/**
 * Verifica se o pedido é da Shopee
 */
export function isShopeeOrder(order: TinyOrderDetail): boolean {
  return order.ecommerce?.nomeEcommerce === 'Shopee';
}

/**
 * Verifica se o pedido já foi alterado (valor unitário já é <= R$3.00)
 */
export function isAlreadyAltered(order: TinyOrderDetail): boolean {
  const items = ensureArray(
    Array.isArray(order.itens.item) ? order.itens.item : [order.itens.item]
  );
  return items.every(item => parseFloat(item.valor_unitario) <= config.valorAlto);
}

/**
 * Altera o pedido no Tiny, setando valor unitário baseado no total original
 * > R$60 = R$3.00 | R$15-R$60 = R$1.00 | < R$15 = R$0.50
 */
export async function alterOrder(orderId: string, order: TinyOrderDetail): Promise<boolean> {
  const items = ensureArray(
    Array.isArray(order.itens.item) ? order.itens.item : [order.itens.item]
  );

  const totalOriginal = parseFloat(order.total_pedido);
  const valorUnitario = calcularValorUnitario(totalOriginal);

  const dadosPedido = {
    itens: items.map(item => ({
      item: {
        id_produto: item.id_produto,
        descricao: item.descricao,
        unidade: item.unidade,
        quantidade: item.quantidade,
        valor_unitario: valorUnitario.toFixed(2),
      },
    })),
  };

  const result = await tinyPostJson('pedido.alterar.php', { id: orderId }, { dados_pedido: dadosPedido });
  const retorno = result.retorno || result;

  if (retorno.status !== 'OK') {
    const erros = retorno.erros;
    const msg = Array.isArray(erros) ? erros.map((e: any) => e.erro).join(', ') : erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] Falha ao alterar pedido ${orderId}: ${msg}`);
    return false;
  }

  console.log(`[OK] Pedido ${orderId} alterado - total original: R$${totalOriginal.toFixed(2)} -> valor unitario: R$${valorUnitario.toFixed(2)}`);
  return true;
}

/**
 * Verifica se algum item do pedido tem '*' na descrição
 */
export function hasAsteriskItems(order: TinyOrderDetail): boolean {
  const items = ensureArray(
    Array.isArray(order.itens.item) ? order.itens.item : [order.itens.item]
  );
  return items.some(item => item.descricao?.includes('*'));
}

/**
 * Gera nota fiscal a partir do pedido
 */
export async function generateNF(orderId: string): Promise<{ success: boolean; nfId?: string }> {
  const data = await tinyPost('gerar.nota.fiscal.pedido.php', { id: orderId });
  const retorno = data.retorno;

  if (retorno.status !== 'OK') {
    const erro = retorno.erros?.[0]?.erro || retorno.erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] Falha ao gerar NF para pedido ${orderId}: ${erro}`);
    return { success: false };
  }

  // Pode vir como registro único ou array
  const registros = ensureArray(retorno.registros?.registro ?? retorno.registros);
  const registro = registros[0]?.registro || registros[0];
  const nfId = registro?.idNotaFiscal;
  console.log(`[OK] NF gerada para pedido ${orderId} - NF ID: ${nfId || 'N/A'}`);
  return { success: true, nfId: nfId ? String(nfId) : undefined };
}


