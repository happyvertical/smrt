/** Component-free display utilities for server exports and browser hosts. */
import type { RuntimeReportResult } from './runtime-compiler.js';

type Column = RuntimeReportResult['columns'][number];

export { validReportResult } from './svelte/result.js';

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
