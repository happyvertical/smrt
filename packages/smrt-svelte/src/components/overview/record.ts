/**
 * The default overview of a record view (#3718 record view): one `records`
 * panel (newest related records) per `children` relation of the model,
 * persisted per model kind under `detail:<model>`. `RecordScreen` heads each
 * panel with the relation's count and its one "View all" link, so a default
 * record page reads as one panel per relation; `metrics: true` adds a paired
 * `metric` count before each panel, and a person can add one from the
 * layout editor either way.
 *
 * Svelte-free. The widgets are the core `records` / `metric` types with the
 * parent-filter vocabulary: `filter: 'parent'` plus `field` (the FK on the
 * child) tell the host's loader to confine the query to rows whose `field`
 * equals `ctx.record.id`, the record the overview is rendered on
 * (`WidgetLoadContext.record`). The shell's own loaders need no data access;
 * hosts implement it.
 */
import type { ScreenRelation } from '../screens/relations.js';
import type { ScreenCollectionDefinition } from '../screens/types.js';
import { defineOverview } from './model.js';
import type { OverviewDefinition, OverviewWidget } from './types.js';

export interface RecordOverviewOptions {
  /** Overview id; defaults to `recordOverviewId(definition.objectRef)`. */
  id?: string;
  /**
   * Also declare a `metric` count (span 1) before each `records` panel, which
   * then spans 3. Off by default: the panel heading already carries the count.
   */
  metrics?: boolean;
}

/** Widget types a record overview offers by default. */
export const RECORD_OVERVIEW_ALLOWED: readonly string[] = [
  'records',
  'metric',
  'chart',
  'note',
];

/** Rows a default `records` panel shows. */
export const RECORD_OVERVIEW_LIMIT = 5;

/**
 * `detail:<model>` as an overview id. A qualified model id
 * (`@acme/shop:Customer`) carries characters an overview id cannot
 * (`OVERVIEW_PAGE_ID_PATTERN`), so `@`, `/` and `:` fold to dots:
 * `detail:acme.shop.Customer`. Stable per model kind.
 */
export function recordOverviewId(model: string): string {
  const folded = model
    .replace(/^@/, '')
    .replace(/[/:]+/g, '.')
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  return `detail:${folded || 'record'}`;
}

/**
 * A default widget's id, from its relation rather than its position:
 * `<prefix>-<Class>-<field>` (`records-Order-customerId`). The same relation
 * keeps its id whichever other relations a host shows (a host may narrow the
 * defaults to the models one app has), and never collides with the `w<n>`
 * ids `nextWidgetId` gives added widgets, so a stored override stays valid
 * against the full and the narrowed definition alike.
 */
function relationWidgetId(
  prefix: string,
  relation: ScreenRelation,
  taken: Set<string>,
): string {
  const className = relation.model.split(/[:/]/).pop() ?? relation.model;
  const base = `${prefix}-${className}-${relation.field}`
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .slice(0, 60);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Span of a default `records` panel: two side by side on a wide page. */
export const RECORD_OVERVIEW_PANEL_SPAN = 2;

/** The default record overview of `definition` for its `children` relations. */
export function recordOverview(
  definition: ScreenCollectionDefinition,
  relations: readonly ScreenRelation[],
  options: RecordOverviewOptions = {},
): OverviewDefinition {
  const children = relations.filter((r) => r.kind === 'children');
  const defaults: OverviewWidget[] = [];
  const models: string[] = [];
  const taken = new Set<string>();
  for (const relation of children) {
    if (!models.includes(relation.model)) models.push(relation.model);
    if (options.metrics) {
      defaults.push({
        id: relationWidgetId('count', relation, taken),
        type: 'metric',
        span: 1,
        options: {
          title: relation.label,
          model: relation.model,
          measure: 'count',
          field: relation.field,
          filter: 'parent',
        },
      });
    }
    defaults.push({
      id: relationWidgetId('records', relation, taken),
      type: 'records',
      span: options.metrics ? 3 : RECORD_OVERVIEW_PANEL_SPAN,
      options: {
        title: relation.label,
        model: relation.model,
        field: relation.field,
        filter: 'parent',
        sort: 'createdAt',
        direction: 'desc',
        limit: RECORD_OVERVIEW_LIMIT,
      },
    });
  }
  return defineOverview({
    id: options.id ?? recordOverviewId(definition.objectRef),
    allowed: RECORD_OVERVIEW_ALLOWED,
    models: models.length > 0 ? models : undefined,
    defaults,
  });
}
