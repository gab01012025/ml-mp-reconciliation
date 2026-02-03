# 🔄 Instruções para Atualizar a API no EasyPanel

## Passo a Passo

### 1. Acesse o EasyPanel
```
URL: [Ver arquivo CREDENCIAIS-CLIENTE.txt]
```

### 2. Vá até o serviço da API
- Clique em **Projeto > n8n-conciliacao** (ou similar)
- Clique no serviço da **API**

### 3. Atualize a imagem Docker

Na configuração do serviço, altere:

**Campo "Image":**
```
ghcr.io/gab01012025/ml-mp-reconciliation:latest
```

### 4. Clique em "Deploy" ou "Redeploy"

Isso vai baixar a nova imagem e reiniciar o serviço.

### 5. Aguarde alguns segundos e teste

```bash
curl -s "https://n8n-conciliacao-api.zgbjol.easypanel.host/health" \
  -H "x-api-key: $API_KEY"
```

---

## Por que isso é necessário?

A nova imagem Docker contém correções para:
- ✅ Tratamento de erros do Mercado Pago (conta de teste)
- ✅ Formato correto de datas na API do MP
- ✅ Sincronização continua mesmo se balance/movements falhar

Após atualizar, a sincronização do MP não vai mais falhar com erro.
