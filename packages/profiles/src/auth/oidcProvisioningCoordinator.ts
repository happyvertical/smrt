import { ValidationError } from '@happyvertical/smrt-core';
import {
  BackfillTableUnavailableError,
  BackfillTracker,
} from '@happyvertical/smrt-core/migrations';
import type { getDatabase } from '@happyvertical/sql';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

const provisioningLocks = new Map<
  string | object,
  Map<string, Promise<void>>
>();
const sqliteRetryLocks = new Map<string | object, Promise<void>>();
let savepointSequence = 0;

const OIDC_RACE_FIELD_NAMES = new Set([
  'email_key',
  'emailKey',
  'identity_key',
  'identityKey',
  'profile_id',
  'profileId',
]);
const OIDC_RACE_MESSAGE_PATTERNS = [
  /oidc_identities[._].*identity_key/iu,
  /oidc_identities_identity_key/iu,
  /oidc_profile_email_reservations[._].*(?:email_key|profile_id)/iu,
  /profile_types_slug_context_meta_type/iu,
];

class OidcRaceArbiterConflict extends Error {
  constructor(cause: unknown) {
    super('An OIDC provisioning race arbiter reported a unique conflict.', {
      cause,
    });
    this.name = 'OidcRaceArbiterConflict';
  }
}

class SavepointUnavailableError extends Error {
  constructor(cause: unknown) {
    super('OIDC provisioning could not start a transaction savepoint.', {
      cause,
    });
    this.name = 'SavepointUnavailableError';
  }
}

/** Shared transaction and concurrency policy for OIDC provisioning. */
export interface OidcProvisioningCoordinatorOptions<T> {
  /** Root or transaction-bound database used for every provisioning write. */
  db: DatabaseInterface;
  /**
   * Stable keys used for local serialization. Supply both the exact
   * issuer/subject key and normalized email when available.
   */
  lockKeys: readonly string[];
  /** Package-specific durable race-arbiter classifier. */
  isRaceConflict: (error: unknown) => boolean;
  /** Package-specific transaction failure mapping. */
  createTransactionError: (message: string, cause?: unknown) => Error;
  /** Package-specific terminal concurrency failure mapping. */
  createConcurrencyError: (cause?: unknown) => Error;
  /** Provision atomically using the supplied transaction-bound handle. */
  provision: (tx: DatabaseInterface) => Promise<T>;
  /**
   * Rehydrate root-owned results after commit so models do not retain a
   * released transaction client. Omit for non-model results.
   */
  rebindRootResult?: (result: T, rootDb: DatabaseInterface) => Promise<T>;
}

/**
 * Coordinate one OIDC provisioning operation across adapters.
 *
 * Root adapters must expose `beginTransaction`. Already-bound adapters must
 * support savepoints. An adapter that exposes only `transaction()` is
 * intentionally ambiguous and fails closed instead of risking a nested
 * transaction that could roll back its caller's work.
 */
export async function coordinateOidcProvisioning<T>(
  options: OidcProvisioningCoordinatorOptions<T>,
): Promise<T> {
  // Establish the shared backfill table outside the provisioning transaction.
  // Transaction-bound callers are handled below via savepoints and must not
  // leak DDL into their caller's transaction.
  const rootBackfillTableReady =
    typeof options.db.beginTransaction === 'function';
  if (rootBackfillTableReady) {
    await new BackfillTracker({ db: options.db }).initialize();
  }
  return withProvisioningLocks(options.db, options.lockKeys, async () => {
    const result = await retryProvisioning(options, () =>
      withProvisioningTransaction(
        options.db,
        (tx) => {
          // Marker reads inside provisioning transactions must never run DDL.
          // Root callers inherit a verified durable initialization; already-
          // bound callers may read an existing table but fail closed if it is
          // absent because no root handle is available for safe recovery.
          if (rootBackfillTableReady) {
            BackfillTracker.inheritInitialization(tx, options.db);
          } else {
            BackfillTracker.requireExistingTable(tx);
          }
          return options.provision(tx);
        },
        options.createTransactionError,
      ),
    );
    return rootBackfillTableReady && options.rebindRootResult
      ? options.rebindRootResult(result, options.db)
      : result;
  });
}

async function withProvisioningLocks<T>(
  db: DatabaseInterface,
  lockKeys: readonly string[],
  callback: () => Promise<T>,
): Promise<T> {
  // SQLite and DuckDB root handles cannot safely overlap transactions, even
  // when the identities are unrelated. Their database-scoped adapter lock is
  // acquired before the narrower identity/email locks shared across handles.
  const keys = [
    ...new Set([
      ...(!isPostgresDatabase(db) || typeof db.beginTransaction !== 'function'
        ? ['adapter-transaction']
        : []),
      ...lockKeys,
    ]),
  ].sort();
  const acquire = (index: number): Promise<T> =>
    index >= keys.length
      ? callback()
      : withProvisioningLock(db, keys[index], () => acquire(index + 1));
  return acquire(0);
}

/** Detect an adapter error caused by an aborted transaction. */
export function isOidcAbortedTransactionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      /current transaction is aborted|transaction.*aborted/iu.test(
        current.message,
      )
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface OidcProvisioningRaceClassifierOptions {
  /** Package-specific database constraint messages. */
  messagePatterns?: readonly RegExp[];
}

function testRaceMessagePattern(pattern: RegExp, message: string): boolean {
  // Callers may supply stateful global/sticky expressions. Do not let a prior
  // classification change the result of the next provisioning attempt.
  pattern.lastIndex = 0;
  try {
    return pattern.test(message);
  } finally {
    pattern.lastIndex = 0;
  }
}

/** Classify only the durable constraints used to converge OIDC retries. */
export function isOidcProvisioningRaceConflict(
  error: unknown,
  options: OidcProvisioningRaceClassifierOptions = {},
): boolean {
  if (isOidcAbortedTransactionError(error)) return true;
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const messagePatterns = [
    ...OIDC_RACE_MESSAGE_PATTERNS,
    ...(options.messagePatterns ?? []),
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof OidcRaceArbiterConflict) return true;
    if (
      current instanceof Error &&
      current.name === 'CanonicalPersonProfileError' &&
      (current as Error & { code?: unknown }).code === 'reservation_conflict'
    ) {
      return true;
    }
    if (
      current instanceof ValidationError &&
      current.code === 'VALIDATION_UNIQUE_CONSTRAINT' &&
      OIDC_RACE_FIELD_NAMES.has(String(current.details?.fieldName ?? ''))
    ) {
      return true;
    }
    if (
      current instanceof Error &&
      messagePatterns.some((pattern) =>
        testRaceMessagePattern(pattern, current.message),
      )
    ) {
      return true;
    }
    const details = current as {
      cause?: unknown;
      context?: unknown;
      details?: unknown;
      originalError?: unknown;
    };
    pending.push(
      details.cause,
      details.context,
      details.details,
      details.originalError,
    );
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

/** Wrap a known OIDC arbiter write so only its unique failure is retryable. */
export async function saveOidcRaceArbiter<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      (error instanceof ValidationError &&
        error.code === 'VALIDATION_UNIQUE_CONSTRAINT') ||
      isOidcAbortedTransactionError(error)
    ) {
      throw new OidcRaceArbiterConflict(error);
    }
    throw error;
  }
}

async function withProvisioningLock<T>(
  db: DatabaseInterface,
  lockKey: string,
  callback: () => Promise<T>,
): Promise<T> {
  // Non-Postgres handles for the same URL share a local lock. Durable unique
  // keys remain the cross-process and PostgreSQL race arbiters.
  const databaseKey = getDatabaseLockKey(db);
  const locks = provisioningLocks.get(databaseKey) ?? new Map();
  provisioningLocks.set(databaseKey, locks);
  const previous = locks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(lockKey, queued);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (locks.get(lockKey) === queued) locks.delete(lockKey);
    if (locks.size === 0) provisioningLocks.delete(databaseKey);
  }
}

function getDatabaseLockKey(db: DatabaseInterface): string | object {
  const url = db.url;
  if (
    isPostgresDatabase(db) &&
    typeof db.beginTransaction !== 'function' &&
    db.client !== null &&
    (typeof db.client === 'object' || typeof db.client === 'function')
  ) {
    return db.client;
  }
  return url && !isPostgresDatabase(db) ? url : (db as object);
}

function isPostgresDatabase(db: DatabaseInterface): boolean {
  return /^postgres(?:ql)?:/iu.test(db.url ?? '');
}

async function retryProvisioning<T>(
  options: OidcProvisioningCoordinatorOptions<T>,
  callback: () => Promise<T>,
): Promise<T> {
  let serializeSqliteRetry = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await (serializeSqliteRetry
        ? withSqliteRetryLock(options.db, callback)
        : callback());
    } catch (error) {
      if (error instanceof BackfillTableUnavailableError) {
        if (typeof options.db.beginTransaction === 'function' && attempt < 7) {
          BackfillTracker.invalidateInitialization(options.db);
          await new BackfillTracker({ db: options.db }).initialize();
          continue;
        }
        throw options.createTransactionError(
          'Transaction-bound OIDC provisioning requires an existing _smrt_backfills table; pass the root database so SMRT can initialize it safely.',
          error,
        );
      }
      const sqliteBusy = isSqliteBusyError(error);
      const postgresTransactionRetry = isPostgresTransactionRetryError(error);
      const raceConflict = options.isRaceConflict(error);
      if (!sqliteBusy && !postgresTransactionRetry && !raceConflict)
        throw error;
      if (sqliteBusy && attempt < 7) {
        serializeSqliteRetry = true;
        await waitForRetry(Math.min(100 * 2 ** attempt, 1_000));
        continue;
      }
      if (postgresTransactionRetry && attempt < 7) {
        await waitForRetry(Math.min(25 * 2 ** attempt, 500));
        continue;
      }
      if (raceConflict && attempt === 0) continue;
      throw options.createConcurrencyError(error);
    }
  }
  throw options.createConcurrencyError();
}

function isPostgresTransactionRetryError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const messagePattern =
    /deadlock detected|could not serialize access|serialization failure/iu;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const details = current as {
      cause?: unknown;
      code?: unknown;
      context?: unknown;
      originalError?: unknown;
    };
    if (details.code === '40P01' || details.code === '40001') return true;
    if (current instanceof Error && messagePattern.test(current.message)) {
      return true;
    }
    pending.push(details.cause, details.context, details.originalError);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

async function withSqliteRetryLock<T>(
  db: DatabaseInterface,
  callback: () => Promise<T>,
): Promise<T> {
  const key = db.url || (db as object);
  const previous = sqliteRetryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  sqliteRetryLocks.set(key, queued);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (sqliteRetryLocks.get(key) === queued) sqliteRetryLocks.delete(key);
  }
}

function isSqliteBusyError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const busyPattern =
    /SQLITE_(?:BUSY|LOCKED)|database(?: table)? is locked|cannot (?:commit transaction|release savepoint) - SQL statements in progress/iu;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (busyPattern.test(current)) return true;
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      if (busyPattern.test(current.message)) return true;
      pending.push((current as { cause?: unknown }).cause);
      if (current instanceof AggregateError) pending.push(...current.errors);
    }
    const details = current as {
      context?: unknown;
      details?: unknown;
      originalError?: unknown;
    };
    pending.push(details.context, details.details, details.originalError);
  }
  return false;
}

async function waitForRetry(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withProvisioningTransaction<T>(
  db: DatabaseInterface,
  callback: (tx: DatabaseInterface) => Promise<T>,
  createTransactionError: (message: string, cause?: unknown) => Error,
): Promise<T> {
  if (typeof db.beginTransaction === 'function') {
    if (db.transaction) return db.transaction((tx) => callback(tx));
    const tx = await db.beginTransaction();
    try {
      const result = await callback(tx);
      await tx.commit();
      return result;
    } catch (error) {
      try {
        if (tx.isActive()) await tx.rollback();
      } catch (rollbackError) {
        throw createTransactionError(
          'OIDC provisioning could not roll back its root transaction.',
          new AggregateError([error, rollbackError]),
        );
      }
      throw error;
    }
  }

  try {
    return await withSavepoint(db, () => callback(db), createTransactionError);
  } catch (error) {
    if (!(error instanceof SavepointUnavailableError)) throw error;
    throw createTransactionError(
      'OIDC provisioning requires a root database or a transaction handle that supports savepoints.',
      error.cause,
    );
  }
}

async function withSavepoint<T>(
  db: DatabaseInterface,
  callback: () => Promise<T>,
  createTransactionError: (message: string, cause?: unknown) => Error,
): Promise<T> {
  savepointSequence = (savepointSequence + 1) % Number.MAX_SAFE_INTEGER;
  const savepoint = `smrt_oidc_${savepointSequence.toString(36)}`;
  try {
    await db.query(`SAVEPOINT ${savepoint}`);
  } catch (error) {
    throw new SavepointUnavailableError(error);
  }

  try {
    const result = await callback();
    await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    try {
      await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (rollbackError) {
      throw createTransactionError(
        'OIDC provisioning could not roll back its transaction savepoint.',
        new AggregateError([error, rollbackError]),
      );
    }
    throw error;
  }
}
