/**
 * SMRT Template Server
 *
 * Demonstrates auto-generated REST API from SMRT objects.
 * No manual route definitions needed - everything is generated from @smrt() decorated classes.
 */

import { createRestServer, startRestServer } from '@have/smrt';
import { Category } from './lib/models/Category';
import { Product } from './lib/models/Product';

async function startServer() {
  console.log('🚀 Starting SMRT Template Server...');

  // Start server with registered SMRT objects
  const shutdown = await startRestServer(
    [Product, Category], // SMRT objects to generate API for
    {}, // context
    {
      port: 3000,
      hostname: 'localhost',
      basePath: '/api/v1',
      enableCors: true,
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

  console.log('\n💡 Try these endpoints:');
  console.log('   curl http://localhost:3000/api/v1/products');
  console.log('   curl http://localhost:3000/api/v1/categories');
  console.log(
    '   curl -X POST http://localhost:3000/api/v1/products -H "Content-Type: application/json" -d \'{"name":"Test Product","price":29.99}\'',
  );

  return { shutdown };
}

// Start if running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(console.error);
}

export { startServer };
