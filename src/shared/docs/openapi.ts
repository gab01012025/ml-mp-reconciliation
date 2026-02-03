/**
 * OpenAPI Documentation
 * API specification for ML-MP Financial Reconciliation
 */

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'ML-MP Financial Reconciliation API',
    description: `
API para conciliação financeira entre Mercado Libre e Mercado Pago.

## Funcionalidades

- **Sincronização**: Importa pedidos do ML e movimentos do MP
- **Conciliação**: Reconcilia pedidos com movimentos financeiros
- **Relatórios**: Gera relatórios financeiros e exporta dados em CSV
- **Observabilidade**: Métricas, circuit breakers e rate limiters

## Autenticação

A API usa autenticação via API Key no header \`x-api-key\`.

Endpoints públicos (sem autenticação):
- \`/health\`
- \`/health/ready\`
- \`/health/live\`
- \`/auth/ml/callback\`
- \`/auth/mp/callback\`
    `,
    version: '1.0.0',
    contact: {
      name: 'API Support',
    },
  },
  servers: [
    {
      url: 'http://localhost:3002',
      description: 'Development server',
    },
  ],
  tags: [
    { name: 'Health', description: 'Health check endpoints' },
    { name: 'OAuth', description: 'OAuth authentication for ML/MP' },
    { name: 'Sync', description: 'Data synchronization endpoints' },
    { name: 'Reconciliation', description: 'Financial reconciliation' },
    { name: 'Reports', description: 'Reports and exports' },
    { name: 'Metrics', description: 'Observability and monitoring' },
  ],
  paths: {
    '/': {
      get: {
        summary: 'API Info',
        description: 'Returns basic API information',
        responses: {
          '200': {
            description: 'API information',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    version: { type: 'string' },
                    status: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Returns health status of the API',
        responses: {
          '200': {
            description: 'API is healthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness check',
        description: 'Checks if API is ready to receive requests (database connected)',
        responses: {
          '200': { description: 'API is ready' },
          '503': { description: 'API is not ready' },
        },
      },
    },
    '/auth/ml/authorize': {
      get: {
        tags: ['OAuth'],
        summary: 'Start ML OAuth flow',
        description: 'Redirects to Mercado Libre OAuth authorization page',
        parameters: [
          {
            name: 'sellerId',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Seller identifier',
          },
        ],
        responses: {
          '302': { description: 'Redirect to ML OAuth' },
        },
      },
    },
    '/sync/ml/orders': {
      post: {
        tags: ['Sync'],
        summary: 'Sync ML orders',
        description: 'Synchronizes orders from Mercado Libre',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  sellerId: { type: 'string' },
                  startDate: { type: 'string', format: 'date' },
                  endDate: { type: 'string', format: 'date' },
                },
                required: ['sellerId'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Sync completed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SyncResponse' },
              },
            },
          },
        },
      },
    },
    '/sync/mp/movements': {
      post: {
        tags: ['Sync'],
        summary: 'Sync MP movements',
        description: 'Synchronizes movements from Mercado Pago',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  startDate: { type: 'string', format: 'date' },
                  endDate: { type: 'string', format: 'date' },
                },
                required: ['userId'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Sync completed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SyncResponse' },
              },
            },
          },
        },
      },
    },
    '/reconciliation': {
      post: {
        tags: ['Reconciliation'],
        summary: 'Run reconciliation',
        description: 'Reconciles ML orders with MP movements',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  sellerId: { type: 'string' },
                  startDate: { type: 'string', format: 'date' },
                  endDate: { type: 'string', format: 'date' },
                  tolerance: { type: 'number', default: 0.01 },
                },
                required: ['sellerId', 'startDate', 'endDate'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Reconciliation completed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReconciliationResponse' },
              },
            },
          },
        },
      },
      get: {
        tags: ['Reconciliation'],
        summary: 'List reconciliations',
        description: 'List all reconciliations with pagination',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: 'sellerId', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: {
          '200': { description: 'List of reconciliations' },
        },
      },
    },
    '/reconciliation/{id}': {
      get: {
        tags: ['Reconciliation'],
        summary: 'Get reconciliation',
        description: 'Get reconciliation by ID with items',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Reconciliation details' },
          '404': { description: 'Reconciliation not found' },
        },
      },
    },
    '/reconciliation/dashboard': {
      get: {
        tags: ['Reconciliation'],
        summary: 'Dashboard stats',
        description: 'Get reconciliation dashboard statistics',
        security: [{ ApiKeyAuth: [] }],
        responses: {
          '200': {
            description: 'Dashboard statistics',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DashboardStats' },
              },
            },
          },
        },
      },
    },
    '/reports/summary': {
      get: {
        tags: ['Reports'],
        summary: 'Financial summary',
        description: 'Get financial summary for a period',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: 'startDate', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          '200': { description: 'Financial summary' },
        },
      },
    },
    '/reports/daily': {
      get: {
        tags: ['Reports'],
        summary: 'Daily report',
        description: 'Get daily breakdown for a period',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: 'startDate', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          '200': { description: 'Daily breakdown' },
        },
      },
    },
    '/reports/export/orders': {
      get: {
        tags: ['Reports'],
        summary: 'Export orders CSV',
        description: 'Export orders to CSV file',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: 'startDate', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          '200': {
            description: 'CSV file',
            content: {
              'text/csv': {
                schema: { type: 'string' },
              },
            },
          },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['Metrics'],
        summary: 'All metrics',
        description: 'Get all observability metrics',
        security: [{ ApiKeyAuth: [] }],
        responses: {
          '200': { description: 'All metrics' },
        },
      },
    },
    '/metrics/system': {
      get: {
        tags: ['Metrics'],
        summary: 'System metrics',
        description: 'Get system metrics (memory, uptime, etc)',
        security: [{ ApiKeyAuth: [] }],
        responses: {
          '200': { description: 'System metrics' },
        },
      },
    },
    '/metrics/circuit-breakers': {
      get: {
        tags: ['Metrics'],
        summary: 'Circuit breaker stats',
        description: 'Get all circuit breaker statistics',
        security: [{ ApiKeyAuth: [] }],
        responses: {
          '200': { description: 'Circuit breaker stats' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
    schemas: {
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
          timestamp: { type: 'string', format: 'date-time' },
          version: { type: 'string' },
        },
      },
      SyncResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              synced: { type: 'integer' },
              created: { type: 'integer' },
              updated: { type: 'integer' },
              errors: { type: 'integer' },
            },
          },
        },
      },
      ReconciliationResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              totalOrders: { type: 'integer' },
              totalMovements: { type: 'integer' },
              matchedCount: { type: 'integer' },
              unmatchedCount: { type: 'integer' },
              divergentCount: { type: 'integer' },
            },
          },
        },
      },
      DashboardStats: {
        type: 'object',
        properties: {
          totalReconciliations: { type: 'integer' },
          pendingItems: { type: 'integer' },
          matchedItems: { type: 'integer' },
          divergentItems: { type: 'integer' },
          totalDiscrepancy: { type: 'number' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

export function getOpenApiSpec(): typeof openApiSpec {
  return openApiSpec;
}
