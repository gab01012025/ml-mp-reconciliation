# 📦 Instruções de Deploy - Versão 2.0

Este documento contém as instruções para atualizar o deploy no EasyPanel com as correções de MP sync.

## Correções Aplicadas

1. **MP Client** (`src/modules/mp/clients/mp.client.ts`):
   - APIs de balance e movements agora tratam erros graciosamente
   - Formato de datas corrigido para API do MP
   - Contas de teste não falham mais (retornam dados vazios ao invés de erro)

2. **MP Sync Service** (`src/modules/mp/services/sync.service.ts`):
   - Balance sync agora é opcional (não falha se conta não tem permissão)
   - Continua para payments mesmo se movements não estiver disponível

## Opções de Deploy

### Opção 1: Via GitHub (Recomendado)

1. **Criar repositório no GitHub**:
```bash
# No terminal, dentro da pasta do projeto
gh repo create ml-mp-reconciliation --private --source=. --push
```

Ou manualmente:
- Vá em github.com/new
- Crie repositório "ml-mp-reconciliation" privado
- Execute:
```bash
git remote add origin https://github.com/SEU_USUARIO/ml-mp-reconciliation.git
git push -u origin master
```

2. **No EasyPanel**:
   - Vá no serviço "conciliacao-api"
   - Clique em "Settings" > "Source"
   - Configure:
     - **Repository**: seu-usuario/ml-mp-reconciliation
     - **Branch**: master
   - Clique em "Deploy"

### Opção 2: Docker Image

1. **Login no GitHub Container Registry**:
```bash
echo "SEU_GITHUB_TOKEN" | docker login ghcr.io -u SEU_USUARIO --password-stdin
```

2. **Build e Push**:
```bash
docker build -t ghcr.io/SEU_USUARIO/ml-mp-reconciliation:latest .
docker push ghcr.io/SEU_USUARIO/ml-mp-reconciliation:latest
```

3. **No EasyPanel**:
   - Atualize a imagem do serviço para: `ghcr.io/SEU_USUARIO/ml-mp-reconciliation:latest`

### Opção 3: Upload Manual (se tiver SSH)

```bash
# Copiar ZIP para servidor
scp conciliacao-api-v2.zip root@[IP_DO_SERVIDOR]:/tmp/

# No servidor
ssh root@[IP_DO_SERVIDOR]
cd /easypanel/data/projects/conciliacao/services/conciliacao-api
unzip -o /tmp/conciliacao-api-v2.zip
npm install
npm run build
# Reiniciar container via EasyPanel
```

## Após Deploy - Testar

```bash
# 1. Verificar se API está online
curl -s "https://n8n-conciliacao-api.zgbjol.easypanel.host/health"

# 2. Testar sync de MP (deve funcionar sem erros)
curl -s -X POST "https://n8n-conciliacao-api.zgbjol.easypanel.host/sync/mp/movements" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'

# 3. Rodar conciliação
curl -s -X POST "https://n8n-conciliacao-api.zgbjol.easypanel.host/reconciliation" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'
```

## Nota Importante sobre Conta de Teste

O token de MP fornecido é para uma conta de **teste** (`TESTUSER1157660230523708851`). 
Algumas APIs do MP não estão disponíveis para contas de teste:

- ❌ `/users/{id}/mercadopago_account/balance` - Requer permissão especial
- ❌ `/mercadopago_account/movements/search` - Requer permissão especial  
- ✅ `/v1/payments/search` - Funciona normalmente

Com as correções aplicadas:
- O sistema trata esses erros graciosamente
- Retorna dados vazios ao invés de falhar
- A API de payments (a mais importante) continua funcionando

Para uma conta de **produção real** do cliente, todas as APIs devem funcionar normalmente.
