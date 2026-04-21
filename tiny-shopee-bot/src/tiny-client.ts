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

interface TinyClientData {
  nome: string;
  tipo_pessoa: string;
  cpf_cnpj: string;
  ie: string;
  endereco: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
}

interface TinyOrderDetail {
  id: string;
  numero: string;
  numero_ecommerce: string;
  data_pedido: string;
  situacao: string;
  itens: TinyOrderItem[];
  cliente: TinyClientData;
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

  // Normaliza itens: API pode retornar array [{item:{...}}] ou objeto {item:{...}} ou {item:[{...}]}
  const rawItens = p.itens;
  let items: TinyOrderItem[];
  if (Array.isArray(rawItens)) {
    // [{item: {...}}, {item: {...}}]
    items = rawItens.map((i: any) => i.item || i);
  } else if (rawItens?.item) {
    // {item: {...}} ou {item: [{...}, {...}]}
    items = ensureArray(rawItens.item);
  } else {
    items = [];
  }

  const cli = p.cliente || {};

  return {
    id: String(p.id),
    numero: String(p.numero),
    numero_ecommerce: String(p.numero_ecommerce || ''),
    data_pedido: String(p.data_pedido),
    situacao: String(p.situacao),
    itens: items,
    cliente: {
      nome: String(cli.nome || ''),
      tipo_pessoa: String(cli.tipo_pessoa || 'F'),
      cpf_cnpj: String(cli.cpf_cnpj || ''),
      ie: String(cli.ie || ''),
      endereco: String(cli.endereco || ''),
      numero: String(cli.numero || ''),
      complemento: String(cli.complemento || ''),
      bairro: String(cli.bairro || ''),
      cidade: String(cli.cidade || ''),
      uf: String(cli.uf || ''),
      cep: String(cli.cep || ''),
    },
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
 * Verifica se o pedido é do Mercado Livre
 */
export function isMercadoLivreOrder(order: TinyOrderDetail): boolean {
  const nome = (order.ecommerce?.nomeEcommerce || '').toLowerCase();
  return nome.includes('mercado livre') || nome.includes('mercadolivre') || nome === 'ml';
}

/**
 * Verifica se cliente é Pessoa Física (CPF)
 */
export function isPessoaFisica(order: TinyOrderDetail): boolean {
  const tipo = (order.cliente.tipo_pessoa || '').toUpperCase();
  const doc = (order.cliente.cpf_cnpj || '').replace(/\D/g, '');
  // tipo 'F' OU CPF tem 11 dígitos (CNPJ tem 14)
  return tipo === 'F' || doc.length === 11;
}

/**
 * Verifica se o pedido já foi alterado (valor unitário já é <= R$15.00, o maior valor de faixa)
 */
export function isAlreadyAltered(order: TinyOrderDetail): boolean {
  return order.itens.every(item => parseFloat(item.valor_unitario) <= config.valorMuitoAlto);
}

/**
 * Verifica se o cliente do pedido tem endereço suficiente e não-mascarado para emissão de NF
 */
export function hasClientAddress(order: TinyOrderDetail): boolean {
  const c = order.cliente;
  const hasFields = !!(c.endereco && c.bairro && c.cidade && c.uf && c.cep);
  const isMasked = [c.nome, c.endereco].some(v => v?.includes('***'));
  return hasFields && !isMasked;
}

/**
 * Verifica se os dados do cliente estão mascarados pela Shopee (ex: T******s, Av******)
 */
export function hasMaskedClientData(order: TinyOrderDetail): boolean {
  const c = order.cliente;
  return [c.nome, c.endereco, c.cpf_cnpj].some(v => v?.includes('***'));
}

export interface NFResult {
  success: boolean;
  nfId?: string;
  numero?: string;
  chaveAcesso?: string;
  valorNota?: number;
  clienteNome?: string;
  numeroEcommerce?: string;
}

/**
 * Cria NF via nota.fiscal.incluir com valores customizados e emite na SEFAZ
 */
export async function createAndEmitNF(order: TinyOrderDetail): Promise<NFResult> {
  const totalOriginal = parseFloat(order.total_pedido);
  const valorUnitario = calcularValorUnitario(totalOriginal);

  const nota = {
    nota_fiscal: {
      tipo_nota: 'N',
      natureza_operacao: 'Venda de mercadorias',
      numero_ecommerce: order.numero_ecommerce,
      frete_por_conta: 'R',
      cliente: {
        nome: order.cliente.nome,
        tipo_pessoa: order.cliente.tipo_pessoa,
        cpf_cnpj: order.cliente.cpf_cnpj,
        ie: order.cliente.ie,
        endereco: order.cliente.endereco,
        numero: order.cliente.numero,
        complemento: order.cliente.complemento,
        bairro: order.cliente.bairro,
        cep: order.cliente.cep,
        cidade: order.cliente.cidade,
        uf: order.cliente.uf,
      },
      itens: order.itens.map(item => ({
        item: {
          id_produto: item.id_produto,
          descricao: item.descricao,
          unidade: item.unidade,
          quantidade: item.quantidade,
          valor_unitario: valorUnitario.toFixed(3),
        },
      })),
    },
  };

  // Passo 1: Incluir NF (cria rascunho com valores corretos)
  const incluirResult = await tinyPost('nota.fiscal.incluir.php', {
    nota: JSON.stringify(nota),
  });
  const incluirRetorno = incluirResult.retorno;

  // nota.fiscal.incluir retorna registros como objeto ou array
  const registro = incluirRetorno.registros?.registro;
  const reg = Array.isArray(registro) ? registro[0] : registro;

  if (incluirRetorno.status !== 'OK' || reg?.status !== 'OK') {
    const erros = reg?.erros || incluirRetorno.erros;
    const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] Falha ao criar NF para pedido ${order.id}: ${errList}`);
    return { success: false };
  }

  const nfId = String(reg.id);
  console.log(`[OK] NF ${reg.numero} criada para pedido ${order.id} (NF ID: ${nfId}) - valor: R$${valorUnitario.toFixed(2)}`);

  // Passo 2: Emitir NF na SEFAZ
  await sleep(1500);
  const emitirResult = await tinyPost('nota.fiscal.emitir.php', { id: nfId });
  const emitirRetorno = emitirResult.retorno;

  if (emitirRetorno.status !== 'OK') {
    const erros = emitirRetorno.erros;
    const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] NF ${nfId} criada mas falhou ao emitir: ${errList}`);
    return { success: false, nfId };
  }

  const situacao = emitirRetorno.nota_fiscal?.situacao;
  console.log(`[OK] NF ${nfId} emitida na SEFAZ - situacao: ${situacao}`);

  // Passo 3: Obter chave de acesso da NF emitida
  let chaveAcesso: string | undefined;
  let numeroNF: string | undefined;
  try {
    await sleep(1500);
    const obterResult = await tinyPost('nota.fiscal.obter.php', { id: nfId });
    const nfData = obterResult.retorno?.nota_fiscal;
    if (nfData) {
      chaveAcesso = nfData.chave_acesso || undefined;
      numeroNF = nfData.numero || reg.numero;
      console.log(`[OK] Chave de acesso NF ${nfId}: ${chaveAcesso || 'N/A'}`);
    }
  } catch (err) {
    console.error(`[AVISO] NF ${nfId} emitida mas falha ao obter chave_acesso:`, err);
  }

  return {
    success: true,
    nfId,
    numero: numeroNF || String(reg.numero),
    chaveAcesso,
    valorNota: valorUnitario * order.itens.reduce((sum, i) => sum + parseFloat(i.quantidade), 0),
    clienteNome: order.cliente.nome,
    numeroEcommerce: order.numero_ecommerce,
  };
}

/**
 * Cria NF via nota.fiscal.incluir com valor unitário reduzido por percentual de desconto (Mercado Livre).
 * Ex: discountPercent=30 → NF emitida com 70% do valor unitário original de cada item.
 */
export async function createAndEmitNFDiscounted(order: TinyOrderDetail, discountPercent: number): Promise<NFResult> {
  const factor = (100 - discountPercent) / 100;

  const nota = {
    nota_fiscal: {
      tipo_nota: 'N',
      natureza_operacao: 'Venda de mercadorias',
      numero_ecommerce: order.numero_ecommerce,
      frete_por_conta: 'R',
      cliente: {
        nome: order.cliente.nome,
        tipo_pessoa: order.cliente.tipo_pessoa,
        cpf_cnpj: order.cliente.cpf_cnpj,
        ie: order.cliente.ie,
        endereco: order.cliente.endereco,
        numero: order.cliente.numero,
        complemento: order.cliente.complemento,
        bairro: order.cliente.bairro,
        cep: order.cliente.cep,
        cidade: order.cliente.cidade,
        uf: order.cliente.uf,
      },
      itens: order.itens.map(item => {
        const vuOriginal = parseFloat(item.valor_unitario);
        const vuReduzido = Math.max(0.01, +(vuOriginal * factor).toFixed(3));
        return {
          item: {
            id_produto: item.id_produto,
            descricao: item.descricao,
            unidade: item.unidade,
            quantidade: item.quantidade,
            valor_unitario: vuReduzido.toFixed(3),
          },
        };
      }),
    },
  };

  const incluirResult = await tinyPost('nota.fiscal.incluir.php', { nota: JSON.stringify(nota) });
  const incluirRetorno = incluirResult.retorno;
  const registro = incluirRetorno.registros?.registro;
  const reg = Array.isArray(registro) ? registro[0] : registro;

  if (incluirRetorno.status !== 'OK' || reg?.status !== 'OK') {
    const erros = reg?.erros || incluirRetorno.erros;
    const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] Falha ao criar NF (ML) para pedido ${order.id}: ${errList}`);
    return { success: false };
  }

  const nfId = String(reg.id);
  const valorTotal = order.itens.reduce(
    (sum, i) => sum + parseFloat(i.valor_unitario) * parseFloat(i.quantidade) * factor,
    0,
  );
  console.log(`[OK] NF ML ${reg.numero} criada para pedido ${order.id} (NF ID: ${nfId}) - desconto ${discountPercent}% - total: R$${valorTotal.toFixed(2)}`);

  await sleep(1500);
  const emitirResult = await tinyPost('nota.fiscal.emitir.php', { id: nfId });
  const emitirRetorno = emitirResult.retorno;

  if (emitirRetorno.status !== 'OK') {
    const erros = emitirRetorno.erros;
    const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] NF ML ${nfId} criada mas falhou ao emitir: ${errList}`);
    return { success: false, nfId };
  }

  const situacao = emitirRetorno.nota_fiscal?.situacao;
  console.log(`[OK] NF ML ${nfId} emitida na SEFAZ - situacao: ${situacao}`);

  let chaveAcesso: string | undefined;
  let numeroNF: string | undefined;
  try {
    await sleep(1500);
    const obterResult = await tinyPost('nota.fiscal.obter.php', { id: nfId });
    const nfData = obterResult.retorno?.nota_fiscal;
    if (nfData) {
      chaveAcesso = nfData.chave_acesso || undefined;
      numeroNF = nfData.numero || reg.numero;
      console.log(`[OK] Chave de acesso NF ML ${nfId}: ${chaveAcesso || 'N/A'}`);
    }
  } catch (err) {
    console.error(`[AVISO] NF ML ${nfId} emitida mas falha ao obter chave_acesso:`, err);
  }

  return {
    success: true,
    nfId,
    numero: numeroNF || String(reg.numero),
    chaveAcesso,
    valorNota: valorTotal,
    clienteNome: order.cliente.nome,
    numeroEcommerce: order.numero_ecommerce,
  };
}

/**
 * Gera nota fiscal a partir do pedido (usa valores originais do pedido)
 * Fallback para quando não há endereço completo do cliente
 */
export async function generateNF(orderId: string): Promise<{ success: boolean; nfId?: string }> {
  const data = await tinyPost('gerar.nota.fiscal.pedido.php', { id: orderId });
  const retorno = data.retorno;

  if (retorno.status !== 'OK') {
    const erro = retorno.erros?.[0]?.erro || retorno.erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] Falha ao gerar NF para pedido ${orderId}: ${erro}`);
    return { success: false };
  }

  const registros = ensureArray(retorno.registros?.registro ?? retorno.registros);
  const registro = registros[0]?.registro || registros[0];
  const nfId = registro?.idNotaFiscal;
  console.log(`[OK] NF gerada (fallback) para pedido ${orderId} - NF ID: ${nfId || 'N/A'}`);
  return { success: true, nfId: nfId ? String(nfId) : undefined };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


