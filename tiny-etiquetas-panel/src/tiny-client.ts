import { XMLParser } from 'fast-xml-parser';
import { config } from './config';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

function parseResponse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return parser.parse(text);
  }
}

function ensureArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
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
  return parseResponse(text);
}

export interface OrderSummary {
  id: string;
  numero: string;
  numero_ecommerce: string;
  data_pedido: string;
  nome: string;
  valor: string;
  situacao: string;
}

export interface OrderItem {
  descricao: string;
  codigo: string;
  quantidade: number;
  valor_unitario: number;
}

export interface OrderDetail {
  id: string;
  numero: string;
  numero_ecommerce: string;
  data_pedido: string;
  situacao: string;
  nome_cliente: string;
  ecommerce: string;
  forma_envio: string;
  itens: OrderItem[];
}

export interface ProductGroup {
  produto: string;
  codigo: string;
  pedidos: {
    id: string;
    numero: string;
    numero_ecommerce: string;
    cliente: string;
    quantidade: number;
    situacao: string;
    data: string;
  }[];
  totalUnidades: number;
  totalPedidos: number;
}

/**
 * Busca pedidos do dia por data
 */
export async function searchOrders(dataInicial: string, dataFinal: string): Promise<OrderSummary[]> {
  const allOrders: OrderSummary[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const data = await tinyPost('pedidos.pesquisa.php', {
      dataInicial,
      dataFinal,
      pagina: String(page),
    });

    const retorno = data.retorno;
    if (retorno.status !== 'OK') {
      const erro = String(retorno.erros?.erro || '');
      if (erro.includes('não retornou registros')) return allOrders;
      throw new Error(`Tiny API: ${erro}`);
    }

    totalPages = parseInt(String(retorno.numero_paginas || '1'), 10);

    const pedidos = ensureArray(retorno.pedidos?.pedido ?? retorno.pedidos);
    for (const p of pedidos) {
      const ped = p.pedido || p;
      allOrders.push({
        id: String(ped.id),
        numero: String(ped.numero),
        numero_ecommerce: String(ped.numero_ecommerce || ''),
        data_pedido: String(ped.data_pedido),
        nome: String(ped.nome),
        valor: String(ped.valor),
        situacao: String(ped.situacao),
      });
    }

    page++;
    if (page <= totalPages) await sleep(1100);
  }

  return allOrders;
}

/**
 * Obtém detalhes de um pedido
 */
export async function getOrderDetail(id: string): Promise<OrderDetail> {
  const data = await tinyPost('pedido.obter.php', { id });
  const retorno = data.retorno;

  if (retorno.status !== 'OK') {
    throw new Error(`Tiny API order ${id}: ${retorno.erros?.erro}`);
  }

  const p = retorno.pedido;
  const rawItems = ensureArray(p.itens?.item ?? p.itens);
  const itens: OrderItem[] = rawItems.map((it: any) => {
    const item = it.item || it;
    return {
      descricao: String(item.descricao || ''),
      codigo: String(item.codigo || ''),
      quantidade: parseFloat(String(item.quantidade || '0')),
      valor_unitario: parseFloat(String(item.valor_unitario || '0')),
    };
  });

  return {
    id: String(p.id),
    numero: String(p.numero),
    numero_ecommerce: String(p.numero_ecommerce || ''),
    data_pedido: String(p.data_pedido),
    situacao: String(p.situacao),
    nome_cliente: String(p.nome || p.cliente?.nome || ''),
    ecommerce: String(p.ecommerce?.nomeEcommerce || ''),
    forma_envio: String(p.forma_envio || ''),
    itens,
  };
}

/**
 * Busca todos os pedidos do dia com detalhes, agrupados por produto
 */
export async function getOrdersByProduct(dataInicial: string, dataFinal: string): Promise<{
  products: ProductGroup[];
  totalOrders: number;
  totalItems: number;
  orders: OrderDetail[];
}> {
  console.log(`Buscando pedidos de ${dataInicial} a ${dataFinal}...`);
  const orders = await searchOrders(dataInicial, dataFinal);
  console.log(`Encontrados ${orders.length} pedidos. Buscando detalhes...`);

  const details: OrderDetail[] = [];
  const productMap = new Map<string, ProductGroup>();

  // Fetch details in batches with rate limiting
  for (let i = 0; i < orders.length; i++) {
    try {
      const detail = await getOrderDetail(orders[i].id);
      details.push(detail);

      // Group by product
      for (const item of detail.itens) {
        const key = item.codigo || item.descricao;
        if (!productMap.has(key)) {
          productMap.set(key, {
            produto: item.descricao,
            codigo: item.codigo,
            pedidos: [],
            totalUnidades: 0,
            totalPedidos: 0,
          });
        }
        const group = productMap.get(key)!;
        group.pedidos.push({
          id: detail.id,
          numero: detail.numero,
          numero_ecommerce: detail.numero_ecommerce,
          cliente: detail.nome_cliente,
          quantidade: item.quantidade,
          situacao: detail.situacao,
          data: detail.data_pedido,
        });
        group.totalUnidades += item.quantidade;
        group.totalPedidos += 1;
      }
    } catch (err) {
      console.error(`Erro no pedido ${orders[i].id}:`, err);
    }

    if (i < orders.length - 1) await sleep(1100);
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${orders.length} processados...`);
  }

  const products = Array.from(productMap.values()).sort((a, b) => b.totalPedidos - a.totalPedidos);

  return {
    products,
    totalOrders: details.length,
    totalItems: products.reduce((acc, p) => acc + p.totalUnidades, 0),
    orders: details,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
