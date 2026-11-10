/**
 * Database failures inside ingestion reads (#4651). Server-only.
 *
 * A PostgreSQL deadlock (`40P01`) or serialization failure (`40001`) rolls the
 * whole transaction back: it says nothing about the data, and the same work
 * may simply run again. Any driver error also leaves a PostgreSQL transaction
 * aborted, so code that excludes one bad row by catching its error must let a
 * driver error through instead of carrying on in a dead transaction.
 */

const CONFLICT_SQLSTATES = new Set(['40P01', '40001']);
const CONFLICT_MESSAGE = /deadlock detected|could not serialize access/i;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const DRIVER_MESSAGE =
  /current transaction is aborted|deadlock detected|could not serialize access/i;

function* chain(
  error: unknown,
): Generator<{ code?: unknown; message?: unknown }> {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    yield current as { code?: unknown; message?: unknown };
    current = (current as { cause?: unknown }).cause;
  }
}

/** True for a deadlock or serialization failure anywhere in the cause chain. */
export function isTransactionConflict(error: unknown): boolean {
  for (const link of chain(error)) {
    if (typeof link.code === 'string' && CONFLICT_SQLSTATES.has(link.code))
      return true;
    if (typeof link.message === 'string' && CONFLICT_MESSAGE.test(link.message))
      return true;
  }
  return false;
}

/**
 * True when the error came from the database driver (a SQLSTATE or SQLite
 * code, or the aborted-transaction wording), not from an ingestion or host
 * refusal. Such an error must propagate out of the transaction.
 */
export function isDatabaseFailure(error: unknown): boolean {
  for (const link of chain(error)) {
    if (
      typeof link.code === 'string' &&
      (SQLSTATE.test(link.code) || link.code.startsWith('SQLITE_'))
    )
      return true;
    if (typeof link.message === 'string' && DRIVER_MESSAGE.test(link.message))
      return true;
  }
  return false;
}

/** Rethrow a driver error; anything else is the caller's to handle. */
export function rethrowDatabaseFailure(error: unknown): void {
  if (isDatabaseFailure(error)) throw error;
}

/** Runs per conflict-retried unit of work, including the first. */
export const TRANSACTION_CONFLICT_ATTEMPTS = 5;

/**
 * Run `work` (one complete transaction) again after a deadlock or
 * serialization failure, with a short jittered pause, up to
 * {@link TRANSACTION_CONFLICT_ATTEMPTS} runs. Any other error, and the last
 * conflict, propagate unchanged.
 */
export async function retryTransactionConflicts<T>(
  work: () => Promise<T>,
  attempts = TRANSACTION_CONFLICT_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isTransactionConflict(error)) throw error;
      const pause = 10 * 2 ** attempt * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}
