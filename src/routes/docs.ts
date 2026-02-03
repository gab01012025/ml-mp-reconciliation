/**
 * Documentation Routes
 * OpenAPI/Swagger endpoints
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getOpenApiSpec } from '../shared/docs/openapi.js';

export async function docsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /docs/openapi.json
   * OpenAPI specification in JSON format
   */
  app.get('/docs/openapi.json', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(getOpenApiSpec());
  });

  /**
   * GET /docs
   * Swagger UI HTML page
   */
  app.get('/docs', async (_request: FastifyRequest, reply: FastifyReply) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ML-MP Reconciliation API - Documentation</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: '/docs/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>
    `;

    return reply.type('text/html').send(html);
  });

  /**
   * GET /docs/redoc
   * ReDoc alternative documentation
   */
  app.get('/docs/redoc', async (_request: FastifyRequest, reply: FastifyReply) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ML-MP Reconciliation API - Documentation</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;700&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
  <redoc spec-url='/docs/openapi.json'></redoc>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>
    `;

    return reply.type('text/html').send(html);
  });
}
