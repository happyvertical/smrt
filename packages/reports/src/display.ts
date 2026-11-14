/** Component-free display utilities for server exports and browser hosts. */
import type { RuntimeReportResult } from './runtime-compiler.js';

type Column = RuntimeReportResult['columns'][number];

/** Validate untrusted result data before formatting, including integer precision. */
export function validReportResult(
  value: unknown,
): value is RuntimeReportResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as RuntimeReportResult;
  return (
    r.version === 1 &&
    typeof r.title === 'string' &&
    typeof r.specHash === 'string' &&
    typeof r.ranAt === 'string' &&
    typeof r.truncated === 'boolean' &&
    Array.isArray(r.columns) &&
    r.columns.length > 0 &&
    r.columns.length <= 10 &&
    new Set(r.columns.map((c) => c?.id)).size === r.columns.length &&
    r.columns.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.label === 'string' &&
        ['dimension', 'measure'].includes(c.role) &&
        ['string', 'integer', 'decimal', 'boolean', 'datetime', 'id'].includes(
          c.type,
        ),
    ) &&
    Array.isArray(r.rows) &&
    r.rows.length <= 1000 &&
    r.rowCount === r.rows.length &&
    r.rows.every(
      (row) =>
        row &&
        typeof row === 'object' &&
        r.columns.every((c) => {
          const v = row[c.id];
          if (v === null) return true;
          if (c.type === 'integer')
            return typeof v === 'number' && Number.isSafeInteger(v);
          if (c.type === 'decimal')
            return typeof v === 'number' && Number.isFinite(v);
          if (c.type === 'boolean') return typeof v === 'boolean';
          return typeof v === 'string';
        }),
    ) &&
    !!r.chart &&
    ['bar', 'line', 'table', 'pie', 'stat'].includes(r.chart.type) &&
    (r.chart.y === undefined ||
      (Array.isArray(r.chart.y) &&
        r.chart.y.every((id) =>
          r.columns.some((c) => c.id === id && c.role === 'measure'),
        ))) &&
    (r.chart.x === undefined || r.columns.some((c) => c.id === r.chart.x))
  );
}

/**
 * A cell as CSV text: quoted when needed, and a text cell is never read as a
 * formula. A number column's cell ("-$5.00", "-3") is left as a number.
 */
function csvCell(text: string, numeric = false): string {
  const safe = !numeric && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The result as CSV with the screen's own formatting (labels, buckets, money). */
export function reportCsv(
  result: RuntimeReportResult,
  cell: (
    value: unknown,
    column: Column,
    row: RuntimeReportResult['rows'][number],
  ) => string,
): string {
  const lines = [
    result.columns.map((column) => csvCell(column.label)).join(','),
    ...result.rows.map((row) =>
      result.columns
        .map((column) =>
          csvCell(
            cell(row[column.id], column, row),
            (column.type === 'integer' || column.type === 'decimal') &&
              typeof row[column.id] === 'number',
          ),
        )
        .join(','),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}
