# 🚀 ATUALIZAÇÃO RÁPIDA - EasyPanel

## Passo 1: Atualizar Serviço no EasyPanel

1. Acesse: **http://31.97.87.68:3000**
2. Login no EasyPanel
3. Vá no projeto **conciliacao** > serviço **conciliacao-api**
4. Clique em **"Settings"** > **"Source"**
5. Configure:
   - **Type**: Docker Image
   - **Image**: `ghcr.io/gab01012025/ml-mp-reconciliation:latest`
6. Clique **"Deploy"**

## Passo 2: Verificar Deploy

Após o deploy, execute:

```bash
# Verificar se API está online
curl -s "https://n8n-conciliacao-api.zgbjol.easypanel.host/health"
```

## Passo 3: Testar Sync MP

```bash
curl -s -X POST "https://n8n-conciliacao-api.zgbjol.easypanel.host/sync/mp/movements" \
  -H "x-api-key: conciliacao-api-key-2026" \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'
```

Agora deve retornar sucesso (mesmo que 0 movements, não vai mais dar erro).

## Informações da Imagem Docker

- **Registry**: ghcr.io
- **Image**: ghcr.io/gab01012025/ml-mp-reconciliation
- **Tags**: latest, sha-9067e98
- **Repositório**: https://github.com/gab01012025/ml-mp-reconciliation
