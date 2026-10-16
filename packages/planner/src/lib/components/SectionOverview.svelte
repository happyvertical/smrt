<script lang="ts">
// A section page's editable overview (smrt#3727): smrt-svelte's OverviewGrid
// over the section's definition. The cookbook owns the override (the
// controller reads `cookbookStore.overview(id)` and writes each edit back), so
// a customised page is saved, exported and imported with the rest of the app.
// The shell's pencil edits it like the layout; widget data comes from the
// in-browser sample source. Mount it under `{#key}` on the section id.
//
// The widgets are page sections, not cards in a card: the grid's `plain`
// presentation drops the tile frame (edit mode brings it back with the
// controls) and each title is drawn as a section heading.
import {
  type OverviewDefinition,
  OverviewGrid,
  type OverviewModelChoice,
  type OverviewWidget,
} from '@happyvertical/smrt-svelte/overview';
import { useShellLayout } from '@happyvertical/smrt-svelte/workspace';
import { onDestroy, untrack } from 'svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import { createSectionOverview } from '../overviews/page.ts';
import { appHref } from '../planner/app.svelte.ts';
import type { SectionEntry } from '../sections/entries.ts';

interface SectionOverviewProps {
  definition: OverviewDefinition;
  /** Layout item id -> model and scope, for the shortcuts' record counts. */
  entries: ReadonlyMap<string, SectionEntry>;
  /** Models the option editor offers (the app's). */
  models: readonly OverviewModelChoice[];
  /** Accessible name of the grid. */
  label: string;
  /** Page sections (`plain`, the default) or framed tiles (`card`). */
  presentation?: 'card' | 'plain';
  /** An in-app path with the app query; the standalone page's `appHref`. */
  href?: (path: string) => string;
}

let {
  definition,
  entries,
  models,
  label,
  presentation = 'plain',
  href = appHref,
}: SectionOverviewProps = $props();

const shell = useShellLayout();
const source = useDataSource();

const controller = createSectionOverview(
  untrack(() => definition),
  cookbookStore,
  () => ({ source, sections: shell.sections, entryIndex: entries, href }),
);

function reloadAll() {
  for (const widget of controller.document.widgets)
    controller.reload(widget.id);
}

// The shortcuts follow the menu (renames, hides, moves) and the counts follow
// the entries; the grid already requested the first load, so skip that run.
let first = true;
$effect(() => {
  void JSON.stringify(shell.sections);
  void entries;
  if (first) {
    first = false;
    return;
  }
  untrack(reloadAll);
});
// A reset (a cookbook applied, the app reset) swaps the rows underneath.
$effect(() => source.onReset?.(() => reloadAll()));

onDestroy(() => controller.destroy());
</script>

{#snippet heading(_widget: OverviewWidget, title: string)}
  <span class="section-heading">{title}</span>
{/snippet}

<OverviewGrid {controller} {models} {label} {presentation} {heading} />

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .section-heading {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    font-weight: var(--smrt-typography-title-medium-weight, 600);
  }
}
</style>
