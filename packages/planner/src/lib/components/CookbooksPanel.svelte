<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { onMount } from 'svelte';
import { cookbookStore } from '$lib/cookbook/store.svelte.ts';
import { useDataSource } from '$lib/data/context.ts';
import {
  applyLibraryCookbook,
  holdsCookbook,
  needsConfirm,
} from '$lib/library/apply.ts';
import {
  COOKBOOK_ICONS,
  type LibraryCookbook,
  libraryCookbooks,
  libraryRecipeLabels,
} from '$lib/library/index.ts';
import { previewMenu } from '$lib/library/menu.ts';
import { libraryState } from '$lib/library/state.svelte.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import {
  type AppSettings as Settings,
  settingsOfCookbook,
} from '$lib/settings/app-settings.ts';
import AppSettings from './AppSettings.svelte';

const dataSource = useDataSource();
let selectedId = $state<string | null>(null);
let confirming = $state(false);
let error = $state('');
let notice = $state('');

onMount(() => {
  libraryState.load();
  selectedId = libraryState.active;
});

const selected = $derived(libraryCookbooks.find((c) => c.id === selectedId));

// The preview's editable copy of the cookbook's settings; choosing a cookbook
// (again) resets it to the cookbook's own values. The cookbook is never changed.
let settings = $state<Settings>(settingsOfCookbook(undefined));
$effect(() => {
  settings = settingsOfCookbook(selected?.settings);
});
const isActive = (cookbook: LibraryCookbook) =>
  libraryState.active === cookbook.id &&
  holdsCookbook(cookbook, {
    recipes: recipeState.ids,
    features: recipeState.features,
  });

function use() {
  if (!selected) return;
  if (needsConfirm(cookbookStore)) confirming = true;
  else commit();
}

function commit() {
  confirming = false;
  if (!selected) return;
  const result = applyLibraryCookbook(
    selected,
    cookbookStore,
    $state.snapshot(settings),
  );
  if (result.ok) {
    // Sample records are regenerated from the cookbook's own sample data.
    dataSource.reset?.();
    libraryState.select(selected.id);
    error = '';
    notice = `Now using the ${selected.name} cookbook.`;
  } else {
    error = result.error;
    notice = '';
  }
}
</script>

<div class="cookbooks">
  <p class="meta">
    A cookbook is a ready-made starting point: the recipes, menu and settings a
    kind of business usually needs. Pick one, look it over, then change
    anything in the other tabs.
  </p>

  <ul class="grid" aria-label="Cookbooks">
    {#each libraryCookbooks as cookbook (cookbook.id)}
      {@const active = isActive(cookbook)}
      <li>
        <button
          type="button"
          class="card"
          class:selected={selectedId === cookbook.id}
          aria-pressed={selectedId === cookbook.id}
          onclick={() => (selectedId = cookbook.id)}
        >
          <svg
            class="icon"
            viewBox="0 0 24 24"
            width="32"
            height="32"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            {#each COOKBOOK_ICONS[cookbook.icon] ?? [] as d (d)}
              <path {d} />
            {/each}
          </svg>
          <span class="name">{cookbook.name}</span>
          <span class="summary">{cookbook.summary}</span>
          {#if active}<span class="badge">In use</span>{/if}
        </button>
      </li>
    {/each}
  </ul>

  {#if selected}
    {@const menu = previewMenu(selected.document)}
    <section class="preview" aria-labelledby="preview-heading">
      <h2 id="preview-heading">{selected.name}</h2>
      <div class="block">
        <h3>Recipes</h3>
        <ul class="chips" aria-label="Recipes">
          {#each libraryRecipeLabels(selected) as label (label)}
            <li>{label}</li>
          {/each}
        </ul>
      </div>
      <div class="block">
        <h3>Menu</h3>
        <div class="menu">
          {#each menu as section (section.id)}
            <div>
              <h4>{section.label}</h4>
              <ul>
                {#each section.entries as entry (entry.id)}
                  <li>{entry.label}</li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      </div>
      <div class="block">
        <h3>Settings</h3>
        <AppSettings
          value={settings}
          onchange={(next) => (settings = next)}
          idPrefix="cookbook-settings"
        />
      </div>
      <div class="actions">
        <Button onclick={use}>Use this cookbook</Button>
        <span class="meta">Replaces your current recipes, menu and sample records.</span>
      </div>
    </section>
  {/if}

  {#if error}
    <Alert variant="error" title="Could not use this cookbook">{error}</Alert>
  {/if}
  <p class="notice" role="status" aria-live="polite">{notice}</p>
</div>

<ConfirmDialog
  open={confirming}
  title={selected ? `Use the ${selected.name} cookbook?` : 'Use this cookbook?'}
  message="Replaces your current recipes, menu and sample records."
  confirmLabel="Replace"
  destructive
  onconfirm={commit}
  oncancel={() => (confirming = false)}
/>

<style>
  .cookbooks {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  h2,
  h3,
  h4,
  p {
    margin: 0;
  }

  h3,
  h4 {
    font-size: 1rem;
  }

  .meta,
  .summary,
  .notice {
    color: var(--smrt-color-on-surface-variant);
  }

  .notice:empty {
    display: none;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: var(--smrt-spacing-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .card {
    position: relative;
    display: grid;
    gap: var(--smrt-spacing-2);
    justify-items: start;
    width: 100%;
    height: 100%;
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 0.75rem);
    background: var(--smrt-color-surface);
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .card.selected {
    border-color: var(--smrt-color-primary);
    outline: 2px solid var(--smrt-color-primary);
  }

  .icon {
    color: var(--smrt-color-primary);
  }

  .name {
    font-weight: 600;
  }

  .badge {
    position: absolute;
    top: var(--smrt-spacing-3);
    right: var(--smrt-spacing-3);
    padding: 0 var(--smrt-spacing-2);
    border-radius: 999px;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-size: 0.75rem;
  }

  .preview {
    display: grid;
    gap: var(--smrt-spacing-4);
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 0.75rem);
  }

  .block {
    display: grid;
    gap: var(--smrt-spacing-2);
  }

  .chips,
  .menu ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }

  .chips li {
    padding: 0 var(--smrt-spacing-3);
    border-radius: 999px;
    background: var(--smrt-color-surface-container);
  }

  .menu {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: var(--smrt-spacing-3);
  }

  .menu ul {
    display: grid;
    gap: var(--smrt-spacing-1);
    margin-top: var(--smrt-spacing-1);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-3);
  }
</style>
