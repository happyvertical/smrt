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
import type {
  CookbookEntry,
  CookbookSectionHeadingInfo,
  CookbookSectionPresentationProps,
} from './types.js';

interface Props extends CookbookSectionPresentationProps {
  /** The section's default overview from the cookbook; read once at mount (key the component on the section id). */
  definition: OverviewDefinition;
  /** Widget types available on this overview, with their option schemas and loaders. */
  registry: WidgetRegistry;
  /** Where the user's edits to this overview are read from and written back to (the cookbook override). */
  store: CookbookOverviewStore;
  /** The section's menu entries by id, passed to loaders so shortcuts follow renames, hides and moves. */
  entries: ReadonlyMap<string, CookbookEntry>;
  /** Svelte component that renders each widget type. */
  components: WidgetComponents;
  /** Models the user may pick as a widget's data source in edit mode. */
  models: readonly OverviewModelChoice[];
  /** Host capabilities for widget loaders. */
  hostContext: () => Record<string, unknown>;
  /** Accessible name of the overview grid, usually the section title. */
  label: string;
  /** The section; needed for `heading`, which renders above the grid. */
  section?: CookbookSectionHeadingInfo;
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
  presentation = 'card',
  heading,
  section,
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

<div class="cookbook-section-overview" data-smrt-component="CookbookSectionOverview">
  {#if heading && section}{@render heading({ section })}{/if}
  <OverviewGrid {controller} {components} {models} {label} {presentation} />
</div>
