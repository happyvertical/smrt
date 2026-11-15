/**
 * The in-batch row check of the retire step (#5005).
 *
 * The plan counts a retired table's rows before the run, outside any
 * transaction. A writer (an old instance in a rolling deploy) can insert after
 * that count and before the drop. So a retirement without `rows: 'discard'`
 * counts again inside the atomic batch, right before its `DROP TABLE`, and the
 * whole batch rolls back when rows appeared.
 *
 * - PostgreSQL: the batch takes `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE`
 *   first (inside a `DO` block that tolerates a table another run dropped
 *   meanwhile), so no writer can get a row in between the second count and
 *   the drop, and the count's snapshot is taken after the lock.
 * - DuckDB: there are no table locks, and the batch's snapshot is fixed when
 *   it starts: a row another connection commits after that is invisible to
 *   the count and is dropped with the table, with no conflict raised. So the
 *   DuckDB check also compares the table's physical row count
 *   (`duckdb_tables().estimated_size`, which counts every committed row,
 *   whatever the snapshot) with the one the plan read: any growth is rows.
 * - SQLite: one writer at a time; a writer that commits after the batch's
 *   snapshot makes the batch's own write fail, never succeed silently.
 *
 * The check is one plain `SELECT` statement in the migration, recognised by
 * its column alias: the tracker runs it like every other statement and reads
 * the count it returns (see `checkRetireRowsGuard`). When the table is gone
 * by then (another migrate run dropped it first), there is nothing to count
 * or drop, and the tracker skips the check (`runRetireAwareStatement`).
 * Import-free apart from identifier quoting, so the tracker can load it.
 */
import { quoteStringLiteral } from '../schema/sql-identifiers.js';

/** The column alias that marks the statement as the retire step's row check. */
const GUARD_ALIAS = 'smrt_retire_guard_rows';

const QUOTED = '"((?:[^"]|"")+)"';
const GUARD = new RegExp(
  `^\\s*SELECT COUNT\\(\\*\\)(?: \\+ \\(SELECT COUNT\\(\\*\\) FROM duckdb_tables\\(\\) WHERE [^\\n]*? AND estimated_size > \\d+\\))? AS "${GUARD_ALIAS}" FROM (?:${QUOTED}\\.)?${QUOTED}\\s*$`,
);

const unquote = (value: string) => value.replace(/""/g, '"');

/**
 * The row check for `qualifiedTable` (already quoted, schema-qualified where
 * it applies). On DuckDB pass `duckdbPhysicalRows`, the table's
 * `estimated_size` when the plan counted it: growth past it counts as rows.
 */
export function retireRowsGuardSql(
  qualifiedTable: string,
  options: { table?: string; duckdbPhysicalRows?: number } = {},
): string {
  const growth =
    options.duckdbPhysicalRows !== undefined && options.table !== undefined
      ? ` + (SELECT COUNT(*) FROM duckdb_tables() WHERE ${duckdbTableMatch(options.table)} AND estimated_size > ${Math.max(0, Math.trunc(options.duckdbPhysicalRows))})`
      : '';
  return `SELECT COUNT(*)${growth} AS "${GUARD_ALIAS}" FROM ${qualifiedTable}`;
}

/** `duckdb_tables()` / `duckdb_columns()` filter for one table of this schema. */
export function duckdbTableMatch(table: string): string {
  return `database_name = current_database() AND schema_name = current_schema() AND lower(table_name) = lower(${quoteStringLiteral(table)})`;
}

/**
 * PostgreSQL: lock the table against every writer for the rest of the batch.
 * A table another migrate run dropped meanwhile (the lock waited on that
 * run's drop) is nothing to lock: the row check and `DROP TABLE IF EXISTS`
 * that follow then have nothing to do.
 */
export function retireLockSql(qualifiedTable: string): string {
  return `DO $smrt_retire$ BEGIN LOCK TABLE ${qualifiedTable} IN ACCESS EXCLUSIVE MODE; EXCEPTION WHEN undefined_table THEN NULL; END $smrt_retire$`;
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

function rowsOf(result: unknown): unknown[] | null {
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? rows : null;
}

function firstCount(result: unknown): number | null {
  const rows = rowsOf(result);
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  const value = row[GUARD_ALIAS] ?? Object.values(row)[0];
  const n = Number(typeof value === 'bigint' ? value : String(value));
  return Number.isFinite(n) ? n : null;
}

/** The table a row check counts, or undefined when `sql` is not one. */
export function retireGuardTarget(
  sql: string,
): { schema?: string; table: string } | undefined {
  const match = GUARD.exec(sql);
  if (!match) return undefined;
  return {
    ...(match[1] !== undefined ? { schema: unquote(match[1]) } : {}),
    table: unquote(match[2]),
  };
}

/**
 * After a statement ran: when it is a retire row check, throw
 * {@link RetiredTableRowsAppearedError} unless it counted zero rows. A count
 * that cannot be read is treated as rows: the table is not dropped.
 */
export function checkRetireRowsGuard(sql: string, result: unknown): void {
  const target = retireGuardTarget(sql);
  if (!target) return;
  const n = firstCount(result);
  if (n === 0) return;
  throw new RetiredTableRowsAppearedError(target.table, n ?? Number.NaN);
}

/** A statement that returns a row when the guarded table is live. */
function liveTableSql(
  engine: string,
  target: { schema?: string; table: string },
): string | undefined {
  const table = quoteStringLiteral(target.table);
  if (engine === 'postgres')
    return `SELECT 1 AS live FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${target.schema !== undefined ? quoteStringLiteral(target.schema) : 'current_schema()'} AND c.relname = ${table} AND c.relkind IN ('r', 'p')`;
  if (engine === 'duckdb')
    return `SELECT 1 AS live FROM duckdb_tables() WHERE ${duckdbTableMatch(target.table)}`;
  if (engine === 'sqlite')
    return `SELECT 1 AS live FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(${table})`;
  return undefined;
}

/**
 * Run one batch statement through `run` (the batch's own transaction), with
 * the retire row check applied. A row check whose table is already gone (a
 * concurrent migrate run dropped it) is skipped: nothing to count, and the
 * `DROP TABLE IF EXISTS` after it has nothing to do (#5005 T2).
 */
export async function runRetireAwareStatement(
  run: (sql: string) => Promise<unknown>,
  engine: string,
  sql: string,
): Promise<unknown> {
  const target = retireGuardTarget(sql);
  if (target) {
    const probe = liveTableSql(engine, target);
    if (probe) {
      const rows = rowsOf(await run(probe));
      if (rows && rows.length === 0) return undefined;
    }
  }
  const result = await run(sql);
  checkRetireRowsGuard(sql, result);
  return result;
}

/** Whether `error` is the in-batch row check's stop. */
export function isRetiredTableRowsAppeared(
  error: unknown,
): error is RetiredTableRowsAppearedError {
  return error instanceof RetiredTableRowsAppearedError;
}
