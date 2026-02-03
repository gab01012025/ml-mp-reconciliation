# ML-MP Reconciliation

Automação de conciliação financeira entre Mercado Livre e Mercado Pago.

## Requisitos

- Node.js >= 20
- Docker & Docker Compose
- PostgreSQL 15 (via Docker ou local)

## Setup Rápido

```bash
# 1. Clone e entre no projeto
cd ml-mp-reconciliation

# 2. Copie o arquivo de ambiente
cp .env.example .env

# 3. Edite .env com suas credenciais
nano .env

# 4. Suba os containers (postgres + app)
docker-compose up -d

# 5. Rode as migrations
npm run prisma:migrate:prod
```

## Desenvolvimento Local

```bash
# 1. Instale dependências
npm install

# 2. Suba apenas o Postgres
docker-compose up -d postgres

# 3. Gere o Prisma Client
npm run prisma:generate

# 4. Rode as migrations
npm run prisma:migrate

# 5. Inicie em modo dev
npm run dev
```

## Scripts Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Inicia em modo desenvolvimento (hot reload) |
| `npm run build` | Compila TypeScript para JavaScript |
| `npm run start` | Inicia a aplicação compilada |
| `npm run test` | Executa testes |
| `npm run lint` | Verifica código com ESLint |
| `npm run format` | Formata código com Prettier |
| `npm run prisma:studio` | Abre Prisma Studio (GUI do banco) |
| `npm run prisma:migrate` | Executa migrations (dev) |

## Endpoints da API

### Autenticação
Todas as rotas requerem header `x-api-key` com a chave configurada em `API_KEY`.

### Sincronização
```
POST /sync/ml          # Sincroniza dados do Mercado Livre
POST /sync/mp          # Sincroniza dados do Mercado Pago
```

### Conciliação
```
POST /reconcile        # Executa conciliação entre ML e MP
```

### Relatórios
```
GET /reports/summary?from=2024-01-01&to=2024-01-31
GET /reports/discrepancies?from=2024-01-01&to=2024-01-31
GET /reports/export.csv?from=2024-01-01&to=2024-01-31&type=all
GET /reports/export.csv?from=2024-01-01&to=2024-01-31&type=discrepancies
```

### Health Check
```
GET /health            # Status da aplicação
```

## Estrutura do Projeto

```
src/
├── app.ts                    # Configuração Fastify
├── server.ts                 # Entry point
├── config/
│   ├── env.ts               # Variáveis de ambiente
│   └── constants.ts         # Constantes
├── modules/
│   ├── ml/                  # Mercado Livre
│   │   ├── ml.client.ts
│   │   ├── ml.service.ts
│   │   ├── ml.routes.ts
│   │   └── ml.types.ts
│   ├── mp/                  # Mercado Pago
│   │   ├── mp.client.ts
│   │   ├── mp.service.ts
│   │   ├── mp.routes.ts
│   │   └── mp.types.ts
│   ├── reconciliation/      # Motor de conciliação
│   │   ├── reconciliation.service.ts
│   │   ├── reconciliation.engine.ts
│   │   ├── reconciliation.routes.ts
│   │   └── reconciliation.types.ts
│   └── reports/             # Relatórios
│       ├── reports.service.ts
│       └── reports.routes.ts
├── db/
│   └── prisma.ts            # Cliente Prisma singleton
├── jobs/
│   └── cron.ts              # Jobs agendados
├── middlewares/
│   ├── auth.ts              # Autenticação API key
│   └── error-handler.ts     # Tratamento de erros
└── utils/
    ├── logger.ts            # Pino logger
    ├── retry.ts             # Retry com backoff
    └── date.ts              # Helpers de data
```

## Variáveis de Ambiente

Veja `.env.example` para lista completa. Principais:

| Variável | Descrição |
|----------|-----------|
| `DATABASE_URL` | Connection string PostgreSQL |
| `API_KEY` | Chave de autenticação da API |
| `ML_CLIENT_ID` | App ID do Mercado Livre |
| `ML_CLIENT_SECRET` | Secret do Mercado Livre |
| `MP_ACCESS_TOKEN` | Token do Mercado Pago |

## Fluxo de Conciliação

1. **Sync ML**: Busca vendas/pedidos do Mercado Livre e persiste no banco
2. **Sync MP**: Busca pagamentos/transações do Mercado Pago e persiste
3. **Reconcile**: Cruza dados usando `external_reference` ↔ `order_id`
4. **Reports**: Gera relatórios de divergências e sumário

## Licença

ISC
