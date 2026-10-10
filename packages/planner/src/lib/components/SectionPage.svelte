<script lang="ts">
// A navigation section's own page. The sidebar lists only sections, so this is
// where a section's entries are. The page is an editable overview (smrt#3727):
// by default the entries as shortcut cards (with record counts), then the
// section's lead model as a count and its latest records. In the shell's
// layout edit mode the widgets get the overview chrome (add, move, resize,
// configure, remove, reset) and the entries are listed below with grips,
// rename and hide controls. A section id no overview can have shows the menu.
import {
  ShellSectionIcon,
  ShellSectionMenu,
  type ShellSectionMenuEntry,
  useShellLayout,
} from '@happyvertical/smrt-svelte/workspace';
import { page } from '$app/state';
import SectionActions from '$lib/components/SectionActions.svelte';
import SectionIcons from '$lib/components/SectionIcons.svelte';
import SectionOverview from '$lib/components/SectionOverview.svelte';
import { cookbookStore } from '$lib/cookbook/store.svelte.ts';
import { useDataSource } from '$lib/data/context.ts';
import { humanize, navNoun, pluralize, recordCount } from '$lib/data/format.ts';
import { sectionOverview } from '$lib/overviews/definitions.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import { requestCreate } from '$lib/planner/create.ts';
import { recipeModels, recipesById } from '$lib/recipes/index.ts';
import { inScope } from '$lib/recipes/scope.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import { entryIndex, optionGroups } from '$lib/sections/entries.ts';
import {
  DEFAULT_SECTION_ICON,
  sectionInfo,
  sectionTitle,
} from '$lib/sections/info.ts';

interface SectionPageProps {
  /** The layout id: `section:<id>`, `custom:<id>` or `package:<id>`. */
  sectionId: string;
}

let { sectionId }: SectionPageProps = $props();

const shell = useShellLayout();
const source = useDataSource();

const section = $derived(shell.sections.find((s) => s.id === sectionId));
const title = $derived(sectionTitle(section?.heading));
const icon = $derived(section?.icon ?? DEFAULT_SECTION_ICON);
const description = $derived(sectionInfo(sectionId).description);
const itemIds = $derived(section?.items.map((entry) => entry.id) ?? []);

const added = $derived(
  recipeState.ids.flatMap((id) => {
    const recipe = recipesById.get(id);
    return recipe ? [recipe] : [];
  }),
);
const index = $derived(entryIndex(added, recipeState.features));
const groups = $derived(optionGroups(itemIds, added));
const overview = $derived(sectionOverview(sectionId));
// The option editor offers the app's models: the added recipes' and features'.
const models = $derived.by(() => {
  const ids = new Set<string>();
  const choices: { value: string; label: string }[] = [];
  const offer = (id: string, name: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    choices.push({ value: id, label: pluralize(humanize(name)) });
  };
  for (const recipe of added) {
    for (const { model } of recipeModels(recipe)) offer(model.id, model.name);
  }
  for (const entry of index.values()) offer(entry.model.id, entry.model.name);
  return choices;
});

let counts = $state(new Map<string, number>());
let generation = 0;

async function loadCounts() {
  const run = ++generation;
  const next = new Map<string, number>();
  await Promise.all(
    itemIds.map(async (id) => {
      const entry = index.get(id);
      if (!entry) return;
      const rows = await source.list(entry.model);
      next.set(id, rows.filter((row) => inScope(entry.scope, row)).length);
    }),
  );
  // A newer run (the section or the data changed meanwhile) wins.
  if (run === generation) counts = next;
}

$effect(() => {
  void itemIds;
  void index;
  void loadCounts();
});
// A reset (a cookbook applied, the app reset) swaps the rows underneath.
$effect(() => source.onReset?.(() => void loadCounts()));

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

{#snippet meta(entry: ShellSectionMenuEntry)}
  {#if counts.has(entry.id)}{recordCount(counts.get(entry.id) ?? 0)}{/if}
{/snippet}

{#snippet actions(entry: ShellSectionMenuEntry)}
  {@const noun = newNoun(entry)}
  {#if noun}
    <a class="new" href={entry.href} onclick={() => startNew(entry)}>New {noun}</a>
  {/if}
{/snippet}

{#if cookbookStore.loaded}
  <main>
    {#if section}
      <header>
        <span class="mark"><ShellSectionIcon name={icon} size={28} /></span>
        <div class="heading">
          <h1>{title}</h1>
          {#if description}<p>{description}</p>{/if}
        </div>
        {#if groups.length === 1}
          <SectionIcons section={groups[0].id} label={groups[0].label} />
        {:else if groups.length > 1}
          <SectionActions label={title} {groups} />
        {/if}
      </header>
      {#if overview}
        {#key sectionId}
          <SectionOverview
            definition={overview}
            entries={index}
            {models}
            label={`${title} overview`}
          />
        {/key}
        {#if shell.editing}
          <section class="entries" aria-labelledby="section-entries">
            <h2 id="section-entries">Menu entries</h2>
            <ShellSectionMenu {sectionId} {meta} />
          </section>
        {/if}
      {:else}
        <ShellSectionMenu {sectionId} layout="cards" {meta} {actions} />
      {/if}
    {:else}
      <h1>Section not found</h1>
      <p>This section is not in your app. <a href={appHref('/')}>Back to the Planner</a></p>
    {/if}
  </main>
{/if}

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 64rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4);
  }

  .mark {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    inline-size: 3rem;
    block-size: 3rem;
    border-radius: var(--smrt-radius-large, 0.75rem);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .heading {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  h1 {
    margin: 0;
  }

  .heading p {
    margin: var(--smrt-spacing-1) 0 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .entries {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  .entries h2 {
    margin: 0;
    font-size: 1rem;
  }

  .new {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full, 999px);
    color: var(--smrt-color-primary);
    text-decoration: none;
    white-space: nowrap;
  }

  .new:hover,
  .new:focus-visible {
    background: var(--smrt-color-surface-container-high);
  }
</style>
