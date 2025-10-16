/**
 * SMRT Content Service Server
 *
 * Demonstrates auto-generated REST API from SMRT Content objects.
 * No manual route definitions needed - everything is generated from @smrt() decorated classes.
 */

import { createRestServer, startRestServer } from '@have/smrt';
import { Content } from './content';

async function startServer() {
  console.log('🚀 Starting SMRT Content Server...');

  // Start server with registered SMRT objects
  const shutdown = await startRestServer(
    [Content], // SMRT objects to generate API for
    {}, // context
    {
      port: 3100,
      hostname: 'localhost',
      basePath: '/api/v1',
      enableCors: true,
    },
  );

  console.log('✅ Server ready!');
  console.log('📡 REST API: http://localhost:3100/api/v1');
  console.log('📚 Endpoints:');
  console.log('   GET    /api/v1/contents - List contents');
  console.log('   POST   /api/v1/contents - Create content');
  console.log('   GET    /api/v1/contents/:id - Get content');
  console.log('   PUT    /api/v1/contents/:id - Update content');
  console.log('   DELETE /api/v1/contents/:id - Delete content');

  console.log('\n💡 Try these endpoints:');
  console.log('   curl http://localhost:3100/api/v1/contents');
  console.log(
    '   curl -X POST http://localhost:3100/api/v1/contents -H "Content-Type: application/json" -d \'{"title":"Test Content","body":"Test body content"}\'',
  );

  return { shutdown };
}

// Start if running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(console.error);
}

export { startServer };
