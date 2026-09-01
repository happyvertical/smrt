import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';

function processCommand(pid) {
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

export function writeProcessRecord(path, record) {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function sendTerminationSignal(pid, killProcess = process.kill) {
  try {
    killProcess(pid, 'SIGTERM');
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export function matchesApplicationProcess(record, command) {
  return (
    typeof command === 'string' &&
    command.includes('smrt-web.mjs') &&
    command.includes(`--smrt-instance=${record.instance}`)
  );
}

export function readOwnedProcess(path) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
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
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') {
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
