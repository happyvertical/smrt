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

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A permission boundary still proves that the process exists.
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return true;
    return false;
  }
}

export async function withOperationLock(stateRoot, operation, callback) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, 'operation.lock');
  const instance = randomBytes(16).toString('hex');
  let descriptor;
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
      if (error?.code !== 'EEXIST') throw error;
      let ownerPid = null;
      let staleIdentity;
      let staleDescriptor;
      try {
        staleDescriptor = openSync(path, 'r');
        staleIdentity = fstatSync(staleDescriptor);
        ownerPid = JSON.parse(readFileSync(staleDescriptor, 'utf8')).pid;
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
      if (processExists(ownerPid)) {
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
        if (removeError?.code !== 'ENOENT') throw removeError;
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
      const current = JSON.parse(readFileSync(path, 'utf8'));
      if (current.pid === process.pid && current.instance === instance) {
        rmSync(path, { force: true });
      }
    } catch {
      // A missing or externally repaired lock is not ours to remove.
    }
  }
}
