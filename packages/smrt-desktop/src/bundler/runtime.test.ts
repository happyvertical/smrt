import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stopMeasuredProcess } from './measure.js';
import { descendantsOf, spawnMeasuredChild } from './runtime.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie (killed, not yet reaped) is not running.
  return !/^Z/.test(psState(pid));
}

function psState(pid: number): string {
  try {
    const out = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    return out.trim() || 'gone';
  } catch {
    return 'gone';
  }
}

async function waitFor<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(20);
  }
}

/**
 * A parent that starts a grandchild in its own group, one that calls setsid
 * (what `spawn(..., { detached: true })` does) and optionally ignores SIGTERM,
 * then writes their pids and idles.
 */
function scenario(options: { ignoreTerm: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-measure-run-'));
  dirs.push(dir);
  const pidFile = join(dir, 'pids.json');
  const script = join(dir, 'parent.mjs');
  const idle = options.ignoreTerm
    ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
    : 'setInterval(()=>{},1000)';
  writeFileSync(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const idle = ${JSON.stringify(idle)};`,
      "const same = spawn(process.execPath, ['-e', idle], { stdio: 'ignore' });",
      "const away = spawn(process.execPath, ['-e', idle], { stdio: 'ignore', detached: true });",
      'away.unref();',
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ same: same.pid, away: away.pid }));`,
      ...(options.ignoreTerm ? ["process.on('SIGTERM', () => {});"] : []),
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  return { dir, pidFile, script };
}

posixOnly('stopping a measured sidecar', () => {
  async function leavesNothing(ignoreTerm: boolean): Promise<void> {
    const { dir, pidFile, script } = scenario({ ignoreTerm });
    const child = spawnMeasuredChild({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const grand = await waitFor(() =>
      existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('}')
        ? (JSON.parse(readFileSync(pidFile, 'utf8')) as {
            same: number;
            away: number;
          })
        : undefined,
    );
    pids.push(grand.same, grand.away);
    expect(isRunning(grand.same)).toBe(true);
    expect(isRunning(grand.away)).toBe(true);
    expect(await child.alive?.()).toBe(true);

    await stopMeasuredProcess(
      child,
      { now: () => performance.now(), sleep },
      ignoreTerm ? 300 : 3000,
    );

    await waitFor(() => (isRunning(grand.same) ? undefined : true), 3000);
    await waitFor(() => (isRunning(grand.away) ? undefined : true), 3000);
    expect(await child.alive?.()).toBe(false);
  }

  it('leaves no grandchild running, grouped or detached', async () => {
    await leavesNothing(false);
  }, 20000);

  it('leaves no grandchild running even when everything ignores SIGTERM', async () => {
    await leavesNothing(true);
  }, 20000);

  it('is a process group leader, so one signal reaches a child that never spawns anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smrt-measure-run-'));
    dirs.push(dir);
    const child = spawnMeasuredChild({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    expect(await child.alive?.()).toBe(true);
    await stopMeasuredProcess(
      child,
      { now: () => performance.now(), sleep },
      3000,
    );
    expect(await child.alive?.()).toBe(false);
  }, 20000);
});

describe('descendantsOf', () => {
  it('walks the parent chain without the root and without cycles', () => {
    const rows = [
      { pid: 1, ppid: 0, pgid: 1, stat: 'S' },
      { pid: 10, ppid: 1, pgid: 10, stat: 'S' },
      { pid: 11, ppid: 10, pgid: 10, stat: 'S' },
      { pid: 12, ppid: 11, pgid: 12, stat: 'S' },
      { pid: 20, ppid: 1, pgid: 20, stat: 'S' },
    ];
    expect(descendantsOf(rows, 10).sort()).toEqual([11, 12]);
    expect(descendantsOf(rows, 20)).toEqual([]);
    expect(descendantsOf(rows, 999)).toEqual([]);
  });
});
