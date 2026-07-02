/**
 * Live products collection (spike #1756).
 *
 * The entire client data layer is assembled from generated artifacts:
 * - `@happyvertical/smrt-virt-web` — typed collection definitions emitted
 *   from the package manifest by the SMRT vite plugin (name, endpoint, id
 *   field, exposed actions, field metadata, row type)
 * - `@happyvertical/smrt-web` — the TanStack DB wrapper: fetchers derived
 *   from the generated definition (same URL scheme as the generated REST
 *   client), SWR reads, optimistic mutations with rollback
 *
 * No hand-written fetch calls, no hand-written state management: components
 * read this through a live query (`useLiveQuery` from
 * `@happyvertical/smrt-web/svelte`).
 *
 * Spike finding: the demo intentionally derives fetchers from the generated
 * definition instead of importing `@happyvertical/smrt-virt-client`. In
 * builds that run both smrtPlugin and smrtConsumer (products standalone /
 * federation), virt-client and `@smrt/client` collide on the same internal
 * module id and the consumer's fallback wins — and its generated code is
 * syntactically invalid for qualified manifest keys. Tracked in the spike
 * findings for #1756.
 */

import type { ProductData } from '@happyvertical/smrt-virt-types';
import { collectionDefinitions } from '@happyvertical/smrt-virt-web';
import {
  type SmrtWebCollection,
  createSmrtCollection,
  newLocalId,
} from '@happyvertical/smrt-web';

/** Staleness window: reads within this window never hit the network. */
export const PRODUCTS_STALE_TIME_MS = 30_000;

let productsCollection: SmrtWebCollection<ProductData> | undefined;

/**
 * Lazily create the app-wide products collection (module singleton so every
 * page shares one cache and repeated navigation reuses local data).
 */
export function getProductsCollection(): SmrtWebCollection<ProductData> {
  if (!productsCollection) {
    productsCollection = createSmrtCollection(collectionDefinitions.products, {
      basePath: '/api/v1',
      staleTimeMs: PRODUCTS_STALE_TIME_MS,
    });
  }
  return productsCollection;
}

/**
 * Optimistically create a product: applies to the live collection
 * immediately, persists through the definition-derived REST fetchers, rolls
 * back on server error. Returns the transaction so callers can await/handle
 * persistence.
 */
export function createProductOptimistically(
  data: Omit<ProductData, 'id'>,
): ReturnType<SmrtWebCollection<ProductData>['insert']> {
  const collection = getProductsCollection();
  return collection.insert({
    ...data,
    id: newLocalId(),
  });
}
