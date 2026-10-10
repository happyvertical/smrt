<script lang="ts">
/**
 * A section page's editable overview (#3749): `OverviewGrid` over the
 * section's definition. The cookbook owns the override (the controller reads
 * it and writes each edit back). Mount it under `{#key}` on the section id.
 */
import { onDestroy, untrack } from 'svelte';
import type { OverviewModelChoice } from '../overview/grid-types.js';
import OverviewGrid from '../overview/OverviewGrid.svelte';
import type { WidgetComponents, WidgetRegistry } from '../overview/registry.js';
import type { OverviewDefinition } from '../overview/types.js';
import { useShellLayout } from '../workspace/admin-shell/layout-context.js';
import { type CookbookOverviewStore, createSectionOverview } from './page.js';
import type { CookbookEntry } from './types.js';

interface Props {
  definition: OverviewDefinition;
  registry: WidgetRegistry;
  store: CookbookOverviewStore;
  entries: ReadonlyMap<string, CookbookEntry>;
  components: WidgetComponents;
  models: readonly OverviewModelChoice[];
  /** Host capabilities for widget loaders. */
  hostContext: () => Record<string, unknown>;
  label: string;
}

let {
  definition,
  registry,
  store,
  entries,
  components,
  models,
  hostContext,
  label,
}: Props = $props();

const layout = useShellLayout();

const controller = createSectionOverview(
  untrack(() => definition),
  untrack(() => registry),
  untrack(() => store),
  () => ({
    ...hostContext(),
    sections: layout.sections,
    entries,
  }),
);

// The shortcuts follow the menu (renames, hides, moves); the grid already
// requested the first load, so skip that run.
let first = true;
$effect(() => {
  void JSON.stringify(layout.sections);
  if (first) {
    first = false;
    return;
  }
  untrack(() => {
    for (const widget of controller.document.widgets) {
      controller.reload(widget.id);
    }
  });
});

onDestroy(() => controller.destroy());
</script>

<OverviewGrid {controller} {components} {models} {label} />
