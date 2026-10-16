<script lang="ts">
// A navigation section's page body for the static app's section route
// (`SectionPage.svelte`, which adds the Help/Options icons and the New
// buttons). The static app's shell is a plain `AppShell`, not `CookbookApp`,
// so it cannot use the framework's `CookbookSectionPage` (the mounted
// `Planner` does, with the same `SectionHeading`). It needs no `$app`
// import: the shell's layout context gives it the section, the cookbook store
// its overview and the data source its counts.
//
// The page is an editable overview (smrt#3727): by default the entries as
// shortcut cards (with record counts), then the section's lead model as a
// count and its latest records, drawn as plain page sections. In the shell's
// layout edit mode the widgets get the overview chrome (add, move, resize,
// configure, remove, reset) and the entries are listed below with grips,
// rename and hide controls. A section id no overview can have shows the menu.
import { tryGetCookbookContext } from '@happyvertical/smrt-svelte/cookbook';
import {
  ShellSectionMenu,
  type ShellSectionMenuEntry,
  useShellLayout,
} from '@happyvertical/smrt-svelte/workspace';
import type { Snippet } from 'svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import { recordCount } from '../data/format.ts';
import { sectionOverview } from '../overviews/definitions.ts';
import { overviewModelChoices } from '../overviews/models.ts';
import { appHref } from '../planner/app.svelte.ts';
import { recipesById } from '../recipes/index.ts';
import { inScope } from '../recipes/scope.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { entryIndex } from '../sections/entries.ts';
import {
  DEFAULT_SECTION_ICON,
  sectionInfo,
  sectionTitle,
} from '../sections/info.ts';
import SectionHeading from './SectionHeading.svelte';
import SectionOverview from './SectionOverview.svelte';

interface SectionViewProps {
  /** The layout id: `section:<id>`, `custom:<id>` or `package:<id>`. */
  sectionId: string;
  /** An in-app path with the app query; the planner's `appHref` by default. */
  href?: (path: string) => string;
  /** Controls after the heading (the standalone page's Help and Options icons). */
  headerActions?: Snippet<[{ title: string; itemIds: readonly string[] }]>;
  /** Per-entry controls on the menu cards a section without an overview shows. */
  menuActions?: Snippet<[ShellSectionMenuEntry]>;
}

let {
  sectionId,
  href = appHref,
  headerActions,
  menuActions,
}: SectionViewProps = $props();

const shell = useShellLayout();
const source = useDataSource();
// Under a `CookbookApp` the shell's own suggestion (label, icon, description)
// is the fallback; the static app has none and reads the planner's data.
const cookbook = tryGetCookbookContext();

const section = $derived(shell.sections.find((s) => s.id === sectionId));
const suggested = $derived(
  cookbook?.shell.sections.find((s) => s.id === sectionId),
);
const title = $derived(sectionTitle(section?.heading || suggested?.label));
const icon = $derived(section?.icon ?? suggested?.icon ?? DEFAULT_SECTION_ICON);
const description = $derived(
  sectionInfo(sectionId).description ?? suggested?.description,
);
const itemIds = $derived(section?.items.map((entry) => entry.id) ?? []);

const added = $derived(
  recipeState.ids.flatMap((id) => {
    const recipe = recipesById.get(id);
    return recipe ? [recipe] : [];
  }),
);
const index = $derived(entryIndex(added, recipeState.features));
const overview = $derived(sectionOverview(sectionId));
// The option editor offers the app's models: the added recipes' and features'.
const models = $derived(overviewModelChoices(added, index));

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
</script>

{#snippet meta(entry: ShellSectionMenuEntry)}
  {#if counts.has(entry.id)}{recordCount(counts.get(entry.id) ?? 0)}{/if}
{/snippet}

{#if cookbookStore.loaded}
  <main class="section-view">
    {#if section}
      <SectionHeading {icon} {title} {description}>
        {#snippet actions()}{@render headerActions?.({ title, itemIds })}{/snippet}
      </SectionHeading>
      {#if overview}
        {#key sectionId}
          <SectionOverview
            definition={overview}
            entries={index}
            {models}
            {href}
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
        <ShellSectionMenu {sectionId} layout="cards" {meta} actions={menuActions} />
      {/if}
    {:else}
      <h1>Section not found</h1>
      <p>This section is not in your app. <a href={href('/')}>Back to the Planner</a></p>
    {/if}
  </main>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  main {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 64rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  .entries {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  .entries h2 {
    margin: 0;
    font: var(--smrt-typography-title-medium-font);
    letter-spacing: var(--smrt-typography-title-medium-tracking);
  }
}
</style>
