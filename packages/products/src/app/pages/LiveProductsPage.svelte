<script lang="ts">
/**
 * Standalone-app page hosting the live products surface (#1761, slice D).
 *
 * ── The code-split boundary (ratified condition ① of #1761) ─────────────────
 * `LiveProductList` statically pulls the `@happyvertical/smrt-web` runtime and
 * the `@happyvertical/smrt-svelte/web` binding — i.e. the ~76 kB TanStack
 * client-data engine. This page reaches it ONLY through a dynamic `import()`
 * below, so the bundler emits the engine (and this component) into a
 * lazily-loaded chunk fetched only when THIS page renders. Public / smrt-sites
 * pages that never mount this page never download the engine.
 *
 * The whole point of this slice is that this `import()` is the SOLE path from
 * the app entry to the runtime. `App.svelte` routes here lazily; nothing on the
 * public path imports the store or the live component statically. The
 * `scripts/check-web-engine-code-split.mjs` assertion proves the split holds.
 */

import type { Component } from 'svelte';
import { onMount } from 'svelte';
import AppLayout from '../layouts/AppLayout.svelte';

// Lazily-resolved live component. The dynamic import is what code-splits the
// engine out of the entry bundle — do NOT convert this to a static import.
let LiveProductList = $state<Component<{ basePath?: string }> | null>(null);
let loadError = $state<string | null>(null);

onMount(async () => {
  try {
    const mod = await import('../../lib/components/LiveProductList.svelte');
    LiveProductList = mod.default as Component<{ basePath?: string }>;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
});
</script>

<AppLayout>
  {#snippet children()}
    <div class="live-products-page">
      <div class="page-header">
        <h1>Live products</h1>
        <p class="page-description">
          The <code>@happyvertical/smrt-web</code> browser runtime as the
          reference store — live rows + optimistic insert, loaded in a
          code-split chunk so public pages never pay for the engine.
        </p>
      </div>

      {#if loadError}
        <p class="page-status" role="alert">Failed to load runtime: {loadError}</p>
      {:else if LiveProductList}
        <LiveProductList />
      {:else}
        <p class="page-status" role="status" aria-live="polite">
          Loading live runtime…
        </p>
      {/if}
    </div>
  {/snippet}
</AppLayout>

<style>
  .live-products-page {
    max-width: 1200px;
    margin: 0 auto;
  }

  .page-header {
    text-align: center;
    margin-bottom: 2rem;
  }

  .page-header h1 {
    margin: 0 0 0.5rem 0;
    font-size: var(--smrt-typography-display-small-size, 2.25rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .page-description {
    max-width: 640px;
    margin: 0 auto;
    font-size: var(--smrt-typography-body-large-size, 1.125rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    line-height: var(--smrt-typography-body-large-line-height, 1.6);
  }

  .page-description code {
    font-size: 0.9em;
  }

  .page-status {
    text-align: center;
    padding: 2rem 1rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }
</style>
