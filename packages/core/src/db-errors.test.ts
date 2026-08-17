/**
 * Unit tests for the driver-error classifier (#2366).
 *
 * The error shapes below are the real ones. `@happyvertical/sql` catches the
 * driver failure and rethrows
 * `DatabaseError('Failed to upsert record into table', { …, originalError })`,
 * where `originalError` is the **string** produced by the SDK's `formatDbError`
 * — `"<driver message>, code=<driver code>, detail=…"`. That stringification
 * is exactly what defeated the old `error.message` matcher, so the fixtures
 * reproduce it verbatim (captured from a live adapter run) rather than
 * approximating it with a nested `Error`.
 *
 * End-to-end coverage against real databases lives in
 * `__tests__/save-error-contract.test.ts` (SQLite) and
 * `__tests__/issue-2366-error-contract-postgres.optional.test.ts` (PostgreSQL).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyDatabaseError,
  classifyDialectMessage,
  isAbortedTransactionError,
  isDeterministicDatabaseError,
  isNotNullViolationError,
  isTransientDatabaseError,
  isUniqueViolationError,
} from './db-errors';
import { DatabaseError, ValidationError } from './errors';

/** Mirrors `@happyvertical/utils`' BaseError, which nests under `context`. */
class SdkDatabaseError extends Error {
  readonly code = 'DATABASE_ERROR';
  readonly context: Record<string, unknown>;
  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = 'DatabaseError';
    this.context = context;
  }
}

function sdkUpsertFailure(originalError: string): SdkDatabaseError {
  return new SdkDatabaseError('Failed to upsert record into table', {
    table: 'widgets',
    values: { id: 'a', sku: 's1' },
    conflictColumns: ['sku'],
    originalError,
  });
}

// Verbatim `formatDbError` output, captured from live adapters.
const SQLITE_UNIQUE =
  'SQLITE_CONSTRAINT: UNIQUE constraint failed: widgets.sku, code=SQLITE_CONSTRAINT';
const SQLITE_NOT_NULL =
  'SQLITE_CONSTRAINT: NOT NULL constraint failed: widgets.name, code=SQLITE_CONSTRAINT';
const PG_UNIQUE =
  'duplicate key value violates unique constraint "widgets_sku_key", code=23505, detail=Key (sku)=(abc) already exists., severity=ERROR';
const PG_NOT_NULL =
  'null value in column "name" of relation "widgets" violates not-null constraint, code=23502, severity=ERROR';
const PG_ABORTED_TX =
  'current transaction is aborted, commands ignored until end of transaction block, code=25P02, severity=ERROR';
const PG_BAD_UUID =
  'invalid input syntax for type uuid: "not-a-uuid", code=22P02, severity=ERROR';

describe('classifyDatabaseError reads driver codes through the SDK wrapper (#2366)', () => {
  it('classifies a PostgreSQL unique violation the wrapper had hidden', () => {
    const error = sdkUpsertFailure(PG_UNIQUE);

    // The regression in one line: the message the old matcher saw.
    expect(error.message).toBe('Failed to upsert record into table');

    const classification = classifyDatabaseError(error);
    expect(classification.kind).toBe('unique_violation');
    expect(classification.sqlstate).toBe('23505');
    expect(classification.deterministic).toBe(true);
    expect(classification.retryable).toBe(false);
  });

  it('classifies a PostgreSQL not-null violation', () => {
    const classification = classifyDatabaseError(sdkUpsertFailure(PG_NOT_NULL));
    expect(classification.kind).toBe('not_null_violation');
    expect(classification.sqlstate).toBe('23502');
    expect(classification.deterministic).toBe(true);
  });

  it('classifies a SQLite unique violation from the bare parent code', () => {
    // SQLite reports `SQLITE_CONSTRAINT` with no sub-kind, so the sub-kind has
    // to come from the message. Getting this wrong reports every SQLite
    // constraint failure as the same kind.
    const classification = classifyDatabaseError(
      sdkUpsertFailure(SQLITE_UNIQUE),
    );
    expect(classification.kind).toBe('unique_violation');
    expect(classification.deterministic).toBe(true);
  });

  it('classifies a SQLite not-null violation from the same bare parent code', () => {
    const classification = classifyDatabaseError(
      sdkUpsertFailure(SQLITE_NOT_NULL),
    );
    expect(classification.kind).toBe('not_null_violation');
  });

  it('classifies a bad-uuid cast as deterministic invalid input', () => {
    const classification = classifyDatabaseError(sdkUpsertFailure(PG_BAD_UUID));
    expect(classification.kind).toBe('invalid_input');
    expect(classification.sqlstate).toBe('22P02');
    expect(classification.deterministic).toBe(true);
  });

  it('reads through core DatabaseError.queryFailed re-wrapping', () => {
    // save()/loadFromId() re-wrap the SDK error before it reaches withRetry.
    const wrapped = DatabaseError.queryFailed(
      'UPSERT INTO widgets',
      sdkUpsertFailure(PG_UNIQUE),
    );
    expect(classifyDatabaseError(wrapped).kind).toBe('unique_violation');
    expect(isUniqueViolationError(wrapped)).toBe(true);
  });

  it('recovers the PostgreSQL DETAIL line for column extraction', () => {
    const classification = classifyDatabaseError(sdkUpsertFailure(PG_UNIQUE));
    expect(
      classification.driverMessages.some((message) =>
        message.includes('Key (sku)=(abc) already exists.'),
      ),
    ).toBe(true);
  });
});

describe('classifyDatabaseError separates transient from deterministic (#2366)', () => {
  it.each([
    ['40001 serialization_failure', '40001'],
    ['40P01 deadlock_detected', '40P01'],
    ['55P03 lock_not_available', '55P03'],
    ['57P01 admin_shutdown', '57P01'],
    ['08006 connection_failure', '08006'],
    ['53300 too_many_connections', '53300'],
  ])('treats %s as retryable', (_label, sqlstate) => {
    const error = sdkUpsertFailure(`transient failure, code=${sqlstate}`);
    expect(classifyDatabaseError(error).kind).toBe('transient');
    expect(isTransientDatabaseError(error)).toBe(true);
    expect(isDeterministicDatabaseError(error)).toBe(false);
  });

  it.each([
    ['SQLITE_BUSY', true],
    ['SQLITE_LOCKED', true],
    ['SQLITE_MISMATCH', false],
  ])('treats SQLite %s as retryable=%s', (code, retryable) => {
    const error = sdkUpsertFailure(`sqlite failure, code=${code}`);
    expect(isTransientDatabaseError(error)).toBe(retryable);
    expect(isDeterministicDatabaseError(error)).toBe(!retryable);
  });

  it('treats a dropped socket as retryable', () => {
    const socketError = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    expect(isTransientDatabaseError(socketError)).toBe(true);
  });

  it.each([
    ['23503 foreign_key_violation', '23503', 'foreign_key_violation'],
    ['23514 check_violation', '23514', 'check_violation'],
    ['42P01 undefined_table', '42P01', 'undefined_object'],
    ['42703 undefined_column', '42703', 'undefined_object'],
  ])('treats %s as deterministic', (_label, sqlstate, kind) => {
    const error = sdkUpsertFailure(`deterministic failure, code=${sqlstate}`);
    expect(classifyDatabaseError(error).kind).toBe(kind);
    expect(isDeterministicDatabaseError(error)).toBe(true);
  });

  it('keeps an exclusion violation off the unique-violation path', () => {
    // An EXCLUDE constraint rejects rows that *overlap* under an operator; the
    // conflicting rows differ on the constrained columns. Reporting 23P01 as a
    // unique violation would make save() raise VALIDATION_UNIQUE_CONSTRAINT
    // naming a field that never collided.
    const error = sdkUpsertFailure(
      'conflicting key value violates exclusion constraint "booking_no_overlap", code=23P01, severity=ERROR',
    );
    const classification = classifyDatabaseError(error);
    expect(classification.kind).toBe('exclusion_violation');
    expect(classification.deterministic).toBe(true);
    expect(isUniqueViolationError(error)).toBe(false);
  });

  it('classifies a SQLite foreign-key failure as such, not as a check violation', () => {
    // SQLite reports FK failures under the bare `SQLITE_CONSTRAINT` parent
    // code, so the sub-kind has to come from this exact wording.
    const error = sdkUpsertFailure(
      'SQLITE_CONSTRAINT: FOREIGN KEY constraint failed, code=SQLITE_CONSTRAINT',
    );
    expect(classifyDatabaseError(error).kind).toBe('foreign_key_violation');
    expect(isUniqueViolationError(error)).toBe(false);
    expect(isDeterministicDatabaseError(error)).toBe(true);
  });

  it('has no opinion about a non-database error', () => {
    const classification = classifyDatabaseError(
      new Error('totally unrelated'),
    );
    expect(classification.kind).toBe('unknown');
    expect(classification.deterministic).toBe(false);
    expect(classification.retryable).toBe(false);
  });

  it('has no opinion about a thrown non-Error value', () => {
    expect(classifyDatabaseError(undefined).kind).toBe('unknown');
    expect(classifyDatabaseError(null).kind).toBe('unknown');
    expect(classifyDatabaseError(42).kind).toBe('unknown');
  });
});

describe('aborted-transaction detection (#2366)', () => {
  it('detects 25P02 anywhere in the chain', () => {
    const error = sdkUpsertFailure(PG_ABORTED_TX);
    expect(isAbortedTransactionError(error)).toBe(true);
    expect(classifyDatabaseError(error).kind).toBe('aborted_transaction');
    expect(isDeterministicDatabaseError(error)).toBe(true);
  });

  it('does not fire on 25P03, which terminates the session rather than the transaction', () => {
    // `idle_in_transaction_session_timeout` means the server dropped the
    // session. Calling it an aborted transaction would block the
    // connection-level retry that can actually succeed, and would make the
    // profiles OIDC coordinator report a timed-out session as a race conflict.
    const error = sdkUpsertFailure(
      'terminating connection due to idle-in-transaction timeout, code=25P03, severity=FATAL',
    );
    expect(isAbortedTransactionError(error)).toBe(false);
    expect(classifyDatabaseError(error).kind).toBe('transient');
    expect(isTransientDatabaseError(error)).toBe(true);
    expect(isDeterministicDatabaseError(error)).toBe(false);
  });

  it('does not fire on a foreign-key violation that merely mentions a transaction', () => {
    // The heuristic this replaced matched a bare /transaction.*aborted/ and
    // would misclassify any error whose text happened to say both words.
    const error = sdkUpsertFailure(
      'insert or update on table "orders" violates foreign key constraint "orders_customer_id_fkey", code=23503, detail=the aborted transaction log is unrelated',
    );
    expect(isAbortedTransactionError(error)).toBe(false);
    expect(classifyDatabaseError(error).kind).toBe('foreign_key_violation');
  });

  it('reports the root constraint, not the downstream 25P02, when both are present', () => {
    const rootCause = sdkUpsertFailure(PG_UNIQUE);
    const symptom = new SdkDatabaseError('Failed to upsert record into table', {
      originalError: PG_ABORTED_TX,
      cause: rootCause,
    });
    (symptom as { cause?: unknown }).cause = rootCause;

    // Both signals are reachable, and both mean "do not retry".
    expect(isAbortedTransactionError(symptom)).toBe(true);
    expect(classifyDatabaseError(symptom).kind).toBe('unique_violation');
    expect(isDeterministicDatabaseError(symptom)).toBe(true);
  });
});

describe('SMRT typed errors classify as their driver equivalent (#2366)', () => {
  it('recognizes an already-typed unique ValidationError', () => {
    const typed = ValidationError.uniqueConstraint('sku', 'abc');
    expect(isUniqueViolationError(typed)).toBe(true);
  });

  it('does not treat an unrelated ValidationError as a unique violation', () => {
    expect(
      isUniqueViolationError(ValidationError.requiredField('name', 'W')),
    ).toBe(false);
  });
});

describe('the classifier is reachable from every package entry (#2366)', () => {
  it('is exported from the browser entry as well as the node entry', async () => {
    // The package's `browser` export condition resolves to `browser.ts`, so a
    // consumer importing these from the package root in a browser bundle gets
    // MISSING_EXPORT unless both entries carry them. `smrt-users`'
    // TenantIntegrationCollection and `smrt-profiles`' OIDC coordinator both
    // import from the root.
    const [browserEntry, nodeEntry] = await Promise.all([
      import('./browser'),
      import('./index'),
    ]);
    const required = [
      'classifyDatabaseError',
      'classifyDialectMessage',
      'isAbortedTransactionError',
      'isDeterministicDatabaseError',
      'isNotNullViolationError',
      'isTransientDatabaseError',
      'isUniqueViolationError',
    ] as const;
    for (const name of required) {
      expect(nodeEntry, `node entry must export ${name}`).toHaveProperty(name);
      expect(browserEntry, `browser entry must export ${name}`).toHaveProperty(
        name,
      );
    }
  });
});

describe('classifyDialectMessage keeps DuckDB wording separable (#1578)', () => {
  it('reads DuckDB unique and primary-key wording', () => {
    expect(
      classifyDialectMessage(
        'Constraint Error: Duplicate key "sku: abc" violates unique constraint.',
      ),
    ).toBe('unique_violation');
    expect(
      classifyDialectMessage(
        'Constraint Error: Duplicate key violates primary key constraint.',
      ),
    ).toBe('unique_violation');
  });

  it('does not read DuckDB foreign-key/check wording as unique', () => {
    expect(
      classifyDialectMessage(
        'Constraint Error: Violates foreign key constraint because key "owner_id: 7" does not exist in the referenced table',
      ),
    ).toBe('foreign_key_violation');
    expect(
      classifyDialectMessage(
        'Constraint Error: CHECK constraint failed: price_positive',
      ),
    ).toBe('check_violation');
  });

  it('returns unknown for unrelated or empty text', () => {
    expect(classifyDialectMessage('some unrelated database error')).toBe(
      'unknown',
    );
    expect(classifyDialectMessage('')).toBe('unknown');
  });

  it('classifies DuckDB constraint failures end to end, code-free', () => {
    const duckdb = sdkUpsertFailure(
      'Constraint Error: Duplicate key "sku: abc" violates unique constraint.',
    );
    expect(isUniqueViolationError(duckdb)).toBe(true);
    expect(isNotNullViolationError(duckdb)).toBe(false);
  });
});
