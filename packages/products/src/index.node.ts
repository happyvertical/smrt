/**
 * Node entry for `@happyvertical/smrt-products` (the `node` export condition).
 *
 * Re-exports the browser-safe root entry plus the Node-only server bootstrap so
 * Node consumers keep `import { startServer } from '@happyvertical/smrt-products'`
 * (#3616). Browser/bundler resolution never selects this file; it gets `index.ts`.
 */

export * from './index';
export { generateMCPServer, startAll, startServer } from './server';
