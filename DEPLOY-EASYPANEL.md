# 🚀 Deploy no EasyPanel

Este guia explica como fazer deploy do sistema ML-MP Financial Reconciliation no EasyPanel.

## Pré-requisitos

- EasyPanel instalado e funcionando
- Acesso ao n8n em: `https://n8n-n8n.zgbjol.easypanel.host/`
- Credenciais do Mercado Pago (Access Token)

---

## 1️⃣ Deploy da API no EasyPanel

### Opção A: Via GitHub

1. Acesse seu EasyPanel
2. Clique em **"Create Project"**
3. Selecione **"App"** → **"From GitHub"**
4. Configure:
   - **Repository**: URL do repositório
   - **Branch**: `main`
   - **Dockerfile Path**: `./Dockerfile`

### Opção B: Via Docker Image

1. Build a imagem localmente:
```bash
docker build -t ml-mp-api:latest .
docker tag ml-mp-api:latest seu-registry.com/ml-mp-api:latest
docker push seu-registry.com/ml-mp-api:latest
```

2. No EasyPanel:
   - **"Create Project"** → **"App"** → **"Docker Image"**
   - Image: `seu-registry.com/ml-mp-api:latest`

---

## 2️⃣ Configurar Variáveis de Ambiente

No EasyPanel, adicione estas variáveis ao serviço da API:

```env
# Básico
NODE_ENV=production
PORT=3002
LOG_LEVEL=info
API_KEY=sua-chave-api-segura-aqui

# Database (o EasyPanel cria automaticamente)
DATABASE_URL=postgresql://mlmp:senha@postgres:5432/mlmp_reconciliation

# Mercado Livre
ML_APP_ID=7482396727089965
ML_SECRET_KEY=hlDcv6hWZDeysAm293dL5rJGgN6PrJ
ML_REDIRECT_URI=https://seu-dominio.easypanel.host/auth/ml/callback

# Mercado Pago
MP_ACCESS_TOKEN=TOKEN_DO_CLIENTE_AQUI
```

---

## 3️⃣ Adicionar PostgreSQL

1. No mesmo projeto, clique em **"Add Service"**
2. Selecione **"PostgreSQL"**
3. Configure:
   - **Database Name**: `mlmp_reconciliation`
   - **Username**: `mlmp`
   - **Password**: (escolha uma senha segura)

---

## 4️⃣ Executar Migrations

Após o deploy, execute as migrations:

```bash
# Via terminal do EasyPanel ou SSH
docker exec -it ml-mp-api npx prisma migrate deploy
```

---

## 5️⃣ Configurar n8n

### Passo 1: Criar Credencial de API

1. Acesse: `https://n8n-n8n.zgbjol.easypanel.host/`
2. Vá em **Settings** → **Credentials**
3. Clique em **"Add Credential"**
4. Selecione **"Header Auth"**
5. Configure:
   - **Name**: `ML-MP API Key`
   - **Header Name**: `x-api-key`
   - **Header Value**: `sua-chave-api-segura-aqui` (mesma do API_KEY)

### Passo 2: Criar Variáveis de Ambiente no n8n

Vá em **Settings** → **Variables** e adicione:

| Variável | Valor |
|----------|-------|
| `API_URL` | `http://ml-mp-api:3002` (interno) ou URL pública |
| `DASHBOARD_URL` | URL do dashboard (se tiver) |

### Passo 3: Importar Workflow

1. Vá em **Workflows** → **Add Workflow**
2. Clique no menu (**...**) → **"Import from File"**
3. Selecione o arquivo: `n8n-workflow-conciliacao.json`
4. Atualize as credenciais nos nodes HTTP Request
5. Ative o workflow!

---

## 6️⃣ Testar a Integração

### Teste Manual via n8n

1. Abra o workflow importado
2. Clique em **"Test Workflow"**
3. Verifique se cada step executa corretamente

### Teste via cURL

```bash
# Health check
curl https://sua-api.easypanel.host/health

# Sincronizar pedidos
curl -X POST https://sua-api.easypanel.host/sync/ml/orders \
  -H "x-api-key: sua-chave-api" \
  -H "Content-Type: application/json" \
  -d '{"startDate": "2026-01-01", "endDate": "2026-01-31"}'

# Executar conciliação
curl -X POST https://sua-api.easypanel.host/reconciliation/run \
  -H "x-api-key: sua-chave-api" \
  -H "Content-Type: application/json" \
  -d '{"periodStart": "2026-01-01", "periodEnd": "2026-01-31"}'
```

---

## 📊 Endpoints Disponíveis

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/health` | GET | Status do sistema |
| `/docs` | GET | Documentação Swagger |
| `/sync/ml/orders` | POST | Sincroniza pedidos ML |
| `/reconciliation/run` | POST | Executa conciliação |
| `/reports/summary` | GET | Resumo financeiro |
| `/reports/excel/orders` | GET | Export Excel pedidos |
| `/reports/excel/movements` | GET | Export Excel movimentos |
| `/reports/excel/full` | GET | Relatório completo |
| `/scheduler/jobs` | GET | Status dos jobs |

---

## 🔧 Troubleshooting

### Erro de conexão com banco
```bash
# Verificar se PostgreSQL está rodando
docker ps | grep postgres

# Ver logs
docker logs ml-mp-postgres
```

### API não responde
```bash
# Ver logs da API
docker logs ml-mp-api

# Verificar health
curl http://localhost:3002/health
```

### n8n não consegue conectar
- Verifique se a API está acessível internamente
- Confirme que a credencial está configurada corretamente
- Tente usar o IP interno do container ao invés do hostname

---

## 📞 Suporte

Em caso de dúvidas, entre em contato!
