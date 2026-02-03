#!/bin/bash
# Script de teste do Sistema de Conciliação ML-MP
# Execute: bash teste-sistema.sh

API_URL="https://n8n-conciliacao-api.zgbjol.easypanel.host"
API_KEY="conciliacao-api-key-2026"

echo "==========================================="
echo "   TESTE DO SISTEMA DE CONCILIAÇÃO ML-MP"
echo "==========================================="
echo ""

# Cores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Função para testar endpoint
test_endpoint() {
    local method=$1
    local endpoint=$2
    local data=$3
    local description=$4
    
    echo -e "${YELLOW}Testando: $description${NC}"
    
    if [ "$method" == "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" -X GET "$API_URL$endpoint" \
            -H "x-api-key: $API_KEY")
    else
        response=$(curl -s -w "\n%{http_code}" -X POST "$API_URL$endpoint" \
            -H "x-api-key: $API_KEY" \
            -H "Content-Type: application/json" \
            -d "$data")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        echo -e "${GREEN}✅ Sucesso (HTTP $http_code)${NC}"
        echo "$body" | head -c 200
        echo ""
    else
        echo -e "${RED}❌ Erro (HTTP $http_code)${NC}"
        echo "$body" | head -c 200
        echo ""
    fi
    echo ""
}

# 1. Health Check
test_endpoint "GET" "/health" "" "Health Check"

# 2. Sincronização ML
test_endpoint "POST" "/sync/ml/orders" '{"days": 7}' "Sincronização Mercado Livre (últimos 7 dias)"

# 3. Sincronização MP
test_endpoint "POST" "/sync/mp/movements" '{"days": 7}' "Sincronização Mercado Pago (últimos 7 dias)"

# 4. Conciliação
test_endpoint "POST" "/reconciliation" '{"days": 7}' "Executar Conciliação"

# 5. Métricas
test_endpoint "GET" "/metrics" "" "Métricas do Sistema"

echo "==========================================="
echo "   TESTES CONCLUÍDOS"
echo "==========================================="
echo ""
echo "Para baixar relatório Excel:"
echo "curl -o relatorio.xlsx \"$API_URL/reports/excel?days=30\" -H \"x-api-key: $API_KEY\""
