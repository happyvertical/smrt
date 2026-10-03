/**
 * Serialized removal of stale `operation.lock` / `writer.lease` files.
 *
 * Deciding a lock is stale (owner pid gone) and unlinking it are two steps,
 * and POSIX has no "unlink if unchanged". Two reclaimers that both observed
 * the same dead owner could otherwise interleave so that the slower one
 * unlinks the live lock the faster one just created (#3371 review R1).
 *
 * Every reclamation therefore runs under an exclusive SQLite transaction on
 * a dedicated mutex database next to the lock. The kernel releases that lock
 * when its holder dies, so the mutex itself can never go stale, and nothing
 * on the lock path is renamed or replaced. Under the mutex the reclaimer
 * re-reads the lock and only unlinks the exact record it judged stale, after
 * re-checking that its owner is still gone. Acquisition stays a plain
 * `O_EXCL` create, so record formats are unchanged and readable by the
 * template's original scripts.
 */

import { chmodSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { errorCode } from './error-code.js';

/** Mutex database file created in the lock's (private) state directory. */
export const RECLAIM_MUTEX_FILE = '.smrt-lock-reclaim.sqlite';

/** How long a reclaimer waits for another process's reclamation. */
const RECLAIM_WAIT_MS = 2_000;

/** Outcome of {@link reclaimStaleRecord}. */
export type ReclaimOutcome =
  /** The observed stale record was removed by this call. */
  | 'removed'
  /** The lock no longer exists (another reclaimer removed it). */
  | 'gone'
  /** The lock now holds a different record, or its owner is live: untouched. */
  | 'changed';

function withReclaimMutex<T>(stateRoot: string, callback: () => T): T {
  const mutexPath = join(stateRoot, RECLAIM_MUTEX_FILE);
  try {
    const details = lstatSync(mutexPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error('The application lock reclaim mutex is unsafe.');
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const database = new DatabaseSync(mutexPath, { timeout: RECLAIM_WAIT_MS });
  try {
    try {
      chmodSync(mutexPath, 0o600);
    } catch {
      // Best effort: the state directory itself is already mode 0700.
    }
    try {
      database.exec('BEGIN EXCLUSIVE');
    } catch {
      throw new Error(
        'Another process is reclaiming a stale application lock; retry the operation.',
      );
    }
    try {
      return callback();
    } finally {
      database.exec('ROLLBACK');
    }
  } finally {
    database.close();
  }
}

/**
 * Remove `path` only if it still contains exactly `observed` and
 * `isStale(observed)` still holds, serialized against every other reclaimer.
 */
export function reclaimStaleRecord(
  path: string,
  observed: string,
  isStale: (contents: string) => boolean,
): ReclaimOutcome {
  return withReclaimMutex(dirname(path), () => {
    let current: string;
    try {
      current = readFileSync(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'gone';
      throw error;
    }
    if (current !== observed || !isStale(current)) return 'changed';
    rmSync(path);
    return 'removed';
  });
}
