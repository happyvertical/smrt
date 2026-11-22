/**
 * Views around a DuckDB table rebuild (P5a).
 *
 * DuckDB binds a view's result types when the view is created and keeps no
 * record of the tables it reads, so a view over a column whose type a
 * migration changes fails every later query. SMRT never drops, creates or
 * replaces a view. A plan that changes a column type instead:
 *
 * - is refused at planning while any view of the database does not bind, or a
 *   dependency-tracked view (`enable_view_dependencies`) depends on a table it
 *   rebuilds;
 * - starts with a guard that stops the run when the target database or
 *   schema, any view, or the source column type changed after planning
 *   ({@link REBUILD_PLAN_VIEWS_STALE_MARKER});
 * - ends with one bind probe per view, `SELECT * FROM "db"."schema"."view"
 *   LIMIT 0`, after the last changing statement. A probe that fails rolls the
 *   whole migration back, and the error names the view.
 *
 * The probes carry no comment: a view name can hold any text, and a comment
 * has no quoting. A probe is recognised by its exact shape, three quoted
 * identifiers, and the view is read back from them.
 *
 * Views committed by another connection while the migration runs are outside
 * what the guard can see; the tracker probes every view again after commit and
 * reports a view that no longer binds ({@link ViewInvalidatedAfterCommitWarning}).
 */
import { quoteIdentifier } from '../schema/sql-identifiers.js';
import type { DatabaseInterface } from './types.js';

/** A view by catalog (database), schema and name. */
export interface QualifiedView {
  database: string;
  schema: string;
  name: string;
}

const IDENTIFIER = '"((?:[^"]|"")+)"';
const PROBE_SHAPE = new RegExp(
  `^SELECT \\* FROM ${IDENTIFIER}\\.${IDENTIFIER}\\.${IDENTIFIER} LIMIT 0$`,
);
const unquote = (text: string) => text.replace(/""/g, '"');

/** `"database"."schema"."name"`, as DuckDB resolves it. */
export function qualifiedViewName(view: QualifiedView): string {
  return [view.database, view.schema, view.name]
    .map((part) => quoteIdentifier(part))
    .join('.');
}

/** The bind probe for one view. */
export function viewProbeStatement(view: QualifiedView): string {
  return `SELECT * FROM ${qualifiedViewName(view)} LIMIT 0`;
}

/** The view a bind probe names, or `undefined` when `sql` is not a probe. */
export function parseViewProbe(sql: string): QualifiedView | undefined {
  const match = PROBE_SHAPE.exec(sql);
  return match
    ? {
        database: unquote(match[1]),
        schema: unquote(match[2]),
        name: unquote(match[3]),
      }
    : undefined;
}

/** Present in every "a view or the target database changed" guard failure. */
export const REBUILD_PLAN_VIEWS_STALE_MARKER =
  'smrt table rebuild refused: a view or the target database changed after the migration was planned';

/**
 * A guard at the start of a column type change found the target database or
 * schema, a view, or the source column type different from the plan, and
 * stopped. Nothing was changed. Running the migrate again plans from the
 * database as it is now.
 */
export class ViewsChangedSincePlanError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      'A view or the target database changed after this migration was planned (the current database or schema, a view, or the type of a column it converts), so it was not run. Nothing was changed. Run the migrate again to plan from the database as it is now.',
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ViewsChangedSincePlanError';
  }
}

/**
 * A migration changed the result columns of a view and was rolled back.
 * DuckDB binds a view's result types when it is created, so the view would
 * fail every query after the change.
 */
export class DependentViewTypeError extends Error {
  constructor(
    readonly view: QualifiedView,
    /** The tables the migration changes. */
    readonly tables: string[],
    readonly migration: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(
      `${migration ? `Migration ${migration}` : 'This migration'} changes the result columns of view ${qualifiedViewName(view)}; nothing was changed. The migration changes ${tables.length > 0 ? tables.map((table) => `"${table}"`).join(', ') : 'tables'}. To run it: save the view's SQL, comment and column comments; drop it and every view that reads it; run the migrate; create them again in order (keep a published FLOAT with ::FLOAT where readers expect it) and reapply the comments.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DependentViewTypeError';
  }
}

/**
 * A view could not be checked after a migration's changes (missing file,
 * function, extension or permission) and the migration was rolled back.
 */
export class DependentViewCheckError extends Error {
  constructor(
    readonly view: QualifiedView,
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `View ${qualifiedViewName(view)} could not be checked after the change: ${detail}; nothing was changed. Run the migrate again once the view binds.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DependentViewCheckError';
  }
}

/**
 * DuckDB refused to alter or drop a table because another catalog entry
 * depends on it (a view created with `enable_view_dependencies`), and the
 * migration was rolled back.
 */
export class DependentObjectError extends Error {
  constructor(
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `${detail}; nothing was changed. Drop the dependent views (created with enable_view_dependencies) and run the migrate again.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DependentObjectError';
  }
}

/**
 * The migration carries a table rebuild, a plan guard or a view probe, which
 * hold only when every statement runs in one transaction that rolls back on
 * the first failure; the adapter offers no transaction, so nothing was run.
 */
export class MigrationTransactionRequiredError extends Error {
  constructor(readonly migration: string) {
    super(
      `Migration ${migration} rebuilds a table or checks views, which must run in one transaction, and the database adapter has no transaction support; nothing was run.`,
    );
    this.name = 'MigrationTransactionRequiredError';
  }
}

/**
 * After a migration committed, a view no longer binds. It was not visible to
 * the migration (created by another connection while it ran) or was broken
 * by something else; the migration itself is applied.
 */
export class ViewInvalidatedAfterCommitWarning extends Error {
  constructor(
    readonly view: QualifiedView,
    readonly detail: string,
  ) {
    super(
      `View ${qualifiedViewName(view)} no longer binds after the migration committed: ${detail}. Save its SQL and comments, drop it, and create it again (keep a published FLOAT with ::FLOAT where readers expect it).`,
    );
    this.name = 'ViewInvalidatedAfterCommitWarning';
  }
}

/** Every message in an error and its causes (the SQL adapter wraps errors). */
export function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      messages.push(current);
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const details = current as Record<string, unknown>;
    pending.push(
      details.message,
      details.cause,
      details.originalError,
      details.context,
      details.details,
    );
  }
  return messages;
}

const STALE_VIEW =
  /Contents of view were altered|has \d+ columns available but \d+ columns specified/;

/** The named error for a failed view guard, or `null`. */
export function asViewsChangedSincePlan(
  error: unknown,
): ViewsChangedSincePlanError | null {
  if (error instanceof ViewsChangedSincePlanError) return error;
  return errorMessages(error).some((message) =>
    message.includes(REBUILD_PLAN_VIEWS_STALE_MARKER),
  )
    ? new ViewsChangedSincePlanError({ cause: error })
    : null;
}

/**
 * The named error for a failed bind probe, or `null` when `statement` is not
 * a probe. A probe whose view no longer matches its bound types is a
 * {@link DependentViewTypeError}; any other failure (I/O, a missing function
 * or extension, a permission) is a {@link DependentViewCheckError}.
 */
export function asViewProbeFailure(
  error: unknown,
  statement: string | undefined,
  context: { migration?: string; tables: string[] },
): DependentViewTypeError | DependentViewCheckError | null {
  if (
    error instanceof DependentViewTypeError ||
    error instanceof DependentViewCheckError
  )
    return error;
  const view = statement === undefined ? undefined : parseViewProbe(statement);
  if (!view) return null;
  const messages = errorMessages(error);
  if (messages.some((message) => STALE_VIEW.test(message)))
    return new DependentViewTypeError(view, context.tables, context.migration, {
      cause: error,
    });
  const detail =
    messages.find((message) => !/^Failed to execute/.test(message)) ??
    messages[0] ??
    String(error);
  return new DependentViewCheckError(view, detail, { cause: error });
}

/** The named error for DuckDB's "entries depend on it" refusal, or `null`. */
export function asDependentObjectError(
  error: unknown,
): DependentObjectError | null {
  if (error instanceof DependentObjectError) return error;
  const message = errorMessages(error).find((text) =>
    /Dependency Error: Cannot (alter|drop) entry/.test(text),
  );
  return message
    ? new DependentObjectError(
        message.replace(/^.*?(Dependency Error:)/, '$1'),
        { cause: error },
      )
    : null;
}

const REBUILD_STAGING = /"_smrt_rebuild_/;

/**
 * Whether the statements hold a DuckDB table rebuild, its guard or a view
 * probe: they are only safe in one transaction that rolls back on the first
 * failure.
 */
export function requiresTransaction(statements: readonly string[]): boolean {
  return statements.some(
    (sql) => REBUILD_STAGING.test(sql) || parseViewProbe(sql) !== undefined,
  );
}

/** Whether the statements end with view probes (a DuckDB type change). */
export function hasViewProbes(statements: readonly string[]): boolean {
  return statements.some((sql) => parseViewProbe(sql) !== undefined);
}

const CHANGED_TABLE = new RegExp(
  `^\\s*(?:ALTER\\s+TABLE|DROP\\s+TABLE|CREATE\\s+TABLE)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?((?:${IDENTIFIER}|[^\\s("]+)(?:\\.(?:${IDENTIFIER}|[^\\s("]+))*)`,
  'i',
);

/** The tables a list of statements alters, drops or creates (not staging). */
export function changedTablesOf(statements: readonly string[]): string[] {
  const tables = new Set<string>();
  for (const sql of statements) {
    const match = CHANGED_TABLE.exec(sql);
    if (!match) continue;
    const parts = match[1].match(/"(?:[^"]|"")+"|[^.]+/g) ?? [];
    const last = parts[parts.length - 1] ?? '';
    const name = last.startsWith('"') ? unquote(last.slice(1, -1)) : last;
    if (
      !name ||
      name.startsWith('_smrt_rebuild_') ||
      name.startsWith('_smrt_check_')
    )
      continue;
    tables.add(name);
  }
  return [...tables];
}

/** The views of the connection's current database, plus its temporary views. */
export async function listViews(
  db: DatabaseInterface,
  options: { includeTemporary?: boolean } = {},
): Promise<QualifiedView[]> {
  const { rows } = await db.query(
    `SELECT database_name, schema_name, view_name FROM duckdb_views()
      WHERE NOT internal AND (database_name = current_database()${options.includeTemporary ? " OR database_name = 'temp'" : ''})
      ORDER BY database_name, schema_name, view_name`,
  );
  return rows.map((row) => ({
    database: String(row.database_name),
    schema: String(row.schema_name),
    name: String(row.view_name),
  }));
}

/** The views among `views` that do not bind, with DuckDB's message. */
export async function unboundViews(
  db: DatabaseInterface,
  views: readonly QualifiedView[],
): Promise<Array<{ view: QualifiedView; message: string }>> {
  const failures: Array<{ view: QualifiedView; message: string }> = [];
  for (const view of views) {
    try {
      await db.query(viewProbeStatement(view));
    } catch (error) {
      const messages = errorMessages(error);
      failures.push({
        view,
        message:
          messages.find((message) => !/^Failed to execute/.test(message)) ??
          messages[0] ??
          String(error),
      });
    }
  }
  return failures;
}

/**
 * Probe every view of the database after a migration committed and report
 * those that no longer bind (E11). Read-only, outside any transaction.
 */
export async function checkViewsAfterCommit(
  db: DatabaseInterface,
): Promise<ViewInvalidatedAfterCommitWarning[]> {
  const views = await listViews(db, { includeTemporary: true });
  return (await unboundViews(db, views)).map(
    ({ view, message }) => new ViewInvalidatedAfterCommitWarning(view, message),
  );
}
