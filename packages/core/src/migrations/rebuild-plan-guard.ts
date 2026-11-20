/**
 * The check a table rebuild makes before it touches anything: is the table
 * still the one the plan was built from?
 *
 * A rebuild replaces a table. Its plan holds the table's definition, its
 * column list and its indexes and triggers as they were read when the
 * migration was planned, and the new table is built from exactly those. On
 * SQLite and DuckDB nothing holds the table between planning and applying, so
 * another connection can change it in that window: a column it adds is not in
 * the plan, is not copied, and goes with the old table when it is dropped,
 * with everything written to it.
 *
 * So every rebuild plan starts with statements that compare the live
 * definitions with the planned ones inside the rebuild's own transaction and
 * fail it when they differ (`sqlite-rebuild.ts`, `duckdb-rebuild.ts`). They
 * are part of the plan, so they hold for every executor: the tracker, the CLI,
 * and a caller that runs the statements itself. The failure carries
 * {@link REBUILD_PLAN_STALE_MARKER}; {@link asTableChangedSincePlan} turns it
 * into the named error.
 */

/** Present in every "the table changed since the plan" failure, on either engine. */
export const REBUILD_PLAN_STALE_MARKER =
  'smrt table rebuild refused: the table changed after the migration was planned';

/** What the guard for `tableName` reports when it fails. */
export function rebuildPlanStaleMessage(tableName: string): string {
  // Quoted as an identifier, so the name reads back whole whatever it holds.
  return `${REBUILD_PLAN_STALE_MARKER}: "${tableName.replace(/"/g, '""')}". Nothing was changed; run the migrate again`;
}

/**
 * A table rebuild found the table changed since the migration was planned and
 * stopped. The batch was rolled back: no table, row or index changed. Running
 * the migrate again plans from the table as it is now.
 */
export class TableChangedSincePlanError extends Error {
  constructor(
    /** The table that changed, when the database's message names it. */
    readonly table: string | null,
    options?: { cause?: unknown },
  ) {
    super(
      `The table ${table ? `"${table}" ` : ''}changed after this migration was planned, so its rebuild was not run: it would have been built from the old definition, and anything added since would have been lost. Nothing was changed. Run the migrate again to plan from the table as it is now.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'TableChangedSincePlanError';
  }
}

/**
 * The named error for a failure raised by a rebuild's plan guard, or `null`
 * for any other failure. Reads the message of the error and of its causes: the
 * SQL adapter wraps the database's own error.
 */
export function asTableChangedSincePlan(
  error: unknown,
): TableChangedSincePlanError | null {
  if (error instanceof TableChangedSincePlanError) return error;
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      const table = staleTableIn(current);
      if (table !== undefined)
        return new TableChangedSincePlanError(table, { cause: error });
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const details = current as {
      message?: unknown;
      cause?: unknown;
      originalError?: unknown;
      context?: unknown;
      details?: unknown;
    };
    pending.push(
      details.message,
      details.cause,
      details.originalError,
      details.context,
      details.details,
    );
  }
  return null;
}

/** The table a guard failure names, `null` when it names none, `undefined` when `text` is no such failure. */
function staleTableIn(text: string): string | null | undefined {
  const at = text.indexOf(REBUILD_PLAN_STALE_MARKER);
  if (at === -1) return undefined;
  const named = /^: "((?:[^"]|"")+)"/.exec(
    text.slice(at + REBUILD_PLAN_STALE_MARKER.length),
  );
  return named ? named[1].replace(/""/g, '"') : null;
}
