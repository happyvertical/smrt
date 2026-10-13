/**
 * Column summaries for `DataTable` (`summaries` prop): a footer row with a
 * count, sum or average per column, or a caller-computed string.
 *
 * Pure and Svelte-free so the arithmetic is Node-tested. Sums never leave
 * integers while every summed value is a safe integer: money in integer minor
 * units stays in minor units until the column's `summaryFormat` turns it into
 * text, so a footer never adds floating-point cents. A sum that would leave
 * the safe-integer range is refused (`null`, an empty cell) rather than
 * rounded.
 */
import type { DataTableColumn, DataTableStructuralRow } from './types.js';
import { getNestedValue } from './types.js';

/** A built-in aggregate. */
export type DataTableSummaryKind = 'sum' | 'count' | 'avg';

/** A built-in aggregate, or a function that renders the cell from the rows. */
export type DataTableSummary<T> =
  | DataTableSummaryKind
  | ((rows: readonly T[]) => string);

/** Summary per column id. Columns without an entry get an empty footer cell. */
export type DataTableSummaries<T> = Readonly<
  Record<string, DataTableSummary<T>>
>;

/** What a column's `summaryFormat` is told about the value it formats. */
export interface DataTableSummaryFormatContext {
  kind: DataTableSummaryKind;
  columnId: string;
  /** The table's active locale. */
  locale?: string;
}

/** True for the aggregates whose cells are numbers (right-aligned by default). */
export function isNumericSummary(summary: unknown): boolean {
  return summary === 'sum' || summary === 'avg';
}

function cellValue<T>(row: T, column: DataTableColumn<T>): unknown {
  return getNestedValue(row, String(column.accessor ?? column.id));
}

/**
 * Sum of the finite numeric values of `column` (numeric strings count too).
 * Integer-only input stays exact and returns `null` past
 * `Number.MAX_SAFE_INTEGER`; `null` too when no row has a number.
 */
export function sumDataTableColumn<T>(
  rows: readonly T[],
  column: DataTableColumn<T>,
): number | null {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = toNumber(cellValue(row, column));
    if (value === null) continue;
    seen = true;
    total += value;
    if (Number.isInteger(value) && !Number.isSafeInteger(total)) return null;
  }
  return seen ? total : null;
}

/** Mean of the finite numeric values of `column`; `null` when there are none. */
export function averageDataTableColumn<T>(
  rows: readonly T[],
  column: DataTableColumn<T>,
): number | null {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const value = toNumber(cellValue(row, column));
    if (value === null) continue;
    total += value;
    count += 1;
  }
  return count === 0 ? null : total / count;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The raw value of one summary: a number for the aggregates, text for a function. */
export function summarizeDataTableColumn<T>(
  rows: readonly T[],
  column: DataTableColumn<T>,
  summary: DataTableSummary<T>,
): number | string | null {
  if (typeof summary === 'function') return summary(rows);
  if (summary === 'count') return rows.length;
  if (summary === 'sum') return sumDataTableColumn(rows, column);
  if (summary === 'avg') return averageDataTableColumn(rows, column);
  return null;
}

/** Default text of an aggregate: `Intl.NumberFormat` in the table's locale. */
export function formatDataTableSummary(
  value: number,
  context: DataTableSummaryFormatContext,
): string {
  try {
    return new Intl.NumberFormat(context.locale, {
      maximumFractionDigits: context.kind === 'avg' ? 2 : 6,
    }).format(value);
  } catch {
    return String(value);
  }
}

export interface DataTableSummaryRowOptions {
  /** Structural row id (default `summary`). */
  id?: string;
  /** Row label, announced and shown in the first column when it has no summary. */
  label: string;
  locale?: string;
}

/**
 * The footer row for `summaries` over `rows`, as a `footer` structural row
 * (`DataTable` renders it in `<tfoot>`). `null` when no visible column has a
 * summary. Each aggregate goes through the column's `summaryFormat`, else
 * {@link formatDataTableSummary}; a function summary's text is used as is.
 */
export function buildDataTableSummaryRow<T>(
  rows: readonly T[],
  columns: readonly DataTableColumn<T>[],
  summaries: DataTableSummaries<T> | undefined,
  options: DataTableSummaryRowOptions,
): DataTableStructuralRow<T> | null {
  if (!summaries) return null;
  const values: Record<string, string> = {};
  let any = false;
  for (const column of columns) {
    if (column.hidden) continue;
    const summary = summaries[column.id];
    if (summary === undefined) continue;
    any = true;
    const raw = summarizeDataTableColumn(rows, column, summary);
    if (raw === null) {
      values[column.id] = '';
    } else if (typeof raw === 'string') {
      values[column.id] = raw;
    } else {
      const context: DataTableSummaryFormatContext = {
        kind: summary as DataTableSummaryKind,
        columnId: column.id,
        locale: options.locale,
      };
      values[column.id] = column.summaryFormat
        ? column.summaryFormat(raw, context)
        : formatDataTableSummary(raw, context);
    }
  }
  if (!any) return null;
  return {
    id: options.id ?? 'summary',
    kind: 'footer',
    label: options.label,
    values,
  };
}
