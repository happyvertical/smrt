<script lang="ts">
// Material Design Icons "storage" (Apache-2.0,
// https://github.com/google/material-design-icons); smrt-ui's Icon fills its path.
import { Icon } from '@happyvertical/smrt-ui';
import {
  SearchInput,
  Switch,
  ToggleButton,
} from '@happyvertical/smrt-ui/forms';
import { catalog } from '../catalog/index.ts';
import { humanize } from '../data/format.ts';
import { appHref } from '../planner/app.svelte.ts';
import {
  type FeatureEntry,
  featureEntries,
  featurePackages,
  featureSummary,
  filterFeatures,
  visibleFeatures,
} from '../recipes/features.ts';
import { recipes } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';

const DATABASE =
  'M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.59 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm6 14c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-4.55c-1.3.95-3.58 1.55-6 1.55s-4.7-.6-6-1.55V9.64c1.47.83 3.61 1.36 6 1.36s4.53-.53 6-1.36v2.81zM12 9C8.13 9 6 7.5 6 7s2.13-2 6-2 6 1.5 6 2-2.13 2-6 2z';

const all = featureEntries(catalog, recipes);

let query = $state('');
let packageId = $state<string | null>(null);
let showAll = $state(false);
let notice = $state('');

// Chips offer only packages that have a result for the current search.
const pool = $derived(visibleFeatures(all, showAll));
const chips = $derived(featurePackages(filterFeatures(pool, query)));
const active = $derived(
  packageId && chips.includes(packageId) ? packageId : null,
);
const results = $derived(filterFeatures(pool, query, active));
// Plumbing the current search and package filter would match, now hidden.
const hidden = $derived(
  showAll ? 0 : filterFeatures(all, query, active).length - results.length,
);

// Switching never navigates: the feature joins the menu whenever the visitor
// likes, and the status line announces what changed.
function toggle(entry: FeatureEntry, on: boolean) {
  if (on) recipeState.addFeature(entry.id);
  else recipeState.removeFeature(entry.id);
  notice = on
    ? `Added ${entry.label} to the menu.`
    : `Removed ${entry.label} from the menu.`;
}
</script>

<div class="features">
  <p class="meta">
    Models no recipe covers. Add one to give it a list and a form of its own
    under More in the menu.
  </p>

  <SearchInput
    value={query}
    onsearch={(next) => {
      query = next;
    }}
    label="Search features"
    placeholder="Search models, packages and fields"
    debounceMs={0}
  />

  {#if chips.length > 1}
    <div class="chips" role="group" aria-label="Filter by package">
      <ToggleButton pressed={active === null} onclick={() => (packageId = null)}>
        All
      </ToggleButton>
      {#each chips as id (id)}
        <ToggleButton
          pressed={active === id}
          onclick={() => (packageId = active === id ? null : id)}
        >
          {humanize(id)}
        </ToggleButton>
      {/each}
    </div>
  {/if}

  <div class="bar">
    <h2 class="count">
      {results.length} {results.length === 1 ? 'feature' : 'features'}{hidden
        ? ` (${hidden} hidden)`
        : ''}
    </h2>
    <Switch
      checked={showAll}
      label="Show all"
      onchange={(event) => {
        showAll = event.currentTarget.checked;
      }}
    />
  </div>

  {#if results.length}
    <ul class="rows" aria-label="Features">
      {#each results as entry (entry.id)}
        {@const on = recipeState.hasFeature(entry.id)}
        <li class:selected={on}>
          <span class="icon" aria-hidden="true"><Icon path={DATABASE} size={22} /></span>
          <div class="text">
            <span class="name">
              <a href={appHref(`/packages/${entry.packageId}/`)}>{entry.label}</a>
              {#if entry.plumbing}<span class="tag">plumbing</span>{/if}
            </span>
            <span class="meta">{featureSummary(entry)}</span>
            {#if entry.includes.length}
              <span class="includes">+ {entry.includes.join(', ')}</span>
            {/if}
          </div>
          <Switch
            checked={on}
            aria-label={`${on ? 'Remove' : 'Add'} ${entry.label} feature`}
            onchange={(event) => toggle(entry, event.currentTarget.checked)}
          />
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No features match "{query}".</p>
  {/if}
  <p class="notice" role="status" aria-live="polite">{notice}</p>
</div>

<style>
  .features {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  h2,
  p {
    margin: 0;
  }

  .meta,
  .notice,
  .empty,
  .count {
    color: var(--smrt-color-on-surface-variant);
  }

  .count {
    font-size: var(--smrt-font-size-body-medium, 0.875rem);
    font-weight: 400;
  }

  .notice:empty {
    display: none;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }

  .rows {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
    overflow: hidden;
  }

  .rows li {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
  }

  .rows li + li {
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .rows li.selected {
    background: var(--smrt-color-surface-container);
  }

  .includes {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-font-size-body-small, 0.75rem);
  }

  .icon {
    display: inline-flex;
    color: var(--smrt-color-on-surface-variant);
  }

  .text {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
  }

  .name {
    display: flex;
    align-items: baseline;
    gap: var(--smrt-spacing-2);
  }

  .tag {
    padding: 0 var(--smrt-spacing-2);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-font-size-label-small, 0.6875rem);
  }

  .text a {
    width: fit-content;
    color: var(--smrt-color-on-surface);
    font-weight: 500;
  }

  .text .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
