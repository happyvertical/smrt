<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import type { PageProps } from './$types';

  // `data` comes from the server load in `+page.server.ts`. It is fetched
  // during SSR, serialized into the initial HTML, and hydrated here — the
  // first client render issues NO fetch for it. It re-runs only when
  // something calls `invalidate('smrt:items')` (below) or on navigation.
  let { data, form }: PageProps = $props();

  let creating = $state(false);
</script>

<svelte:head>
  <title>SMRT SvelteKit App</title>
</svelte:head>

<!--
  This page renders inside the root layout's <AdminShell> `<main>`
  (`src/routes/+layout.svelte`). Its server load + `invalidate('smrt:items')`
  refresh flow is unchanged by the shell — the shell is chrome around the
  page, not a replacement for its data loading. A plain wrapper element (not a
  second <main>) keeps the HTML valid.
-->
<div class="page">
  <h1>Welcome to SMRT + SvelteKit</h1>

  <section>
    <h2>Items</h2>

    {#if data.loadError}
      <p class="error">{data.loadError}</p>
      <p>If this is a fresh project, initialize the database with <code>smrt db:setup</code>.</p>
    {:else if data.items.length === 0}
      <p>No items yet. Create your first item below!</p>
    {:else}
      <ul>
        {#each data.items as item (item.id)}
          <li>
            <strong>{item.title}</strong>
            <span class="status">{item.status}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <!--
      Post-mutation refresh convention: submit the mutation (a form action
      here, but a fetch to a generated /api route works the same way), then
      call `invalidate('smrt:items')`. Every load that declared
      `depends('smrt:items')` re-runs and the list updates in place.
      Without JavaScript this form still works — SvelteKit falls back to a
      full-page POST + re-render.
    -->
    <form
      method="POST"
      action="?/create"
      use:enhance={() => {
        creating = true;
        return async ({ result, update }) => {
          try {
            // Apply the action result (sets `form`, resets the input) but
            // skip SvelteKit's default invalidateAll() — we re-run only the
            // loads that depend on this collection.
            await update({ invalidateAll: false });
            if (result.type === 'success') {
              await invalidate('smrt:items');
            }
          } finally {
            // Always re-enable the form, even if update()/invalidate()
            // throws (network error, aborted navigation, …).
            creating = false;
          }
        };
      }}
    >
      <input
        name="title"
        placeholder="New item title"
        aria-label="New item title"
        required
      />
      <button type="submit" disabled={creating}>
        {creating ? 'Creating…' : 'Create item'}
      </button>
    </form>

    {#if form?.error}
      <p class="error">{form.error}</p>
    {/if}
  </section>

  <section>
    <h2>Getting Started</h2>
    <ul>
      <li>Edit <code>src/lib/objects/Item.ts</code> to customize your SMRT object</li>
      <li>Load data in <code>+page.server.ts</code> files — see this page's load for the SSR + <code>depends</code>/<code>invalidate</code> pattern</li>
      <li>Run <code>smrt objects</code> to see registered objects</li>
      <li>Run <code>smrt generate-routes</code> to regenerate API routes</li>
      <li>API routes are auto-generated in <code>src/routes/api/</code></li>
    </ul>
  </section>
</div>

<style>
  .page {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
    font-family: system-ui, -apple-system, sans-serif;
  }

  h1 {
    color: #667eea;
  }

  section {
    margin: 2rem 0;
    padding: 1rem;
    background: #f5f5f5;
    border-radius: var(--smrt-radius-md, 8px);
  }

  .error {
    color: #c33;
  }

  .status {
    font-size: 0.8em;
    background: #e0e0e0;
    padding: 2px 8px;
    border-radius: var(--smrt-radius-sm, 4px);
    margin-left: 8px;
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  input {
    flex: 1;
    padding: 0.5rem;
    border: 1px solid #ccc;
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 1em;
  }

  button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: var(--smrt-radius-sm, 4px);
    background: #667eea;
    color: white;
    font-size: 1em;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  code {
    background: #e0e0e0;
    padding: 2px 6px;
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 0.9em;
  }

  ul {
    list-style: disc;
    padding-left: 1.5rem;
  }

  li {
    margin: 0.5rem 0;
  }
</style>
