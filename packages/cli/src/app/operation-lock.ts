/**
 * Exclusive operator-operation lock (`<state>/operation.lock`).
 *
 * Ported from the template's `scripts/smrt-operation-lock.mjs`: the same
 * file, record shape, and messages. Stale-owner reclamation is serialized
 * through `stale-reclaim.ts` so it can never remove a live lock.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { errorCode } from './errors.js';
import { reclaimStaleRecord } from './stale-reclaim.js';

/** Held lock handed to the operation callback. */
export interface OperationLock {
  /** Per-acquisition nonce; a managed writer presents it to join the operation. */
  readonly instance: string;
  /** Lock file path. */
  readonly path: string;
}

/** True when `pid` names a live process, including one owned by another user. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A permission boundary still proves that the process exists.
    const code = errorCode(error);
    return code === 'EPERM' || code === 'EACCES';
  }
}

/** Owner pid of a lock record, or `null` when it cannot be verified. */
export function lockOwnerPid(contents: string): number | null {
  try {
    const pid = (JSON.parse(contents) as { pid?: unknown } | null)?.pid;
    return Number.isSafeInteger(pid) && (pid as number) >= 1
      ? (pid as number)
      : null;
  } catch {
    return null;
  }
}

/** True when an operation-lock record names an owner that no longer exists. */
export function isStaleOperationLock(contents: string): boolean {
  const pid = lockOwnerPid(contents);
  return pid !== null && !processExists(pid);
}

/**
 * Run `callback` while holding the application's exclusive operation lock.
 *
 * A lock whose owner process is gone is reclaimed; an unverifiable lock fails
 * closed. The lock is only removed when it is still this acquisition's own.
 */
export async function withOperationLock<T>(
  stateRoot: string,
  operation: string,
  callback: (lock: OperationLock) => Promise<T> | T,
): Promise<T> {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, 'operation.lock');
  const instance = randomBytes(16).toString('hex');
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify({ schemaVersion: 1, pid: process.pid, operation, instance })}\n`,
        );
      } catch (error) {
        closeSync(descriptor);
        descriptor = undefined;
        rmSync(path, { force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      let observed: string | null = null;
      try {
        observed = readFileSync(path, 'utf8');
      } catch {
        // A lock that cannot be read has no provable owner.
      }
      const ownerPid = observed === null ? null : lockOwnerPid(observed);
      if (ownerPid === null) {
        throw new Error(
          'An application operation lock exists but cannot be verified; inspect the private state directory.',
        );
      }
      if (processExists(ownerPid)) {
        throw new Error(
          `Another application operation is active (process ${ownerPid}).`,
        );
      }
      // Removed only under the reclaim mutex, and only if it is still this
      // exact dead owner's record; a replaced lock is retried, never unlinked.
      reclaimStaleRecord(path, observed as string, isStaleOperationLock);
    }
  }
  if (descriptor === undefined) {
    throw new Error('The application operation lock could not be acquired.');
  }
  try {
    return await callback({ instance, path });
  } finally {
    closeSync(descriptor);
    // Do not unlink a replacement lock if an operator repaired this one while
    // the operation was active.
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as {
        pid?: unknown;
        instance?: unknown;
      };
      if (current.pid === process.pid && current.instance === instance) {
        rmSync(path, { force: true });
      }
    } catch {
      // A missing or externally repaired lock is not ours to remove.
    }
  }
}
