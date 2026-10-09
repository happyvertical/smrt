/**
 * Which field labels a record in pickers. `model.display` comes from the
 * manifest's `displayLabelField` (happyvertical/smrt#3611); a model that
 * declares none falls back to the first of `name`, `title`, `label`, `code`.
 */
import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import { formatMoney } from './format.ts';

export const DEFAULT_LABEL_FIELDS = ['name', 'title', 'label', 'code'] as const;

/** The fields that may label a record of the model, best first. */
export function labelFields(model: CatalogModel): string[] {
  const declared = model.display?.label;
  const names = new Set(model.fields.map((f) => f.name));
  return [...(declared ? [declared] : []), ...DEFAULT_LABEL_FIELDS].filter(
    (name, index, all) => names.has(name) && all.indexOf(name) === index,
  );
}

/** The first non-empty label field of a record, or undefined. */
export function displayLabel(
  model: CatalogModel,
  record: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const name of labelFields(model)) {
    const value = record[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// One label per record, for list cells, pickers, child tables, titles and
// row aria-labels. A model that declares no name still reads as something: its
// own number (an invoice's `invoiceNumber`), the record it is about (the
// customer), and for money records the amount and date.
// ---------------------------------------------------------------------------

/** Finds the label of the record a relation field points at. */
export type RelatedLabel = (
  field: CatalogField,
  id: string,
) => string | undefined;

const isRef = (f: CatalogField) =>
  f.type === 'foreignKey' || f.type === 'crossPackageRef';

/** Relations that say what a record is about, best first. */
const PARTY_ORDER = [
  /^customer/i,
  /^vendor/i,
  /^profile/i,
  /^product/i,
  /^invoice/i,
  /^order/i,
  /^payment/i,
  /^contract/i,
];

/** A record's own number, e.g. `invoiceNumber` or `number`. */
export function numberOf(
  model: CatalogModel,
  record: Readonly<Record<string, unknown>>,
): string | undefined {
  const field = model.fields.find(
    (f) =>
      !f.system &&
      f.type === 'text' &&
      /(^|[a-z])Number$|^number$/.test(f.name) &&
      typeof record[f.name] === 'string' &&
      String(record[f.name]).trim() !== '',
  );
  return field ? String(record[field.name]) : undefined;
}

/** The relation field that best says what a record is about, if it has one. */
export function partyField(
  fields: readonly CatalogField[],
  record: Readonly<Record<string, unknown>>,
): CatalogField | undefined {
  const set = fields.filter(
    (f) =>
      isRef(f) && typeof record[f.name] === 'string' && record[f.name] !== '',
  );
  for (const pattern of PARTY_ORDER) {
    const found = set.find((f) => pattern.test(f.name));
    if (found) return found;
  }
  return undefined;
}

const DATE_NAME = /(paid|allocated|issue|^date$|createdat)/i;

/**
 * The text that names a record: its label field, else its number (plus the
 * party it is for), else the party, with the amount and date for a money record
 * such as a payment. `undefined` when nothing names it.
 */
export function recordName(
  model: CatalogModel,
  record: Readonly<Record<string, unknown>>,
  related: RelatedLabel,
  fields: readonly CatalogField[] = model.fields,
): string | undefined {
  const own = displayLabel(model, record);
  if (own) return own;
  const partyOf = partyField(fields, record);
  const party = partyOf?.related
    ? related(partyOf, String(record[partyOf.name]))
    : undefined;
  const number = numberOf(model, record);
  if (number) return unique([number, party]);
  const moneyField = model.fields.find(
    (f) => f.name === 'amount' && f.type === 'integer',
  );
  if (moneyField && typeof record.amount === 'number') {
    const dateField = model.fields.find(
      (f) => f.type === 'datetime' && DATE_NAME.test(f.name) && record[f.name],
    );
    return unique([
      party,
      formatMoney(record.amount),
      dateField ? String(record[dateField.name]).slice(0, 10) : undefined,
    ]);
  }
  const reference = ['reference', 'description']
    .map((name) => record[name])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return unique([party, reference]);
}

function unique(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p));
  const text = kept.filter((p, i) => kept.indexOf(p) === i).join(' · ');
  return text || undefined;
}
