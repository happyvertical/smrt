// Related records on a record page: the reverse of link (reference) fields.
// Pure helpers; the shell route and the components only call these.
import { type Column, referencedModels } from './columns.ts';
import { fieldLabel } from './fields.ts';
import { modelHref } from './menu.ts';
import type { ModelInfo, RecordRow } from './types.ts';

/** One reverse relation: `model.field` points at the record's model. */
export interface Relation {
  /** `Model.field`, unique and stable. */
  key: string;
  model: string;
  field: string;
  /** The related model's label. */
  modelLabel: string;
  /** The link field's label. */
  fieldLabel: string;
  /** The model label, plus the field label only when two fields clash. */
  tabLabel: string;
}

/** Most tabs shown before the rest move under "More". */
export const MAX_TABS = 4;
/** Rows a tab shows. */
export const TAB_ROWS = 8;
/** Columns a tab shows. */
export const TAB_COLUMNS = 4;
/** Most rows the records route scans to filter by a link. */
export const FILTER_SCAN_LIMIT = 1000;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Every visible link field of a model that points at `target`, in model then
 * field order. One level only: callers never ask for the relations of a
 * related record.
 */
export function reverseRelations(
  models: Record<string, ModelInfo>,
  target: string,
): Relation[] {
  const found: Omit<Relation, 'tabLabel'>[] = [];
  for (const [model, info] of Object.entries(models)) {
    for (const [field, def] of Object.entries(info.fields)) {
      if (def.type !== 'reference' || def.ref !== target || def.hidden)
        continue;
      found.push({
        key: `${model}.${field}`,
        model,
        field,
        modelLabel: info.label,
        fieldLabel: fieldLabel(field, def),
      });
    }
  }
  const perModel = new Map<string, number>();
  for (const r of found)
    perModel.set(r.model, (perModel.get(r.model) ?? 0) + 1);
  return found.map((r) => ({
    ...r,
    tabLabel:
      (perModel.get(r.model) ?? 0) > 1
        ? `${r.modelLabel} (${r.fieldLabel})`
        : r.modelLabel,
  }));
}

export interface Counted {
  key: string;
  count: number;
}

/**
 * Tabs by count (highest first, then declared order), at most `max`;
 * relations with no records and the overflow go under "More".
 */
export function arrangeTabs(
  items: Counted[],
  max = MAX_TABS,
): { tabs: string[]; more: string[] } {
  const filled = items
    .map((item, order) => ({ ...item, order }))
    .filter((i) => i.count > 0)
    .sort((a, b) => b.count - a.count || a.order - b.order);
  const tabs = filled.slice(0, Math.max(0, max)).map((i) => i.key);
  const shown = new Set(tabs);
  return {
    tabs,
    more: items.map((i) => i.key).filter((k) => !shown.has(k)),
  };
}

/**
 * A few useful columns: the declared fields without the link back to this
 * record, hidden and json ones.
 */
export function relatedColumns(
  info: Pick<ModelInfo, 'fields'>,
  backField: string,
  max = TAB_COLUMNS,
): Column[] {
  return Object.entries(info.fields)
    .filter(
      ([name, def]) => name !== backField && !def.hidden && def.type !== 'json',
    )
    .slice(0, max)
    .map(([name, def]) => ({ name, label: fieldLabel(name, def), def }));
}

/** Models whose records label the reference cells of these columns. */
export function columnReferenceModels(columns: Column[]): string[] {
  return referencedModels(
    Object.fromEntries(columns.map((c) => [c.name, c.def])),
  );
}

/** `field:id` for a `?where=` / `?with=` query value. */
export function linkParam(field: string, id: string): string {
  return `${field}:${id}`;
}

/**
 * Read a `field:id` value for `info`: the field must be a visible link field
 * of that model and the id plain. Anything else is ignored.
 */
export function parseLinkParam(
  raw: string | null | undefined,
  info: Pick<ModelInfo, 'fields'>,
): { field: string; id: string; ref: string } | null {
  if (!raw) return null;
  const at = raw.indexOf(':');
  if (at < 1) return null;
  const field = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!Object.hasOwn(info.fields, field) || !ID.test(id)) return null;
  const def = info.fields[field];
  if (def.type !== 'reference' || !def.ref || def.hidden) return null;
  return { field, id, ref: def.ref };
}

/** Link to a model's table filtered by one of its link fields. */
export function filteredHref(model: string, field: string, id: string) {
  return `${modelHref(model)}?where=${encodeURIComponent(linkParam(field, id))}`;
}

/** Link to a new record with that link field already set. */
export function prefilledNewHref(model: string, field: string, id: string) {
  return `${modelHref(model)}/new?with=${encodeURIComponent(linkParam(field, id))}`;
}

/** Rows whose `field` equals `id`: the first `limit` and the full count. */
export function matchLink<T extends Record<string, unknown>>(
  rows: T[],
  field: string,
  id: string,
  limit: number,
): { records: T[]; total: number } {
  const hits = rows.filter((r) => r[field] === id);
  return { records: hits.slice(0, Math.max(0, limit)), total: hits.length };
}

/**
 * A count for a badge: `N+` when the route only scanned part of the table, so
 * the real count may be higher.
 */
export function countLabel(total: number, truncated: boolean): string {
  return truncated ? `${total}+` : String(total);
}

/** One relation's loaded data, from the filtered records route. */
export interface RelatedData {
  key: string;
  total: number;
  /** The route scanned its row limit, so the total may be higher. */
  truncated: boolean;
  records: RecordRow[];
}
