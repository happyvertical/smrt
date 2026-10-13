/**
 * Pure helpers behind the records tables (#3718 record page): the `records`
 * widget with columns, each tab of `related`, and `lineItems`. Columns
 * come by role; cells format by role; the footer (smrt-ui `DataTable`
 * `summaries`) counts the rows and sums the money and quantity columns.
 *
 * Svelte-free and Node-tested. No date is formatted in the viewer's zone:
 * a date cell shows in `timeZone` (default UTC), so the server and the
 * browser render the same text.
 */
import { humanizeFieldName } from '../../screens/fields.js';
import type { FieldRole, ScreenFieldRoles } from '../../screens/roles.js';
import type { ScreenCollectionDefinition } from '../../screens/types.js';
import { formatScreenValue } from '../../screens/values.js';
import {
  isRecord,
  type RecordListColumn,
  type RecordListRow,
  type RecordStatusTone,
} from './data.js';

/** Column keys: `[A-Za-z_][A-Za-z0-9_.-]{0,63}`, the overview identifier shape. */
const COLUMN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** At most this many columns render (the widget is compact). */
export const RECORD_TABLE_MAX_COLUMNS = 6;
/** At most this many rows render. */
export const RECORD_TABLE_MAX_ROWS = 50;

/**
 * The `columns` widget option: a comma-separated list of field names
 * (`"number,status,issuedAt,totalAmount"`). Options are flat JSON
 * primitives, so a list travels as text; invalid or repeated keys are
 * dropped and the list is capped at {@link RECORD_TABLE_MAX_COLUMNS}.
 */
export function parseColumnsOption(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const key = part.trim();
    if (!COLUMN_KEY.test(key) || out.includes(key)) continue;
    out.push(key);
    if (out.length === RECORD_TABLE_MAX_COLUMNS) break;
  }
  return out;
}

/** The inverse of {@link parseColumnsOption}. */
export function formatColumnsOption(columns: readonly string[]): string {
  return columns.join(',');
}

/** Roles that render one column each, in table order. */
const COLUMN_ROLE_ORDER: readonly FieldRole[] = [
  'identifier',
  'status',
  'date',
  'party',
  'total',
  'money',
];

/** A records column's role: the first of its roles a table renders specially. */
function renderRole(roles: readonly FieldRole[]): FieldRole | undefined {
  for (const role of [
    'identifier',
    'status',
    'date',
    'money',
    'quantity',
    'party',
    'title',
  ] as const) {
    if (roles.includes(role)) return role;
  }
  return undefined;
}

/**
 * Columns a related-records table shows for a child model, chosen by role:
 * identifier (else the title), status, the lead date, a party other than the
 * parent link, and the amount (the record's total, else its first money
 * field). `exclude` drops the FK back to the parent.
 */
export function relatedColumns(
  definition: ScreenCollectionDefinition,
  roles: ScreenFieldRoles,
  options: { exclude?: readonly string[]; max?: number } = {},
): RecordListColumn[] {
  const exclude = new Set(options.exclude ?? []);
  const max = options.max ?? 4;
  const names = Object.keys(roles).filter(
    (name) => !exclude.has(name) && name in definition.fields,
  );
  const pick = (role: FieldRole): string | undefined =>
    names.find((name) => roles[name]?.includes(role));
  const chosen: string[] = [];
  const add = (name: string | undefined) => {
    if (name && !chosen.includes(name)) chosen.push(name);
  };
  add(pick('identifier') ?? pick('title'));
  for (const role of COLUMN_ROLE_ORDER) {
    if (role === 'identifier') continue;
    if (role === 'money' && chosen.some((n) => roles[n]?.includes('money')))
      continue;
    if (role === 'date') {
      // The lead date: a business date before the system timestamps.
      add(
        names.find(
          (n) =>
            roles[n]?.includes('date') &&
            n !== 'createdAt' &&
            n !== 'updatedAt',
        ) ?? pick('date'),
      );
      continue;
    }
    add(pick(role));
  }
  return chosen.slice(0, max).map((name) => ({
    key: name,
    label: humanizeColumnLabel(name, definition),
    ...(renderRole(roles[name] ?? [])
      ? { role: renderRole(roles[name] ?? []) }
      : {}),
  }));
}

/**
 * Columns of a line-items table: the item (description / title / name),
 * quantity, unit price and the line amount. `unitPrice` is the money field
 * named like a unit price; the amount is the last other money field.
 */
export function lineItemColumns(
  definition: ScreenCollectionDefinition,
  roles: ScreenFieldRoles,
  options: { exclude?: readonly string[] } = {},
): RecordListColumn[] {
  const exclude = new Set(options.exclude ?? []);
  const names = Object.keys(roles).filter(
    (name) => !exclude.has(name) && name in definition.fields,
  );
  const textNames = names.filter((n) => definition.fields[n]?.type === 'text');
  const item =
    textNames.find((n) => /^(?:description|title|name|label)$/.test(n)) ??
    textNames.find((n) => roles[n]?.includes('title')) ??
    textNames.find((n) => !roles[n]?.includes('identifier'));
  const quantity = names.find((n) => roles[n]?.includes('quantity'));
  const money = names.filter((n) => roles[n]?.includes('money'));
  const unit = money.find((n) => /unit|price|rate/i.test(n));
  const amount =
    money.find((n) => /^(?:amount|lineTotal|total|lineAmount)$/.test(n)) ??
    [...money].reverse().find((n) => n !== unit);
  const out: RecordListColumn[] = [];
  if (item)
    out.push({ key: item, label: humanizeColumnLabel(item, definition) });
  if (quantity)
    out.push({
      key: quantity,
      label: humanizeColumnLabel(quantity, definition),
      role: 'quantity',
    });
  if (unit)
    out.push({
      key: unit,
      label: humanizeColumnLabel(unit, definition),
      role: 'money',
    });
  if (amount && amount !== unit)
    out.push({
      key: amount,
      label: humanizeColumnLabel(amount, definition),
      role: 'money',
    });
  return out;
}

function humanizeColumnLabel(
  name: string,
  definition: ScreenCollectionDefinition,
): string {
  const field = definition.fields[name];
  if (
    field &&
    (field.type === 'foreignKey' || field.type === 'crossPackageRef') &&
    /.[a-z]Id$/.test(name)
  ) {
    return humanizeFieldName(name.slice(0, -2));
  }
  return humanizeFieldName(name);
}

/** Common status values and their badge tone; anything else is neutral. */
export const DEFAULT_STATUS_TONES: Readonly<Record<string, RecordStatusTone>> =
  {
    active: 'success',
    accepted: 'success',
    approved: 'success',
    completed: 'success',
    confirmed: 'success',
    delivered: 'success',
    fulfilled: 'success',
    paid: 'success',
    settled: 'success',
    shipped: 'success',
    open: 'info',
    pending: 'info',
    processing: 'info',
    sent: 'info',
    viewed: 'info',
    partial: 'warning',
    overdue: 'warning',
    on_hold: 'warning',
    suspended: 'warning',
    declined: 'error',
    failed: 'error',
    rejected: 'error',
    refunded: 'default',
    cancelled: 'default',
    canceled: 'default',
    draft: 'default',
    inactive: 'default',
    void: 'default',
    written_off: 'default',
  };

/** Badge tone of a status value: `tones`, then the defaults, else neutral. */
export function statusTone(
  value: unknown,
  tones?: Readonly<Record<string, RecordStatusTone>>,
): RecordStatusTone {
  if (typeof value !== 'string') return 'default';
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (
    tones?.[value] ?? tones?.[key] ?? DEFAULT_STATUS_TONES[key] ?? 'default'
  );
}

/** `in_progress` -> `In progress`: a status value as a badge label. */
export function statusLabel(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  return humanizeFieldName(value.trim());
}

export interface RecordCellContext {
  currency?: string;
  locale?: string;
  timeZone?: string;
}

/** A cell's text, by its column role. Empty values are `''`. */
export function formatRecordCell(
  column: Pick<RecordListColumn, 'role'>,
  value: unknown,
  context: RecordCellContext = {},
): string {
  if (value === null || value === undefined || value === '') return '';
  switch (column.role) {
    case 'money':
      return formatScreenValue({ kind: 'money' }, value, {
        currency: context.currency,
        locale: context.locale,
      });
    case 'date':
      if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}/.test(value))
        return value;
      return formatScreenValue(
        { kind: 'datetime', definition: { format: 'date' } },
        value,
        { locale: context.locale, timeZone: context.timeZone ?? 'UTC' },
      );
    case 'quantity':
      return formatScreenValue({ kind: 'decimal' }, value, {
        locale: context.locale,
      });
    case 'status':
      return statusLabel(value);
    default:
      if (typeof value === 'number')
        return formatScreenValue({ kind: 'decimal' }, value, {
          locale: context.locale,
        });
      if (typeof value === 'boolean') return value ? '✓' : '';
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/** True for the roles a footer sums. */
export function isSummedRole(role: FieldRole | undefined): boolean {
  return role === 'money' || role === 'quantity';
}

/**
 * Rows of untrusted widget data, validated: a row needs a string `title`
 * (or any cells), ids default to the position, `cells` must be an object.
 */
export function readRecordRows(data: unknown): RecordListRow[] {
  if (!isRecord(data) || !Array.isArray(data.rows)) return [];
  const out: RecordListRow[] = [];
  for (const row of data.rows.slice(0, RECORD_TABLE_MAX_ROWS)) {
    if (!isRecord(row)) continue;
    const cells = isRecord(row.cells) ? row.cells : undefined;
    if (typeof row.title !== 'string' && !cells) continue;
    out.push({
      id: typeof row.id === 'string' ? row.id : String(out.length),
      title: typeof row.title === 'string' ? row.title : '',
      ...(typeof row.subtitle === 'string' ? { subtitle: row.subtitle } : {}),
      ...(typeof row.meta === 'string' ? { meta: row.meta } : {}),
      ...(typeof row.href === 'string' ? { href: row.href } : {}),
      ...(cells ? { cells } : {}),
    });
  }
  return out;
}

const ROLES: ReadonlySet<string> = new Set([
  'title',
  'identifier',
  'status',
  'money',
  'quantity',
  'date',
  'party',
  'subtotal',
  'tax',
  'discount',
  'total',
]);

/**
 * The columns to render: `keys` (the `columns` option) when given, else the
 * data's own `columns`; a key's label and role come from the data's column
 * list, else a humanized label and no role.
 */
export function resolveRecordColumns(
  keys: readonly string[],
  dataColumns: unknown,
): RecordListColumn[] {
  const declared: RecordListColumn[] = [];
  if (Array.isArray(dataColumns)) {
    for (const entry of dataColumns) {
      if (!isRecord(entry) || typeof entry.key !== 'string') continue;
      if (!COLUMN_KEY.test(entry.key)) continue;
      declared.push({
        key: entry.key,
        label:
          typeof entry.label === 'string' && entry.label !== ''
            ? entry.label
            : humanizeFieldName(entry.key),
        ...(typeof entry.role === 'string' && ROLES.has(entry.role)
          ? { role: entry.role as FieldRole }
          : {}),
      });
    }
  }
  const order = keys.length > 0 ? keys : declared.map((c) => c.key);
  return order.slice(0, RECORD_TABLE_MAX_COLUMNS).map(
    (key) =>
      declared.find((c) => c.key === key) ?? {
        key,
        label: humanizeFieldName(key),
      },
  );
}
