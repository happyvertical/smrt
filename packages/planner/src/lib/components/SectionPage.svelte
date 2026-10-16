<script lang="ts">
// The static app's section route: the shared `SectionView` plus what only the
// static app has pages for (the Help and Options icons, which open
// `/recipes/<id>/`) and the New buttons (which ask the entry page to open its
// create form through `planner/create.ts`).
import {
  type ShellSectionMenuEntry,
  useShellLayout,
} from '@happyvertical/smrt-svelte/workspace';
import { page } from '$app/state';
import { navNoun } from '../data/format.ts';
import { requestCreate } from '../planner/create.ts';
import { recipesById } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { entryIndex, optionGroups } from '../sections/entries.ts';
import { sectionTitle } from '../sections/info.ts';
import SectionActions from './SectionActions.svelte';
import SectionIcons from './SectionIcons.svelte';
import SectionView from './SectionView.svelte';

interface SectionPageProps {
  /** The layout id: `section:<id>`, `custom:<id>` or `package:<id>`. */
  sectionId: string;
}

let { sectionId }: SectionPageProps = $props();

const shell = useShellLayout();
const title = $derived(
  sectionTitle(shell.sections.find((s) => s.id === sectionId)?.heading),
);

const added = $derived(
  recipeState.ids.flatMap((id) => {
    const recipe = recipesById.get(id);
    return recipe ? [recipe] : [];
  }),
);
const index = $derived(entryIndex(added, recipeState.features));

const newNoun = (entry: ShellSectionMenuEntry) => {
  const target = index.get(entry.id);
  return target ? navNoun(entry.label, target.noun) : undefined;
};

function startNew(entry: ShellSectionMenuEntry) {
  requestCreate(new URL(entry.href, page.url).pathname);
}
</script>

<svelte:head>
  <title>{title} · smrt planner</title>
</svelte:head>

{#snippet headerActions({ title: heading, itemIds }: { title: string; itemIds: readonly string[] })}
  {@const groups = optionGroups(itemIds, added)}
  {#if groups.length === 1}
    <SectionIcons section={groups[0].id} label={groups[0].label} />
  {:else if groups.length > 1}
    <SectionActions label={heading} {groups} />
  {/if}
{/snippet}

{#snippet menuActions(entry: ShellSectionMenuEntry)}
  {@const noun = newNoun(entry)}
  {#if noun}
    <a class="new" href={entry.href} onclick={() => startNew(entry)}>New {noun}</a>
  {/if}
{/snippet}

<SectionView {sectionId} {headerActions} {menuActions} />

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .new {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full, 999px);
    color: var(--smrt-color-primary);
    text-decoration: none;
    white-space: nowrap;
  }

  .new:hover,
  .new:focus-visible {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }
}
</style>
