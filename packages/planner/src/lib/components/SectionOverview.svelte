<script lang="ts">
// A section page's editable overview (smrt#3727): smrt-svelte's OverviewGrid
// over the section's definition. The cookbook owns the override (the
// controller reads `cookbookStore.overview(id)` and writes each edit back), so
// a customised page is saved, exported and imported with the rest of the app.
// The shell's pencil edits it like the layout; widget data comes from the
// in-browser sample source. Mount it under `{#key}` on the section id.
import {
  type OverviewDefinition,
  OverviewGrid,
  type OverviewModelChoice,
} from '@happyvertical/smrt-svelte/overview';
import { useShellLayout } from '@happyvertical/smrt-svelte/workspace';
import { onDestroy, untrack } from 'svelte';
import { cookbookStore } from '$lib/cookbook/store.svelte.ts';
import { useDataSource } from '$lib/data/context.ts';
import { createSectionOverview } from '$lib/overviews/page.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import type { SectionEntry } from '$lib/sections/entries.ts';

interface SectionOverviewProps {
  definition: OverviewDefinition;
  /** Layout item id -> model and scope, for the shortcuts' record counts. */
  entries: ReadonlyMap<string, SectionEntry>;
  /** Models the option editor offers (the app's). */
  models: readonly OverviewModelChoice[];
  /** Accessible name of the grid. */
  label: string;
}

let { definition, entries, models, label }: SectionOverviewProps = $props();

const shell = useShellLayout();
const source = useDataSource();

const controller = createSectionOverview(
  untrack(() => definition),
  cookbookStore,
  () => ({ source, sections: shell.sections, entries, href: appHref }),
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

<OverviewGrid {controller} {models} {label} />
