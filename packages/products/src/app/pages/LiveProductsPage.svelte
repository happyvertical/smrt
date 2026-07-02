<script lang="ts">
/**
 * Live products demo (spike #1756).
 *
 * Renders the products collection through a TanStack DB live query backed
 * entirely by generated artifacts (virt-web definitions + virt-client
 * fetchers + smrt-web factory). No hand-written fetch or state management:
 * - reads are stale-while-revalidate (navigate away and back within the
 *   staleness window: no network request — watch the demo server log)
 * - creates apply optimistically and roll back visibly when the server is
 *   forced to error (names starting with "FAIL" are rejected by the demo
 *   server with a 500)
 */
import { Input } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import { useLiveQuery } from '@happyvertical/smrt-web/svelte';
import { onMount } from 'svelte';
import {
  PRODUCTS_STALE_TIME_MS,
  createProductOptimistically,
  getProductsCollection,
} from '../../lib/stores/product-live-collection.js';
import AppLayout from '../layouts/AppLayout.svelte';

const products = getProductsCollection();
const query = useLiveQuery((q) => q.from({ product: products }));

let name = $state('');
let price = $state('19.99');
let forceServerError = $state(false);
let lastEvent = $state('Waiting for the first action…');
let now = $state(Date.now());

onMount(() => {
  const timer = setInterval(() => {
    now = Date.now();
  }, 1000);
  return () => clearInterval(timer);
});

const secondsSinceFetch = $derived(
  products.utils.dataUpdatedAt > 0
    ? Math.max(0, Math.round((now - products.utils.dataUpdatedAt) / 1000))
    : null,
);
const withinStaleWindow = $derived(
  secondsSinceFetch !== null &&
    secondsSinceFetch * 1000 < PRODUCTS_STALE_TIME_MS,
);

async function handleCreate() {
  const finalName = forceServerError
    ? `FAIL ${name.trim() || 'doomed product'}`
    : name.trim();
  if (!finalName) {
    lastEvent = 'Enter a product name first.';
    return;
  }

  lastEvent = `Optimistically inserted "${finalName}" — persisting…`;
  const tx = createProductOptimistically({
    name: finalName,
    price: Number.parseFloat(price) || 0,
    inStock: true,
  });

  try {
    await tx.isPersisted.promise;
    lastEvent = `"${finalName}" persisted through the generated client (server id assigned).`;
    name = '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastEvent = `Server rejected "${finalName}" — the optimistic row was rolled back. ${message}`;
  }
}
</script>

<AppLayout>
  {#snippet children()}
    <div class="live-page">
      <div class="page-header">
        <h1>Live Products (TanStack DB spike)</h1>
        <p class="page-description">
          Collection rendered through a live query over generated
          definitions. Reads are cached with stale-while-revalidate;
          creates are optimistic with automatic rollback.
        </p>
      </div>

      <div class="status-bar">
        <span class="status-chip" class:fresh={withinStaleWindow}>
          {#if products.utils.isFetching}
            fetching…
          {:else if secondsSinceFetch === null}
            no data yet
          {:else if withinStaleWindow}
            fresh — fetched {secondsSinceFetch}s ago; reads stay local for
            {Math.round(PRODUCTS_STALE_TIME_MS / 1000)}s
          {:else}
            stale — next subscriber revalidates in the background
          {/if}
        </span>
        <span class="status-chip">{query.data.length} products</span>
      </div>

      <div class="create-form">
        <Input
          id="live-product-name"
          label="Product name"
          bind:value={name}
          placeholder="e.g. Solar Widget"
        />
        <Input
          id="live-product-price"
          label="Price"
          bind:value={price}
          placeholder="19.99"
        />
        <label class="force-error">
          <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
          <input type="checkbox" bind:checked={forceServerError} />
          Force server error (demo server rejects names starting with "FAIL")
        </label>
        <Button type="button" onclick={handleCreate}>
          Create optimistically
        </Button>
      </div>

      <p class="event-log">{lastEvent}</p>

      {#if query.isLoading}
        <p class="loading">Loading products…</p>
      {:else}
        <ul class="product-list">
          {#each query.data as row (row.product.id)}
            <li class="product-row">
              <span class="product-name">{row.product.name}</span>
              <span class="product-price">
                ${Number(row.product.price ?? 0).toFixed(2)}
              </span>
              <span class="product-id">{row.product.id}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/snippet}
</AppLayout>

<style>
  .live-page {
    max-width: 900px;
    margin: 0 auto;
  }

  .page-header {
    text-align: center;
    margin-bottom: 1.5rem;
  }

  .page-header h1 {
    margin: 0 0 0.5rem 0;
    font-size: var(--smrt-typography-display-small-size, 2.25rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .page-description {
    margin: 0 auto;
    max-width: 640px;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    line-height: 1.6;
  }

  .status-bar {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }

  .status-chip {
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    background: var(--smrt-color-surface, #fff);
    font-size: 0.85rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .status-chip.fresh {
    border-color: var(--smrt-color-primary, #2563eb);
    color: var(--smrt-color-primary, #2563eb);
  }

  .create-form {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.75rem 1rem;
    align-items: end;
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    border-radius: var(--smrt-radius-md, 8px);
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .force-error {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .event-log {
    min-height: 1.5rem;
    text-align: center;
    font-size: 0.9rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    margin-bottom: 1.5rem;
  }

  .loading {
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .product-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  .product-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 1rem;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    border-radius: var(--smrt-radius-md, 8px);
  }

  .product-name {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .product-price {
    color: var(--smrt-color-primary, #2563eb);
    font-variant-numeric: tabular-nums;
  }

  .product-id {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, #9ca3af);
    font-family: monospace;
  }
</style>
