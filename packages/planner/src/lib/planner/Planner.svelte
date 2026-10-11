<script lang="ts">
import { Provider, tryGetAppStateContext } from '@happyvertical/smrt-svelte';
import {
  ShellLayoutController,
  ShellLayoutEditor,
  useShellLayout,
} from '@happyvertical/smrt-svelte/workspace';
import { Tabs } from '@happyvertical/smrt-ui';
import { onMount, untrack } from 'svelte';
import CookbooksPanel from '../components/CookbooksPanel.svelte';
import ExportPanel from '../components/ExportPanel.svelte';
import FeaturesPanel from '../components/FeaturesPanel.svelte';
import RecipeCards from '../components/RecipeCards.svelte';
import SettingsPanel from '../components/SettingsPanel.svelte';
import { browserStorage } from '../cookbook/storage.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { provideDataSource, tryUseDataSource } from '../data/context.ts';
import { createPlannerDataSource } from '../data/planner-source.ts';
import { cookbookNavGroups } from '../library/menu.ts';
import { libraryState } from '../library/state.svelte.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { setBasePath } from './app.svelte.ts';
import { createPlannerAssistant } from './assistant.ts';
import { PLANNER_TAB_IDS, type PlannerTabId } from './commands/index.ts';
import { plannerController, plannerRuntime } from './instance.ts';
import { plannerTab } from './tab.svelte.ts';
import type { PlannerProps } from './types.ts';

let {
  controller = plannerController,
  basePath,
  inference,
  layout = 'own',
  persistence = 'self',
  themeControls = false,
  tabs = PLANNER_TAB_IDS,
  onready,
}: PlannerProps = $props();

// Links to planner pages carry the base; set before anything renders them.
$effect.pre(() => {
  if (basePath !== undefined) setBasePath(basePath);
});

// Generated views and the Cookbooks tab read sample records from a data
// source: use the host's, else make the planner's own.
const dataSource =
  tryUseDataSource() ?? provideDataSource(createPlannerDataSource());

// smrt-svelte's inputs read the app state. Inside a host's own provider (or
// the static app's AppShell) use that; otherwise the planner brings one.
const hasAppState = tryGetAppStateContext() !== null;

const labels: Record<PlannerTabId, string> = {
  cookbooks: 'Cookbooks',
  recipes: 'Recipes',
  features: 'Features',
  layout: 'Layout',
  settings: 'Settings',
  export: 'Export',
};
const shown = $derived(tabs.filter((id) => PLANNER_TAB_IDS.includes(id)));
const items = $derived(shown.map((id) => ({ id, label: labels[id] })));
const active = $derived(
  shown.includes(plannerTab.active)
    ? plannerTab.active
    : (shown[0] ?? 'recipes'),
);

// The headless layout controller: the menu the cookbook generates, edited
// through the cookbook store, with no AppShell around.
// Fixed at mount: the two editors are different objects.
const layoutMode = untrack(() => layout);
const ownLayout =
  layoutMode === 'own'
    ? new ShellLayoutController({
        nav: () => [],
        groups: () =>
          cookbookNavGroups({
            recipes: recipeState.ids,
            features: recipeState.features,
          }),
        panels: () => undefined,
        layout: () => cookbookStore.layout,
        editable: () => true,
        commit: (next) => cookbookStore.setLayout(next),
      })
    : null;
const shellLayout = layoutMode === 'shell' ? useShellLayout() : null;

const select = (id: string) => {
  const tab = PLANNER_TAB_IDS.find((t) => t === id);
  if (tab) plannerTab.active = tab;
};

// The controller's focus -> the tab on screen, and back, each only on a
// difference, so a foreign controller and the app's own both stay in step.
onMount(() => {
  const stop = controller.subscribe((snapshot) => {
    const tab = snapshot.focus.tab;
    if (tab && tab !== plannerTab.active) plannerTab.active = tab;
  });
  return stop;
});
$effect(() => {
  const tab = plannerTab.active;
  untrack(() => {
    if (controller.snapshot().focus.tab !== tab) {
      controller.run({ name: 'focus', input: { tab } });
    }
  });
});

// A library cookbook applied by a command regenerates the sample records.
onMount(() => {
  const previous = plannerRuntime.onReplaced;
  plannerRuntime.onReplaced = () => dataSource.reset?.();
  return () => {
    plannerRuntime.onReplaced = previous;
  };
});

// Saved in this browser, unless the host looks after it.
onMount(() => {
  if (persistence !== 'self') return;
  if (!cookbookStore.loaded) {
    libraryState.load();
    cookbookStore.hydrate('', browserStorage());
  }
});
$effect(() => {
  if (persistence !== 'self') return;
  // Reading it all (layout is deep) subscribes the effect to every part.
  void JSON.stringify(cookbookStore.snapshot());
  cookbookStore.scheduleSave();
});

onMount(() => {
  const assistant = inference
    ? createPlannerAssistant(controller, inference)
    : undefined;
  onready?.({ controller, ...(assistant ? { assistant } : {}) });
});
</script>

<svelte:window onpagehide={() => persistence === 'self' && cookbookStore.flush()} />

{#snippet view()}
<div class="planner">
  <Tabs tabs={items} {active} onchange={select} aria-label="Planner">
    {#if shown.includes('cookbooks')}
      <div hidden={active !== 'cookbooks'}><CookbooksPanel /></div>
    {/if}
    {#if shown.includes('recipes')}
      <div hidden={active !== 'recipes'}><RecipeCards /></div>
    {/if}
    {#if shown.includes('features')}
      <div hidden={active !== 'features'}><FeaturesPanel /></div>
    {/if}
    {#if shown.includes('layout')}
      <div hidden={active !== 'layout'} class="pane">
        <p class="meta">
          Reorder, move or hide navigation entries and choose which panels show.
          The layout is saved with the cookbook.
        </p>
        <ShellLayoutEditor controller={ownLayout ?? shellLayout ?? undefined} />
      </div>
    {/if}
    {#if shown.includes('settings')}
      <div hidden={active !== 'settings'}><SettingsPanel {themeControls} /></div>
    {/if}
    {#if shown.includes('export')}
      <div hidden={active !== 'export'}><ExportPanel /></div>
    {/if}
  </Tabs>
</div>
{/snippet}

{#if hasAppState}
  {@render view()}
{:else}
  <Provider>{@render view()}</Provider>
{/if}

<style>
  .planner :global(.tab-panel) {
    padding-top: var(--smrt-spacing-4);
  }

  .pane {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  /* `display: grid` would otherwise override the inactive pane's `hidden`. */
  .pane[hidden] {
    display: none;
  }

  .meta {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }
</style>
