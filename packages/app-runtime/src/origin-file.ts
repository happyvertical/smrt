/**
 * The running local app's loopback origin (`origin.json`, smrt#4729).
 *
 * A process that is not the app's own web server (the desktop plugin
 * launcher) needs to find the instance that is running for one data root. The
 * app records its origin in the application state root, which is per location
 * (a backup or copy of the data root does not carry it), and removes it on a
 * clean exit. The file holds nothing secret; a reader must still probe the
 * origin, because a crash leaves the file behind.
 */

import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { processExists } from './operation-lock.js';
import {
  isPrivateFileStat,
  readPrivateFileBounded,
  writePrivateFileAtomicSync,
} from './private-files.js';

/** File name inside the application state root. */
export const ORIGIN_FILE = 'origin.json';

/** Persisted origin record. */
export interface OriginRecord {
  version: 1;
  /** Exactly `http://127.0.0.1:<port>`. */
  origin: string;
  pid: number;
  startedAt: string;
}

const MAX_BYTES = 1024;
const ORIGIN = /^http:\/\/127\.0\.0\.1:(0|[1-9][0-9]{0,4})$/u;

/** `origin` when it is exactly `http://127.0.0.1:<port>` (1..65535), else `null`. */
export function parseLoopbackOrigin(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  const port = Number(ORIGIN.exec(origin)?.[1]);
  return port >= 1 && port <= 65_535 ? origin : null;
}

/**
 * Record this process's origin. Returns the record, or `null` (nothing is
 * written) when `origin` is not an exact loopback origin.
 */
export function writeOriginFile(
  stateRoot: string,
  origin: unknown,
  now: Date = new Date(),
): OriginRecord | null {
  const valid = parseLoopbackOrigin(origin);
  if (!valid) return null;
  const record: OriginRecord = {
    version: 1,
    origin: valid,
    pid: process.pid,
    startedAt: now.toISOString(),
  };
  writePrivateFileAtomicSync(
    join(stateRoot, ORIGIN_FILE),
    `${JSON.stringify(record)}\n`,
  );
  return record;
}

/**
 * Remove the record. With `pid`, only a record that process wrote, so a later
 * instance's file is never removed by an earlier one shutting down.
 */
export function removeOriginFile(stateRoot: string, pid?: number): void {
  const path = join(stateRoot, ORIGIN_FILE);
  try {
    if (pid !== undefined) {
      const record = JSON.parse(readFileSync(path, 'utf8')) as {
        pid?: unknown;
      };
      if (record.pid !== pid) return;
    }
    rmSync(path, { force: true });
  } catch {
    // Best effort: an unreadable record is left for the next writer.
  }
}

/**
 * Read the record: `null` when it is absent, unreadable, not owner-private,
 * malformed, not an exact loopback origin, or names a process that is gone.
 * Never throws and never creates anything.
 */
export async function readOriginFile(
  stateRoot: string,
): Promise<OriginRecord | null> {
  const path = join(stateRoot, ORIGIN_FILE);
  try {
    if (
      process.platform !== 'win32' &&
      !isPrivateFileStat(lstatSync(path), MAX_BYTES)
    ) {
      return null;
    }
    const text = await readPrivateFileBounded(path, MAX_BYTES);
    if (text === null) return null;
    const value = JSON.parse(text) as Partial<OriginRecord>;
    if (
      Object.keys(value).sort().join() !== 'origin,pid,startedAt,version' ||
      value.version !== 1 ||
      !parseLoopbackOrigin(value.origin) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      typeof value.startedAt !== 'string' ||
      !processExists(value.pid as number)
    ) {
      return null;
    }
    return value as OriginRecord;
  } catch {
    return null;
  }
}

const SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Write the record for `env.ORIGIN` (the desktop supervisor sets it) and
 * remove it when the process exits or is asked to stop. Best effort: a failure
 * never blocks startup. Returns a disposer, or `undefined` when nothing was
 * written. `resolveStateRoot` runs only for a valid origin, so a plain
 * `pnpm dev` never creates the state root for this.
 */
export function publishLocalOrigin(
  env: NodeJS.ProcessEnv,
  resolveStateRoot: () => string,
): (() => void) | undefined {
  if (!parseLoopbackOrigin(env.ORIGIN)) return undefined;
  let stateRoot: string;
  try {
    stateRoot = resolveStateRoot();
    if (!writeOriginFile(stateRoot, env.ORIGIN)) return undefined;
  } catch {
    return undefined;
  }
  const remove = () => removeOriginFile(stateRoot, process.pid);
  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      remove();
      process.off(signal, handler);
      // Our listener replaced the default stop; restore it when nobody else
      // (adapter-node's graceful shutdown) is handling the signal.
      if (process.listenerCount(signal) === 0)
        process.kill(process.pid, signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  process.once('exit', remove);
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off('exit', remove);
    remove();
  };
}
