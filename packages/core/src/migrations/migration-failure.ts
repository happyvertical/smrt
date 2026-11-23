/**
 * Closed failure reasons for migration execution.
 *
 * Authored migration SQL can carry literals, and database error text can echo
 * them back. Neither may reach a log line, a thrown message, or the tracking
 * table's `error_message`. A failure is therefore reported only as a closed
 * reason: the statement's ordinal, a fixed statement kind, the phase it ran in,
 * and the SQLSTATE where the driver supplies one. Closing is the default:
 * every error the executor did not raise itself, or that is not a framework
 * guard's own failure, is closed. A closed failure keeps no reference to the
 * original error (no `cause`), so nothing that inspects the error object can
 * print the database's text.
 *
 * Identifiers (index, table and migration names) may appear in messages: they
 * are schema names, not values, and are not treated as secrets.
 */
import { classifyIndexStatement } from './postgres-create-index.js';

/** Fixed statement kinds; the only SQL-derived text a reason may carry. */
export type StatementKind =
  | 'create-index'
  | 'drop-index'
  | 'alter-table'
  | 'validate-constraint'
  | 'create-table'
  | 'drop-table'
  | 'data-change'
  | 'other';

/** Fixed phases a migration can fail in. */
export type FailurePhase =
  | 'regular'
  | 'concurrent-index'
  | 'index-check'
  | 'catalog-read'
  | 'commit'
  | 'ledger-read'
  | 'ledger-record'
  | 'unknown';

/** A statement the planner synthesised rather than one taken from `up`. */
export type GeneratedStatement = 'swap build' | 'swap close';

/**
 * The SQLSTATE classes PostgreSQL defines (Appendix A of its manual). A
 * SQLSTATE is five characters from one of these classes; anything else
 * (Node system codes such as `EPIPE`, driver codes such as
 * `SQLITE_CONSTRAINT`, undefined classes) is not one.
 */
const SQLSTATE_CLASSES = new Set([
  '00',
  '01',
  '02',
  '03',
  '08',
  '09',
  '0A',
  '0B',
  '0F',
  '0L',
  '0P',
  '0Z',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '2B',
  '2D',
  '2F',
  '34',
  '38',
  '39',
  '3B',
  '3D',
  '3F',
  '40',
  '42',
  '44',
  '53',
  '54',
  '55',
  '57',
  '58',
  '72',
  'F0',
  'HV',
  'P0',
  'XX',
]);

function isSqlstate(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    /^[0-9A-Z]{5}$/.test(code) &&
    SQLSTATE_CLASSES.has(code.slice(0, 2))
  );
}

/**
 * `error` and the errors it wraps (`cause`, `originalError`), breadth
 * first, each once: wrappers can nest deeply and can refer back to
 * themselves.
 */
function* wrappedErrors(error: unknown): Generator<object> {
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && seen.size < 64) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current))
      continue;
    seen.add(current);
    yield current;
    const { cause, originalError } = current as {
      cause?: unknown;
      originalError?: unknown;
    };
    pending.push(cause, originalError);
  }
}

/**
 * The SQLSTATE of `error`, or `null` when the driver gave none (SQLite and
 * DuckDB never do). The SQL adapter wraps driver errors (its own `code` is
 * `DATABASE_ERROR`), so every wrapped error is read.
 */
export function sqlstateOf(error: unknown): string | null {
  for (const current of wrappedErrors(error)) {
    const { code } = current as { code?: unknown };
    if (isSqlstate(code)) return code;
  }
  return null;
}

/**
 * Whether `error`, or an error it wraps, came from the database: the SQL
 * adapter's wrapper (`DATABASE_ERROR`, a `context` with the driver error or
 * SQL), core's `DatabaseError` (`DB_` codes), a driver error (a SQLSTATE, a `SQLITE_` code, PostgreSQL's
 * `severity`), or the adapter's sanitized driver snapshot.
 */
export function isDatabaseError(error: unknown): boolean {
  for (const current of wrappedErrors(error)) {
    const { code, name, severity, context } = current as {
      code?: unknown;
      name?: unknown;
      severity?: unknown;
      context?: { originalError?: unknown; sql?: unknown } | null;
    };
    if (
      code === 'DATABASE_ERROR' ||
      isSqlstate(code) ||
      (typeof code === 'string' &&
        (code.startsWith('DB_') || code.startsWith('SQLITE_'))) ||
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

/**
 * Comments, string literals, dollar-quoted bodies and quoted identifiers,
 * which classification must not read: their contents can hold any words.
 */
const SQL_OPAQUE_RE =
  /--[^\n]*|\/\*[\s\S]*?\*\/|[Ee]?'(?:[^'\\]|''|\\.)*'|\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1\$|"(?:[^"]|"")*"/g;

/** Classify a statement into a fixed kind without keeping any of its text. */
export function statementKindOf(sql: string): StatementKind {
  const index = classifyIndexStatement(sql);
  if (index.kind === 'create-index' || index.kind === 'drop-index')
    return index.kind;
  const head = sql
    .replace(SQL_OPAQUE_RE, (token) => (token.startsWith('"') ? '""' : ' '))
    .trimStart()
    .toLowerCase();
  if (/^alter\s+table\b/.test(head))
    return /\bvalidate\s+constraint\b/.test(head)
      ? 'validate-constraint'
      : 'alter-table';
  if (/^create\s+(?:\w+\s+)*table\b/.test(head)) return 'create-table';
  if (/^drop\s+table\b/.test(head)) return 'drop-table';
  if (/^(?:insert|update|delete)\b/.test(head)) return 'data-change';
  return 'other';
}

/** The engine a framework guard is written for, which decides its own failure. */
export type GuardEngine = 'postgres' | 'sqlite' | 'duckdb';

/**
 * The SQLSTATE every framework PostgreSQL guard raises with
 * (`RAISE EXCEPTION ... USING ERRCODE`). A `P0001` from a function an
 * authored expression calls inside a guard is not the guard's own failure.
 */
export const FRAMEWORK_GUARD_SQLSTATE = 'P0S01';

/**
 * The SQL expression a guard's `USING ERRCODE` is written with. Built from
 * two literals: the SQL adapter removes every literal of a failing statement
 * from the error it reports, the error's code included, and neither part
 * alone matches the code.
 */
export const FRAMEWORK_GUARD_ERRCODE_SQL = "'P0' || 'S01'";

interface GuardExpectation {
  engine: GuardEngine;
  /** Fixed framework texts; the guard's own failure carries one of these. */
  reasons: Set<string>;
}

/**
 * Guard statements the framework generated in this process, by exact text.
 * Provenance, not recognition: a statement is a guard only because the
 * framework produced it here, never because of its shape. One text can stand
 * for several guards (the SQLite and DuckDB guard statements are the same for
 * every table); every reason registered for it is kept, and a failure is
 * reported only with the registered reason it exactly carries. A guard loaded
 * from a file written by another process is not here, and its failure is
 * closed like any other. Bounded; an evicted guard's failure is also closed.
 */
const frameworkGuards = new Map<string, GuardExpectation>();
const FRAMEWORK_GUARD_LIMIT = 4096;

/**
 * Record `sql` as a guard the framework generated, whose own failure carries
 * one of `reasons` (fixed framework text). Returns `sql` unchanged.
 */
export function frameworkGuardStatement(
  sql: string,
  engine: GuardEngine,
  reasons: readonly string[],
): string {
  const known = frameworkGuards.get(sql);
  frameworkGuards.delete(sql);
  const merged = known?.engine === engine ? known.reasons : new Set<string>();
  for (const reason of reasons) merged.add(reason);
  frameworkGuards.set(sql, { engine, reasons: merged });
  if (frameworkGuards.size > FRAMEWORK_GUARD_LIMIT) {
    const oldest = frameworkGuards.keys().next().value;
    if (oldest !== undefined) frameworkGuards.delete(oldest);
  }
  return sql;
}

/** Every message on `error` and the errors it wraps. */
function messagesOf(error: unknown): string[] {
  const messages: string[] = [];
  for (const current of wrappedErrors(error)) {
    const { message } = current as { message?: unknown };
    if (typeof message === 'string') messages.push(message);
  }
  return messages;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The error to report when `error` is the guard's own failure, or `null`
 * when it is not. Own failures are: the RAISE of a PostgreSQL `DO` block
 * with {@link FRAMEWORK_GUARD_SQLSTATE}, the CHECK named by the reason
 * failing on SQLite, DuckDB's `error()` with the guard's findings. A guard
 * that fails for any other reason (a timeout, a lock, an error or a `P0001`
 * from an authored expression it embeds) is not.
 *
 * On every engine the report is a fresh framework error built only from the
 * registered reasons it matched; the driver's error (its message, `context`
 * and `cause`) is dropped. DuckDB findings are reported by their fixed part
 * (table and what differed), without the values they list.
 */
function guardOwnFailure(
  error: object,
  expectation: GuardExpectation,
): Error | null {
  const messages = messagesOf(error);
  const reasons = [...expectation.reasons];
  let matched: string[];
  switch (expectation.engine) {
    case 'postgres':
      if (
        sqlstateOf(error) !== FRAMEWORK_GUARD_SQLSTATE ||
        reasons.length !== 1
      )
        return null;
      matched = reasons;
      break;
    case 'sqlite':
      matched = reasons.filter((reason) => {
        const own = new RegExp(
          `CHECK constraint failed: ${escapeRegExp(reason)}(?:$|, code=)`,
        );
        return messages.some((message) => own.test(message));
      });
      break;
    case 'duckdb':
      // The guard only reads its own temporary table and raises its
      // findings with `error()`; a finding starts with a registered reason.
      matched = reasons.filter((reason) =>
        messages.some((message) => message.includes(reason)),
      );
      break;
  }
  if (matched.length === 0) return null;
  const report = frameworkError(matched.join('; '));
  return expectation.engine === 'postgres'
    ? Object.assign(report, { code: FRAMEWORK_GUARD_SQLSTATE })
    : report;
}

/** Errors the executor raised itself, with framework text only. */
const frameworkErrors = new WeakSet<object>();

/**
 * The same mark, readable across module copies (the CLI reads it to decide
 * that an error's text may be printed). Non-enumerable; set only here.
 */
export const FRAMEWORK_ERROR_BRAND = Symbol.for(
  '@happyvertical/smrt-core/migrations:framework-error',
);

/** Mark `error` as raised by the framework with framework text only. */
export function markFrameworkError<T extends object>(error: T): T {
  frameworkErrors.add(error);
  if (Object.isExtensible(error))
    Object.defineProperty(error, FRAMEWORK_ERROR_BRAND, { value: true });
  return error;
}

/** An `Error` the executor raises itself; its message is framework text. */
export function frameworkError(
  message: string,
  options?: { cause?: unknown },
): Error {
  return markFrameworkError(new Error(message, options));
}

/**
 * A migration statement (or probe) that failed. The message is closed: no
 * authored SQL and no database message text, and the original error is not
 * kept.
 */
export class MigrationStatementFailure extends Error {
  readonly statementOrdinal: number | null;
  readonly statementKind: StatementKind;
  readonly phase: FailurePhase;
  readonly generated: GeneratedStatement | null;
  readonly sqlstate: string | null;
  /** Framework text explaining what the failure means, if any. */
  readonly explanation: string | null;
  /**
   * A closed failure of the cleanup that followed (restoring a connection
   * setting), kept beside this one instead of replacing it.
   */
  cleanupFailure: Error | null = null;
  /** SQLSTATE, for callers that branch on `.code`. */
  readonly code: string | null;
  migrationId: string | null;

  /**
   * @param error - the failure; only its SQLSTATE is read, nothing is kept
   */
  constructor(
    error: unknown,
    details: {
      phase: FailurePhase;
      ordinal?: number | null;
      sql?: string;
      kind?: StatementKind;
      generated?: GeneratedStatement | null;
      migrationId?: string | null;
      /** Framework text only (identifiers allowed); never database text. */
      explanation?: string | null;
    },
  ) {
    const ordinal = details.ordinal ?? null;
    const kind =
      details.kind ?? (details.sql ? statementKindOf(details.sql) : 'other');
    const generated = details.generated ?? null;
    const sqlstate = sqlstateOf(error);
    const migrationId = details.migrationId ?? null;
    const explanation = details.explanation ?? null;
    super(
      describe(
        migrationId,
        ordinal,
        kind,
        generated,
        details.phase,
        sqlstate,
        explanation,
      ),
    );
    this.name = 'MigrationStatementFailure';
    this.phase = details.phase;
    this.statementOrdinal = ordinal;
    this.statementKind = kind;
    this.generated = generated;
    this.sqlstate = sqlstate;
    this.code = sqlstate;
    this.migrationId = migrationId;
    this.explanation = explanation;
  }

  /** Name the migration once the tracker boundary knows it. */
  bindMigration(id: string): this {
    if (this.migrationId === null) {
      this.migrationId = id;
      this.rewrite();
    }
    return this;
  }

  /** Keep `cleanup` (a closed failure) beside this failure. */
  attachCleanupFailure(cleanup: Error): this {
    if (this.cleanupFailure === null) {
      this.cleanupFailure = cleanup;
      this.rewrite();
    }
    return this;
  }

  private rewrite(): void {
    const before = this.message;
    // Read first: V8 formats the stack's header lazily, from the message.
    const stack = this.stack;
    const message = `${describe(
      this.migrationId,
      this.statementOrdinal,
      this.statementKind,
      this.generated,
      this.phase,
      this.sqlstate,
      this.explanation,
    )}${cleanupSuffix(this.cleanupFailure)}`;
    this.message = message;
    // A callback, so `$&` or `$1` in a migration id stays literal.
    if (typeof stack === 'string')
      this.stack = stack.replace(before, () => message);
  }
}

/** Whether `error` is a closed {@link MigrationStatementFailure}. */
export function isMigrationStatementFailure(
  error: unknown,
): error is MigrationStatementFailure {
  return error instanceof MigrationStatementFailure;
}

function cleanupSuffix(cleanup: Error | null): string {
  return cleanup === null ? '' : ` (cleanup also failed: ${cleanup.message})`;
}

/**
 * Keep `cleanup`, a closed failure of the cleanup that followed, beside
 * `primary` (the failure the caller sees) instead of replacing it.
 */
export function attachCleanupFailure(primary: Error, cleanup: Error): Error {
  if (primary instanceof MigrationStatementFailure)
    return primary.attachCleanupFailure(cleanup);
  const target = primary as Error & { cleanupFailure?: Error };
  if (target.cleanupFailure) return primary;
  const before = target.message;
  const stack = target.stack;
  const message = `${before}${cleanupSuffix(cleanup)}`;
  target.cleanupFailure = cleanup;
  target.message = message;
  if (typeof stack === 'string')
    target.stack = stack.replace(before, () => message);
  return primary;
}

/** The fixed phrase every closed reason ends with. */
const WITHHELD = 'database message withheld';

function describe(
  migrationId: string | null,
  ordinal: number | null,
  kind: StatementKind,
  generated: GeneratedStatement | null,
  phase: FailurePhase,
  sqlstate: string | null,
  explanation: string | null,
): string {
  const prefix = migrationId === null ? '' : `Migration ${migrationId}: `;
  const cause = `(SQLSTATE ${sqlstate ?? 'unavailable'}; ${WITHHELD})`;
  const suffix = explanation === null ? '' : `: ${explanation}`;
  if (phase === 'ledger-read')
    return `${prefix}reading the last migrate run failed ${cause}${suffix}`;
  if (phase === 'ledger-record')
    return `${prefix}recording the migrate run failed ${cause}${suffix}`;
  if (ordinal === null && (phase === 'commit' || phase === 'unknown'))
    return `${prefix}the migration failed in the ${phase} phase ${cause}${suffix}`;
  const where = ordinal === null ? 'a statement' : `statement ${ordinal}`;
  const what = generated === null ? kind : `generated ${generated}, ${kind}`;
  return `${prefix}${where} (${what}) failed in the ${phase} phase ${cause}${suffix}`;
}

/**
 * `error` when the framework raised it (a closed failure, a framework error,
 * a guard's own failure), otherwise a closed failure in `phase`. The default
 * is closed: an error of unknown origin never passes through.
 */
export function closeMigrationError(
  error: unknown,
  phase: FailurePhase,
): Error {
  if (
    error instanceof MigrationStatementFailure ||
    (typeof error === 'object' && error !== null && frameworkErrors.has(error))
  )
    return error as Error;
  return new MigrationStatementFailure(error, { phase });
}

/**
 * Run one statement, translating any database failure into a closed
 * {@link MigrationStatementFailure}. `ordinal` is the 1-based position in the
 * migration's `up` (authored) list. Only a guard the framework generated, and
 * only its own failure, passes through.
 */
export async function runStatementClosed<T>(
  run: () => Promise<T>,
  details: {
    phase: FailurePhase;
    ordinal?: number | null;
    sql: string;
    generated?: GeneratedStatement | null;
  },
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MigrationStatementFailure) throw error;
    const guard = frameworkGuards.get(details.sql);
    const own =
      guard && typeof error === 'object' && error !== null
        ? guardOwnFailure(error, guard)
        : null;
    if (own) throw own;
    throw new MigrationStatementFailure(error, details);
  }
}

/** A short, closed description of a diagnostic read's failure, for logs. */
export function closedCauseText(error: unknown): string {
  const sqlstate = sqlstateOf(error);
  return `SQLSTATE ${sqlstate ?? 'unavailable'}; ${WITHHELD}`;
}
