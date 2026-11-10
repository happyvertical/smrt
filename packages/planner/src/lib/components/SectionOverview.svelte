<script lang="ts">
// A section page's editable overview (smrt#3727): smrt-svelte's OverviewGrid
// over the section's definition. The cookbook owns the override (the
// controller reads `cookbookStore.overview(id)` and writes each edit back), so
// a customised page is saved, exported and imported with the rest of the app.
// The shell's pencil edits it like the layout; widget data comes from the
// in-browser sample source. Mount it under `{#key}` on the section id.
//
// The grid defaults to the existing themed card presentation. Explicit plain
// presentation remains available; edit mode keeps its controls and frame.
import {
  type OverviewDefinition,
  OverviewGrid,
  type OverviewModelChoice,
  type OverviewWidget,
  resolveWidgetComponents,
  type WidgetComponents,
} from '@happyvertical/smrt-svelte/overview';
import { useShellLayout } from '@happyvertical/smrt-svelte/workspace';
import { onDestroy, untrack } from 'svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import { createSectionOverview } from '../overviews/page.ts';
import { overviewRegistry } from '../overviews/registry.ts';
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
  /** Existing themed tiles (`card`, default) or unframed page sections (`plain`). */
  presentation?: 'card' | 'plain';
  /** An in-app path with the app query; the standalone page's `appHref`. */
  href?: (path: string) => string;
}

let {
  definition,
  entries,
  models,
  label,
  presentation = 'card',
  href = appHref,
}: SectionOverviewProps = $props();

const shell = useShellLayout();
const source = useDataSource();

const controller = createSectionOverview(
  untrack(() => definition),
  cookbookStore,
  () => ({ source, sections: shell.sections, entryIndex: entries, href }),
);

// Recipe widgets (smrt-reports' saved reports) load their component lazily:
// resolve the ones on the page so the grid can draw them.
let components = $state<WidgetComponents | undefined>();
$effect(() => {
  const types = controller.document.widgets.map((widget) => widget.type);
  let active = true;
  void resolveWidgetComponents(types, overviewRegistry).then((resolved) => {
    if (active) components = resolved;
  });
  return () => {
    active = false;
  };
});

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

<!-- Drawn once its widgets' components resolve, so a recipe widget never
     flashes "not available" while its module loads. -->
{#if components}
  <OverviewGrid {controller} {models} {label} {presentation} {heading} {components} />
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .section-heading {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    font-weight: var(--smrt-typography-title-medium-weight, 600);
  }
}
</style>
