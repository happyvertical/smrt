/**
 * Reference `@happyvertical/smrt-web` store for the products package (#1761,
 * slice D).
 *
 * Products is the reference consumer of the browser client-data runtime. This
 * module materializes a manifest-generated `products` web collection definition
 * into a cached, reactive {@link SmrtWebCollection} over the generated
 * `/api/v1/products` REST surface via {@link createSmrtCollection}. The Svelte
 * live-query binding + optimistic insert live in
 * `../components/LiveProductList.svelte`.
 *
 * ── Plugin-agnostic on purpose ──────────────────────────────────────────────
 * The `products` definition comes from the `@happyvertical/smrt-virt-web`
 * virtual module, which exists ONLY under a SMRT Vite-plugin build. To keep
 * this module importable everywhere (unit tests, plain `tsc`, an npm consumer
 * wiring its own definition), it does NOT import that virtual module at the top
 * level. Instead the definition is supplied by the caller:
 *   - the live component resolves it from the plugin (see LiveProductList),
 *   - {@link productsCollectionDefinition} lazily resolves it on demand.
 * A caller passing an explicit `definition` never touches the virtual module.
 *
 * ── Engine-absorption boundary ──────────────────────────────────────────────
 * `createSmrtCollection` pulls the client-data engine (currently the ~76 kB
 * TanStack DB/Query layer). This module is therefore engine-bearing. It is
 * imported ONLY through a dynamic `import()` (see
 * `../components/LiveProductList.svelte`, reached from
 * `src/app/pages/LiveProductsPage.svelte` via `import()`), so the bundler lands
 * the engine in a lazily-loaded chunk that public / smrt-sites pages never
 * fetch (ratified condition ① of #1761). NEVER import this module (or the live
 * component) statically from an app-root / public entry — doing so pulls the
 * engine into the entry bundle and defeats the split. The
 * `scripts/check-web-engine-code-split.mjs` assertion guards this.
 */

import {
  type CreateSmrtCollectionOptions,
  createSmrtCollection,
  type SmrtWebClient,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
} from '@happyvertical/smrt-web';
import type { ProductData } from '../types';

/**
 * The public DTO carried by the products collection: the persisted product
 * columns plus the required `id` key the client collection stores rows under.
 */
export type ProductRow = ProductData & { id: string };

/** The `products` collection definition, typed to this package's row shape. */
export type ProductCollectionDefinition =
  SmrtWebCollectionDefinition<ProductData>;

/** Options for {@link createProductCollection}. */
export type CreateProductCollectionOptions = Pick<
  CreateSmrtCollectionOptions,
  'basePath' | 'fetchFn' | 'client' | 'scope' | 'staleTimeMs' | 'retry'
>;

/**
 * Lazily resolve the manifest-generated `products` definition from the
 * `@happyvertical/smrt-virt-web` virtual module.
 *
 * Kept out of module top-level so importing this store never eagerly resolves a
 * module that exists only under a SMRT Vite-plugin build — a unit test or npm
 * consumer that supplies its own definition must never trigger it. The dynamic
 * `import()` also keeps the virtual specifier out of every static import graph.
 * Resolved for `tsc` via the ambient `@happyvertical/smrt-virt-web` → `@smrt/web`
 * alias in `ambient.d.ts`.
 */
export async function productsCollectionDefinition(): Promise<ProductCollectionDefinition> {
  const { getCollectionDefinition } = await import(
    '@happyvertical/smrt-virt-web'
  );
  return getCollectionDefinition(
    'products',
  ) as unknown as ProductCollectionDefinition;
}

/**
 * Build the reference products collection over the generated REST surface from
 * a `products` collection definition.
 *
 * The definition is a parameter (not resolved here) so this factory is
 * synchronous and plugin-agnostic: the live component passes the
 * plugin-provided definition (via {@link productsCollectionDefinition}); a unit
 * test or npm consumer passes its own. Neither path imports the virtual module
 * unless it explicitly calls {@link productsCollectionDefinition}.
 *
 * Reads are stale-while-revalidate; `insert({ ...data, id })` is optimistic and
 * rolls back automatically if the server rejects the create. Pass a shared
 * {@link SmrtWebClient} (from `createSmrtWebClient()`) as `client` so this
 * collection shares a cache and deduplicates requests with the rest of the app;
 * omit it for an isolated cache.
 *
 * @example
 * ```ts
 * const definition = await productsCollectionDefinition();
 * const products = createProductCollection(definition, { basePath: '/api/v1' });
 * await products.preload();
 * const tx = products.insert({ id: crypto.randomUUID(), name: 'New' });
 * await tx.isPersisted.promise;
 * ```
 */
export function createProductCollection(
  definition: ProductCollectionDefinition,
  options: CreateProductCollectionOptions = {},
): SmrtWebCollection<ProductData> {
  return createSmrtCollection<ProductData>(definition, {
    basePath: '/api/v1',
    ...options,
  });
}

export type { SmrtWebClient, SmrtWebCollection, SmrtWebCollectionDefinition };
