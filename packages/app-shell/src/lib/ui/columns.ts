// Which columns a list shows, and how a cell reads.
import { fieldLabel, recordLabel } from './fields.ts';
import { formatMoney } from './money.ts';
import type { FieldDef, ModelInfo, RecordRow } from './types.ts';

export interface Column {
  name: string;
  label: string;
  def: FieldDef;
}

/** Visible fields, the long free-form ones last, at most `max` columns. */
export function selectColumns(
  model: Pick<ModelInfo, 'fields'>,
  max = 5,
): Column[] {
  const cols = Object.entries(model.fields)
    .filter(([, d]) => !d.hidden)
    .map(([name, def]) => ({ name, label: fieldLabel(name, def), def }));
  const plain = cols.filter((c) => c.def.type !== 'json');
  return plain.slice(0, max);
}

/** Newest first by creation time (ties keep the server order). */
export function orderByCreated<T extends { createdAt?: string | null }>(
  rows: T[],
): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const x = a.row.createdAt ?? '';
      const y = b.row.createdAt ?? '';
      if (x === y) return a.i - b.i;
      return x < y ? 1 : -1;
    })
    .map((e) => e.row);
}

export function formatDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(v));
  return dateOnly || /T00:00:00(\.000)?Z$/.test(String(v))
    ? d.toLocaleDateString(undefined, { timeZone: 'UTC' })
    : d.toLocaleString();
}

export type ReferenceLookup = Record<string, Record<string, RecordRow>>;

/** Text for one cell. References show the target record's label. */
export function cellText(
  def: FieldDef,
  value: unknown,
  models: Record<string, ModelInfo> = {},
  refs: ReferenceLookup = {},
): string {
  if (value === null || value === undefined || value === '') return '';
  switch (def.type) {
    case 'boolean':
      return value === true || value === 1 || value === '1' ? 'Yes' : 'No';
    case 'money':
      return formatMoney(value);
    case 'date':
      return formatDate(value);
    case 'reference': {
      const target = def.ref ? refs[def.ref]?.[String(value)] : undefined;
      return target
        ? recordLabel(def.ref ? models[def.ref] : undefined, target)
        : String(value);
    }
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

/** Index records of each model by id for reference lookups. */
export function indexReferences(
  records: Record<string, RecordRow[]>,
): ReferenceLookup {
  const out: ReferenceLookup = {};
  for (const [model, rows] of Object.entries(records))
    out[model] = Object.fromEntries(rows.map((r) => [r.id, r]));
  return out;
}

/** Models a set of fields refers to (for loading their records). */
export function referencedModels(fields: Record<string, FieldDef>): string[] {
  return [
    ...new Set(
      Object.values(fields)
        .filter((d) => d.type === 'reference' && d.ref)
        .map((d) => d.ref as string),
    ),
  ];
}
