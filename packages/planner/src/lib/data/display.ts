/**
 * Which field labels a record in pickers. `model.display` comes from the
 * manifest's `displayLabelField` (happyvertical/smrt#3611); a model that
 * declares none falls back to the first of `name`, `title`, `label`, `code`.
 */
import {
  deriveFieldRoles,
  fieldWithRole,
  type ScreenFieldType,
} from '@happyvertical/smrt-svelte/screens';
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
// row aria-labels. A model that declares no name still reads as something: a
// document reads as its own identifier (an invoice's `invoiceNumber`, an
// order's `reference`), a party as its name (see `labels.ts`), and a money
// record with no identifier as the record it is about, its amount and date.
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

/** A document's own number, e.g. `invoiceNumber` or `number`. */
const NUMBER_NAME = /(^|[a-z])Number$|^number$/;

/**
 * The field that identifies a document to a person (`invoiceNumber`, an
 * order's `reference`): the first field the framework's field roles
 * (`deriveFieldRoles`, smrt#3718) give the `identifier` role. `undefined`
 * for a model with a name of its own: a product's `code` is a detail, its
 * `name` is what it is called.
 */
export function identifierField(model: CatalogModel): CatalogField | undefined {
  if (labelFields(model).some((name) => name !== 'code')) return undefined;
  const own = model.fields.filter((f) => !f.system);
  const roles = deriveFieldRoles({
    objectRef: model.id,
    className: model.name,
    fields: Object.fromEntries(
      own.map((f) => [
        f.name,
        {
          type: SCREEN_TYPES.has(f.type) ? (f.type as ScreenFieldType) : 'text',
          ...(f.enum?.length ? { enum: f.enum } : {}),
          ...(f.ui ? { ui: { ...f.ui } } : {}),
        },
      ]),
    ),
  });
  const name = fieldWithRole(roles, 'identifier');
  return name ? own.find((f) => f.name === name) : undefined;
}

const SCREEN_TYPES = new Set([
  'text',
  'integer',
  'decimal',
  'boolean',
  'datetime',
  'json',
  'foreignKey',
  'crossPackageRef',
]);

/** A document's identifier value, e.g. `WIL-1133`; `undefined` when empty. */
export function identifierOf(
  model: CatalogModel,
  record: Readonly<Record<string, unknown>>,
): string | undefined {
  const field = identifierField(model);
  const value = field ? record[field.name] : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A record's own number, e.g. `invoiceNumber` or `number`. */
export function numberOf(
  model: CatalogModel,
  record: Readonly<Record<string, unknown>>,
): string | undefined {
  const field = model.fields.find(
    (f) =>
      !f.system &&
      f.type === 'text' &&
      NUMBER_NAME.test(f.name) &&
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
 * The text that names a record: its label field, else its identifier (a
 * document is its number: `GRA-3159`, never `Ridgeline Construction ·
 * GRA-3159`), else, for a money record such as a payment allocation, the party
 * it is for with its amount and date, else the party and a description.
 * `undefined` when nothing names it.
 */
export function recordName(
  model: CatalogModel,
  record: Readonly<Record<string, unknown>>,
  related: RelatedLabel,
  fields: readonly CatalogField[] = model.fields,
): string | undefined {
  const own = displayLabel(model, record);
  if (own) return own;
  const identifier = identifierOf(model, record);
  if (identifier) return identifier;
  const partyOf = partyField(fields, record);
  const party = partyOf?.related
    ? related(partyOf, String(record[partyOf.name]))
    : undefined;
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
  const description =
    typeof record.description === 'string' && record.description.trim() !== ''
      ? record.description
      : undefined;
  return unique([party, description]);
}

/**
 * A record page's heading: a document is its kind and identifier
 * (`Order GRA-3159`), anything else its name. `kind` is the model's name
 * as a person reads it ("Order", "Purchase order").
 */
export function recordHeading(
  model: CatalogModel,
  record: Readonly<Record<string, unknown>>,
  name: string,
  kind: string,
): string {
  if (displayLabel(model, record)) return name;
  const identifier = identifierOf(model, record);
  return identifier && identifier === name ? `${kind} ${identifier}` : name;
}

function unique(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p));
  const text = kept.filter((p, i) => kept.indexOf(p) === i).join(' · ');
  return text || undefined;
}
