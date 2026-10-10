/**
 * How a section page wires its overview to the cookbook (smrt#3727): the
 * controller reads the page's stored override from the cookbook store and
 * writes every edit back, so the cookbook is the single source of truth.
 * `SectionOverview.svelte` calls this; tests drive the same wiring.
 */
import {
  createOverview,
  loadOverview,
  type OverviewController,
  type OverviewDefinition,
  type OverviewOverride,
  type OverviewWidget,
} from '@happyvertical/smrt-svelte/overview';
import { overviewRegistry, type PlannerWidgetContext } from './registry.ts';

/** The part of the cookbook store an overview reads and writes. */
export interface OverviewStore {
  overview(id: string): OverviewOverride | null;
  setOverview(id: string, override: OverviewOverride | null): void;
}

/**
 * One widget's data from the in-browser source, through the same
 * sanitize-and-load path (timeout, serializable check) as a page load. A
 * failed load throws, which the grid shows as that widget's error tile.
 */
export async function loadSectionWidget(
  definition: OverviewDefinition,
  context: PlannerWidgetContext,
  widget: OverviewWidget,
  signal?: AbortSignal,
): Promise<unknown> {
  const loaded = await loadOverview(
    { widgets: [widget] },
    definition,
    overviewRegistry,
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
  store: OverviewStore,
  context?: () => PlannerWidgetContext,
): OverviewController {
  const id = definition.id;
  return createOverview({
    definition,
    registry: overviewRegistry,
    override: () => store.overview(id),
    onchange: (override) => store.setOverview(id, override),
    ...(context
      ? {
          loadWidget: (widget: OverviewWidget, signal: AbortSignal) =>
            loadSectionWidget(definition, context(), widget, signal),
        }
      : {}),
  });
}
