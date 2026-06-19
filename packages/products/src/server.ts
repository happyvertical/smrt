/**
 * SMRT Template Server
 *
 * Demonstrates auto-generated REST API from SMRT objects.
 * No manual route definitions needed - everything is generated from @smrt() decorated classes.
 */

import { startRestServer } from '@happyvertical/smrt-core';
import { Category } from './lib/models/Category';
import { Product } from './lib/models/Product';

/**
 * Reference auth stub (#1540). Generated routes are FAIL-CLOSED: without an
 * `authMiddleware` (or `@smrt({ api: { public: true } })` on the model) every
 * route returns 401. This stub demonstrates the contract — replace it with your
 * real auth (verify a session cookie / bearer token, attach the principal).
 *
 * Returning the (optionally augmented) request allows the call; returning a
 * `Response` rejects it.
 */
function demoAuthMiddleware(_objectName: string, _action: string) {
  return async (req: Request): Promise<Request | Response> => {
    const token = req.headers.get('authorization');
    if (!token) {
      return new Response(
        JSON.stringify({ error: 'Authentication required' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    // TODO: verify `token` and attach the resolved principal to the request.
    return req;
  };
}

async function startServer() {
  console.log('🚀 Starting SMRT Template Server...');

  // Start server with registered SMRT objects. Secure defaults (#1540): bind to
  // loopback, an explicit CORS origin allowlist (never `*`), and a fail-closed
  // auth middleware.
  const shutdown = await startRestServer(
    [Product, Category], // SMRT objects to generate API for
    {}, // context
    {
      port: 3000,
      hostname: '127.0.0.1',
      basePath: '/api/v1',
      enableCors: true,
      allowedOrigins: ['http://localhost:3000'],
      authMiddleware: demoAuthMiddleware,
    },
  );

  console.log('✅ Server ready!');
  console.log('📡 REST API: http://localhost:3000/api/v1');
  console.log('📚 Endpoints:');
  console.log('   GET    /api/v1/products - List products');
  console.log('   POST   /api/v1/products - Create product');
  console.log('   GET    /api/v1/products/:id - Get product');
  console.log('   PUT    /api/v1/products/:id - Update product');
  console.log('   GET    /api/v1/categories - List categories');
  console.log('   POST   /api/v1/categories - Create category');

  console.log('\n💡 Try these endpoints (auth required — send a token):');
  console.log(
    '   curl http://localhost:3000/api/v1/products -H "Authorization: Bearer <token>"',
  );
  console.log(
    '   curl http://localhost:3000/api/v1/categories -H "Authorization: Bearer <token>"',
  );
  console.log(
    '   curl -X POST http://localhost:3000/api/v1/products -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d \'{"name":"Test Product","price":29.99}\'',
  );

  return { shutdown };
}

// Start if running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(console.error);
}

export { startServer };
