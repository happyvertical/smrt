/**
 * Loaders of the record-page widgets (#3718 record page), Svelte-free (on
 * both entries); the definitions are in `record-widgets.ts`. The widgets: `related` (one tab per
 * `children` relation, each a records table with a totals footer) and, with
 * `line-items`, the document's lines and totals block. They are built from
 * the record's relations, so they register per record view
 * (`registerRecordWidgets`), not with the core widgets.
 *
 * Loader contract: `related` needs no loader of its own. Each tab is ONE
 * call of the host's core `records` loader with the parent-filter
 * vocabulary — `{ model, field, filter: 'parent', sort: 'createdAt',
 * direction: 'desc', limit, columns }` — so a host that implements the
 * `records` widget's `filter: 'parent'` already implements `related`. The
 * `columns` option tells the loader which `cells` to fill; `summaries` in
 * its data (totals over every matching record) fill the footer when the tab
 * shows a page of a longer list.
 */
import type { ScreenRelation } from '../../screens/relations.js';
import { relationKey } from '../../screens/relations.js';
import type {
  OverviewOptions,
  WidgetLoad,
  WidgetLoadContext,
} from '../types.js';
import {
  isRecord,
  type LineItemsWidgetData,
  type RecordListWidgetData,
  type RelatedWidgetData,
  type RelatedWidgetTab,
} from './data.js';
import type { LineItemsTotals } from './line-totals.js';
import {
  formatColumnsOption,
  parseColumnsOption,
  readRecordRows,
  resolveRecordColumns,
} from './record-table.js';

/** Rows per tab by default. */
export const RELATED_WIDGET_LIMIT = 5;
/** At most this many relations (tabs) one `related` widget lists. */
export const RELATED_WIDGET_MAX_TABS = 20;

export interface RecordWidgetsOptions {
  /** The record's relations (`deriveScreenRelations`). */
  relations: readonly ScreenRelation[];
  /** The host's core `records` loader; every tab is one parent-filtered load. */
  records: WidgetLoad<RecordListWidgetData>;
  /** A tab's "View all" link; else the loaded data's `href`. */
  viewAllHref?: (relation: ScreenRelation) => string | undefined;
  /**
   * `line-items`: the parent record's own subtotal / discount / tax / total
   * (read when the widget loads; `RecordScreen` reads them by role).
   */
  totals?: () => LineItemsTotals | undefined;
  /** `line-items`: the currency of the parent's amounts. */
  currency?: () => string | undefined;
}

/** Lines a `line-items` widget loads by default (and at most). */
export const LINE_ITEMS_LIMIT = 50;

/** The relations a `related` widget lists: `children` (never `items`), or the named ones. */
export function relatedRelations(
  relations: readonly ScreenRelation[],
  keys: readonly string[],
): ScreenRelation[] {
  const children = relations.filter((r) => r.kind === 'children');
  if (keys.length === 0) return children.slice(0, RELATED_WIDGET_MAX_TABS);
  return keys
    .map((key) => children.find((r) => relationKey(r) === key))
    .filter((r): r is ScreenRelation => r !== undefined);
}

/** The `records` loader options one tab loads with. */
export function relatedTabOptions(
  relation: ScreenRelation,
  limit: number,
): OverviewOptions {
  return {
    title: relation.label,
    model: relation.model,
    field: relation.field,
    filter: 'parent',
    sort: 'createdAt',
    direction: 'desc',
    limit,
    columns: formatColumnsOption((relation.columns ?? []).map((c) => c.key)),
  };
}

function toTab(
  relation: ScreenRelation,
  data: unknown,
  href: string | undefined,
): RelatedWidgetTab {
  const record = isRecord(data) ? data : {};
  const rows = readRecordRows(record);
  const keys = (relation.columns ?? []).map((c) => c.key);
  const declared = [
    ...(Array.isArray(record.columns) ? record.columns : []),
    ...(relation.columns ?? []),
  ];
  const summaries: Record<string, number> = {};
  if (isRecord(record.summaries)) {
    for (const [key, value] of Object.entries(record.summaries)) {
      if (typeof value === 'number' && Number.isFinite(value))
        summaries[key] = value;
    }
  }
  const total =
    typeof record.total === 'number' && Number.isFinite(record.total)
      ? record.total
      : rows.length;
  const dataHref = typeof record.href === 'string' ? record.href : undefined;
  return {
    key: relationKey(relation),
    label: relation.label,
    rows,
    total,
    columns: resolveRecordColumns(keys, declared),
    ...((href ?? dataHref) ? { href: href ?? dataHref } : {}),
    ...(typeof record.currency === 'string'
      ? { currency: record.currency }
      : {}),
    ...(typeof record.timeZone === 'string'
      ? { timeZone: record.timeZone }
      : {}),
    ...(Object.keys(summaries).length > 0 ? { summaries } : {}),
  };
}

/**
 * The `related` widget's load: one `records` load per listed relation, in
 * parallel. A tab whose load fails is left out; if every tab fails, the
 * first error is the widget's.
 */
export function createRelatedLoader(
  options: RecordWidgetsOptions,
): WidgetLoad<RelatedWidgetData> {
  return async (widgetOptions, ctx: WidgetLoadContext) => {
    const keys = parseColumnsOption(
      widgetOptions.relations,
      RELATED_WIDGET_MAX_TABS,
    );
    const limit =
      typeof widgetOptions.limit === 'number'
        ? widgetOptions.limit
        : RELATED_WIDGET_LIMIT;
    const selected = relatedRelations(options.relations, keys);
    const settled = await Promise.allSettled(
      // A loader that throws synchronously fails its tab, not the widget.
      selected.map(
        (relation) =>
          new Promise((resolve) =>
            resolve(options.records(relatedTabOptions(relation, limit), ctx)),
          ),
      ),
    );
    const tabs: RelatedWidgetTab[] = [];
    let failure: unknown;
    settled.forEach((result, index) => {
      const relation = selected[index];
      if (!relation) return;
      if (result.status === 'rejected') {
        failure ??= result.reason;
        return;
      }
      tabs.push(toTab(relation, result.value, options.viewAllHref?.(relation)));
    });
    if (tabs.length === 0 && failure !== undefined) throw failure;
    return { tabs };
  };
}

/** The `items` relation a `line-items` widget shows: the named one, else the first. */
export function lineItemsRelation(
  relations: readonly ScreenRelation[],
  key: unknown,
): ScreenRelation | undefined {
  const items = relations.filter((r) => r.kind === 'items');
  if (typeof key === 'string' && key !== '') {
    return items.find((r) => relationKey(r) === key);
  }
  return items[0];
}

/** The `records` loader options the line items load with. */
export function lineItemsOptions(
  relation: ScreenRelation,
  limit: number,
): OverviewOptions {
  return {
    title: relation.label,
    model: relation.model,
    field: relation.field,
    filter: 'parent',
    sort: relation.sort ?? 'createdAt',
    direction: 'asc',
    limit,
    columns: formatColumnsOption((relation.columns ?? []).map((c) => c.key)),
  };
}

/**
 * The `line-items` widget's load: one `records` load of the `items`
 * relation (`filter: 'parent'`, in line order, up to {@link LINE_ITEMS_LIMIT}),
 * plus the parent's totals. No `items` relation is an empty result.
 */
export function createLineItemsLoader(
  options: RecordWidgetsOptions,
): WidgetLoad<LineItemsWidgetData> {
  return async (widgetOptions, ctx: WidgetLoadContext) => {
    const relation = lineItemsRelation(
      options.relations,
      widgetOptions.relation,
    );
    const totals = options.totals?.();
    const currency = options.currency?.();
    if (!relation) {
      return { rows: [], columns: [], ...(totals ? { totals } : {}) };
    }
    const limit =
      typeof widgetOptions.limit === 'number'
        ? widgetOptions.limit
        : LINE_ITEMS_LIMIT;
    const data = await options.records(lineItemsOptions(relation, limit), ctx);
    const tab = toTab(relation, data, undefined);
    return {
      rows: tab.rows,
      columns: tab.columns,
      ...(tab.total !== undefined ? { total: tab.total } : {}),
      ...(totals ? { totals } : {}),
      ...((tab.currency ?? currency)
        ? { currency: tab.currency ?? currency }
        : {}),
      ...(tab.summaries ? { summaries: tab.summaries } : {}),
      ...(tab.href ? { href: tab.href } : {}),
    };
  };
}
