import { createWidgetRegistry } from '../registry.js';
import type {
  OverviewDefinition,
  OverviewWidget,
  WidgetOptionField,
} from '../types.js';

export const countFields: readonly WidgetOptionField[] = [
  { key: 'title', type: 'text', label: 'Title', maxLength: 40 },
  { key: 'model', type: 'model', label: 'Model', required: true },
  {
    key: 'measure',
    type: 'enum',
    label: 'Measure',
    default: 'count',
    choices: [
      { value: 'count', label: 'Count' },
      { value: 'sum', label: 'Sum' },
    ],
  },
  { key: 'limit', type: 'integer', label: 'Limit', min: 1, max: 20 },
  { key: 'compact', type: 'boolean', label: 'Compact' },
];

export function makeRegistry() {
  const registry = createWidgetRegistry();
  registry.register({
    type: 'metric',
    title: 'Metric',
    version: 2,
    options: countFields,
    allowedIn: undefined,
    maxSpan: 2,
    load: (options) => ({ value: options.model === 'events:Event' ? 7 : 0 }),
    migrate: (options, from) => {
      if (from !== 1) return null;
      const { agg, ...rest } = options;
      return { ...rest, measure: agg ?? 'count' };
    },
  });
  registry.register({
    type: 'note',
    title: 'Note',
    options: [{ key: 'body', type: 'markdown', label: 'Body', default: '' }],
  });
  registry.register({
    type: 'secret',
    title: 'Secret',
    options: [],
    allowedIn: ['admin.home'],
  });
  return registry;
}

export const w = (
  id: string,
  type: string,
  span = 1,
  options: OverviewWidget['options'] = {},
): OverviewWidget => ({ id, type, span, options });

export const definition: OverviewDefinition = {
  id: 'events.home',
  allowed: ['metric', 'note', 'secret'],
  models: ['events:Event', 'events:Venue'],
  defaults: [
    w('w1', 'metric', 1, { model: 'events:Event' }),
    w('w2', 'note', 2, { body: 'Hello' }),
    w('w3', 'metric', 1, { model: 'events:Venue', measure: 'sum' }),
  ],
};
