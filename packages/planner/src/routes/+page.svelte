<script lang="ts">
import { ShellLayoutEditor } from '@happyvertical/smrt-svelte/workspace';
import { Button, Tabs } from '@happyvertical/smrt-ui';
import { aiState } from '$lib/ai/instance.ts';
import AiSetup from '$lib/components/AiSetup.svelte';
import CookbooksPanel from '$lib/components/CookbooksPanel.svelte';
import ExportPanel from '$lib/components/ExportPanel.svelte';
import FeaturesPanel from '$lib/components/FeaturesPanel.svelte';
import RecipeCards from '$lib/components/RecipeCards.svelte';
import SettingsPanel from '$lib/components/SettingsPanel.svelte';
import {
  PLANNER_TABS,
  type PlannerTab,
  plannerTab,
} from '$lib/planner/tab.svelte.ts';

const tabs = [
  { id: 'cookbooks', label: 'Cookbooks' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'features', label: 'Features' },
  { id: 'layout', label: 'Layout' },
  { id: 'settings', label: 'Settings' },
  { id: 'export', label: 'Export' },
];

// All six panels stay mounted (the inactive ones hidden), so switching
// never resets a notice or an editor; the layout keeps the URL in step.
const select = (id: string) => {
  const tab = PLANNER_TABS.find((t) => t === id);
  if (tab) plannerTab.active = tab satisfies PlannerTab;
};
</script>

<svelte:head>
  <title>Planner · smrt planner</title>
</svelte:head>

<main>
  {#if aiState.firstRun}
    <section class="first-run" aria-labelledby="first-run-title">
      <h1 id="first-run-title">Set up your assistant</h1>
      <p class="meta">
        Everything runs on this device. Nothing you type or say leaves the page.
      </p>
      <AiSetup />
      <div class="actions">
        <Button onclick={() => aiState.continueFirstRun()}>
          Continue
        </Button>
        <Button variant="secondary" onclick={() => aiState.dismissFirstRun()}>
          I don't need AI, let's just build
        </Button>
      </div>
    </section>
  {:else}
  <Tabs {tabs} active={plannerTab.active} onchange={select} aria-label="Planner">
    <div hidden={plannerTab.active !== 'cookbooks'}><CookbooksPanel /></div>
    <div hidden={plannerTab.active !== 'recipes'}><RecipeCards /></div>
    <div hidden={plannerTab.active !== 'features'}><FeaturesPanel /></div>
    <div hidden={plannerTab.active !== 'layout'} class="pane">
      <p class="meta">
        Reorder, move or hide navigation entries and choose which panels show.
        The layout is saved with the cookbook.
      </p>
      <ShellLayoutEditor />
    </div>
    <div hidden={plannerTab.active !== 'settings'}><SettingsPanel /></div>
    <div hidden={plannerTab.active !== 'export'}><ExportPanel /></div>
  </Tabs>
  {/if}
</main>

<style>
  main {
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  main :global(.tab-panel) {
    padding-top: var(--smrt-spacing-4);
  }

  .first-run {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .first-run h1,
  .first-run p {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
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
