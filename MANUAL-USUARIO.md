# 📊 Sistema de Conciliação Financeira ML-MP

## Manual do Usuário - João Paulo Rocha

---

## 🎯 O que é este sistema?

Este sistema automatiza a conciliação financeira entre suas vendas no **Mercado Livre** e os recebimentos no **Mercado Pago**, identificando automaticamente:

- ✅ Transações conciliadas corretamente
- ⚠️ Divergências de valores
- ❌ Vendas sem pagamento correspondente

---

## 🔗 URLs de Acesso

| Serviço | URL |
|---------|-----|
| **API de Conciliação** | https://n8n-conciliacao-api.zgbjol.easypanel.host |
| **n8n (Automação)** | https://n8n-n8n.zgbjol.easypanel.host |
| **EasyPanel** | http://31.97.87.68:3000 |

---

## 🔐 Credenciais

### API Key
```
x-api-key: conciliacao-api-key-2026
```

### Mercado Livre (já autorizado)
- **User ID**: 697553753
- **Status**: ✅ Conectado

### Mercado Pago
- **Access Token**: Configurado nas variáveis de ambiente
- **Status**: ✅ Configurado (conta de teste)

---

## 📖 Como Usar

### 1. Sincronização Manual

#### Sincronizar Pedidos do Mercado Livre:
```bash
curl -X POST "https://n8n-conciliacao-api.zgbjol.easypanel.host/sync/ml/orders" \
  -H "x-api-key: conciliacao-api-key-2026" \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'
```

#### Sincronizar Movimentos do Mercado Pago:
```bash
curl -X POST "https://n8n-conciliacao-api.zgbjol.easypanel.host/sync/mp/movements" \
  -H "x-api-key: conciliacao-api-key-2026" \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'
```

### 2. Executar Conciliação

```bash
curl -X POST "https://n8n-conciliacao-api.zgbjol.easypanel.host/reconciliation" \
  -H "x-api-key: conciliacao-api-key-2026" \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'
```

**Resposta esperada:**
```json
{
  "success": true,
  "matched": 150,
  "unmatched": 5,
  "divergent": 2,
  "totalDiscrepancy": 45.50
}
```

### 3. Gerar Relatório Excel

```bash
curl -X GET "https://n8n-conciliacao-api.zgbjol.easypanel.host/reports/excel?days=30" \
  -H "x-api-key: conciliacao-api-key-2026" \
  -o relatorio.xlsx
```

---

## ⏰ Automação (n8n)

O sistema está configurado para executar automaticamente a cada 6 horas:

1. Sincroniza pedidos do ML
2. Sincroniza movimentos do MP
3. Executa conciliação
4. Se houver divergências, envia email para: `joaopaulorocha@live.com`

### Importar Workflow no n8n

1. Acesse: https://n8n-n8n.zgbjol.easypanel.host
2. Vá em **Settings** > **Credentials**
3. Crie credencial "Header Auth":
   - **Name**: `ML-MP API Key`
   - **Header Name**: `x-api-key`
   - **Header Value**: `conciliacao-api-key-2026`
4. Vá em **Workflows** > **Import from File**
5. Importe o arquivo: `n8n-workflow-conciliacao.json`
6. Ative o workflow

---

## 🔧 Endpoints Disponíveis

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/health` | Verificar status da API |
| POST | `/sync/ml/orders` | Sincronizar pedidos ML |
| POST | `/sync/mp/movements` | Sincronizar movimentos MP |
| POST | `/reconciliation` | Executar conciliação |
| GET | `/reports/excel` | Gerar relatório Excel |
| GET | `/reports/csv` | Gerar relatório CSV |
| GET | `/metrics` | Métricas do sistema |

---

## ⚠️ Notas Importantes

### Conta de Teste do MP
O token do Mercado Pago atual é de uma **conta de teste**. Isso significa:
- A API de movimentos pode retornar dados vazios
- Para ambiente de produção, configure o token real do MP

### Atualizar Token MP de Produção
No EasyPanel, atualize a variável de ambiente:
```
MP_ACCESS_TOKEN=SEU_TOKEN_DE_PRODUCAO
```

---

## 📞 Suporte

- **Repositório**: https://github.com/gab01012025/ml-mp-reconciliation
- **Imagem Docker**: `ghcr.io/gab01012025/ml-mp-reconciliation:latest`

---

## 📋 Checklist de Configuração

- [x] API deployada no EasyPanel
- [x] Database PostgreSQL configurado
- [x] OAuth Mercado Livre autorizado
- [x] Token Mercado Pago configurado
- [x] Workflow n8n preparado
- [ ] Importar workflow no n8n
- [ ] Configurar credencial no n8n
- [ ] Ativar automação

---

*Última atualização: 03/02/2026*
