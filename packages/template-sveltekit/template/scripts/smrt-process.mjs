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
    return result.status === 0 ? result.stdout.trim() : '';
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function writeProcessRecord(path, record) {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readOwnedProcess(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      typeof record.instance !== 'string' ||
      !/^[a-f0-9]{32}$/.test(record.instance)
    ) {
      throw new Error('Invalid process record.');
    }
    process.kill(record.pid, 0);
    const command = processCommand(record.pid);
    if (
      !command.includes('smrt-web.mjs') ||
      !command.includes(`--smrt-instance=${record.instance}`)
    ) {
      throw new Error('Process identity does not match.');
    }
    return record;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}
