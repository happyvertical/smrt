import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SHUTDOWN_MS, resolveDeadlineMs } from './shutdown.ts';

const child = fileURLToPath(
  new URL('../../../test-support/shutdown-child.ts', import.meta.url),
);

const children: ChildProcess[] = [];
afterEach(() => {
  // Only children this test spawned, by handle.
  for (const c of children.splice(0))
    if (c.exitCode === null) c.kill('SIGKILL');
});

async function start(env: Record<string, string>) {
  const proc = spawn(process.execPath, [child], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(proc);
  let out = '';
  proc.stdout.on('data', (d) => {
    out += d;
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const t = Date.now();
  while (!out.includes('ready')) {
    if (Date.now() - t > 20_000) throw new Error('child did not start');
    await new Promise((r) => setTimeout(r, 20));
  }
  return { proc, exited, output: () => out };
}

describe('resolveDeadlineMs', () => {
  it('prefers the option, then SMRT_APP_SHELL_SHUTDOWN_MS, then 30 s', () => {
    expect(resolveDeadlineMs(5, { SMRT_APP_SHELL_SHUTDOWN_MS: '9' })).toBe(5);
    expect(
      resolveDeadlineMs(undefined, { SMRT_APP_SHELL_SHUTDOWN_MS: '9' }),
    ).toBe(9);
    expect(resolveDeadlineMs(undefined, {})).toBe(DEFAULT_SHUTDOWN_MS);
  });
  it('rejects a deadline that is not a positive whole number', () => {
    for (const bad of ['0', '-1', 'soon', '1.5']) {
      expect(() =>
        resolveDeadlineMs(undefined, { SMRT_APP_SHELL_SHUTDOWN_MS: bad }),
      ).toThrow(/SMRT_APP_SHELL_SHUTDOWN_MS/);
    }
  });
});

describe('graceful shutdown (signal to a child process)', () => {
  it('SIGTERM stops the listener, waits for the call in flight, exits 0', async () => {
    const c = await start({ CHILD_MODE: 'drain' });
    c.proc.kill('SIGTERM');
    const { code } = await c.exited;
    expect(code).toBe(0);
    expect(c.output()).toMatch(/call finished\nexit 0 drains=1/);
  });

  it('SIGINT does the same', async () => {
    const c = await start({ CHILD_MODE: 'drain' });
    c.proc.kill('SIGINT');
    expect((await c.exited).code).toBe(0);
  });

  it('a repeated signal joins the shutdown already running', async () => {
    const c = await start({ CHILD_MODE: 'drain' });
    c.proc.kill('SIGTERM');
    c.proc.kill('SIGTERM');
    c.proc.kill('SIGINT');
    expect((await c.exited).code).toBe(0);
    expect(c.output()).toContain('exit 0 drains=1');
  });

  it('a stuck app hits the deadline and exits non-zero', async () => {
    const c = await start({
      CHILD_MODE: 'stuck',
      SMRT_APP_SHELL_SHUTDOWN_MS: '600',
    });
    const t = Date.now();
    c.proc.kill('SIGTERM');
    const { code } = await c.exited;
    expect(code).toBe(1);
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(c.output()).toContain('exit 1');
  });

  it('a drain that never returns is cut off shortly after the deadline', async () => {
    const c = await start({
      CHILD_MODE: 'hang',
      SMRT_APP_SHELL_SHUTDOWN_MS: '500',
    });
    c.proc.kill('SIGTERM');
    const { code } = await c.exited;
    expect(code).toBe(1);
  });
});
