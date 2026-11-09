import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ same: same.pid, away: away.pid, sidecar: process.pid }));`,
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
            sidecar: number;
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

posixOnly('the measured sidecar does not outlive an interrupted CLI', () => {
  const require = createRequire(import.meta.url);
  const runtimeUrl = new URL('./runtime.ts', import.meta.url).href;

  /**
   * A stand-in for the CLI: a real process that spawns the measured sidecar
   * (which leads its own session) and then idles, as `timeOneStart` does while
   * it polls the health route.
   */
  async function interrupted(signal: 'SIGINT' | 'SIGTERM') {
    const { dir, pidFile, script } = scenario({ ignoreTerm: false });
    const host = join(dir, 'host.mjs');
    writeFileSync(
      host,
      [
        `import { spawnMeasuredChild } from ${JSON.stringify(runtimeUrl)};`,
        'spawnMeasuredChild({',
        '  command: process.execPath,',
        `  args: [${JSON.stringify(script)}],`,
        `  cwd: ${JSON.stringify(dir)},`,
        "  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },",
        '});',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    const cli = spawn(
      process.execPath,
      ['--import', pathToFileURL(require.resolve('tsx')).href, host],
      { stdio: 'ignore' },
    );
    if (cli.pid !== undefined) pids.push(cli.pid);
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) =>
        cli.on('close', (code, sig) => resolve({ code, signal: sig })),
    );
    const grand = await waitFor(
      () =>
        existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('}')
          ? (JSON.parse(readFileSync(pidFile, 'utf8')) as {
              same: number;
              away: number;
              sidecar: number;
            })
          : undefined,
      20000,
    );
    pids.push(grand.same, grand.away, grand.sidecar);
    for (const pid of [grand.sidecar, grand.same, grand.away]) {
      expect(isRunning(pid)).toBe(true);
    }

    cli.kill(signal);
    const result = await exited;
    return { result, grand };
  }

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'kills the sidecar, its group and a detached grandchild on %s, and the CLI still exits %i',
    async (signal, status) => {
      const { result, grand } = await interrupted(signal);
      expect(result.code).toBe(status);
      for (const pid of [grand.sidecar, grand.same, grand.away]) {
        await waitFor(() => (isRunning(pid) ? undefined : true), 3000);
      }
    },
    40000,
  );

  it('leaves no process-level handler behind once the child is stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smrt-measure-run-'));
    dirs.push(dir);
    const before = ['exit', 'SIGINT', 'SIGTERM'].map((name) =>
      process.listenerCount(name),
    );
    const child = spawnMeasuredChild({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    expect(process.listenerCount('SIGINT')).toBe(before[1] + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before[2] + 1);
    expect(process.listenerCount('exit')).toBe(before[0] + 1);
    await stopMeasuredProcess(
      child,
      { now: () => performance.now(), sleep },
      3000,
    );
    expect(
      ['exit', 'SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)),
    ).toEqual(before);
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
