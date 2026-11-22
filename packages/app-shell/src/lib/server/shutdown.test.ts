import { type ChildProcess, spawn } from 'node:child_process';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDrain,
  DEFAULT_SHUTDOWN_MS,
  resolveDeadlineMs,
} from './shutdown.ts';

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
    stdio: ['pipe', 'pipe', 'inherit'],
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
  while (!/ready \d+\n/.test(out)) {
    if (Date.now() - t > 20_000) throw new Error('child did not start');
    await new Promise((r) => setTimeout(r, 20));
  }
  const port = Number(/ready (\d+)/.exec(out)?.[1]);
  return { proc, exited, port, output: () => out };
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

  it('waits for background work (an import) before the apps close and the process exits', async () => {
    const c = await start({ CHILD_MODE: 'drain' });
    c.proc.kill('SIGTERM');
    expect((await c.exited).code).toBe(0);
    // The job finished first, the drain saw it done, and only then the exit.
    expect(c.output()).toMatch(
      /work done\ndrain 1 workDone=true\ncall finished\nexit 0/,
    );
  });

  it('ends an open event stream first, so one idle tab does not hold the shutdown to its deadline', async () => {
    const c = await start({
      CHILD_MODE: 'drain',
      CHILD_STOPWORK: '0',
      SMRT_APP_SHELL_SHUTDOWN_MS: '8000',
    });
    const stream = get({ port: c.port, path: '/stream', agent: false });
    await new Promise<void>((resolve) =>
      stream.once('response', (res) => {
        res.resume();
        resolve();
      }),
    );
    const t = Date.now();
    c.proc.kill('SIGTERM');
    expect((await c.exited).code).toBe(0);
    expect(Date.now() - t).toBeLessThan(4_000);
  });

  it('still drains the apps when a step before it throws, and exits non-zero', async () => {
    const c = await start({ CHILD_MODE: 'drain', CHILD_STOPWORK: 'throw' });
    c.proc.kill('SIGTERM');
    expect((await c.exited).code).toBe(1);
    expect(c.output()).toContain('drain 1');
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

describe('embedded drain (the host owns the listener, signals and exit, #5546)', () => {
  it('runs the ordered steps, leaves the host listener open, and does not exit the host', async () => {
    const c = await start({ CHILD_MODE: 'embedded' });
    c.proc.stdin?.write('drain\n');
    // The process leaves only when the HOST closes its listener and exits.
    expect((await c.exited).code).toBe(0);
    const out = c.output();
    // Streams end, then the import finishes, then the apps close.
    expect(out).toMatch(
      /streams ended\nwork done\ndrain 1 workDone=true\ncall finished\n/,
    );
    expect(out).toContain('same promise true');
    expect(out).toContain(
      'steps {"endStreams":"ok","stopAccepting":"skipped","stopWork":"ok","drain":"ok"}',
    );
    // Still listening, and still answering, after the drain returned.
    expect(out).toContain('listening true');
    expect(out).toContain('served 200 ok');
    expect(out).toContain('exit code 0');
  });

  it('never closes a listener or installs a signal handler by itself', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const before = process.listenerCount('SIGTERM');
    const drain = createDrain({ drain: async () => ({ closed: 2, busy: 0 }) });
    const result = await drain();
    expect(result).toMatchObject({ code: 0, clean: true, closed: 2, busy: 0 });
    expect(result.steps.stopAccepting).toBe('skipped');
    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
    err.mockRestore();
  });

  it('is idempotent: a second call returns the first promise and drains once', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const apps = vi.fn(async () => ({ closed: 1, busy: 0 }));
    const drain = createDrain({ drain: apps });
    const first = drain();
    expect(drain({ reason: 'again' })).toBe(first);
    await first;
    expect(drain()).toBe(first);
    expect(apps).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('reports a failed step and still closes the apps', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const apps = vi.fn(async () => ({ closed: 1, busy: 0 }));
    const result = await createDrain({
      stopWork: () => {
        throw new Error('x');
      },
      drain: apps,
    })();
    expect(apps).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ code: 1, clean: false });
    expect(result.steps).toMatchObject({ stopWork: 'failed', drain: 'ok' });
    err.mockRestore();
  });

  it('reports busy apps at close', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const result = await createDrain({
      drain: async () => ({ closed: 1, busy: 2 }),
    })();
    expect(result).toMatchObject({ code: 1, busy: 2 });
    expect(result.steps.drain).toBe('busy');
    err.mockRestore();
  });

  it('is bounded: a drain that never returns resolves by the deadline with that step timed out', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const started = Date.now();
    const result = await createDrain({
      deadlineMs: 200,
      drain: () => new Promise(() => {}),
    })();
    expect(Date.now() - started).toBeLessThan(1_800);
    expect(result).toMatchObject({ code: 1, clean: false });
    expect(result.steps.drain).toBe('timeout');
    err.mockRestore();
  });

  it('runs the listener step only when the caller owns one and passes it', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stop = vi.fn();
    const result = await createDrain({
      drain: async () => ({ closed: 0, busy: 0 }),
    })({ stopAccepting: stop });
    expect(stop).toHaveBeenCalledOnce();
    expect(result.steps.stopAccepting).toBe('ok');
    err.mockRestore();
  });
});
