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

import { useWebMcpTool } from '@happyvertical/smrt-svelte';
import { Form, TextInput } from '@happyvertical/smrt-svelte/forms';
import { liveCollection } from '@happyvertical/smrt-svelte/web';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import {
  createProductCollection,
  type ProductCollectionDefinition,
} from '../stores/product-collection';
import type { ProductData } from '../types';

interface Props {
  /**
   * The `products` collection definition, resolved by the caller (the hosting
   * page resolves it from the SMRT Vite plugin via `productsCollectionDefinition()`
   * and passes it here). Threading it in as a prop keeps this component — and the
   * store it uses — free of a top-level `@happyvertical/smrt-virt-web` import.
   */
  definition: ProductCollectionDefinition;
  /** API base path for the generated REST surface (default `/api/v1`). */
  basePath?: string;
}

const { definition, basePath = '/api/v1' }: Props = $props();
const { t } = useI18n();

// Build the reference collection once (from the initial props), then bind a
// runes-reactive live view. `liveCollection` installs a `$effect` internally, so
// it (like this whole initializer) must run during component initialization —
// which it does. `liveCollection` rows are `SmrtWebRow<ProductData>`, i.e.
// `ProductData & { id: string }`, so it exposes the required key on every row.
const products = createProductCollection(definition, { basePath });
const view = liveCollection<ProductData>(products);

let newName = $state('');
let filterQuery = $state('');
let submitting = $state(false);
let lastError = $state<string | null>(null);

// Bespoke, client-only intent: this is the one place the reference store owns
// live UI state, so it needs one small hand-written tool. CRUD tools come from
// the Provider's `webmcp` opt-in and the submit tool comes from `<Form>`.
useWebMcpTool(() => ({
  name: 'filter_products',
  description: 'Filter the products currently loaded in this browser surface',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
  },
  annotations: { readOnlyHint: true },
  execute: (args) => {
    filterQuery = typeof args.query === 'string' ? args.query : filterQuery;
    const query = filterQuery.trim().toLowerCase();
    return JSON.stringify(
      view.rows.filter(
        (row) => !query || row.name?.toLowerCase().includes(query),
      ),
    );
  },
}));

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

<section class="smrt-live-product-list__root" aria-label={t(M['products.live_list.title'])} data-smrt-component="LiveProductList">
  <header class="smrt-live-product-list__header" data-smrt-part="header">
    <h2>{t(M['products.live_list.title'])}</h2>
    <p class="smrt-live-product-list__hint" data-smrt-part="meta">{t(M['products.live_list.hint'])}</p>
  </header>

  <Form
    collection="products"
    webmcp={{ name: 'create_product', description: 'Create a product from this form' }}
    onsubmit={() => addProduct()}
    class="smrt-live-product-list__form"
  >
    <TextInput
      name="name"
      bind:value={newName}
      placeholder={t(M['products.live_list.name_placeholder'])}
      label={t(M['products.live_list.name_placeholder'])}
      disabled={submitting}
    />
    <Button type="submit" variant="primary" disabled={submitting || !newName.trim()}>
      {submitting ? t(M['products.live_list.adding']) : t(M['products.live_list.add'])}
    </Button>
  </Form>

  {#if lastError}
    <p class="smrt-live-product-list__error" data-smrt-part="error" role="alert">
      {t(M['products.live_list.insert_failed'])} {lastError}
    </p>
  {/if}

  {#if view.isLoading}
    <p class="smrt-live-product-list__status" data-smrt-part="status" role="status" aria-live="polite">
      {t(M['products.live_list.loading'])}
    </p>
  {:else if view.isError}
    <p class="smrt-live-product-list__status" data-smrt-part="status" role="alert">
      {t(M['products.live_list.load_failed'])} {String(view.error)}
    </p>
  {:else if view.rows.length === 0}
    <p class="smrt-live-product-list__status" data-smrt-part="status" role="status" aria-live="polite">
      {t(M['products.live_list.empty'])}
    </p>
  {:else}
    <ul class="smrt-live-product-list__list" data-smrt-part="list">
      {#each view.rows as row (row.id)}
        <li class="smrt-live-product-list__item" data-smrt-part="item">
          <span class="smrt-live-product-list__item-name" data-smrt-part="label">{row.name}</span>
          {#if row.price != null}
            <span class="smrt-live-product-list__item-price" data-smrt-part="value">${row.price}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-live-product-list__root {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem;
  }
  .smrt-live-product-list__header {
    margin-bottom: 1rem;
  }
  .smrt-live-product-list__header h2 {
    margin: 0 0 0.25rem 0;
  }
  .smrt-live-product-list__hint {
    margin: 0;
  }
  /* smrt-svelte <Form> renders its own inner <form>; reach it through the
  component hook because the scoped selector can't (#1589), same as
  ProductForm.svelte's forwarded form class handling. */
  .smrt-live-product-list__root :global([data-smrt-component="Form"]) {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .smrt-live-product-list__root :global([data-smrt-component="Form"]) :global(.smrt-live-product-list__name) {
    flex: 1;
  }
  .smrt-live-product-list__error {
    margin: 0 0 1rem 0;
  }
  .smrt-live-product-list__status {
    margin: 0;
    padding: 1rem 0;
  }
  .smrt-live-product-list__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-live-product-list__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
  }
}

@layer smrt.theme {
  .smrt-live-product-list__root {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-live-product-list__header h2 {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-live-product-list__hint {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-live-product-list__error {
    color: var(--smrt-color-error);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-live-product-list__status {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-live-product-list__item {
    background: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-live-product-list__item-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-live-product-list__item-price {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
}

</style>
