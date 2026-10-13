/**
 * The default overview of a record view (#3718 record page), persisted per
 * model kind under `detail:<model>`: a summary strip of `metric` tiles
 * (a count per related relation, and the sum of its money column where it
 * has one), then the `line-items` table and totals when the model has an
 * `items` relation, then one tabbed `related` widget over the `children`
 * relations. Every piece is an ordinary widget, so a person can remove,
 * move or replace it from the layout editor; `related: 'panels'` keeps the
 * earlier one `records` panel per relation.
 *
 * Svelte-free. The widgets use the parent-filter vocabulary: `filter:
 * 'parent'` plus the FK on the child (`field` for a count or a records
 * panel; `parentField` when `field` is the measured one) confine the
 * host's query to rows that point at `ctx.record.id`. `related` and
 * `line-items` load through the host's `records` loader
 * (`registerRecordWidgets`), so the shell's own loaders need no data access.
 */
import type { ScreenRelation } from '../screens/relations.js';
import { relationKey } from '../screens/relations.js';
import type { ScreenCollectionDefinition } from '../screens/types.js';
import { defineOverview } from './model.js';
import type { OverviewDefinition, OverviewWidget } from './types.js';
import { formatColumnsOption } from './widgets/record-table.js';

export interface RecordOverviewOptions {
  /** Overview id; defaults to `recordOverviewId(definition.objectRef)`. */
  id?: string;
  /** The summary strip of `metric` tiles (default on). */
  metrics?: boolean;
  /** Most tiles in the strip (default {@link RECORD_OVERVIEW_MAX_METRICS}). */
  maxMetrics?: number;
  /**
   * `tabs` (default): one `related` widget with a tab per relation.
   * `panels`: one `records` panel per relation, with role-chosen columns.
   */
  related?: 'tabs' | 'panels';
}

/** Widget types a record overview offers by default. */
export const RECORD_OVERVIEW_ALLOWED: readonly string[] = [
  'related',
  'line-items',
  'records',
  'metric',
  'chart',
  'note',
];

/** Tiles in the default summary strip. */
export const RECORD_OVERVIEW_MAX_METRICS = 4;

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
  const base = `${prefix}-${relationKey(relation)}`
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .slice(0, 60);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Span of a default `records` panel: two side by side on a wide page. */
export const RECORD_OVERVIEW_PANEL_SPAN = 2;

/** The default record overview of `definition` for its relations. */
export function recordOverview(
  definition: ScreenCollectionDefinition,
  relations: readonly ScreenRelation[],
  options: RecordOverviewOptions = {},
): OverviewDefinition {
  const children = relations.filter((r) => r.kind === 'children');
  const items = relations.filter((r) => r.kind === 'items');
  const defaults: OverviewWidget[] = [];
  const models: string[] = [];
  const taken = new Set<string>();
  for (const relation of [...items, ...children]) {
    if (!models.includes(relation.model)) models.push(relation.model);
  }

  if (options.metrics !== false) {
    const max = options.maxMetrics ?? RECORD_OVERVIEW_MAX_METRICS;
    const strip: OverviewWidget[] = [];
    for (const relation of children) {
      if (strip.length >= max) break;
      strip.push({
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
      const money = (relation.columns ?? []).find((c) => c.role === 'money');
      if (!money || strip.length >= max) continue;
      strip.push({
        id: relationWidgetId('sum', relation, taken),
        type: 'metric',
        span: 1,
        options: {
          title: `${relation.label} · ${money.label}`,
          model: relation.model,
          measure: 'sum',
          field: money.key,
          filter: 'parent',
          parentField: relation.field,
        },
      });
    }
    defaults.push(...strip);
  }

  const lines = items[0];
  if (lines) {
    defaults.push({
      id: relationWidgetId('items', lines, taken),
      type: 'line-items',
      span: 4,
      options: { title: lines.label, relation: relationKey(lines) },
    });
  }

  if (options.related === 'panels') {
    for (const relation of children) {
      defaults.push({
        id: relationWidgetId('records', relation, taken),
        type: 'records',
        span: RECORD_OVERVIEW_PANEL_SPAN,
        options: {
          title: relation.label,
          model: relation.model,
          field: relation.field,
          filter: 'parent',
          sort: 'createdAt',
          direction: 'desc',
          limit: RECORD_OVERVIEW_LIMIT,
          ...((relation.columns ?? []).length > 0
            ? {
                columns: formatColumnsOption(
                  (relation.columns ?? []).map((c) => c.key),
                ),
              }
            : {}),
        },
      });
    }
  } else if (children.length > 0) {
    taken.add('related');
    defaults.push({
      id: 'related',
      type: 'related',
      span: 4,
      options: { limit: RECORD_OVERVIEW_LIMIT },
    });
  }

  return defineOverview({
    id: options.id ?? recordOverviewId(definition.objectRef),
    allowed: RECORD_OVERVIEW_ALLOWED,
    models: models.length > 0 ? models : undefined,
    defaults,
  });
}
