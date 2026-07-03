/**
 * Reference `@happyvertical/smrt-web` store for the products package (#1761,
 * slice D).
 *
 * Products is the reference consumer of the browser client-data runtime. This
 * module materializes the manifest-generated `products` web collection
 * definition (`@happyvertical/smrt-virt-web`) into a cached, reactive
 * {@link SmrtWebCollection} over the generated `/api/v1/products` REST surface
 * via {@link createSmrtCollection}. The Svelte live-query binding + optimistic
 * insert live in `../components/LiveProductList.svelte`.
 *
 * ── Engine-absorption boundary ──────────────────────────────────────────────
 * `createSmrtCollection` pulls the client-data engine (currently the ~76 kB
 * TanStack DB/Query layer). This module is therefore the FIRST module in the
 * products graph that carries that engine. It is imported ONLY through a
 * dynamic `import()` (see `../components/LiveProductList.svelte`, reached from
 * `src/app/pages/LiveProductsPage.svelte` via `import()`), so the bundler lands
 * the engine in a lazily-loaded chunk that public / smrt-sites pages never
 * fetch (ratified condition ① of #1761). NEVER import this module (or the live
 * component) statically from an app-root / public entry — doing so pulls the
 * engine into the entry bundle and defeats the split. The
 * `scripts/check-web-engine-code-split.mjs` assertion guards this.
 */

// Manifest-generated per-collection definitions. Served at runtime by the SMRT
// Vite plugin (standalone/federation app builds + vitest); resolved for `tsc`
// via the ambient `@happyvertical/smrt-virt-web` → `@smrt/web` alias in
// `ambient.d.ts`.
import { getCollectionDefinition } from '@happyvertical/smrt-virt-web';
import {
  type CreateSmrtCollectionOptions,
  createSmrtCollection,
  type SmrtWebClient,
  type SmrtWebCollection,
} from '@happyvertical/smrt-web';
import type { ProductData } from '../types';

/**
 * The public DTO carried by the products collection: the persisted product
 * columns plus the required `id` key the client collection stores rows under.
 */
export type ProductRow = ProductData & { id: string };

/** Options for {@link createProductCollection}. */
export interface CreateProductCollectionOptions
  extends Pick<
    CreateSmrtCollectionOptions,
    'basePath' | 'fetchFn' | 'client' | 'scope' | 'staleTimeMs' | 'retry'
  > {
  /**
   * Override the collection definition (tests / non-plugin builds). Defaults to
   * the manifest-generated `products` definition from
   * `@happyvertical/smrt-virt-web`.
   */
  definition?: Parameters<typeof createSmrtCollection<ProductData>>[0];
}

/**
 * Build the reference products collection over the generated REST surface.
 *
 * Reads are stale-while-revalidate; `insert({ ...data, id })` is optimistic and
 * rolls back automatically if the server rejects the create. Pass a shared
 * {@link SmrtWebClient} (from `createSmrtWebClient()`) as `client` so this
 * collection shares a cache and deduplicates requests with the rest of the app;
 * omit it for an isolated cache.
 *
 * @example
 * ```ts
 * const products = createProductCollection({ basePath: '/api/v1' });
 * await products.preload();
 * const tx = products.insert({ id: crypto.randomUUID(), name: 'New' });
 * await tx.isPersisted.promise;
 * ```
 */
export function createProductCollection(
  options: CreateProductCollectionOptions = {},
): SmrtWebCollection<ProductData> {
  const { definition, ...collectionOptions } = options;
  return createSmrtCollection<ProductData>(
    definition ?? getCollectionDefinition('products'),
    { basePath: '/api/v1', ...collectionOptions },
  );
}

export type { SmrtWebClient, SmrtWebCollection };
