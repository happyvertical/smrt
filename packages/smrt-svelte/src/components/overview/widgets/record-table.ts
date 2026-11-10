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
import type { FieldRole } from '../../screens/roles.js';
import { formatScreenValue } from '../../screens/values.js';
import {
  isRecord,
  type RecordListColumn,
  type RecordListRow,
  type RecordStatusTone,
} from './data.js';

export { lineItemColumns, relatedColumns } from '../../screens/columns.js';

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
export function parseColumnsOption(
  value: unknown,
  max: number = RECORD_TABLE_MAX_COLUMNS,
): string[] {
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const key = part.trim();
    if (!COLUMN_KEY.test(key) || out.includes(key)) continue;
    out.push(key);
    if (out.length === max) break;
  }
  return out;
}

/** The inverse of {@link parseColumnsOption}. */
export function formatColumnsOption(columns: readonly string[]): string {
  return columns.join(',');
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

/** True when the footer sums this column (`summarize`, else by role). */
export function isSummedColumn(
  column: Pick<RecordListColumn, 'role' | 'summarize'>,
): boolean {
  return column.summarize ?? isSummedRole(column.role);
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
        ...(typeof entry.summarize === 'boolean'
          ? { summarize: entry.summarize }
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
