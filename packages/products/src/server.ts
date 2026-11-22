/**
 * SMRT Template Server
 *
 * Demonstrates auto-generated REST API from SMRT objects.
 * No manual route definitions needed - everything is generated from @smrt() decorated classes.
 */

import { pathToFileURL } from 'node:url';
import {
  type APIRequestPrincipal,
  startRestServer,
} from '@happyvertical/smrt-core';
import { Category } from './lib/models/Category';
import { Product } from './lib/models/Product';

/**
 * Reference principal resolver (#1540, #5195). Generated routes are
 * FAIL-CLOSED: a route that is not `@smrt({ api: { public } })` answers 401
 * to a caller who is not signed in, and every write needs the
 * `<collection>.<action>` permission (`products.create`, `categories.update`,
 * ...). The server enforces both from the principal returned here, once per
 * request, and nothing in the request can change it.
 *
 * Tenant-scoped models (`Product` is `@TenantScoped`) run inside the
 * principal's tenant: when tenancy is enabled, a principal with no tenant
 * reads global rows only and cannot write, and a write body that names
 * another tenant is refused with 403.
 *
 * Replace the stub with your real authentication: verify the session cookie
 * or bearer token and return the tenant, user and permission slugs of the
 * verified principal, never values from a header or parameter the caller
 * controls. Return `null` for an anonymous caller.
 */
function demoResolvePrincipal(req: Request): APIRequestPrincipal | null {
  const token = req.headers.get('authorization');
  if (!token) return null;
  // TODO: verify `token` and return its principal. This stub verifies
  // nothing, so it knows no tenant and grants only what the demo needs.
  return {
    tenantId: null,
    allowCrossTenant: false,
    authenticated: true,
    permissions: [
      'products.create',
      'products.update',
      'categories.create',
      'categories.update',
    ],
  };
}

async function startServer() {
  console.log('🚀 Starting SMRT Template Server...');

  // Start server with registered SMRT objects. Secure defaults (#1540): bind to
  // loopback, an explicit CORS origin allowlist (never `*`), and a fail-closed
  // principal resolver.
  const shutdown = await startRestServer(
    [Product, Category], // SMRT objects to generate API for
    {}, // context
    {
      port: 3000,
      hostname: '127.0.0.1',
      basePath: '/api/v1',
      enableCors: true,
      allowedOrigins: ['http://localhost:3000'],
      resolvePrincipal: demoResolvePrincipal,
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
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer().catch(console.error);
}

export { startServer };
