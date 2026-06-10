<script lang="ts">
  let items: any[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);

  $effect(() => {
    fetchItems();
  });

  async function fetchItems() {
    try {
      const response = await fetch('/api/items');
      const data = await response.json();
      items = data.items || [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to fetch items';
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>SMRT SvelteKit App</title>
</svelte:head>

<main>
  <h1>Welcome to SMRT + SvelteKit</h1>

  <section>
    <h2>Items</h2>

    {#if loading}
      <p>Loading...</p>
    {:else if error}
      <p class="error">{error}</p>
    {:else if items.length === 0}
      <p>No items yet. Create your first item!</p>
    {:else}
      <ul>
        {#each items as item}
          <li>
            <strong>{item.title}</strong>
            <span class="status">{item.status}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h2>Getting Started</h2>
    <ul>
      <li>Edit <code>src/lib/objects/Item.ts</code> to customize your SMRT object</li>
      <li>Run <code>smrt objects</code> to see registered objects</li>
      <li>Run <code>smrt generate-routes</code> to regenerate API routes</li>
      <li>API routes are auto-generated in <code>src/routes/api/</code></li>
    </ul>
  </section>
</main>

<style>
  main {
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
