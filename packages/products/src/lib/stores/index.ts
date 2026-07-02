/**
 * SMRT Template Stores
 *
 * Svelte 5 rune-based state management for SMRT objects.
 * These stores integrate with auto-generated SMRT clients.
 */

export { ProductStoreClass, productStore } from './product-store.svelte';
// TanStack DB spike (#1756): generated live collection over the generated client
export {
  PRODUCTS_STALE_TIME_MS,
  createProductOptimistically,
  getProductsCollection,
} from './product-live-collection';
