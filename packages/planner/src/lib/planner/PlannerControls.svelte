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
import ThemeSection from '../components/ThemeSection.svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { provideDataSource, tryUseDataSource } from '../data/context.ts';
import { createPlannerDataSource } from '../data/planner-source.ts';
import { cookbookNavGroups } from '../library/menu.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { PLANNER_TAB_IDS, type PlannerTabId } from './commands/index.ts';
import { plannerController } from './instance.ts';
import PlannerLifecycle from './PlannerLifecycle.svelte';
import { plannerTab } from './tab.svelte.ts';
import type { PlannerProps } from './types.ts';

/**
 * The planner's customization controls alone (Cookbooks, Recipes, Theme,
 * Settings, Export as tabs), for a host that owns the surrounding shell; the
 * complete `Planner` mounts the same inside its own shell.
 */
interface PlannerControlsProps extends PlannerProps {
  /**
   * `true` when the complete `Planner` renders these: its own lifecycle
   * already configured the controller, persistence and inference, so the
   * controls do not mount a second one.
   */
  managedByParent?: boolean;
}

const DEFAULT_TABS: PlannerTabId[] = [
  'cookbooks',
  'recipes',
  'theme',
  'settings',
  'export',
];
const UNLISTED_TABS: PlannerTabId[] = ['features', 'layout'];

let {
  controller = plannerController,
  basePath,
  inference,
  layout = 'own',
  persistence = 'self',
  themeControls = false,
  advancedStylesHref,
  tabs = DEFAULT_TABS,
  onready,
  managedByParent = false,
}: PlannerControlsProps = $props();

// Generated views and the Cookbooks tab read sample records from a data
// source: use the host's, else make the planner's own.
if (!tryUseDataSource()) provideDataSource(createPlannerDataSource());

// smrt-svelte's inputs read the app state. Inside a host's own provider (or
// the static app's AppShell) use that; otherwise the planner brings one.
const hasAppState = tryGetAppStateContext() !== null;

const labels: Record<PlannerTabId, string> = {
  cookbooks: 'Cookbooks',
  recipes: 'Recipes',
  features: 'Features',
  layout: 'Layout',
  theme: 'Theme',
  settings: 'Settings',
  export: 'Export',
};
const shown = $derived(tabs.filter((id) => PLANNER_TAB_IDS.includes(id)));
// Features and Layout left the default tab strip but stay reachable from
// their links, the command palette and focus commands.
const reachable = $derived<readonly PlannerTabId[]>(
  tabs === DEFAULT_TABS ? [...shown, ...UNLISTED_TABS] : shown,
);
const items = $derived(shown.map((id) => ({ id, label: labels[id] })));
const active = $derived(
  reachable.includes(plannerTab.active)
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
</script>

{#if !managedByParent}
  <PlannerLifecycle {controller} {basePath} {inference} {persistence} {onready} />
{/if}

{#snippet view()}
<div class="planner">
  <Tabs tabs={items} {active} onchange={select} aria-label="Planner">
    {#if reachable.includes('cookbooks')}
      <div hidden={active !== 'cookbooks'}><CookbooksPanel /></div>
    {/if}
    {#if reachable.includes('recipes')}
      <div hidden={active !== 'recipes'}><RecipeCards /></div>
    {/if}
    {#if reachable.includes('features')}
      <div hidden={active !== 'features'}><FeaturesPanel /></div>
    {/if}
    {#if reachable.includes('layout')}
      <div hidden={active !== 'layout'} class="pane">
        <p class="meta">
          Reorder, move or hide navigation entries and choose which panels show.
          The layout is saved with the cookbook.
        </p>
        <ShellLayoutEditor controller={ownLayout ?? shellLayout ?? undefined} />
      </div>
    {/if}
    {#if reachable.includes('theme')}
      <div hidden={active !== 'theme'}><ThemeSection provider={themeControls} {advancedStylesHref} /></div>
    {/if}
    {#if reachable.includes('settings')}
      <div hidden={active !== 'settings'}><SettingsPanel /></div>
    {/if}
    {#if reachable.includes('export')}
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .planner :global(.tab-panel) {
    padding-top: var(--smrt-spacing-4);
  }

  /* The strip persists across configure-page route changes; the panel below
     crossfades with the content. smrt-ui's Tabs owns the classes (`tabs-nav`
     for button tabs, `tabs-links` for link tabs; one strip per Tabs). Named
     only while a transition runs, as in Planner.svelte. */
  :global([data-smrt-view-transition]) .planner :global(.tabs-nav),
  :global([data-smrt-view-transition]) .planner :global(.tabs-links) {
    view-transition-name: planner-tabs;
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
}
</style>
