import type { CatalogModel } from '../catalog/types.ts';
import { isRelation } from '../fields/renderer.ts';
import type { ViewField } from '../recipes/policy.ts';
import { recordName } from './display.ts';
import { labelKey } from './format.ts';

/** A list column: a field, or a value worked out from the row (Amount due). */
export interface ListColumn extends ViewField {
  /** A datetime that shows its time of day, not only the date (a class start). */
  showTime?: boolean;
  derive?: (row: Readonly<Record<string, unknown>>) => unknown;
}

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Lower is shown first: what names a row, who it is for, its state, its money, its dates. */
function columnRank(f: ViewField): number {
  const name = f.name;
  if (f.type === 'json') return 99;
  if (/^(name|title|label|code)$|Number$|^number$/.test(name)) return 0;
  if (name === 'reference' && f.type === 'text') return 0.5;
  // Long free text is the first thing a list can do without.
  if (name === 'description' && f.type === 'text') return 5.9;
  if (isRelation(f)) {
    if (/^(customer|vendor|profile)/i.test(name)) return 1;
    // The contract and ledger links are bookkeeping, not what a row is about.
    return /^(contract|.*(journal|account))/i.test(name) ? 7 : 2;
  }
  if ((f.enum?.length ?? 0) > 0 && /(status|state|stage)$/i.test(name))
    return 3;
  if (/^(totalAmount|amount|total)$/.test(name)) return 4;
  if (f.type === 'datetime') {
    // When a scheduled thing starts is what its row is about.
    if (/^start(date|at)?$/i.test(name)) return 1.2;
    if (/^due/i.test(name)) return 5;
    if (/(issue|paid|allocated|^date$)/i.test(name)) return 5.2;
  }
  return 6;
}

/**
 * The columns of a list: what names the row, who it is for, its status, its
 * money and its dates first; then the other numeric/boolean/date fields and
 * choices so a row reads like a record, not a wall of text. A record that
 * tracks payments (`totalAmount` and `amountPaid`) also gets "Amount due".
 */
export function listColumns(
  fields: readonly ViewField[],
  max = 6,
): ListColumn[] {
  const shown = fields.filter((f) => f.type !== 'json');
  const lead = new Set(shown.slice(0, 3));
  const candidates = shown.filter(
    (f) =>
      lead.has(f) ||
      columnRank(f) < 6 ||
      ['integer', 'decimal', 'boolean', 'datetime'].includes(f.type) ||
      (f.enum?.length ?? 0) > 0 ||
      isRelation(f),
  );
  const ranked = candidates
    .map((f, i) => ({ f, i, rank: columnRank(f) }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i)
    .map((x): ListColumn => x.f);
  const total = shown.find((f) => f.name === 'totalAmount');
  if (total && shown.some((f) => f.name === 'amountPaid')) {
    const due: ListColumn = {
      ...total,
      name: 'amountDue',
      label: 'Amount due',
      required: false,
      derive: (row) => num(row.totalAmount) - num(row.amountPaid),
    };
    const at = ranked.findIndex((f) => f.name === 'totalAmount');
    ranked.splice(at < 0 ? ranked.length : at + 1, 0, due);
  }
  // Records that are scheduled (an `allDay` flag) show when they start to the minute.
  const scheduled = shown.some((f) => f.name === 'allDay');
  return ranked
    .slice(0, max)
    .map((f) =>
      scheduled &&
      f.type === 'datetime' &&
      /^(start|end)(date|at)$/i.test(f.name)
        ? { ...f, showTime: true }
        : f,
    );
}

/** The value a list cell shows for a row. */
export function cellValue(
  column: ListColumn,
  row: Readonly<Record<string, unknown>>,
): unknown {
  return column.derive ? column.derive(row) : row[column.name];
}

/** The rows whose foreign key points at the parent record. */
export function rowsOf<T extends Record<string, unknown>>(
  rows: readonly T[],
  fk: string,
  parentId: string,
): T[] {
  return rows.filter((r) => r[fk] === parentId);
}

/**
 * The value a new record starts with: the field's default; an enumeration with
 * none (a `status`, or a required choice) starts at "draft" or its first value
 * rather than empty.
 */
export function blankValue(field: ViewField): unknown {
  if (field.default !== undefined && field.default !== null) {
    return field.default;
  }
  const choices = field.enum ?? [];
  if (
    choices.length > 0 &&
    (field.required || /(status|state|stage)$/i.test(field.name))
  ) {
    return choices.includes('draft') ? 'draft' : choices[0];
  }
  if (field.type === 'boolean') return false;
  return field.type === 'text' ? '' : null;
}

/** Starting values for a new record of the fields shown. */
export function blankRecord(
  fields: readonly ViewField[],
): Record<string, unknown> {
  const blank: Record<string, unknown> = {};
  for (const field of fields) blank[field.name] = blankValue(field);
  return blank;
}

/** Starting values for a new child row: field defaults, the foreign key preset. */
export function blankChild(
  fields: readonly ViewField[],
  fk: string,
  parentId: string,
): Record<string, unknown> {
  return { ...blankRecord(fields), [fk]: parentId };
}

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' && value.trim() === '');

/**
 * Required fields without a value, as `{ name: message }`. A switch always has
 * a value; fields in `skip` (derived or preset ones) are not asked for.
 */
export function missingRequired(
  fields: readonly ViewField[],
  values: Readonly<Record<string, unknown>>,
  skip: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!field.required || field.type === 'boolean' || skip.has(field.name)) {
      continue;
    }
    if (isEmpty(values[field.name]))
      errors[field.name] = `${field.label} is required.`;
  }
  return errors;
}

/**
 * One line for near the Save button: which fields still need a value.
 * Empty when nothing is missing, so it clears itself as the errors do.
 */
export function errorSummary(
  fields: readonly { name: string; label: string }[],
  errors: Readonly<Record<string, string>>,
): string {
  const labels = fields.filter((f) => errors[f.name]).map((f) => f.label);
  if (labels.length === 0) return '';
  return `Cannot save yet: ${labels.join(', ')} ${
    labels.length === 1 ? 'is' : 'are'
  } required.`;
}

/**
 * What names a record to a person (see `recordName`): its label, else its
 * number and who it is for ("WIL-1133 · Lantern Collective"), else the record
 * it points at plus its reference.
 */
export function recordTitle(
  model: CatalogModel,
  fields: readonly ViewField[],
  row: Readonly<Record<string, unknown>>,
  labels: ReadonlyMap<string, string>,
): string {
  return (
    recordName(
      model,
      row,
      (field, id) =>
        field.related ? labels.get(labelKey(field.related, id)) : undefined,
      fields,
    ) ?? ''
  );
}

/** A child table shown inside its parent's record view. */
export interface ChildTable {
  model: CatalogModel;
  fields: ViewField[];
  /** The child's field holding the parent record's id. */
  fk: string;
  title: string;
}
