/**
 * How a section page wires its overview to the cookbook (#3749): the
 * controller reads the page's stored override and writes every edit back, so
 * the cookbook is the single source of truth. Ported from smrt-planner's
 * `overviews/page.ts`.
 */
import {
  createOverview,
  type OverviewController,
} from '../overview/controller.svelte.js';
import { loadOverview } from '../overview/load.js';
import type { WidgetRegistry } from '../overview/registry.js';
import type {
  OverviewDefinition,
  OverviewOverride,
  OverviewWidget,
} from '../overview/types.js';

/** The part of the app an overview reads and writes. */
export interface CookbookOverviewStore {
  overview(id: string): unknown;
  setOverview(id: string, override: OverviewOverride | null): void;
}

/**
 * One widget's data through the same sanitize-and-load path (timeout,
 * serializable check) as a page load. A failed load throws, which the grid
 * shows as that widget's error tile.
 */
export async function loadSectionWidget(
  definition: OverviewDefinition,
  registry: WidgetRegistry,
  context: Record<string, unknown>,
  widget: OverviewWidget,
  signal?: AbortSignal,
): Promise<unknown> {
  const loaded = await loadOverview(
    { widgets: [widget] },
    definition,
    registry,
    { ...context, signal, locale: 'en-US' },
  );
  const result = loaded.widgets[0];
  if (!result || result.status === 'error') {
    throw new Error(result?.error?.code ?? 'load_failed');
  }
  return result.data;
}

/** The controller of a section's overview, persisted through `store`. */
export function createSectionOverview(
  definition: OverviewDefinition,
  registry: WidgetRegistry,
  store: CookbookOverviewStore,
  context: () => Record<string, unknown>,
): OverviewController {
  const id = definition.id;
  return createOverview({
    definition,
    registry,
    override: () => store.overview(id) as OverviewOverride | null,
    onchange: (override) => store.setOverview(id, override),
    loadWidget: (widget: OverviewWidget, signal: AbortSignal) =>
      loadSectionWidget(definition, registry, context(), widget, signal),
  });
}
