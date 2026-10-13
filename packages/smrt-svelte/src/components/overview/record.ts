/**
 * The default overview of a record view (#3718 record view): one `records`
 * panel (newest related records) and one `metric` count per `children`
 * relation of the model, persisted per model kind under `detail:<model>`.
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

/** The default record overview of `definition` for its `children` relations. */
export function recordOverview(
  definition: ScreenCollectionDefinition,
  relations: readonly ScreenRelation[],
  options: RecordOverviewOptions = {},
): OverviewDefinition {
  const children = relations.filter((r) => r.kind === 'children');
  const defaults: OverviewWidget[] = [];
  const models: string[] = [];
  let n = 0;
  for (const relation of children) {
    if (!models.includes(relation.model)) models.push(relation.model);
    defaults.push({
      id: `w${++n}`,
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
    defaults.push({
      id: `w${++n}`,
      type: 'records',
      span: 3,
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
