/**
 * Exclusive operator-operation lock (`<state>/operation.lock`).
 *
 * Ported unchanged from the template's `scripts/smrt-operation-lock.mjs`: the
 * same file, record shape, stale-owner reclamation, and messages.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { errorCode } from './errors.js';

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
      let ownerPid: unknown = null;
      let staleIdentity: Stats | undefined;
      let staleDescriptor: number | undefined;
      try {
        staleDescriptor = openSync(path, 'r');
        staleIdentity = fstatSync(staleDescriptor);
        ownerPid = (
          JSON.parse(readFileSync(staleDescriptor, 'utf8')) as {
            pid?: unknown;
          }
        ).pid;
      } catch {
        // A malformed partial lock has no authority.
      } finally {
        if (staleDescriptor !== undefined) closeSync(staleDescriptor);
      }
      if (!Number.isSafeInteger(ownerPid)) {
        throw new Error(
          'An application operation lock exists but cannot be verified; inspect the private state directory.',
        );
      }
      if (processExists(ownerPid as number)) {
        throw new Error(
          `Another application operation is active (process ${ownerPid}).`,
        );
      }
      try {
        const currentIdentity = lstatSync(path);
        if (
          !staleIdentity ||
          currentIdentity.dev !== staleIdentity.dev ||
          currentIdentity.ino !== staleIdentity.ino
        ) {
          continue;
        }
        rmSync(path);
      } catch (removeError) {
        if (errorCode(removeError) !== 'ENOENT') throw removeError;
      }
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
