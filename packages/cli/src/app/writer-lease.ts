/**
 * Single-writer lease (`<state>/writer.lease`).
 *
 * Ported unchanged from the template's `scripts/smrt-writer-lease.mjs`. The
 * running web server takes the same lease, so the file, record shape, and
 * operation-lock admission rule must stay byte-compatible.
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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { errorCode } from './errors.js';
import { processExists } from './operation-lock.js';

/** Persisted writer-lease record. */
export interface WriterLeaseRecord {
  schemaVersion: 1;
  pid: number;
  instance: string;
}

/** Held writer lease. `release()` is idempotent. */
export interface WriterLease {
  release(): void;
}

/** Options for {@link acquireWriterLease}. */
export interface AcquireWriterLeaseOptions {
  /** Instance of the operation lock this writer was started under, if any. */
  operationInstance?: string;
}

function validateRecord(record: unknown): WriterLeaseRecord {
  const candidate = record as Partial<WriterLeaseRecord> | null;
  if (
    candidate?.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) < 1 ||
    typeof candidate.instance !== 'string' ||
    !/^[a-f0-9]{32}$/.test(candidate.instance)
  ) {
    throw new Error('The application writer lease is malformed.');
  }
  return candidate as WriterLeaseRecord;
}

function readRecord(pathOrDescriptor: string | number): WriterLeaseRecord {
  return validateRecord(JSON.parse(readFileSync(pathOrDescriptor, 'utf8')));
}

/**
 * Return the live writer lease, removing a lease whose owner is gone.
 */
export function readActiveWriterLease(
  stateRoot: string,
): WriterLeaseRecord | null {
  const path = join(stateRoot, 'writer.lease');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'r');
      const identity = fstatSync(descriptor);
      const record = readRecord(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      if (processExists(record.pid)) return record;
      const current = lstatSync(path);
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        continue;
      }
      rmSync(path);
      return null;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (errorCode(error) === 'ENOENT') return null;
      throw new Error(
        'The application writer lease cannot be verified; inspect the private state directory.',
      );
    }
  }
  throw new Error(
    'The application writer lease changed repeatedly and cannot be verified.',
  );
}

/**
 * Acquire the application's single-writer lease.
 *
 * A live operator operation blocks the writer unless the writer presents that
 * operation's own lock instance (a managed `start`); a dead operation lock is
 * reclaimed.
 */
export function acquireWriterLease(
  stateRoot: string,
  options: AcquireWriterLeaseOptions = {},
): WriterLease {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, 'writer.lease');
  const active = readActiveWriterLease(stateRoot);
  if (active?.pid === process.pid) return { release() {} };
  if (active) {
    throw new Error(
      `Another application writer is active (process ${active.pid}).`,
    );
  }
  const instance = randomBytes(16).toString('hex');
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, instance })}\n`,
      );
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
      }
      if (errorCode(error) === 'EEXIST') {
        const owner = readActiveWriterLease(stateRoot);
        if (!owner && attempt === 0) continue;
        throw new Error(
          `Another application writer is active${owner ? ` (process ${owner.pid})` : ''}.`,
        );
      }
      rmSync(path, { force: true });
      throw error;
    }
  }
  if (descriptor === undefined) {
    throw new Error('The application writer lease could not be acquired.');
  }
  closeSync(descriptor);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      const current = readRecord(path);
      if (current.pid === process.pid && current.instance === instance) {
        rmSync(path, { force: true });
      }
    } catch {
      // A missing or externally repaired lease is not ours to remove.
    }
  };
  let operationDescriptor: number | undefined;
  try {
    const operationPath = join(stateRoot, 'operation.lock');
    operationDescriptor = openSync(operationPath, 'r');
    const operationIdentity = fstatSync(operationDescriptor);
    const operation = JSON.parse(readFileSync(operationDescriptor, 'utf8')) as {
      pid?: unknown;
      instance?: unknown;
    };
    closeSync(operationDescriptor);
    operationDescriptor = undefined;
    if (
      !Number.isSafeInteger(operation.pid) ||
      (operation.pid as number) < 1 ||
      typeof operation.instance !== 'string'
    ) {
      throw new Error('The application operation lock cannot be verified.');
    }
    if (!processExists(operation.pid as number)) {
      const currentIdentity = lstatSync(operationPath);
      if (
        currentIdentity.dev !== operationIdentity.dev ||
        currentIdentity.ino !== operationIdentity.ino
      ) {
        throw new Error('The application operation lock changed unexpectedly.');
      }
      rmSync(operationPath);
    } else if (operation.instance !== options.operationInstance) {
      release();
      throw new Error(
        'An application operation is active; wait for it to finish before starting a writer.',
      );
    }
  } catch (error) {
    if (operationDescriptor !== undefined) closeSync(operationDescriptor);
    if (errorCode(error) !== 'ENOENT') {
      release();
      if (error instanceof SyntaxError) {
        throw new Error('The application operation lock cannot be verified.');
      }
      throw error;
    }
  }
  process.once('exit', release);
  return { release };
}
