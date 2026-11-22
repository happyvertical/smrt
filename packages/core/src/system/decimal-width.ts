/**
 * The DOUBLE PRECISION system columns, widened on start (P5a, E8).
 *
 * Six system columns were a 4-byte REAL on older PostgreSQL and DuckDB
 * installs: `_smrt_contexts.confidence`, `_smrt_ai_usage.estimated_cost`,
 * the three `_smrt_ai_runs` cost columns and `_smrt_ai_run_events.reserved_cost`.
 * {@link widenSystemDecimalColumns} runs on every start, outside the schema
 * version gate: one width probe per column, nothing more once DOUBLE.
 *
 * A 4-byte column is the state before the upgrade, not damage, so a known
 * blocker never stops a start. It defers the widening with a warning, and the
 * next start tries again:
 *
 * - DuckDB (and the JSON adapter, in memory): the column is widened through
 *   the migration planner's guarded table rebuild, in its own transaction. A
 *   view that projects it or does not bind, a dependency-tracked view, a
 *   table group the rebuild cannot copy, or a guard that saw the database
 *   change, defers it. Any other failure (disk, I/O, a defect) still fails
 *   the start.
 * - PostgreSQL: each `ALTER … TYPE DOUBLE PRECISION` runs in a savepoint of
 *   its own transaction, under the system-table bootstrap lock with a 5 s
 *   lock timeout; any failure rolls back to the savepoint and defers that
 *   column (the warning carries the SQLSTATE).
 *
 * Inside a caller's transaction (a transaction callback handle, a
 * `beginTransaction()` handle) nothing is attempted: the widening must never
 * take locks or fail inside someone else's transaction. SQLite stores REAL as
 * an 8-byte float already.
 */
import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { isCommentOnlySql } from '../migrations/change-kinds.js';
import { planDuckDbTableChanges } from '../migrations/duckdb-rebuild.js';
import { asTableChangedSincePlan } from '../migrations/rebuild-plan-guard.js';
import {
  asDependentObjectError,
  asViewProbeFailure,
  asViewsChangedSincePlan,
  errorMessages,
} from '../migrations/view-guard.js';
import { quoteIdentifier } from '../schema/sql-identifiers.js';
import {
  getDatabaseEngine,
  SYSTEM_TABLE_BOOTSTRAP_LOCK_SQL,
} from './compatibility.js';

const logger = createLogger({ level: 'info' });

/** The system columns declared DOUBLE PRECISION that older installs hold as REAL. */
export const SYSTEM_DECIMAL_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
}> = [
  { table: '_smrt_contexts', column: 'confidence' },
  { table: '_smrt_ai_usage', column: 'estimated_cost' },
  { table: '_smrt_ai_runs', column: 'cost_used' },
  { table: '_smrt_ai_runs', column: 'inclusive_cost' },
  { table: '_smrt_ai_runs', column: 'reserved_cost' },
  { table: '_smrt_ai_run_events', column: 'reserved_cost' },
];

/** What one start did with one system column. */
export interface SystemDecimalWidening {
  table: string;
  column: string;
  /**
   * `widened` now; `current` already DOUBLE (or an engine where REAL is 8
   * bytes); `absent` no such table or column; `deferred` a blocker held it
   * (see `reason`); `not-attempted` inside a caller's transaction or on an
   * adapter without transactions.
   */
  outcome: 'widened' | 'current' | 'absent' | 'deferred' | 'not-attempted';
  reason?: string;
}

const NARROW = new Set(['FLOAT', 'REAL', 'FLOAT4']);

/** Whether `db` is a handle already inside someone's transaction. */
const insideTransaction = (db: DatabaseInterface) => {
  const handle = db as { commit?: unknown; rollback?: unknown };
  return (
    typeof handle.commit === 'function' && typeof handle.rollback === 'function'
  );
};

/**
 * A transaction refused because the handle is already inside one. Matched by
 * name: the core root must not load `@happyvertical/sql` at boot.
 */
const isNestedRefusal = (error: unknown) =>
  (error instanceof Error && error.name === 'NestedTransactionError') ||
  errorMessages(error).some((message) =>
    /within a transaction|Nested transactions are not supported/i.test(message),
  );

const byTable = () => {
  const tables = new Map<string, string[]>();
  for (const { table, column } of SYSTEM_DECIMAL_COLUMNS)
    tables.set(table, [...(tables.get(table) ?? []), column]);
  return tables;
};

/**
 * Widen every 4-byte system decimal column of this database to DOUBLE, and
 * report what was done per column. Known blockers defer a column; any other
 * failure is thrown.
 */
export async function widenSystemDecimalColumns(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<SystemDecimalWidening[]> {
  const engine = getDatabaseEngine(db, typeHint);
  if (engine === 'postgres') return widenPostgres(db);
  if (engine === 'duckdb' || engine === 'json') return widenDuckDb(db);
  return SYSTEM_DECIMAL_COLUMNS.map(({ table, column }) => ({
    table,
    column,
    outcome: 'current' as const,
  }));
}

/** Log what a start deferred or could not attempt; quiet otherwise. */
export function reportSystemDecimalWidening(
  results: readonly SystemDecimalWidening[],
): void {
  for (const result of results) {
    if (result.outcome === 'deferred')
      logger.warn(
        `[smrt] ${result.table}.${result.column} is still a 4-byte REAL and was not widened to DOUBLE on this start: ${result.reason}. The next start tries again; smrt doctor --db lists it.`,
      );
    else if (result.outcome === 'not-attempted')
      logger.debug(
        `[smrt] ${result.table}.${result.column} widening not attempted: ${result.reason}`,
      );
  }
}

async function columnTypes(
  db: DatabaseInterface,
  table: string,
  postgres: boolean,
): Promise<Map<string, string>> {
  const { rows } = await db.query(
    postgres
      ? `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`
      : `SELECT column_name, data_type FROM duckdb_columns()
          WHERE database_name = current_database() AND schema_name = current_schema() AND table_name = ?`,
    table,
  );
  return new Map(
    rows.map((row) => [String(row.column_name), String(row.data_type)]),
  );
}

async function widenDuckDb(
  db: DatabaseInterface,
): Promise<SystemDecimalWidening[]> {
  const results: SystemDecimalWidening[] = [];
  for (const [table, columns] of byTable()) {
    let types: Map<string, string>;
    try {
      types = await columnTypes(db, table, false);
    } catch (error) {
      // Not a DuckDB catalog after all (the engine is guessed from the URL
      // when no type hint reaches here, #5517): nothing to widen or attempt.
      results.push(
        ...columns.map((column) => ({
          table,
          column,
          outcome: 'not-attempted' as const,
          reason: `the DuckDB catalog could not be read (${errorMessages(error)[0] ?? String(error)})`,
        })),
      );
      continue;
    }
    const narrow = columns.filter((column) =>
      NARROW.has((types.get(column) ?? '').toUpperCase()),
    );
    const settled = (column: string): SystemDecimalWidening => ({
      table,
      column,
      outcome: types.has(column) ? 'current' : 'absent',
    });
    const all = (outcome: SystemDecimalWidening['outcome'], reason?: string) =>
      columns.map((column) =>
        narrow.includes(column)
          ? { table, column, outcome, ...(reason ? { reason } : {}) }
          : settled(column),
      );
    if (narrow.length === 0) {
      results.push(...columns.map(settled));
      continue;
    }
    if (insideTransaction(db)) {
      results.push(...all('not-attempted', "inside a caller's transaction"));
      continue;
    }
    if (typeof db.transaction !== 'function') {
      results.push(
        ...all('not-attempted', 'the database adapter has no transactions'),
      );
      continue;
    }
    // A transaction callback handle: DuckDB has no savepoint, so the nested
    // transaction is refused before it starts and nothing is attempted.
    try {
      await db.transaction(async () => undefined);
    } catch (error) {
      if (!isNestedRefusal(error)) throw error;
      results.push(...all('not-attempted', "inside a caller's transaction"));
      continue;
    }
    const planned = await planDuckDbTableChanges({
      db,
      tableName: table,
      changes: narrow.map((column) => ({
        type: 'type_upgrade' as const,
        table,
        name: column,
        column: { type: 'REAL' as const },
        sql: `ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(column)} TYPE DOUBLE USING ${quoteIdentifier(column)}::DOUBLE`,
      })),
      mapType: () => 'DOUBLE',
      includeTemporaryViews: true,
    });
    // A refused plan carries a comment with the reason instead of SQL; a
    // column folded into the same rebuild carries a "no change needed" note.
    const refused = planned.changes.find(
      (change) =>
        change.kindHint === 'type.rebuild-unavailable' ||
        change.kindHint === 'column.rebuild-unavailable',
    );
    if (refused) {
      results.push(
        ...all('deferred', String(refused.sql).replace(/^\s*--\s*/, '')),
      );
      continue;
    }
    const statements = planned.changes
      .flatMap(
        (change) => change.sqlStatements ?? (change.sql ? [change.sql] : []),
      )
      .filter((sql) => !isCommentOnlySql(sql));
    let failedAt: string | undefined;
    try {
      await db.transaction(async (tx) => {
        for (const sql of statements) {
          failedAt = sql;
          await tx.query(sql);
        }
        failedAt = undefined;
      });
    } catch (error) {
      if (isNestedRefusal(error)) {
        results.push(...all('not-attempted', "inside a caller's transaction"));
        continue;
      }
      // Known blockers defer; anything else fails the start.
      const known =
        asTableChangedSincePlan(error) ??
        asViewsChangedSincePlan(error) ??
        asViewProbeFailure(error, failedAt, {
          migration: `system ${table} widening`,
          tables: [table],
        }) ??
        asDependentObjectError(error);
      if (!known) throw error;
      results.push(...all('deferred', known.message));
      continue;
    }
    results.push(...all('widened'));
  }
  return results;
}

/** The SQLSTATE an error from PostgreSQL carries, if any. */
function sqlStateOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const details = current as Record<string, unknown>;
    if (typeof details.code === 'string' && /^[0-9A-Z]{5}$/.test(details.code))
      return details.code;
    pending.push(
      details.cause,
      details.originalError,
      details.context,
      details.details,
    );
  }
  return undefined;
}

async function widenPostgres(
  db: DatabaseInterface,
): Promise<SystemDecimalWidening[]> {
  // Lock-free probe first: nothing more happens once every column is DOUBLE.
  const probed = new Map<string, Map<string, string>>();
  for (const table of byTable().keys())
    probed.set(table, await columnTypes(db, table, true));
  const results: SystemDecimalWidening[] = SYSTEM_DECIMAL_COLUMNS.map(
    ({ table, column }) => {
      const type = probed.get(table)?.get(column);
      return {
        table,
        column,
        outcome:
          type === undefined
            ? 'absent'
            : type === 'real'
              ? 'deferred'
              : 'current',
      };
    },
  );
  const pending = results.filter((result) => result.outcome === 'deferred');
  if (pending.length === 0) return results;
  // Never inside a caller's transaction: only a root handle (one that can
  // begin a transaction of its own) is widened.
  if (
    insideTransaction(db) ||
    typeof db.beginTransaction !== 'function' ||
    typeof db.transaction !== 'function'
  ) {
    for (const result of pending) {
      result.outcome = 'not-attempted';
      result.reason = "inside a caller's transaction";
    }
    return results;
  }
  try {
    await db.transaction(async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '5s'");
      await tx.query(SYSTEM_TABLE_BOOTSTRAP_LOCK_SQL);
      for (const result of pending) {
        try {
          const run = async (scope: DatabaseInterface) =>
            scope.query(
              `ALTER TABLE ${quoteIdentifier(result.table)} ALTER COLUMN ${quoteIdentifier(result.column)} TYPE DOUBLE PRECISION`,
            );
          if (typeof tx.transaction === 'function') await tx.transaction(run);
          else throw new Error('the transaction handle has no savepoints');
          result.outcome = 'widened';
        } catch (error) {
          const state = sqlStateOf(error);
          const message =
            errorMessages(error).find(
              (text) => !/^Failed to execute/.test(text),
            ) ?? String(error);
          result.reason = `${state ? `SQLSTATE ${state}: ` : ''}${message}`;
        }
      }
    });
  } catch (error) {
    const state = sqlStateOf(error);
    for (const result of pending) {
      if (result.outcome === 'widened') result.outcome = 'deferred';
      result.reason = `${state ? `SQLSTATE ${state}: ` : ''}${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return results;
}
