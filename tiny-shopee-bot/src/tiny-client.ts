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

async function tinyPost(endpoint: string, params: Record<string, string> = {}, maxRetries = 3): Promise<any> {
  const body = new URLSearchParams({
    token: config.tinyToken,
    formato: 'json',
    ...params,
  });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(`${config.tinyApiUrl}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const text = await response.text();
    const data = JSON.parse(text);

    // Detecta erro transitório do Tiny e faz retry automático
    const retorno = data.retorno;
    if (retorno && retorno.status !== 'OK') {
      const erroStr = String(retorno.erros?.[0]?.erro || retorno.erros?.erro || '');
      if ((erroStr.includes('Tente novamente') || erroStr.includes('executar a consulta')) && attempt < maxRetries - 1) {
        const wait = 2000 * (attempt + 1);
        console.log(`[TINY] Erro transitório em ${endpoint} (tentativa ${attempt + 1}/${maxRetries}): ${erroStr.slice(0, 80)} — retry em ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }

    return data;
  }

  // fallback (nunca deve chegar aqui)
  throw new Error(`[TINY] ${endpoint}: falhou após ${maxRetries} tentativas`);
}


/** Wrapper público para tinyPost (para endpoints de teste) */
export { tinyPost as tinyPostPublic };

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
 * Busca pedido(s) Tiny por numero_ecommerce (ID externo do marketplace).
 * Retry de erros transitórios é feito automaticamente pelo tinyPost.
 */
export async function searchByNumeroEcommerce(numeroEcommerce: string): Promise<TinyOrderSummary[]> {
  const data = await tinyPost('pedidos.pesquisa.php', { numero_ecommerce: numeroEcommerce });
  const retorno = data.retorno;
  if (retorno.status !== 'OK') {
    const erro = retorno.erros?.[0]?.erro || retorno.erros?.erro || '';
    const erroStr = String(erro);
    if (erroStr.includes('não retornou registros')) return [];
    throw new Error(`Tiny API error (numero_ecommerce=${numeroEcommerce}): ${erroStr}`);
  }
  const rawPedidos = ensureArray(retorno.pedidos);
  return rawPedidos.map((p: any) => {
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
}

/**
 * Busca pedidos pelo número do pedido Tiny (campo "numero").
 * Diferente de numero_ecommerce — esse é o ID interno do Tiny.
 */
export async function searchByNumero(numero: string): Promise<TinyOrderSummary[]> {
  const data = await tinyPost('pedidos.pesquisa.php', { numero: numero });
  const retorno = data.retorno;
  if (retorno.status !== 'OK') {
    const erro = retorno.erros?.[0]?.erro || retorno.erros?.erro || '';
    const erroStr = String(erro);
    if (erroStr.includes('não retornou registros')) return [];
    throw new Error(`Tiny API error (numero=${numero}): ${erroStr}`);
  }
  const rawPedidos = ensureArray(retorno.pedidos);
  return rawPedidos.map((p: any) => {
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
  error?: string;
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
 * Gera NF a partir de um pedido existente no Tiny via gerar.nota.fiscal.pedido.php.
 * Mantém o vínculo completo com o marketplace (selo do ecommerce), permitindo
 * que o Tiny envie a NF automaticamente para Shopee/ML.
 * O desconto é aplicado pela lista de preço configurada na integração do Tiny.
 */
export async function generateNFFromOrder(orderId: string, orderNumero?: string): Promise<NFResult> {
  const label = orderNumero || orderId;
  console.log(`[TINY] Gerando NF do pedido ${label} via gerar.nota.fiscal.pedido.php...`);

  try {
    const result = await tinyPost('gerar.nota.fiscal.pedido.php', { id: orderId });
    const retorno = result.retorno;

    if (retorno.status !== 'OK') {
      console.error(`[DEBUG] gerar.nota.fiscal.pedido ERRO for ${label}:`, JSON.stringify(retorno, null, 2));
      const erros = retorno.erros;
      const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || `Status: ${retorno.status}`;
      console.error(`[ERRO] Falha ao gerar NF do pedido ${label}: ${errList}`);
      return { success: false, error: errList };
    }

    const registro = retorno.registros?.registro;
    const reg = Array.isArray(registro) ? registro[0] : registro;

    if (!reg || reg.status !== 'OK') {
      // Log full response for debugging
      console.error(`[DEBUG] gerar.nota.fiscal.pedido response for ${label}:`, JSON.stringify(retorno, null, 2));
      const erros = reg?.erros || retorno.erros;
      let errList: string;
      if (Array.isArray(erros)) {
        errList = erros.map((e: any) => e.erro).join('; ');
      } else if (erros?.erro) {
        errList = erros.erro;
      } else if (reg?.descricao_status) {
        errList = reg.descricao_status;
      } else if (reg?.status) {
        errList = `Status: ${reg.status}`;
      } else if (!reg) {
        errList = 'Tiny não retornou registro na resposta';
      } else {
        errList = `Registro sem status OK (keys: ${Object.keys(reg).join(', ')})`;
      }
      console.error(`[ERRO] Gerar NF pedido ${label}: ${errList}`);
      return { success: false, error: errList };
    }

    const nfId = String(reg.id);
    const nfNumero = String(reg.numero || '');
    const nfSerie = String(reg.serie || '');
    console.log(`[OK] NF ${nfNumero} (série ${nfSerie}) gerada para pedido ${label} (NF ID: ${nfId})`);

    // Emitir na SEFAZ
    await sleep(1500);
    const emitirResult = await tinyPost('nota.fiscal.emitir.php', { id: nfId });
    const emitirRetorno = emitirResult.retorno;

    if (emitirRetorno.status !== 'OK') {
      console.error(`[DEBUG] nota.fiscal.emitir ERRO for NF ${nfId}:`, JSON.stringify(emitirRetorno, null, 2));
      const erros = emitirRetorno.erros;
      const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || `Status: ${emitirRetorno.status}`;
      console.error(`[ERRO] NF ${nfId} gerada mas falhou ao emitir: ${errList}`);
      return { success: false, nfId, error: `NF gerada mas falhou ao emitir na SEFAZ: ${errList}` };
    }

    const situacao = emitirRetorno.nota_fiscal?.situacao;
    console.log(`[OK] NF ${nfId} emitida na SEFAZ — situação: ${situacao}`);

    // Obter chave de acesso
    let chaveAcesso: string | undefined;
    let valorNota: number | undefined;
    try {
      await sleep(1500);
      const obterResult = await tinyPost('nota.fiscal.obter.php', { id: nfId });
      const nfData = obterResult.retorno?.nota_fiscal;
      if (nfData) {
        chaveAcesso = nfData.chave_acesso || undefined;
        valorNota = nfData.valor_nota ? parseFloat(nfData.valor_nota) : undefined;
        console.log(`[OK] NF ${nfId}: chave=${chaveAcesso || 'N/A'} valor=R$${valorNota?.toFixed(2) || 'N/A'}`);
      }
    } catch (err) {
      console.error(`[AVISO] NF ${nfId} emitida mas falha ao obter detalhes:`, err);
    }

    return {
      success: true,
      nfId,
      numero: nfNumero,
      chaveAcesso,
      valorNota,
    };
  } catch (err: any) {
    console.error(`[ERRO] gerar.nota.fiscal.pedido para ${label}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Cria NF via nota.fiscal.incluir com valor unitário reduzido por percentual de desconto.
 * Ex: discountPercent=30 → NF emitida com 70% do valor unitário original de cada item.
 * Se ecommerceName for informado, seta os campos numero_pedido_ecommerce + ecommerce
 * para vincular a NF ao pedido do marketplace (permite auto-envio pelo Tiny).
 *
 * NOTA: Prefira generateNFFromOrder() que mantém o selo do ecommerce no Tiny.
 * Esta função é mantida como fallback.
 */
export async function createAndEmitNFDiscounted(order: TinyOrderDetail, discountPercent: number, ecommerceName?: string): Promise<NFResult> {
  const factor = (100 - discountPercent) / 100;

  const nota: any = {
    nota_fiscal: {
      tipo_nota: 'N',
      natureza_operacao: 'Venda de mercadorias',
      numero_pedido_ecommerce: order.numero_ecommerce,
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

  if (ecommerceName) {
    nota.nota_fiscal.ecommerce = ecommerceName;
  }

  console.log(`[TINY] Criando NF com numero_pedido_ecommerce=${order.numero_ecommerce}${ecommerceName ? `, ecommerce=${ecommerceName}` : ''}`);

  const incluirResult = await tinyPost('nota.fiscal.incluir.php', { nota: JSON.stringify(nota) });
  const incluirRetorno = incluirResult.retorno;
  const registro = incluirRetorno.registros?.registro;
  const reg = Array.isArray(registro) ? registro[0] : registro;

  if (incluirRetorno.status !== 'OK' || reg?.status !== 'OK') {
    const erros = reg?.erros || incluirRetorno.erros;
    const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] Falha ao criar NF para pedido ${order.id}: ${errList}`);
    return { success: false };
  }

  const nfId = String(reg.id);
  const valorTotal = order.itens.reduce(
    (sum, i) => sum + parseFloat(i.valor_unitario) * parseFloat(i.quantidade) * factor,
    0,
  );
  const tag = ecommerceName || 'NF';
  console.log(`[OK] ${tag} ${reg.numero} criada para pedido ${order.id} (NF ID: ${nfId}) - desconto ${discountPercent}% - total: R$${valorTotal.toFixed(2)}`);

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
    valorNota: valorTotal,
    clienteNome: order.cliente.nome,
    numeroEcommerce: order.numero_ecommerce,
  };
}

/**
 * Obtém detalhes de uma NF já existente pelo ID (numero, chave_acesso, serie, situacao)
 */
export interface NFDetailsFull {
  numero?: string;
  serie?: string;
  chaveAcesso?: string;
  situacao?: string;
  dataEmissao?: string;
  valorNota?: number;
  valorProdutos?: number;
  itens: Array<{ codigo: string; descricao: string; quantidade: number; valor_unitario: number; unidade: string }>;
}

export async function getNFDetails(nfId: string): Promise<NFDetailsFull> {
  const result = await tinyPost('nota.fiscal.obter.php', { id: nfId });
  const nfData = result.retorno?.nota_fiscal;
  if (!nfData) return { itens: [] };

  // Extrai itens da NF (kits já desmembrados, SKUs corretos)
  let nfItems: Array<{ codigo: string; descricao: string; quantidade: number; valor_unitario: number; unidade: string }> = [];
  const rawItens = nfData.itens;
  if (rawItens) {
    const itemArr = ensureArray(rawItens);
    nfItems = itemArr.map((i: any) => {
      const it = i.item || i;
      return {
        codigo: String(it.codigo || ''),
        descricao: String(it.descricao || ''),
        quantidade: parseFloat(it.quantidade) || 1,
        valor_unitario: parseFloat(it.valor_unitario) || 0,
        unidade: String(it.unidade || 'UN'),
      };
    });
  }

  return {
    numero: nfData.numero || undefined,
    serie: nfData.serie || undefined,
    chaveAcesso: nfData.chave_acesso || undefined,
    situacao: nfData.situacao || undefined,
    dataEmissao: nfData.data_emissao || undefined,
    valorNota: nfData.valor_nota ? parseFloat(nfData.valor_nota) : undefined,
    valorProdutos: nfData.valor_produtos ? parseFloat(nfData.valor_produtos) : undefined,
    itens: nfItems,
  };
}

/**
 * Decodifica entidades HTML/XML (&lt; &gt; &amp; &quot; &apos;)
 */
function decodeXmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Obtém o XML da NF-e emitida pelo ID da nota fiscal.
 * NOTA: Este endpoint do Tiny retorna XML puro (não JSON), mesmo com formato=json.
 * Por isso fazemos a chamada diretamente sem usar tinyPost (que faz JSON.parse).
 */
export async function getNFXml(nfId: string): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      token: config.tinyToken,
      id: nfId,
    });

    const response = await fetch(`${config.tinyApiUrl}/nota.fiscal.obter.xml.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const text = await response.text();

    // A resposta é XML. Precisamos extrair o conteúdo de <xml_nfe> que contém o XML da NF-e.
    // O XML da NF-e fica dentro de CDATA: <xml_nfe><![CDATA[...XML real...]]></xml_nfe>
    const cdataMatch = text.match(/<xml_nfe><!\[CDATA\[([\s\S]*?)\]\]><\/xml_nfe>/);
    if (cdataMatch && cdataMatch[1]) {
      const xml = cdataMatch[1].trim();
      console.log(`[TINY] XML da NF ${nfId} obtido (${xml.length} bytes)`);
      return xml;
    }

    // Fallback: tenta extrair sem CDATA (conteúdo pode estar entity-encoded)
    const tagMatch = text.match(/<xml_nfe>([\s\S]*?)<\/xml_nfe>/);
    if (tagMatch && tagMatch[1]) {
      let xml = tagMatch[1].trim();
      // Só decodifica entidades se o conteúdo INTEIRO está entity-encoded
      // (ou seja, começa com &lt; em vez de <). NÃO decodificar se o XML já tem tags normais,
      // pois &amp; dentro de XML válido (ex: "LTDA &amp; CIA") é legítimo e decodificar corrompe o XML.
      if (xml.startsWith('&lt;')) {
        xml = decodeXmlEntities(xml);
      }
      console.log(`[TINY] XML da NF ${nfId} obtido (${xml.length} bytes)`);
      return xml;
    }

    // Verifica se houve erro na resposta
    const erroMatch = text.match(/<erros>[\s\S]*?<erro>([\s\S]*?)<\/erro>[\s\S]*?<\/erros>/);
    if (erroMatch) {
      console.warn(`[TINY] Erro ao obter XML da NF ${nfId}: ${erroMatch[1]}`);
      return null;
    }

    console.warn(`[TINY] XML da NF ${nfId} não encontrado na resposta`);
    return null;
  } catch (err) {
    console.error(`[TINY] Erro ao obter XML da NF ${nfId}:`, err);
    return null;
  }
}

/**
 * Altera os preços dos itens de um pedido no Tiny (aplica desconto percentual).
 * Usado antes de gerar NF para que a NF vinculada ao pedido tenha os valores corretos.
 */
export async function alterOrderPrices(
  orderId: string,
  order: TinyOrderDetail,
  discountPercent: number,
): Promise<{ success: boolean; error?: string }> {
  const factor = (100 - discountPercent) / 100;

  const pedido = {
    pedido: {
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

  const data = await tinyPost('pedido.alterar.php', {
    id: orderId,
    pedido: JSON.stringify(pedido),
  });
  const retorno = data.retorno;

  if (retorno.status !== 'OK') {
    const erros = retorno.erros;
    const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] Falha ao alterar pedido ${orderId}: ${errList}`);
    return { success: false, error: errList };
  }

  const totalReduzido = order.itens.reduce(
    (sum, i) => sum + parseFloat(i.valor_unitario) * parseFloat(i.quantidade) * factor,
    0,
  );
  console.log(`[OK] Pedido ${orderId} alterado: desconto ${discountPercent}% aplicado — novo total aprox R$${totalReduzido.toFixed(2)}`);
  return { success: true };
}

/**
 * Busca todas as listas de preço cadastradas no Tiny.
 * Retorna id, descricao e acrescimo_desconto (ex: -10 = 10% desconto).
 */
export async function getPriceLists(): Promise<Array<{ id: number; descricao: string; acrescimo_desconto: number }>> {
  const data = await tinyPost('listas.precos.pesquisa.php', {});
  const retorno = data.retorno;
  if (retorno.status !== 'OK') {
    const erro = retorno.erros?.[0]?.erro || retorno.erros?.erro || 'Erro desconhecido';
    if (String(erro).includes('não retornou registros')) return [];
    throw new Error(`Tiny API error (listas de preço): ${erro}`);
  }
  const registros = ensureArray(retorno.registros);
  return registros.map((r: any) => {
    const reg = r.registro || r;
    return {
      id: Number(reg.id),
      descricao: String(reg.descricao),
      acrescimo_desconto: Number(reg.acrescimo_desconto || 0),
    };
  });
}

// --- Cache de Listas de Preço ---
let priceListCache: Array<{ id: number; descricao: string; acrescimo_desconto: number }> | null = null;
let priceListCacheTime = 0;
const PRICE_LIST_CACHE_TTL = 60 * 60 * 1000; // 1 hora

export function clearPriceListCache(): void {
  priceListCache = null;
  priceListCacheTime = 0;
  console.log('[TINY] Cache de listas de preço limpo');
}

/**
 * Retorna o percentual de desconto para um marketplace a partir das listas de preço do Tiny.
 * Cache de 1 hora. Fallback para config se a API falhar ou a lista não for encontrada.
 */
export async function getMarketplaceDiscount(marketplace: 'Shopee' | 'ML'): Promise<number> {
  const fallback = marketplace === 'Shopee'
    ? config.shopeeDiscountPercent
    : config.mlDiscountPercent;

  try {
    const now = Date.now();
    if (!priceListCache || (now - priceListCacheTime) > PRICE_LIST_CACHE_TTL) {
      console.log('[TINY] Atualizando cache de listas de preço...');
      priceListCache = await getPriceLists();
      priceListCacheTime = now;
      console.log(`[TINY] ${priceListCache.length} listas carregadas: ${priceListCache.map(l => `${l.descricao}(id=${l.id}, ${l.acrescimo_desconto}%)`).join(', ')}`);
    }

    const searchTerm = marketplace === 'Shopee' ? 'SHOPEE' : 'ML';
    const lista = priceListCache.find(l => l.descricao.toUpperCase().includes(searchTerm));

    if (!lista) {
      console.warn(`[TINY] Lista de preço "${searchTerm}" não encontrada — usando config fallback: ${fallback}%`);
      return fallback;
    }

    const discount = -lista.acrescimo_desconto;
    console.log(`[TINY] Desconto ${marketplace}: lista "${lista.descricao}" (id=${lista.id}) = ${discount}%`);
    return discount;
  } catch (err) {
    console.error(`[TINY] Erro ao buscar listas de preço — usando config fallback: ${fallback}%`, err);
    return fallback;
  }
}

/**
 * Aplica a Lista de Preço em um pedido Tiny.
 * Como pedido.alterar não suporta id_lista_preco, busca a % de desconto da lista
 * e aplica nos preços dos itens via alterOrderPrices.
 */
export async function setOrderPriceList(
  orderId: string,
  idListaPreco: number,
): Promise<{ success: boolean; error?: string; rawResponse?: any; discountPercent?: number; listaDescricao?: string }> {
  // 1. Busca listas de preço para encontrar a % de desconto
  const listas = await getPriceLists();
  const lista = listas.find(l => l.id === idListaPreco);
  if (!lista) {
    return { success: false, error: `Lista de preço ID=${idListaPreco} não encontrada. Listas disponíveis: ${listas.map(l => `${l.descricao} (${l.id})`).join(', ')}` };
  }

  // acrescimo_desconto negativo = desconto (ex: -10 = 10% desconto)
  // acrescimo_desconto positivo = acréscimo (ex: 5 = 5% acréscimo)
  const discountPercent = -lista.acrescimo_desconto; // inverte: -10 vira 10% desconto
  console.log(`[TINY] Lista "${lista.descricao}" (id=${lista.id}): acrescimo_desconto=${lista.acrescimo_desconto}% → desconto=${discountPercent}%`);

  if (discountPercent === 0) {
    return { success: true, discountPercent: 0, listaDescricao: lista.descricao, error: 'Lista com desconto 0% — nada a alterar' };
  }

  // 2. Busca pedido atual
  const order = await getOrder(orderId);

  // 3. Aplica desconto nos itens
  const result = await alterOrderPrices(orderId, order, discountPercent);

  return {
    success: result.success,
    error: result.error,
    discountPercent,
    listaDescricao: lista.descricao,
  };
}

/**
 * Gera nota fiscal a partir do pedido (usa valores atuais do pedido).
 * A NF fica vinculada ao pedido, permitindo que o Tiny envie automaticamente para a Shopee.
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
  console.log(`[OK] NF gerada a partir do pedido ${orderId} - NF ID: ${nfId || 'N/A'}`);
  return { success: true, nfId: nfId ? String(nfId) : undefined };
}

/**
 * Emite uma NF (rascunho) na SEFAZ.
 */
export async function emitNF(nfId: string): Promise<{ success: boolean; situacao?: string; error?: string }> {
  const data = await tinyPost('nota.fiscal.emitir.php', { id: nfId });
  const retorno = data.retorno;

  if (retorno.status !== 'OK') {
    const erros = retorno.erros;
    const errList = Array.isArray(erros) ? erros.map((e: any) => e.erro).join('; ') : erros?.erro || 'Erro desconhecido';
    console.error(`[ERRO] Falha ao emitir NF ${nfId}: ${errList}`);
    return { success: false, error: errList };
  }

  const situacao = retorno.nota_fiscal?.situacao;
  console.log(`[OK] NF ${nfId} emitida na SEFAZ - situacao: ${situacao}`);
  return { success: true, situacao };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Busca itens detalhados (com SKU/codigo desmembrado) para uma lista de order_sn do e-commerce.
 * Retorna dados do Tiny com kits já desmembrados.
 */
export interface PickingItem {
  order_sn: string;
  sku: string;
  descricao: string;
  quantidade: number;
  valor_unitario: number;
}
export interface PickingOrderResult {
  order_sn: string;
  clienteNome: string;
  items: PickingItem[];
  error?: string;
}
// Cache em memória para não re-buscar pedidos já consultados (evita rate limit)
const pickingCache = new Map<string, PickingOrderResult>();
const PICKING_CACHE_TTL = 30 * 60 * 1000; // 30 minutos
const pickingCacheTime = new Map<string, number>();

export function clearPickingCache(): void {
  pickingCache.clear();
  pickingCacheTime.clear();
  console.log('[PICKING] Cache limpo');
}

export async function getOrderItemsForPicking(orderSns: string[]): Promise<PickingOrderResult[]> {
  const results: PickingOrderResult[] = [];
  const now = Date.now();

  // Limpa cache expirado
  for (const [key, ts] of pickingCacheTime) {
    if (now - ts > PICKING_CACHE_TTL) { pickingCache.delete(key); pickingCacheTime.delete(key); }
  }

  const toFetch: string[] = [];
  for (const sn of orderSns) {
    const cached = pickingCache.get(sn);
    if (cached) {
      results.push(cached);
    } else {
      toFetch.push(sn);
    }
  }

  if (toFetch.length > 0) {
    console.log(`[PICKING] ${toFetch.length} pedidos para buscar no Tiny (${orderSns.length - toFetch.length} em cache)`);
  }

  for (const sn of toFetch) {
    let success = false;
    // Retry até 3 vezes para erros transitórios do Tiny
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[PICKING] ${sn}: tentativa ${attempt + 1}/3...`);
          await sleep(3000 * attempt); // backoff: 3s, 6s
        }

        // Delay entre chamadas para respeitar rate limit do Tiny (60 req/min)
        await sleep(1200);

        // 1) Busca pedido no Tiny pelo numero_ecommerce
        const found = await searchByNumeroEcommerce(sn);
        // Filtra match exato — Tiny faz busca parcial (LIKE) e retorna pedidos com numero_ecommerce similar
        const exactMatch = found.filter(f => f.numero_ecommerce === sn);
        const match = exactMatch.length > 0 ? exactMatch[0] : null;
        if (!match) {
          if (found.length > 0) {
            console.log(`[PICKING] ${sn}: Tiny retornou ${found.length} pedidos mas nenhum é match exato (primeiro: ${found[0].numero_ecommerce})`);
          }
          const r: PickingOrderResult = { order_sn: sn, clienteNome: '', items: [], error: 'Pedido não encontrado no Tiny' };
          results.push(r);
          pickingCache.set(sn, r);
          pickingCacheTime.set(sn, now);
          success = true;
          continue;
        }

        await sleep(1200);

        // 2) Busca detalhes do pedido (para nome do cliente e id_nota_fiscal)
        const detail = await getOrder(match.id);
        const clienteNome = detail.cliente.nome;

        // 3) Se o pedido tem NF, busca itens da NF (kits desmembrados, SKUs corretos)
        let items: PickingItem[];
        if (detail.id_nota_fiscal) {
          await sleep(1200);
          const nf = await getNFDetails(detail.id_nota_fiscal);
          if (nf.itens && nf.itens.length > 0) {
            items = nf.itens.map(it => ({
              order_sn: sn,
              sku: it.codigo || '-',
              descricao: it.descricao || '-',
              quantidade: it.quantidade,
              valor_unitario: it.valor_unitario,
            }));
            console.log(`[PICKING] ${sn}: ${nf.itens.length} itens da NF ${detail.id_nota_fiscal} (SKUs desmembrados)`);
          } else {
            items = detail.itens.map(it => ({
              order_sn: sn,
              sku: it.codigo || '-',
              descricao: it.descricao || '-',
              quantidade: parseFloat(it.quantidade) || 1,
              valor_unitario: parseFloat(it.valor_unitario) || 0,
            }));
          }
        } else {
          items = detail.itens.map(it => ({
            order_sn: sn,
            sku: it.codigo || '-',
            descricao: it.descricao || '-',
            quantidade: parseFloat(it.quantidade) || 1,
            valor_unitario: parseFloat(it.valor_unitario) || 0,
          }));
          console.log(`[PICKING] ${sn}: sem NF, usando ${detail.itens.length} itens do pedido`);
        }

        const r: PickingOrderResult = { order_sn: sn, clienteNome, items };
        results.push(r);
        // Só cacheia resultados com sucesso (com itens)
        pickingCache.set(sn, r);
        pickingCacheTime.set(sn, now);
        success = true;
      } catch (err: any) {
        const errMsg = String(err.message || err);
        const isTransient = errMsg.includes('Tente novamente') || errMsg.includes('executar a consulta') || errMsg.includes('Bloqueada');
        if (isTransient && attempt < 2) {
          console.warn(`[PICKING] ${sn}: erro transitório (tentativa ${attempt + 1}), retentando...`);
          continue; // retry
        }
        console.warn(`[PICKING] Erro ao buscar pedido ${sn} no Tiny:`, errMsg);
        const r: PickingOrderResult = { order_sn: sn, clienteNome: '', items: [], error: errMsg };
        results.push(r);
        // NUNCA cacheia erros — tenta de novo na próxima geração do relatório
        success = true; // sai do loop de retry
      }
    }
  }

  // Reordena na mesma ordem dos orderSns originais
  const map = new Map(results.map(r => [r.order_sn, r]));
  return orderSns.map(sn => map.get(sn)!).filter(Boolean);
}

/**
 * Busca itens para picking usando nfId direto (sem buscar pedido no Tiny).
 * Muito mais rápido e confiável — evita problemas de match parcial do Tiny.
 */
export async function getPickingItemsByNfIds(orders: Array<{ order_sn: string; nfId: string }>): Promise<PickingOrderResult[]> {
  const results: PickingOrderResult[] = [];
  const now = Date.now();

  // Limpa cache expirado
  for (const [key, ts] of pickingCacheTime) {
    if (now - ts > PICKING_CACHE_TTL) { pickingCache.delete(key); pickingCacheTime.delete(key); }
  }

  const toFetch: Array<{ order_sn: string; nfId: string }> = [];
  for (const o of orders) {
    const cached = pickingCache.get(o.order_sn);
    if (cached) {
      results.push(cached);
    } else {
      toFetch.push(o);
    }
  }

  if (toFetch.length > 0) {
    console.log(`[PICKING] ${toFetch.length} NFs para buscar direto no Tiny (${orders.length - toFetch.length} em cache)`);
  }

  for (const o of toFetch) {
    if (!o.nfId) {
      const r: PickingOrderResult = { order_sn: o.order_sn, clienteNome: '', items: [], error: 'NF ID não disponível' };
      results.push(r);
      continue;
    }

    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[PICKING] ${o.order_sn}: tentativa ${attempt + 1}/3...`);
          await sleep(3000 * attempt);
        }
        await sleep(1200); // rate limit

        const nf = await getNFDetails(o.nfId);
        let items: PickingItem[] = [];
        if (nf.itens && nf.itens.length > 0) {
          items = nf.itens.map(it => ({
            order_sn: o.order_sn,
            sku: it.codigo || '-',
            descricao: it.descricao || '-',
            quantidade: it.quantidade,
            valor_unitario: it.valor_unitario,
          }));
          console.log(`[PICKING] ${o.order_sn}: ${nf.itens.length} itens da NF ${o.nfId} (SKUs desmembrados)`);
        }

        const r: PickingOrderResult = { order_sn: o.order_sn, clienteNome: '', items };
        results.push(r);
        pickingCache.set(o.order_sn, r);
        pickingCacheTime.set(o.order_sn, now);
        success = true;
      } catch (err: any) {
        const errMsg = String(err.message || err);
        const isTransient = errMsg.includes('Tente novamente') || errMsg.includes('executar a consulta') || errMsg.includes('Bloqueada');
        if (isTransient && attempt < 2) {
          console.warn(`[PICKING] ${o.order_sn}: erro transitório (tentativa ${attempt + 1}), retentando...`);
          continue;
        }
        console.warn(`[PICKING] Erro ao buscar NF ${o.nfId} para pedido ${o.order_sn}:`, errMsg);
        const r: PickingOrderResult = { order_sn: o.order_sn, clienteNome: '', items: [], error: errMsg };
        results.push(r);
        success = true;
      }
    }
  }

  // Reordena na mesma ordem dos orders originais
  const map = new Map(results.map(r => [r.order_sn, r]));
  return orders.map(o => map.get(o.order_sn)!).filter(Boolean);
}

