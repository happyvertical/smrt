/**
 * SMRT Template: Triple-Purpose Export
 *
 * This is the main entry point when this template is used as an NPM library.
 * It re-exports everything from the lib directory for easy consumption.
 *
 * Usage examples:
 *
 * // Import models
 * import { Product, Category } from '@happyvertical/core-template';
 *
 * // Import UI components
 * import { ProductCard, ProductForm } from '@happyvertical/core-template/components';
 *
 * // Import stores
 * import { ProductStoreClass } from '@happyvertical/core-template/stores';
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Re-export everything from the lib directory
export * from './lib/index';

// The server bootstrap (`startServer`, `generateMCPServer`, `startAll`) lives in
// the Node-only `./server` subpath so this entry stays browser-safe (#3616).
// Node resolution of `.` re-exports it via `index.node.ts`, together with
// `demonstrateClient`, whose module imports the build-time
// `@happyvertical/smrt-virt-client` virtual module a browser bundle cannot resolve.
