<script lang="ts">
import { Switch } from '@happyvertical/smrt-ui/forms';
import { flip } from 'svelte/animate';
import {
  catalog,
  exposedModels,
  searchPackages,
  surfaceCount,
} from '$lib/catalog/index.ts';
import { humanize } from '$lib/data/format.ts';
import { motionDuration } from '$lib/motion/tokens.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
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
  <title>All packages · smrt planner</title>
</svelte:head>

<main>
  <header>
    <p class="smrt-packages-page__meta" data-smrt-part="meta"><a href={appHref('/')}>Planner</a> / All packages</p>
    <h1>All packages</h1>
    <p>
      The whole catalog, a package at a time. Recipes on the Planner page are
      the smaller way in: they add one section of an app, not every model in a
      package. Your picks live in the URL, so you can share the mock-up.
    </p>
  </header>

  <section aria-label="Your selection" class="smrt-packages-page__selection" data-smrt-part="summary">
    <h2>Your app</h2>
    {#if selection.ids.length === 0}
      <p>Nothing selected yet. Choose a package below.</p>
    {:else}
      <ul class="smrt-packages-page__chips" data-smrt-part="list">
        {#each selection.ids as id (id)}
          <li>
            <a href={appHref(`/packages/${id}/`)}>{humanize(id)}</a>
          </li>
        {/each}
      </ul>
      <button type="button" class="smrt-packages-page__secondary" onclick={() => selection.clear()} data-smrt-part="action">
        Clear selection
      </button>
    {/if}
    <p class="smrt-packages-page__notice" role="status" aria-live="polite" data-smrt-part="status">{notice}</p>
  </section>

  <section aria-label="Package catalog">
    <h2>Packages <small>{results.length} of {catalog.packages.length}</small></h2>
    <label class="smrt-packages-page__search" data-smrt-part="search">
      <span class="smrt-packages-page__visually-hidden" data-smrt-part="label">Search packages</span>
      <input
        type="search"
        placeholder="Search packages, models and fields"
        bind:value={query}
      />
    </label>

    <ul class="smrt-packages-page__cards" data-smrt-part="list">
      {#each results as pkg (pkg.id)}
        {@const selected = selection.has(pkg.id)}
        {@const lockedBy = selection.requiredBy(pkg.id)}
        <li class:smrt-packages-page__selected={selected} animate:flip={{ duration: motionDuration('medium2', 300) }} data-smrt-part="item">
          <h3>
            <a href={appHref(`/packages/${pkg.id}/`)}>{humanize(pkg.id)}</a>
          </h3>
          <p class="smrt-packages-page__description" data-smrt-part="description">{pkg.description}</p>
          <p class="smrt-packages-page__meta" data-smrt-part="meta">
            {#if exposedModels(pkg).length}
              {exposedModels(pkg).length} models · {surfaceCount(pkg)} generated surfaces
            {:else}
              {pkg.models.length} internal models · closed: no generated surfaces
            {/if}
          </p>
          {#if pkg.dependencies.length}
            <p class="smrt-packages-page__meta" data-smrt-part="meta">
              Needs: {pkg.dependencies.map(humanize).join(', ')}
            </p>
          {/if}
          <Switch
            checked={selected}
            disabled={selected && lockedBy.length > 0}
            onchange={() => toggle(pkg.id)}
            aria-label={`Include ${humanize(pkg.id)} in my app`}
            label={selected && lockedBy.length > 0
              ? `In your app (needed by ${lockedBy.map(humanize).join(', ')})`
              : selected
                ? 'In your app'
                : 'Add to my app'}
          />
        </li>
      {:else}
        <li class="smrt-packages-page__none" data-smrt-part="empty">No packages match "{query}".</li>
      {/each}
    </ul>
  </section>
</main>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
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
  .smrt-packages-page__selection {
    display: grid;
    gap: var(--smrt-spacing-2);
    justify-items: start;
  }
  .smrt-packages-page__chips,
  .smrt-packages-page__cards {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .smrt-packages-page__chips a {
    display: inline-block;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
  }
  .smrt-packages-page__cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  }
  .smrt-packages-page__cards li {
    display: grid;
    align-content: start;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-4);
  }
  .smrt-packages-page__description {
    display: -webkit-box;
    overflow: hidden;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .smrt-packages-page__search input {
    width: min(100%, 28rem);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
  button.smrt-packages-page__secondary {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    cursor: pointer;
  }
  .smrt-packages-page__visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
}

@layer smrt.theme {
  header p,
  .smrt-packages-page__meta,
  .smrt-packages-page__description,
  small {
    color: var(--smrt-color-on-surface-variant);
  }
  small {
    font-weight: 400;
  }
  .smrt-packages-page__chips a {
    border-radius: var(--smrt-radius-large);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    text-decoration: none;
  }
  .smrt-packages-page__cards li {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large);
  }
  .smrt-packages-page__cards li.smrt-packages-page__selected {
    border-color: var(--smrt-color-primary);
  }
  .smrt-packages-page__cards li.smrt-packages-page__none {
    border: 0;
  }
  .smrt-packages-page__search input {
    border: var(--smrt-control-border);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-surface-control);
    color: var(--smrt-color-on-surface);
    font: inherit;
  }
  button.smrt-packages-page__secondary {
    border: var(--smrt-control-border);
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: inherit;
  }
}

</style>
