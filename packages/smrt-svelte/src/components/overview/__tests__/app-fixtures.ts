import { loadOverview } from '../load.js';
import { resolveOverview } from '../model.js';
import { createWidgetRegistry } from '../registry.js';
import type { OverviewDefinition, OverviewWidget } from '../types.js';
import { registerCoreWidgets } from '../widgets/core.js';

export const w = (
  id: string,
  type: string,
  span: number,
  options: OverviewWidget['options'] = {},
): OverviewWidget => ({ id, type, span, options });

export function coreRegistry() {
  const registry = createWidgetRegistry();
  registerCoreWidgets(registry, {
    metric: (options) => ({
      value: options.model === 'events:Event' ? 42 : 7,
      label: `${String(options.measure)} of ${String(options.model)}`,
      change: 12.5,
    }),
    chart: () => ({
      points: [
        { label: 'Mon', value: 3 },
        { label: 'Tue', value: 9 },
      ],
    }),
    records: () => ({
      rows: [
        {
          id: 'r1',
          title: 'Spring gala',
          subtitle: 'Hall A',
          href: '/events/r1',
        },
        { id: 'r2', title: 'Board meeting', href: 'javascript:alert(1)' },
      ],
      total: 12,
      href: '/events',
    }),
    shortcuts: () => ({
      items: [
        {
          id: 'a',
          label: 'Events',
          href: '/events',
          icon: 'calendar',
          description: 'All events',
        },
        { id: 'b', label: 'Bad', href: 'javascript:alert(1)' },
      ],
    }),
  });
  return registry;
}

export const definition: OverviewDefinition = {
  id: 'events.home',
  allowed: ['metric', 'chart', 'records', 'shortcuts', 'note'],
  models: ['events:Event', 'events:Venue'],
  defaults: [
    w('w1', 'metric', 1, { model: 'events:Event' }),
    w('w2', 'chart', 2, { model: 'events:Event', groupBy: 'type' }),
    w('w3', 'note', 1, { title: 'Welcome', body: '**Hi** there' }),
    w('w4', 'records', 2, { model: 'events:Event', limit: 5 }),
  ],
};

/** What a page's server load would hand the client. */
export async function loadedFor(
  registry = coreRegistry(),
  override: unknown = null,
) {
  const resolved = resolveOverview(definition, override, registry);
  return loadOverview(resolved.document, definition, registry, {});
}
