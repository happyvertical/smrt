/**
 * Managed web-process record (`<state>/app.pid`).
 *
 * Ported from the template's `scripts/smrt-process.mjs`. A recorded pid is
 * only trusted when the live process's command line proves it is the web
 * launcher with this record's instance nonce, so a recycled pid is never
 * signalled.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { errorCode } from './errors.js';

/** Persisted web-process identity. */
export interface ApplicationProcessRecord {
  pid: number;
  instance: string;
}

/** File name of the web launcher; part of the process-identity proof. */
export const WEB_LAUNCHER_NAME = 'smrt-web.mjs';

function processCommand(pid: number): string | null {
  if (platform() === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return result.status === 0 ? result.stdout.trim() : null;
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Write the private (mode 0600) process record. */
export function writeProcessRecord(
  path: string,
  record: ApplicationProcessRecord,
): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * Send SIGTERM. Returns `false` when the process had already exited; any
 * other failure (e.g. EPERM) is rethrown.
 */
export function sendTerminationSignal(
  pid: number,
  killProcess: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
): boolean {
  try {
    killProcess(pid, 'SIGTERM');
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

/** True when `command` is the web launcher started with this record's nonce. */
export function matchesApplicationProcess(
  record: Pick<ApplicationProcessRecord, 'instance'>,
  command: unknown,
): boolean {
  return (
    typeof command === 'string' &&
    command.includes(WEB_LAUNCHER_NAME) &&
    command.includes(`--smrt-instance=${record.instance}`)
  );
}

/**
 * Return the recorded web process when it is live and provably ours;
 * otherwise remove the stale record and return `null`.
 */
export function readOwnedProcess(
  path: string,
): ApplicationProcessRecord | null {
  let record: ApplicationProcessRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as ApplicationProcessRecord;
    if (
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      typeof record.instance !== 'string' ||
      !/^[a-f0-9]{32}$/.test(record.instance)
    ) {
      throw new Error('Invalid process record.');
    }
  } catch {
    rmSync(path, { force: true });
    return null;
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EPERM' && code !== 'EACCES') {
      rmSync(path, { force: true });
      return null;
    }
  }
  const command = processCommand(record.pid);
  if (command === null) {
    throw new Error(
      `Application process ${record.pid} is live but its identity cannot be verified.`,
    );
  }
  if (!matchesApplicationProcess(record, command)) {
    rmSync(path, { force: true });
    return null;
  }
  return record;
}
