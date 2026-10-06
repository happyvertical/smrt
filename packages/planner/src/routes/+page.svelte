<script lang="ts">
import {
  catalog,
  exposedModels,
  searchPackages,
  surfaceCount,
} from '$lib/catalog/index.ts';
import { humanize } from '$lib/data/format.ts';
import { selection } from '$lib/planner/selection.svelte.ts';

let query = $state('');
let notice = $state('');

const results = $derived(searchPackages(catalog.packages, query));

function toggle(id: string) {
  const before = new Set(selection.ids);
  const wasSelected = before.has(id);
  selection.toggle(id);
  const pulled = selection.ids.filter((x) => !before.has(x) && x !== id);
  notice = wasSelected
    ? `Removed ${humanize(id)}.`
    : pulled.length
      ? `Added ${humanize(id)} and the packages it needs: ${pulled.map(humanize).join(', ')}.`
      : `Added ${humanize(id)}.`;
}
</script>

<svelte:head>
  <title>smrt planner</title>
</svelte:head>

<main>
  <header>
    <h1>Plan your app</h1>
    <p>
      Pick s-m-r-t packages and an app assembles around them: navigation, list
      views and forms with sample data, and a list of the REST routes, MCP
      tools and CLI commands s-m-r-t generates for each. Your picks live in the
      URL, so you can share the mock-up.
    </p>
  </header>

  <section aria-label="Your selection" class="selection">
    <h2>Your app</h2>
    {#if selection.ids.length === 0}
      <p>Nothing selected yet. Choose a package below.</p>
    {:else}
      <ul class="chips">
        {#each selection.ids as id (id)}
          <li>
            <a href={selection.href(`/packages/${id}/`)}>{humanize(id)}</a>
          </li>
        {/each}
      </ul>
      <button type="button" class="secondary" onclick={() => selection.clear()}>
        Clear selection
      </button>
    {/if}
    <p class="notice" role="status" aria-live="polite">{notice}</p>
  </section>

  <section aria-label="Package catalog">
    <h2>Packages <small>{results.length} of {catalog.packages.length}</small></h2>
    <label class="search">
      <span class="visually-hidden">Search packages</span>
      <input
        type="search"
        placeholder="Search packages, models and fields"
        bind:value={query}
      />
    </label>

    <ul class="cards">
      {#each results as pkg (pkg.id)}
        {@const selected = selection.has(pkg.id)}
        {@const lockedBy = selection.requiredBy(pkg.id)}
        <li class:selected>
          <h3>
            <a href={selection.href(`/packages/${pkg.id}/`)}>{humanize(pkg.id)}</a>
          </h3>
          <p class="description">{pkg.description}</p>
          <p class="meta">
            {exposedModels(pkg).length} models · {surfaceCount(pkg)} generated surfaces
          </p>
          {#if pkg.dependencies.length}
            <p class="meta">
              Needs: {pkg.dependencies.map(humanize).join(', ')}
            </p>
          {/if}
          <label class="toggle">
            <input
              type="checkbox"
              checked={selected}
              disabled={selected && lockedBy.length > 0}
              onchange={() => toggle(pkg.id)}
            />
            {#if selected && lockedBy.length > 0}
              In your app (needed by {lockedBy.map(humanize).join(', ')})
            {:else if selected}
              In your app
            {:else}
              Add to my app
            {/if}
          </label>
        </li>
      {:else}
        <li class="none">No packages match "{query}".</li>
      {/each}
    </ul>
  </section>
</main>

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  header,
  .selection {
    display: grid;
    gap: var(--smrt-spacing-2);
    justify-items: start;
  }

  header p,
  .meta,
  .description,
  small {
    color: var(--smrt-color-on-surface-variant);
  }

  small {
    font-weight: 400;
  }

  .chips,
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chips a {
    display: inline-block;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    border-radius: var(--smrt-radius-large);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    text-decoration: none;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  }

  .cards li {
    display: grid;
    align-content: start;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
  }

  .cards li.selected {
    border-color: var(--smrt-color-primary);
  }

  .cards li.none {
    border: 0;
  }

  .description {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .toggle {
    display: flex;
    gap: var(--smrt-spacing-2);
    align-items: center;
    font-weight: 500;
  }

  .search input {
    width: min(100%, 28rem);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
  }

  button.secondary {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: inherit;
    cursor: pointer;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
