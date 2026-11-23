/**
 * What `db:migrate` prints for a failure (#5425).
 *
 * A database error's message, driver context (`originalError`, `sql`) and
 * stack can echo authored SQL literals or stored values, so none of them is
 * printed, with or without `--verbose`. A database failure is rendered as a
 * fixed phrase naming the operation, plus its SQLSTATE. Errors the framework
 * closed itself (core's `MigrationStatementFailure`, or an error core marked
 * as raised with framework text only) keep their closed text.
 *
 * Read by shape, never by importing core's helpers: several test suites
 * replace the core modules with doubles that do not provide them.
 */

/** The mark core sets on errors it raised with framework text only. */
const FRAMEWORK_ERROR_BRAND = Symbol.for(
  '@happyvertical/smrt-core/migrations:framework-error',
);

/**
 * The SQLSTATE classes PostgreSQL defines, as core's `sqlstateOf` reads
 * them: anything else (Node system codes, `SQLITE_*`, undefined classes) is
 * not a SQLSTATE.
 */
const SQLSTATE_RE =
  /^(?:0[0-389ABFLPZ]|2[0-7BDF]|3[489BDF]|4[024]|5[34578]|72|F0|HV|P0|XX)[0-9A-Z]{3}$/;

function isSqlstate(code: unknown): code is string {
  return typeof code === 'string' && SQLSTATE_RE.test(code);
}

/** `error` and what it wraps (`cause`, `originalError`), each once, bounded. */
function* wrappedErrors(error: unknown): Generator<object> {
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && seen.size < 64) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current))
      continue;
    seen.add(current);
    yield current;
    const { cause, originalError, context } = current as {
      cause?: unknown;
      originalError?: unknown;
      context?: { originalError?: unknown } | null;
    };
    pending.push(cause, originalError, context?.originalError);
  }
}

/**
 * Whether `error` was closed by the framework: core's
 * `MigrationStatementFailure` (by name and shape) or an error core marked as
 * carrying framework text only.
 */
export function isFrameworkClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'MigrationStatementFailure' && 'phase' in error)
    return true;
  return (
    (error as { [FRAMEWORK_ERROR_BRAND]?: unknown })[FRAMEWORK_ERROR_BRAND] ===
    true
  );
}

/**
 * Whether `error`, or anything it wraps, came from the database: the SQL
 * adapter's wrapper (`DATABASE_ERROR`, a driver `context`), core's
 * `DatabaseError`, or a driver error (a SQLSTATE, a `SQLITE_` code,
 * PostgreSQL's `severity`).
 */
export function isDatabaseFailure(error: unknown): boolean {
  for (const current of wrappedErrors(error)) {
    const { code, name, severity, context } = current as {
      code?: unknown;
      name?: unknown;
      severity?: unknown;
      context?: { originalError?: unknown; sql?: unknown } | null;
    };
    if (
      code === 'DATABASE_ERROR' ||
      (typeof code === 'string' &&
        (code.startsWith('DB_') || code.startsWith('SQLITE_'))) ||
      isSqlstate(code) ||
      name === 'DatabaseError' ||
      name === 'DatabaseDriverError' ||
      typeof severity === 'string' ||
      (typeof context === 'object' &&
        context !== null &&
        (context.originalError !== undefined || context.sql !== undefined))
    )
      return true;
  }
  return false;
}

/** The SQLSTATE `error` or anything it wraps carries, or `null`. */
function sqlstateOf(error: unknown): string | null {
  for (const current of wrappedErrors(error)) {
    const { code } = current as { code?: unknown };
    if (isSqlstate(code)) return code;
  }
  return null;
}

/** The fixed rendering of a database failure during `operation`. */
export function closedDatabaseFailure(
  operation: string,
  error: unknown,
): string {
  return `${operation} failed (SQLSTATE ${sqlstateOf(error) ?? 'unavailable'}; database message withheld)`;
}

/**
 * Whether `db:migrate` may print `error`'s own text (message, and stack with
 * `--verbose`). `closeAll` is for handlers around database work only, where
 * any error the framework did not close is treated as a database failure;
 * elsewhere only errors that came from the database are withheld.
 */
export function mayPrintErrorText(
  error: unknown,
  options: { closeAll?: boolean } = {},
): boolean {
  if (isFrameworkClosedError(error)) return true;
  if (!(error instanceof Error)) return false;
  if (options.closeAll) return false;
  return !isDatabaseFailure(error);
}

/**
 * The text `db:migrate` prints for `error` raised during `operation`: its
 * message when {@link mayPrintErrorText} allows it, else the closed phrase.
 */
export function migrateFailureText(
  operation: string,
  error: unknown,
  options: { closeAll?: boolean } = {},
): string {
  return mayPrintErrorText(error, options)
    ? (error as Error).message
    : closedDatabaseFailure(operation, error);
}

/**
 * Stored diagnostics have no trusted provenance, including text that resembles
 * a closed failure. Withhold them at reporting boundaries without rewriting
 * history; the row's migration identity/status remain available to operators.
 */
export function storedMigrationFailureText(
  message: string | null,
): string | null {
  return message ? 'Stored migration failure details withheld' : message;
}
