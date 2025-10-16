/**
 * Simple standalone server demonstrating AST-based auto-generation
 * This bypasses workspace dependency issues by importing directly
 */

import { resolve } from 'node:path';
import { ASTScanner, ManifestGenerator } from '@have/smrt/scanner';

// Simple HTTP server using Bun
const server = Bun.serve({
  port: 3000,
  hostname: 'localhost',

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    try {
      // Auto-scan and generate routes on each request (for demo purposes)
      const modelsFile = resolve('./src/models.ts');
      const scanner = new ASTScanner([modelsFile]);
      const results = scanner.scanFiles();
      const generator = new ManifestGenerator();
      const manifest = generator.generateManifest(results);

      // Root - show discovered objects
      if (path === '/') {
        const objectsList = Object.entries(manifest.objects).map(
          ([_name, obj]) => ({
            name: obj.className,
            collection: obj.collection,
            fields: Object.keys(obj.fields),
            config: obj.decoratorConfig,
          }),
        );

        return new Response(
          JSON.stringify(
            {
              message: '🚀 SMRT Template Auto-Generated API',
              discovered: objectsList,
              endpoints: {
                '/api/products': 'Product CRUD operations',
                '/api/categories': 'Category CRUD operations',
                '/mcp/tools': 'AI tools manifest',
                '/manifest': 'Full object manifest',
              },
            },
            null,
            2,
          ),
          { headers },
        );
      }

      // Manifest endpoint
      if (path === '/manifest') {
        return new Response(JSON.stringify(manifest, null, 2), { headers });
      }

      // MCP tools endpoint
      if (path === '/mcp/tools') {
        const tools = generator.generateMCPTools(manifest);
        return new Response(tools, {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Auto-generated CRUD endpoints
      for (const [name, obj] of Object.entries(manifest.objects)) {
        const collectionPath = `/api/${obj.collection}`;
        const itemPath = `/api/${obj.collection}/`;
        const apiConfig = obj.decoratorConfig.api;
        const excludedMethods =
          (typeof apiConfig === 'object' && apiConfig?.exclude) || [];

        if (path === collectionPath) {
          if (request.method === 'GET') {
            // List items
            return new Response(
              JSON.stringify(
                {
                  message: `Listing ${obj.collection}`,
                  collection: obj.collection,
                  // Mock data for demo
                  items: [
                    {
                      id: '1',
                      name: `Sample ${obj.className}`,
                      created: new Date().toISOString(),
                    },
                  ],
                },
                null,
                2,
              ),
              { headers },
            );
          }

          if (request.method === 'POST') {
            // Create item
            const body = await request.json();
            return new Response(
              JSON.stringify(
                {
                  message: `Created ${name}`,
                  data: {
                    id: `new-${Date.now()}`,
                    ...body,
                    created: new Date().toISOString(),
                  },
                },
                null,
                2,
              ),
              {
                status: 201,
                headers,
              },
            );
          }
        }

        if (path.startsWith(itemPath)) {
          const id = path.slice(itemPath.length);

          if (request.method === 'GET') {
            // Get item
            return new Response(
              JSON.stringify(
                {
                  message: `Get ${name} ${id}`,
                  data: {
                    id,
                    name: `Sample ${obj.className} ${id}`,
                    created: new Date().toISOString(),
                  },
                },
                null,
                2,
              ),
              { headers },
            );
          }

          if (request.method === 'PUT') {
            // Update item
            const body = await request.json();
            return new Response(
              JSON.stringify(
                {
                  message: `Updated ${name} ${id}`,
                  data: { id, ...body, updated: new Date().toISOString() },
                },
                null,
                2,
              ),
              { headers },
            );
          }

          if (
            request.method === 'DELETE' &&
            !excludedMethods.includes('delete')
          ) {
            // Delete item (if allowed)
            return new Response(
              JSON.stringify({
                message: `Deleted ${name} ${id}`,
              }),
              { headers },
            );
          }
        }
      }

      // 404
      return new Response(
        JSON.stringify(
          {
            error: 'Not Found',
            available_endpoints: Object.entries(manifest.objects).map(
              ([_name, obj]) => {
                const apiConfig = obj.decoratorConfig.api;
                const objExcludedMethods =
                  (typeof apiConfig === 'object' && apiConfig?.exclude) || [];
                return {
                  collection: obj.collection,
                  endpoints: [
                    `GET /api/${obj.collection}`,
                    `POST /api/${obj.collection}`,
                    `GET /api/${obj.collection}/:id`,
                    `PUT /api/${obj.collection}/:id`,
                    ...(objExcludedMethods.includes('delete')
                      ? []
                      : [`DELETE /api/${obj.collection}/:id`]),
                  ],
                };
              },
            ),
          },
          null,
          2,
        ),
        {
          status: 404,
          headers,
        },
      );
    } catch (error) {
      return new Response(
        JSON.stringify(
          {
            error: 'Internal Server Error',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
          null,
          2,
        ),
        {
          status: 500,
          headers,
        },
      );
    }
  },
});

console.log('🚀 SMRT Template Server started!');
console.log(`📡 Server: http://localhost:${server.port}`);
console.log('\n🎯 Auto-generated endpoints:');
console.log('   GET  / - API overview and discovered objects');
console.log('   GET  /manifest - Full SMRT manifest');
console.log('   GET  /mcp/tools - AI tools for MCP integration');
console.log('   GET  /api/products - List products');
console.log('   POST /api/products - Create product');
console.log('   GET  /api/categories - List categories');
console.log('   POST /api/categories - Create category');
console.log('\n💡 Try these commands:');
console.log(`   curl http://localhost:${server.port}/`);
console.log(`   curl http://localhost:${server.port}/api/products`);
console.log(
  `   curl -X POST http://localhost:${server.port}/api/products -H "Content-Type: application/json" -d '{"name":"Demo Product","price":29.99}'`,
);
console.log(
  '\n🔄 The server rescans models.ts on each request to show live updates!',
);
console.log('   Modify src/models.ts and see changes immediately');
