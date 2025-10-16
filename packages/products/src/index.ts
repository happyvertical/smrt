/**
 * SMRT Template: Triple-Purpose Export
 *
 * This is the main entry point when this template is used as an NPM library.
 * It re-exports everything from the lib directory for easy consumption.
 *
 * Usage examples:
 *
 * // Import models
 * import { Product, Category } from '@have/smrt-template';
 *
 * // Import UI components
 * import { ProductCard, ProductForm } from '@have/smrt-template/components';
 *
 * // Import stores
 * import { ProductStoreClass } from '@have/smrt-template/stores';
 */

export { demonstrateClient } from './client';
// Re-export everything from the lib directory
export * from './lib/index';
export { startMCPServer } from './mcp';
// Legacy exports for backward compatibility
export { startServer } from './server';

/**
 * Start all services for demonstration (legacy function)
 */
export async function startAll() {
  const { startServer } = await import('./server');
  const { startMCPServer } = await import('./mcp');

  console.log('🚀 Starting SMRT Template - Full Demo\n');

  // Start REST API server
  console.log('1️⃣ Starting REST API...');
  const server = await startServer();

  // Start MCP server
  console.log('\n2️⃣ Starting MCP Server...');
  const mcp = await startMCPServer();

  console.log('\n✨ All services running!');
  console.log('\n🎯 What was auto-generated:');
  console.log('   • REST endpoints for Product and Category');
  console.log('   • TypeScript client with full type safety');
  console.log('   • MCP tools for AI model integration');
  console.log('   • OpenAPI/Swagger documentation');
  console.log('   • Live reloading during development');

  console.log('\n📝 Next steps:');
  console.log('   • Modify src/lib/models/ to add new fields');
  console.log('   • Add new @smrt() classes to auto-generate more APIs');
  console.log('   • Run bun run dev to see live updates');

  return { server, mcp };
}

// Auto-start if running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startAll().catch(console.error);
}
