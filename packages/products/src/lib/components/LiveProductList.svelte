<script lang="ts">
/**
 * Live products list backed by the `@happyvertical/smrt-web` runtime (#1761,
 * slice D) — the reference "live collection" surface for the products package.
 *
 * Renders stale-while-revalidate live rows from the generated `/products` REST
 * surface and performs an OPTIMISTIC insert: a new row appears instantly and
 * rolls back automatically if the server rejects the create.
 *
 * ── Engine-absorption boundary ──────────────────────────────────────────────
 * This component statically imports the reference store (which carries the
 * client-data engine) and `liveCollection` from `@happyvertical/smrt-svelte/web`
 * (the Svelte binding, which pulls `@tanstack/db` + `@tanstack/svelte-db`). It
 * is therefore engine-bearing and MUST only be reached through a dynamic
 * `import()` — see `src/app/pages/LiveProductsPage.svelte`. Importing it
 * statically from an app-root / public entry pulls the ~76 kB engine into the
 * entry bundle and breaks the code-split (ratified condition ① of #1761).
 */

import { liveCollection } from '@happyvertical/smrt-svelte/web';
import { Input } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import { createProductCollection } from '../stores/product-collection';
import type { ProductData } from '../types';

interface Props {
  /** API base path for the generated REST surface (default `/api/v1`). */
  basePath?: string;
}

const { basePath = '/api/v1' }: Props = $props();

// Build the reference collection once (from the initial `basePath`), then bind a
// runes-reactive live view. `liveCollection` installs a `$effect` internally, so
// it (like this whole initializer) must run during component initialization —
// which it does. `liveCollection` rows are `SmrtWebRow<ProductData>`, i.e.
// `ProductData & { id: string }`, so it exposes the required key on every row.
const products = createProductCollection({ basePath });
const view = liveCollection<ProductData>(products);

let newName = $state('');
let submitting = $state(false);
let lastError = $state<string | null>(null);

async function addProduct() {
  const name = newName.trim();
  if (!name || submitting) return;
  submitting = true;
  lastError = null;

  // Optimistic insert: the row shows in `view.rows` synchronously; the returned
  // mutation settles on the server outcome and rolls back on failure. The
  // client-local id is stripped server-side (mass-assignment guard) and the
  // post-persist refetch swaps in the server-assigned row.
  const mutation = view.insert({ id: crypto.randomUUID(), name });
  newName = '';
  await mutation.done;
  if (mutation.error) {
    lastError =
      mutation.error instanceof Error
        ? mutation.error.message
        : String(mutation.error);
  }
  submitting = false;
}
</script>

<section class="live-products" aria-label="Live products (smrt-web runtime)">
  <header class="live-products__header">
    <h2>Live products</h2>
    <p class="live-products__hint">
      Reactive rows from the <code>@happyvertical/smrt-web</code> runtime over
      <code>{basePath}/products</code>. Adding a product is optimistic.
    </p>
  </header>

  <form
    class="live-products__form"
    onsubmit={(e) => {
      e.preventDefault();
      addProduct();
    }}
  >
    <Input
      type="text"
      bind:value={newName}
      placeholder="New product name"
      aria-label="New product name"
      disabled={submitting}
      class="live-products__name"
    />
    <Button type="submit" variant="primary" disabled={submitting || !newName.trim()}>
      {submitting ? 'Adding…' : 'Add product'}
    </Button>
  </form>

  {#if lastError}
    <p class="live-products__error" role="alert">Insert failed: {lastError}</p>
  {/if}

  {#if view.isLoading}
    <p class="live-products__status" role="status" aria-live="polite">Loading…</p>
  {:else if view.isError}
    <p class="live-products__status" role="alert">
      Failed to load: {String(view.error)}
    </p>
  {:else if view.rows.length === 0}
    <p class="live-products__status" role="status" aria-live="polite">
      No products yet.
    </p>
  {:else}
    <ul class="live-products__list">
      {#each view.rows as row (row.id)}
        <li class="live-products__item">
          <span class="live-products__item-name">{row.name}</span>
          {#if row.price}
            <span class="live-products__item-price">${row.price}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .live-products {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem;
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    border-radius: var(--smrt-radius-md, 8px);
  }

  .live-products__header {
    margin-bottom: 1rem;
  }

  .live-products__header h2 {
    margin: 0 0 0.25rem 0;
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .live-products__hint {
    margin: 0;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .live-products__hint code {
    font-size: 0.85em;
  }

  .live-products__form {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .live-products__form :global(.live-products__name) {
    flex: 1;
  }

  .live-products__error {
    margin: 0 0 1rem 0;
    color: var(--smrt-color-error, #dc2626);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .live-products__status {
    margin: 0;
    padding: 1rem 0;
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .live-products__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .live-products__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-radius: var(--smrt-radius-sm, 4px);
  }

  .live-products__item-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .live-products__item-price {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
</style>
