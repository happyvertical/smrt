/**
 * Node entry for `@happyvertical/smrt-products` (the `node` export condition).
 *
 * Re-exports the browser-safe root entry plus the Node-only server bootstrap so
 * Node consumers keep `import { startServer } from '@happyvertical/smrt-products'`
 * (#3616). Browser/bundler resolution never selects this file; it gets `index.ts`.
 */

// Runtime virtual modules supplied by the SMRT Vite plugin; kept off the
// browser-safe root (#3616).
export { default as createClient } from '@smrt/client';
export { manifest } from '@smrt/manifest';
export { default as createMCPServer } from '@smrt/mcp';
export { default as setupRoutes } from '@smrt/routes';
export { demonstrateClient } from './client';
export * from './index';
export { generateMCPServer, startAll, startServer } from './server';
