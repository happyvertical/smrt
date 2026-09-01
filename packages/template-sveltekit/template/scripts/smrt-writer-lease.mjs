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

/** @param {number} pid */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    return code === 'EPERM' || code === 'EACCES';
  }
}

/** @param {{ schemaVersion: number, pid: number, instance: string }} record */
function validateRecord(record) {
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.instance !== 'string' ||
    !/^[a-f0-9]{32}$/.test(record.instance)
  ) {
    throw new Error('The application writer lease is malformed.');
  }
  return record;
}

/** @param {string | number} pathOrDescriptor */
function readRecord(pathOrDescriptor) {
  return validateRecord(
    JSON.parse(readFileSync(pathOrDescriptor, 'utf8')),
  );
}

/** @param {string} stateRoot */
export function readActiveWriterLease(stateRoot) {
  const path = join(stateRoot, 'writer.lease');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let descriptor;
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
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }
      throw new Error(
        'The application writer lease cannot be verified; inspect the private state directory.',
      );
    }
  }
  throw new Error(
    'The application writer lease changed repeatedly and cannot be verified.',
  );
}

/** @param {string} stateRoot */
export function acquireWriterLease(stateRoot) {
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
  let descriptor;
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
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
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
    try {
      const current = readRecord(path);
      if (current.pid === process.pid && current.instance === instance) {
        rmSync(path, { force: true });
      }
    } catch {
      // A missing or externally repaired lease is not ours to remove.
    }
  };
  process.once('exit', release);
  return { release };
}
