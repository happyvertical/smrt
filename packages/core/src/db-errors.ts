/**
 * Driver-error classification for the persistence path (#2366).
 *
 * `@happyvertical/sql` does not normalize driver errors: every adapter catches
 * the driver failure and rethrows
 * `DatabaseError('Failed to upsert record into table', { …, originalError })`,
 * where `originalError` is the **string** produced by the SDK's `formatDbError`
 * (`"<driver message>, code=<driver code>, detail=…, hint=…"`). The typed
 * message therefore carries none of the constraint wording, which is why
 * matching on `error.message` alone silently stopped recognizing constraint
 * violations and let {@link ErrorUtils.withRetry} retry them.
 *
 * This module walks the whole causal chain — `cause`, `context.originalError`
 * (Error *or* formatted string), `originalError`, `details.causeMessages`, and
 * `AggregateError.errors` — collecting every driver code and message it finds,
 * then classifies on the codes first (PostgreSQL SQLSTATE, SQLite result
 * codes, Node network errno) and only falls back to dialect wording for DuckDB,
 * which reports no machine-readable code.
 *
 * The classification separates two independent questions:
 * - `deterministic` — a retry cannot change the outcome (constraint violation,
 *   bad input syntax, aborted transaction, missing table). Fail fast.
 * - `retryable` — a retry plausibly can succeed (serialization failure,
 *   deadlock, lock timeout, connection loss, `SQLITE_BUSY`).
 *
 * They are not complements: `kind: 'unknown'` means "no opinion", leaving the
 * caller's own default policy in charge.
 *
 * @module
 */

/** Coarse classification of a database driver failure. */
export type DatabaseErrorKind =
  | 'unique_violation'
  | 'not_null_violation'
  | 'foreign_key_violation'
  | 'check_violation'
  | 'exclusion_violation'
  | 'invalid_input'
  | 'aborted_transaction'
  | 'undefined_object'
  | 'insufficient_privilege'
  | 'syntax_error'
  | 'transient'
  | 'unknown';

/** Structured result of {@link classifyDatabaseError}. */
export interface DatabaseErrorClassification {
  /** What kind of failure this is, or `'unknown'` when nothing matched. */
  kind: DatabaseErrorKind;
  /** True when retrying cannot change the outcome. */
  deterministic: boolean;
  /** True when retrying plausibly can succeed. */
  retryable: boolean;
  /** PostgreSQL SQLSTATE recovered from the chain, when present. */
  sqlstate?: string;
  /** Raw driver code that produced the classification, when present. */
  driverCode?: string;
  /** Every driver code found anywhere in the chain, in discovery order. */
  driverCodes: readonly string[];
  /**
   * Every message found anywhere in the chain, in discovery order. Includes
   * the SDK's formatted `originalError` strings and the driver's own
   * `detail`/`hint` fields, which carry the PostgreSQL
   * `Key (col)=(value) already exists.` line used for column recovery.
   */
  driverMessages: readonly string[];
  /**
   * Column named directly by the driver (`node-postgres` sets `error.column`
   * on a `23502`), when one was reported. More reliable than parsing it back
   * out of the message.
   */
  column?: string;
  /** Constraint named directly by the driver (`error.constraint`). */
  constraint?: string;
}

/** Maximum chain depth walked, guarding against pathological nesting. */
const MAX_CHAIN_DEPTH = 12;

/** `formatDbError` renders driver codes as `code=<value>` inside its string. */
const FORMATTED_CODE_PATTERN = /(?:^|[\s,;([{])code=([A-Za-z0-9_]+)/g;

/**
 * PostgreSQL SQLSTATE codes whose failure is fully determined by the statement
 * and its data. Retrying re-executes the same deterministic rejection.
 */
const DETERMINISTIC_SQLSTATES = new Map<string, DatabaseErrorKind>([
  // Class 23 — integrity constraint violation
  ['23000', 'check_violation'], // integrity_constraint_violation (generic)
  ['23001', 'foreign_key_violation'], // restrict_violation
  ['23502', 'not_null_violation'],
  ['23503', 'foreign_key_violation'],
  ['23505', 'unique_violation'],
  ['23514', 'check_violation'],
  // An EXCLUDE constraint is not a unique index: the conflicting rows differ on
  // the constrained columns and merely overlap under the operator. Reporting it
  // as `unique_violation` would make `save()` raise
  // VALIDATION_UNIQUE_CONSTRAINT naming a field that did not collide, so it
  // keeps its own kind and stays on the generic DatabaseError path.
  ['23P01', 'exclusion_violation'],
  // Class 22 — data exception (bad literal, overflow, bad uuid cast)
  ['22001', 'invalid_input'], // string_data_right_truncation
  ['22003', 'invalid_input'], // numeric_value_out_of_range
  ['22007', 'invalid_input'], // invalid_datetime_format
  ['22008', 'invalid_input'], // datetime_field_overflow
  ['22023', 'invalid_input'], // invalid_parameter_value
  ['22P02', 'invalid_input'], // invalid_text_representation — the bad-uuid case
  ['22P03', 'invalid_input'], // invalid_binary_representation
  // Class 25 — invalid transaction state. Only `25P02` belongs here:
  // `25P03 idle_in_transaction_session_timeout` means the server *terminated
  // the session*, which is a connection-level failure a fresh connection can
  // survive, so it lives in TRANSIENT_SQLSTATES instead. Calling it
  // deterministic would both block that retry and make
  // `isAbortedTransactionError()` report a timed-out session as an OIDC race
  // conflict in the profiles coordinator.
  ['25P02', 'aborted_transaction'], // in_failed_sql_transaction
  // Class 42 — syntax error or access rule violation
  ['42501', 'insufficient_privilege'],
  ['42601', 'syntax_error'],
  ['42703', 'undefined_object'], // undefined_column
  ['42804', 'invalid_input'], // datatype_mismatch
  ['42883', 'undefined_object'], // undefined_function
  ['42P01', 'undefined_object'], // undefined_table
  ['42P07', 'undefined_object'], // duplicate_table
  // invalid_column_reference — "no unique or exclusion constraint matching the
  // ON CONFLICT specification". A conflict target that does not match a real
  // unique index is a schema defect, not contention; retrying it four times
  // only delays the report (see epic #2382 finding A4).
  ['42P10', 'undefined_object'],
  ['3D000', 'undefined_object'], // invalid_catalog_name
  ['3F000', 'undefined_object'], // invalid_schema_name
]);

/**
 * PostgreSQL SQLSTATE codes describing a contention or availability failure.
 * The same statement may well succeed on a later attempt.
 */
const TRANSIENT_SQLSTATES = new Set([
  '25P03', // idle_in_transaction_session_timeout — the session was terminated
  '40001', // serialization_failure
  '40003', // statement_completion_unknown
  '40P01', // deadlock_detected
  '53200', // out_of_memory
  '53300', // too_many_connections
  '55P03', // lock_not_available
  '57014', // query_canceled
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '58030', // io_error
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '08P01', // protocol_violation
]);

/**
 * SQLite extended result codes. `better-sqlite3`/`node:sqlite` frequently
 * report the bare `SQLITE_CONSTRAINT` parent code, so the constraint sub-kind
 * is resolved from the message instead (see {@link classifyDialectMessage}).
 */
const DETERMINISTIC_SQLITE_CODES = new Map<string, DatabaseErrorKind>([
  ['SQLITE_CONSTRAINT_UNIQUE', 'unique_violation'],
  ['SQLITE_CONSTRAINT_PRIMARYKEY', 'unique_violation'],
  ['SQLITE_CONSTRAINT_ROWID', 'unique_violation'],
  ['SQLITE_CONSTRAINT_NOTNULL', 'not_null_violation'],
  ['SQLITE_CONSTRAINT_FOREIGNKEY', 'foreign_key_violation'],
  ['SQLITE_CONSTRAINT_CHECK', 'check_violation'],
  ['SQLITE_CONSTRAINT_TRIGGER', 'check_violation'],
  ['SQLITE_MISMATCH', 'invalid_input'],
  ['SQLITE_RANGE', 'invalid_input'],
  ['SQLITE_TOOBIG', 'invalid_input'],
  ['SQLITE_READONLY', 'insufficient_privilege'],
  ['SQLITE_AUTH', 'insufficient_privilege'],
]);

/** SQLite result codes that clear once contention or a lock resolves. */
const TRANSIENT_SQLITE_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
  'SQLITE_PROTOCOL',
]);

/** Node/libuv socket errno values raised when a pooled connection drops. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

/**
 * Dialect wording, in precedence order. Only DuckDB has no machine-readable
 * code, but SQLite's bare `SQLITE_CONSTRAINT` and PostgreSQL errors that have
 * lost their code through string formatting are recovered here too.
 *
 * NOT NULL is tested before UNIQUE because DuckDB phrases both with the same
 * `Constraint Error … violates` shape, and foreign-key/check wording must not
 * be mistaken for a unique violation (#1578).
 */
const DIALECT_MESSAGE_RULES: ReadonlyArray<{
  kind: DatabaseErrorKind;
  pattern: RegExp;
}> = [
  {
    kind: 'aborted_transaction',
    pattern: /current transaction is aborted/i,
  },
  {
    kind: 'not_null_violation',
    pattern:
      /NOT NULL constraint failed|null value in column .* violates not-null/i,
  },
  {
    // SQLite reports `FOREIGN KEY constraint failed` under the bare
    // `SQLITE_CONSTRAINT` parent code, so without this arm the sub-kind
    // recovery below would mislabel every SQLite FK failure.
    kind: 'foreign_key_violation',
    pattern: /violates foreign key constraint|FOREIGN KEY constraint failed/i,
  },
  {
    kind: 'check_violation',
    pattern: /violates check constraint|CHECK constraint failed/i,
  },
  {
    kind: 'unique_violation',
    pattern:
      /UNIQUE constraint failed|violates unique constraint|violates primary key constraint|duplicate key value violates/i,
  },
  {
    kind: 'invalid_input',
    pattern: /invalid input syntax for type|value too long for type/i,
  },
  {
    // Deliberately narrow: a bare /does not exist/ matches far too much to be
    // safe as a fail-fast signal.
    kind: 'undefined_object',
    pattern:
      /no such table|no such column|(?:relation|column|table|function) "[^"]*" does not exist/i,
  },
  {
    kind: 'transient',
    pattern:
      /database is locked|database table is locked|connection terminated|server closed the connection|too many clients|deadlock detected|could not serialize access/i,
  },
];

/** SMRT-level codes that already express a driver classification. */
const SMRT_CODE_KINDS = new Map<string, DatabaseErrorKind>([
  ['VALIDATION_UNIQUE_CONSTRAINT', 'unique_violation'],
  ['DB_CONSTRAINT_VIOLATION', 'check_violation'],
]);

/**
 * Reporting precedence among deterministic kinds, most specific first.
 *
 * `aborted_transaction` ranks last on purpose: PostgreSQL reports `25P02` for
 * every statement issued after the transaction already failed, so a chain
 * carrying both it and the constraint that caused the abort must name the
 * constraint. Every kind here is non-retryable, so ranking changes only what
 * is reported, never whether the operation is retried.
 */
const DETERMINISTIC_KIND_RANK = new Map<DatabaseErrorKind, number>([
  ['unique_violation', 0],
  ['not_null_violation', 1],
  ['foreign_key_violation', 2],
  ['check_violation', 3],
  ['exclusion_violation', 4],
  ['invalid_input', 5],
  ['undefined_object', 6],
  ['insufficient_privilege', 7],
  ['syntax_error', 8],
  ['aborted_transaction', 9],
]);

function rankKind(kind: DatabaseErrorKind): number {
  return DETERMINISTIC_KIND_RANK.get(kind) ?? Number.MAX_SAFE_INTEGER;
}

interface ChainSignals {
  codes: string[];
  messages: string[];
  columns: string[];
  constraints: string[];
}

function pushUnique(collection: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const entry = value.trim();
  if (entry && !collection.includes(entry)) {
    collection.push(entry);
  }
}

function pushCode(signals: ChainSignals, value: unknown): void {
  pushUnique(signals.codes, value);
}

function pushMessage(signals: ChainSignals, value: unknown): void {
  if (typeof value !== 'string') return;
  const message = value.trim();
  if (!message || signals.messages.includes(message)) return;
  signals.messages.push(message);

  // `formatDbError` folds the driver's own `code` into its string, so the
  // machine-readable classification survives even after stringification.
  FORMATTED_CODE_PATTERN.lastIndex = 0;
  let match = FORMATTED_CODE_PATTERN.exec(message);
  while (match) {
    pushCode(signals, match[1]);
    match = FORMATTED_CODE_PATTERN.exec(message);
  }
}

/**
 * Walks an error's causal chain, collecting every driver code and message.
 *
 * Visits `cause`, `context.originalError`, `originalError`,
 * `details.causeMessage`/`details.causeMessages` and `AggregateError.errors`,
 * because the SDK, core and consumer wrappers each nest the driver error
 * differently. Cycles and depth are bounded.
 */
function collectChainSignals(error: unknown): ChainSignals {
  const signals: ChainSignals = {
    codes: [],
    messages: [],
    columns: [],
    constraints: [],
  };
  const seen = new Set<unknown>();
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];

  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) break;
    const { value, depth } = entry;
    if (value === null || value === undefined || depth > MAX_CHAIN_DEPTH) {
      continue;
    }

    if (typeof value === 'string') {
      pushMessage(signals, value);
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);

    const node = value as {
      code?: unknown;
      sqlState?: unknown;
      sqlstate?: unknown;
      message?: unknown;
      detail?: unknown;
      hint?: unknown;
      column?: unknown;
      constraint?: unknown;
      cause?: unknown;
      context?: { originalError?: unknown } | unknown;
      originalError?: unknown;
      details?: unknown;
      errors?: unknown;
    };

    pushCode(signals, node.code);
    pushCode(signals, node.sqlState);
    pushCode(signals, node.sqlstate);
    pushMessage(signals, node.message);
    // `node-postgres` surfaces the PostgreSQL error fields as properties. On
    // the direct INSERT path nothing stringifies them into the message, so the
    // column would otherwise be unrecoverable (`error.detail` carries
    // "Key (sku)=(s1) already exists." for a 23505; `error.column` names the
    // column outright for a 23502).
    pushMessage(signals, node.detail);
    pushMessage(signals, node.hint);
    pushUnique(signals.columns, node.column);
    pushUnique(signals.constraints, node.constraint);

    const details = node.details as
      | { causeMessage?: unknown; causeMessages?: unknown }
      | undefined;
    if (details && typeof details === 'object') {
      pushMessage(signals, details.causeMessage);
      if (Array.isArray(details.causeMessages)) {
        for (const causeMessage of details.causeMessages) {
          pushMessage(signals, causeMessage);
        }
      }
    }

    const context = node.context as { originalError?: unknown } | undefined;
    const next = [
      node.cause,
      node.originalError,
      context && typeof context === 'object'
        ? context.originalError
        : undefined,
    ];
    for (const child of next) {
      if (child !== null && child !== undefined) {
        pending.push({ value: child, depth: depth + 1 });
      }
    }
    if (Array.isArray(node.errors)) {
      for (const child of node.errors) {
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }

  return signals;
}

/**
 * Classifies a raw dialect message. Exposed so
 * `SmrtObject.classifyConstraintError()` and this module share one set of
 * regexes rather than drifting apart.
 */
export function classifyDialectMessage(message: string): DatabaseErrorKind {
  if (!message) return 'unknown';
  for (const rule of DIALECT_MESSAGE_RULES) {
    if (rule.pattern.test(message)) return rule.kind;
  }
  return 'unknown';
}

function isSqlState(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Classifies a database failure by walking its causal chain.
 *
 * Codes win over wording: a PostgreSQL SQLSTATE or SQLite result code is
 * authoritative, and dialect message matching only runs when no code in the
 * chain was recognized (DuckDB, or an error already flattened to a string).
 *
 * Constraint violations are reported ahead of `aborted_transaction` so a chain
 * carrying both surfaces the root cause rather than the downstream symptom;
 * both are deterministic, so retry behavior is identical either way.
 *
 * @param error - Any thrown value. Non-database errors classify as `'unknown'`.
 * @returns The structured classification; never throws.
 */
export function classifyDatabaseError(
  error: unknown,
): DatabaseErrorClassification {
  const signals = collectChainSignals(error);
  const sqlstate = signals.codes.find(
    (code) =>
      isSqlState(code) &&
      (DETERMINISTIC_SQLSTATES.has(code) || TRANSIENT_SQLSTATES.has(code)),
  );

  const base = {
    driverCodes: signals.codes,
    driverMessages: signals.messages,
    ...(sqlstate ? { sqlstate } : {}),
    ...(signals.columns[0] ? { column: signals.columns[0] } : {}),
    ...(signals.constraints[0] ? { constraint: signals.constraints[0] } : {}),
  };

  // Deterministic codes first: a chain that carries both a constraint code and
  // a downstream contention code must fail fast, not retry.
  const deterministicCandidates: Array<{
    code: string;
    kind: DatabaseErrorKind;
  }> = [];
  for (const code of signals.codes) {
    const kind =
      DETERMINISTIC_SQLSTATES.get(code) ??
      DETERMINISTIC_SQLITE_CODES.get(code) ??
      // SMRT's own typed codes: a `ValidationError` already carrying
      // `VALIDATION_UNIQUE_CONSTRAINT` is the classified form of the same
      // driver failure.
      SMRT_CODE_KINDS.get(code) ??
      // A bare `SQLITE_CONSTRAINT` carries no sub-kind; recover it from the
      // message, which SQLite always phrases explicitly.
      (code === 'SQLITE_CONSTRAINT'
        ? (signals.messages
            .map(classifyDialectMessage)
            .find((candidate) => DETERMINISTIC_KIND_RANK.has(candidate)) ??
          'check_violation')
        : undefined);
    if (kind) deterministicCandidates.push({ code, kind });
  }

  if (deterministicCandidates.length > 0) {
    // Rank rather than take the first discovered: an error whose chain holds
    // both `23505` and the `25P02` it caused must report the root constraint,
    // not the downstream symptom.
    const best = deterministicCandidates.reduce((winner, candidate) =>
      rankKind(candidate.kind) < rankKind(winner.kind) ? candidate : winner,
    );
    return {
      ...base,
      kind: best.kind,
      deterministic: true,
      retryable: false,
      driverCode: best.code,
    };
  }

  for (const code of signals.codes) {
    if (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SQLITE_CODES.has(code)) {
      return {
        ...base,
        kind: 'transient',
        deterministic: false,
        retryable: true,
        driverCode: code,
      };
    }
    if (TRANSIENT_NETWORK_CODES.has(code)) {
      return {
        ...base,
        kind: 'transient',
        deterministic: false,
        retryable: true,
        driverCode: code,
      };
    }
  }

  // No recognized code anywhere — fall back to dialect wording. This is the
  // only path DuckDB ever takes.
  const messageKinds = signals.messages
    .map(classifyDialectMessage)
    .filter((kind) => kind !== 'unknown');
  const deterministicFromMessage = messageKinds
    .filter((kind) => DETERMINISTIC_KIND_RANK.has(kind))
    .sort((left, right) => rankKind(left) - rankKind(right))[0];
  if (deterministicFromMessage) {
    return {
      ...base,
      kind: deterministicFromMessage,
      deterministic: true,
      retryable: false,
    };
  }
  if (messageKinds.includes('transient')) {
    return {
      ...base,
      kind: 'transient',
      deterministic: false,
      retryable: true,
    };
  }

  return {
    ...base,
    kind: 'unknown',
    deterministic: false,
    retryable: false,
  };
}

/**
 * True when retrying the statement cannot change the outcome.
 *
 * Used by {@link ErrorUtils.withRetry} to fail fast instead of burning the
 * full 500 + 1000 + 2000 ms backoff on a constraint violation.
 */
export function isDeterministicDatabaseError(error: unknown): boolean {
  return classifyDatabaseError(error).deterministic;
}

/** True when the failure is contention or availability and may clear. */
export function isTransientDatabaseError(error: unknown): boolean {
  return classifyDatabaseError(error).retryable;
}

/** True when a unique or primary-key constraint was violated. */
export function isUniqueViolationError(error: unknown): boolean {
  return classifyDatabaseError(error).kind === 'unique_violation';
}

/** True when a NOT NULL constraint was violated. */
export function isNotNullViolationError(error: unknown): boolean {
  return classifyDatabaseError(error).kind === 'not_null_violation';
}

/**
 * True when the failure came from running inside an already-aborted
 * PostgreSQL transaction (SQLSTATE `25P02`).
 *
 * Detected independently of {@link DatabaseErrorKind} so a chain that also
 * carries the root constraint code still answers `true` here.
 */
export function isAbortedTransactionError(error: unknown): boolean {
  const signals = collectChainSignals(error);
  // `25P02` only. `25P03` is a terminated session, not a failed transaction,
  // and reporting it here would make the profiles coordinator treat an
  // idle-timeout disconnect as a provisioning race conflict.
  if (signals.codes.includes('25P02')) {
    return true;
  }
  return signals.messages.some((message) =>
    /current transaction is aborted/i.test(message),
  );
}
