# 🔧 Guia de Configuração do n8n

## 📋 Informações da API

| Item | Valor |
|------|-------|
| **URL da API** | `https://n8n-conciliacao-api.zgbjol.easypanel.host` |
| **API Key** | `conciliacao-api-key-2026` |
| **Header** | `x-api-key` |

---

## 1️⃣ Criar Credencial da API Key

1. No n8n, vá em **Settings > Credentials**
2. Clique em **Add Credential**
3. Busque por **Header Auth**
4. Configure:
   - **Name**: `ML-MP API Key`
   - **Header Name**: `x-api-key`
   - **Header Value**: `conciliacao-api-key-2026`
5. Salve

---

## 2️⃣ Criar Variável de Ambiente

1. Vá em **Settings > Variables**
2. Adicione:
   - **Name**: `API_URL`
   - **Value**: `https://n8n-conciliacao-api.zgbjol.easypanel.host`

---

## 3️⃣ Importar o Workflow

1. Vá em **Workflows**
2. Clique em **Import from File**
3. Selecione o arquivo `n8n-workflow-conciliacao.json`
4. **Importante**: Após importar, edite cada nó HTTP Request e selecione a credencial `ML-MP API Key` criada no passo 1

---

## 4️⃣ Endpoints Disponíveis

### Sincronização
```
POST /sync/ml/orders
POST /sync/mp/movements
```

### Conciliação
```
POST /reconciliation
GET /reconciliation
GET /reconciliation/{id}
GET /reconciliation/dashboard
```

### Relatórios
```
GET /reports/summary
GET /reports/daily
GET /reports/divergences
GET /reports/export/csv
GET /reports/export/excel
```

---

## 5️⃣ Exemplo de Chamada HTTP

### Sincronizar Pedidos ML
```json
{
  "method": "POST",
  "url": "https://n8n-conciliacao-api.zgbjol.easypanel.host/sync/ml/orders",
  "headers": {
    "x-api-key": "conciliacao-api-key-2026",
    "Content-Type": "application/json"
  },
  "body": {
    "startDate": "2026-02-01T00:00:00Z",
    "endDate": "2026-02-02T23:59:59Z"
  }
}
```

### Executar Conciliação
```json
{
  "method": "POST",
  "url": "https://n8n-conciliacao-api.zgbjol.easypanel.host/reconciliation",
  "headers": {
    "x-api-key": "conciliacao-api-key-2026"
  }
}
```

### Obter Dashboard
```json
{
  "method": "GET",
  "url": "https://n8n-conciliacao-api.zgbjol.easypanel.host/reconciliation/dashboard",
  "headers": {
    "x-api-key": "conciliacao-api-key-2026"
  }
}
```

---

## 6️⃣ Fluxo Recomendado

```
[Schedule Trigger: 6h]
       ↓
[Sync ML Orders]
       ↓
[Sync MP Movements]
       ↓
[Run Reconciliation]
       ↓
[Check Divergences]
       ↓
[Send Email if divergences > 0]
```

---

## 🔑 Credenciais do Cliente

- **ML App ID**: 7482396727089965
- **ML Secret**: hlDcv6hWZDeysAm293dL5rJGgN6PrJ
- **MP Client ID**: APP_USR-f8cf5c60-6d57-4f93-aa71-dc7ac6054ced
- **MP Access Token**: APP_USR-752302537209102-020210-42d8042fb95279e865d18917ea6477e5-3166345954
- **Email**: joaopaulorocha@live.com
