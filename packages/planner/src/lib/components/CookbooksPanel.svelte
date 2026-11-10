<script lang="ts">
import { tryUseAdminShell } from '@happyvertical/smrt-svelte/workspace';
import { Button } from '@happyvertical/smrt-ui';
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { onMount, tick } from 'svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import {
  applyLibraryCookbook,
  holdsCookbook,
  needsConfirm,
} from '../library/apply.ts';
import {
  COOKBOOK_ICONS,
  type LibraryCookbook,
  libraryCookbooks,
  libraryRecipeLabels,
} from '../library/index.ts';
import { previewMenu } from '../library/menu.ts';
import { libraryState } from '../library/state.svelte.ts';
import { cookbookView } from '../library/view.svelte.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import {
  type AppSettings as Settings,
  settingsOfCookbook,
} from '../settings/app-settings.ts';
import AppSettings from './AppSettings.svelte';

const dataSource = useDataSource();
const shell = tryUseAdminShell();
let confirming = $state(false);
let error = $state('');
let notice = $state('');

onMount(() => {
  libraryState.load();
});

// The grid, or one cookbook's detail in its place (`cookbookView`; the host
// keeps it in the address, so Back returns to the grid).
const selected = $derived(
  libraryCookbooks.find((c) => c.id === cookbookView.open),
);

// Focus follows the swap: the detail's heading on the way in, the card the
// visitor came from on the way out, each scrolled into view. Not on the first
// render, so a link that opens a cookbook does not take focus from the page.
let grid = $state<HTMLElement | null>(null);
let detailHeading = $state<HTMLElement | null>(null);
let shownId: string | null | undefined;
$effect(() => {
  const id = selected?.id ?? null;
  const first = shownId === undefined;
  const changed = shownId !== id;
  shownId = id;
  if (first || !changed) return;
  void tick().then(() => {
    if (id) {
      detailHeading?.scrollIntoView({ block: 'nearest' });
      detailHeading?.focus({ preventScroll: true });
      return;
    }
    const card = grid?.querySelector<HTMLElement>(
      `[data-cookbook="${cookbookView.returnTo ?? ''}"]`,
    );
    card?.scrollIntoView({ block: 'nearest' });
    card?.focus({ preventScroll: true });
  });
});

function open(cookbook: LibraryCookbook) {
  notice = '';
  error = '';
  cookbookView.show(cookbook.id);
}

function back() {
  cookbookView.back();
}

// Escape leaves the detail, unless a dialog or a control is using it.
function onDetailKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || confirming) return;
  event.preventDefault();
  back();
}

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
    error = '';
    const count = previewMenu(selected.document).length;
    notice = `${selected.name} added ${count} menu sections. Explore them in the left sidebar.`;
    shell?.setPanelState('left', 'expanded');
  } else {
    error = result.error;
    notice = '';
  }
}
</script>

<div class="cookbooks">
  {#if notice}
    <Alert variant="success" title="Cookbook applied">{notice}</Alert>
  {/if}
  <p class="meta">
    A cookbook is a ready-made starting point: the recipes, menu and settings a
    kind of business usually needs. Pick one, look it over, then change
    anything in the other tabs.
  </p>

  <div class="swap">
  {#if !selected}
  <ul class="grid" aria-label="Cookbooks" bind:this={grid}>
    {#each libraryCookbooks as cookbook (cookbook.id)}
      {@const active = isActive(cookbook)}
      <li>
        <button
          type="button"
          class="card"
          data-cookbook={cookbook.id}
          onclick={() => open(cookbook)}
        >
          <span class="heading">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              width="28"
              height="28"
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
          </span>
          <span class="summary">{cookbook.summary}</span>
          {#if active}<span class="badge">In use</span>{/if}
        </button>
      </li>
    {/each}
  </ul>

  {:else}
    {@const menu = previewMenu(selected.document)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section
      class="preview"
      aria-labelledby="preview-heading"
      data-cookbook-detail={selected.id}
      onkeydown={onDetailKeydown}
    >
      <div class="back">
        <Button variant="ghost" onclick={back}>
          <span aria-hidden="true">←</span> Back to cookbooks
        </Button>
      </div>
      <h2 id="preview-heading" tabindex="-1" bind:this={detailHeading}>{selected.name}</h2>
      <p class="summary">{selected.summary}</p>
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
  </div>

  {#if error}
    <Alert variant="error" title="Could not use this cookbook">{error}</Alert>
  {/if}
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
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
    font: var(--smrt-typography-title-medium-font); letter-spacing: var(--smrt-typography-title-medium-tracking);
  }

  .meta,
  .summary {
    color: var(--smrt-color-on-surface-variant);
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
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-lg, 0.75rem);
    background: var(--smrt-surface-panel);
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .card:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }

  .icon {
    flex: 0 0 auto;
    color: var(--smrt-color-primary);
  }

  .heading {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    padding-inline-end: 4rem;
  }

  .name {
    font-weight: var(--smrt-typography-weight-semibold);
  }

  .badge {
    position: absolute;
    top: var(--smrt-spacing-3);
    right: var(--smrt-spacing-3);
    padding: 0 var(--smrt-spacing-2);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-size: 0.75rem;
  }

  .preview {
    display: grid;
    gap: var(--smrt-spacing-4);
    padding: var(--smrt-spacing-4);
    border: var(--smrt-hairline);
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
    border-radius: var(--smrt-radius-full);
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

  .back {
    justify-self: start;
    margin-inline-start: calc(-1 * var(--smrt-spacing-2));
  }

  .preview h2:focus {
    outline: none;
  }

  .preview h2:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }

  /* The grid and the detail swap in one place: while a view transition runs
     (`runViewTransition` marks the root) they share a name, so the swap is a
     short crossfade there rather than the whole page's. Reduced motion skips
     the transition outright. */
  :global([data-smrt-view-transition]) .swap {
    view-transition-name: planner-cookbooks;
  }

  :global(::view-transition-group(planner-cookbooks)),
  :global(::view-transition-old(planner-cookbooks)),
  :global(::view-transition-new(planner-cookbooks)) {
    animation-duration: var(--smrt-duration-short4);
    animation-timing-function: var(--smrt-easing-standard);
  }
}
</style>
