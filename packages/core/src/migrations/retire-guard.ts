/**
 * The in-batch row check of the retire step (#5005).
 *
 * The plan counts a retired table's rows before the run, outside any
 * transaction. A writer (an old instance in a rolling deploy) can insert after
 * that count and before the drop. So a retirement without `rows: 'discard'`
 * counts again inside the atomic batch, right before its `DROP TABLE`, and the
 * whole batch rolls back when rows appeared. On PostgreSQL the batch takes
 * `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` first, so no writer can get a row
 * in between the second count and the drop.
 *
 * The check is one plain `SELECT` statement in the migration, recognised by
 * its column alias: the tracker runs it like every other statement and reads
 * the count it returns (see `checkRetireRowsGuard`). Import-free apart from
 * identifier quoting, so the tracker can load it.
 */

/** The column alias that marks the statement as the retire step's row check. */
const GUARD_ALIAS = 'smrt_retire_guard_rows';

const GUARD =
  /^\s*SELECT COUNT\(\*\) AS "smrt_retire_guard_rows" FROM ((?:"(?:[^"]|"")+"\.)?"((?:[^"]|"")+)")\s*$/;

/** The row check for `qualifiedTable` (already quoted, schema-qualified where it applies). */
export function retireRowsGuardSql(qualifiedTable: string): string {
  return `SELECT COUNT(*) AS "${GUARD_ALIAS}" FROM ${qualifiedTable}`;
}

/** Rows appeared in a retired table between the plan and the drop. */
export class RetiredTableRowsAppearedError extends Error {
  /** The named stop this is: the same as a plan-time row count. */
  readonly kind = 'table.retire-rows' as const;
  constructor(
    readonly table: string,
    readonly rows: number,
  ) {
    super(
      `table.retire-rows: ${table} holds ${Number.isNaN(rows) ? 'rows (they could not be counted)' : `${rows} row(s)`} that were written after the plan counted it empty, and its retirement does not say rows: 'discard'. Nothing was applied: the whole batch rolled back. Find what still writes to ${table} before it is retired.`,
    );
    this.name = 'RetiredTableRowsAppearedError';
  }
}

function firstCount(result: unknown): number | null {
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  const value = row[GUARD_ALIAS] ?? Object.values(row)[0];
  const n = Number(typeof value === 'bigint' ? value : String(value));
  return Number.isFinite(n) ? n : null;
}

/**
 * After a statement ran: when it is a retire row check, throw
 * {@link RetiredTableRowsAppearedError} unless it counted zero rows. A count
 * that cannot be read is treated as rows: the table is not dropped.
 */
export function checkRetireRowsGuard(sql: string, result: unknown): void {
  const match = GUARD.exec(sql);
  if (!match) return;
  const n = firstCount(result);
  if (n === 0) return;
  throw new RetiredTableRowsAppearedError(
    match[2].replace(/""/g, '"'),
    n ?? Number.NaN,
  );
}

/** Whether `error` is the in-batch row check's stop. */
export function isRetiredTableRowsAppeared(
  error: unknown,
): error is RetiredTableRowsAppearedError {
  return error instanceof RetiredTableRowsAppearedError;
}
