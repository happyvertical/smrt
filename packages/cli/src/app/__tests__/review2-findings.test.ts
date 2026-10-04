/**
 * Second review round on the `smrt app` port (#3371): T1 (an unavailable
 * process query must never drop a live writer's record). T2 (readiness
 * packages resolve with Node's own `exports` selection rules) moved with the
 * readiness resolver to `@happyvertical/smrt-app-runtime`
 * (`src/operator-primitives.test.ts`).
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { afterEach, describe, expect, it, vi } from 'vitest';

const psHooks = vi.hoisted(() => ({
  /** Fail the Nth `ps` query (1-based); 0 disables. */
  failCall: 0,
  calls: 0,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnSync = ((command: string, ...rest: unknown[]) => {
    if (command === 'ps') {
      psHooks.calls += 1;
      if (psHooks.calls === psHooks.failCall) {
        return {
          status: 1,
          stdout: '',
          stderr: 'ps: unavailable',
          pid: 0,
          output: [],
          signal: null,
        };
      }
    }
    return (actual.spawnSync as (...args: unknown[]) => unknown)(
      command,
      ...rest,
    );
  }) as typeof actual.spawnSync;
  return { ...actual, default: { ...actual, spawnSync }, spawnSync };
});

const { runAppCommand } = await import('../cli.js');
const { resolveApplicationStateRoot } = await import('../identity.js');

const roots: string[] = [];
const children: number[] = [];
const ENV_KEYS = ['SMRT_DATA_DIR', 'XDG_STATE_HOME', 'PORT'];
const savedEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  psHooks.failCall = 0;
  psHooks.calls = 0;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporary(label: string): string {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `smrt-review2-${label}-`)),
  );
  roots.push(directory);
  return directory;
}

describe('T1: an unverifiable process keeps its record', () => {
  it('stop neither signals nor forgets a live launcher when the re-check query fails', async () => {
    const root = temporary('t1');
    const app = join(root, 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"t1-app"}');
    process.env.SMRT_DATA_DIR = join(root, 'data');
    process.env.XDG_STATE_HOME = join(root, 'state-home');
    const instance = 'abcdefabcdefabcdefabcdefabcdefab';
    const launcher = join(root, 'smrt-web.mjs');
    writeFileSync(launcher, 'setInterval(() => {}, 1000);\n');
    const child = spawn(
      process.execPath,
      [launcher, `--smrt-instance=${instance}`],
      {
        stdio: 'ignore',
      },
    );
    children.push(child.pid as number);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stateRoot = resolveApplicationStateRoot({
      appId: 't1-app',
      dataDirectory: join(root, 'data'),
      sourceRoot: app,
    });
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const record = join(stateRoot, 'app.pid');
    const io = { stdout: [] as string[], stderr: [] as string[] };
    const run = () =>
      runAppCommand(['stop'], {
        cwd: app,
        io: {
          stdout: (text) => io.stdout.push(text),
          stderr: (text) => io.stderr.push(text),
        },
        dependencies: {
          resolveRuntime: async () =>
            resolveApplicationRuntime({ profile: 'local' }) as never,
        },
      });
    // `prepareApplicationStateRoot` runs before the record is written.
    await run();
    writeFileSync(record, `${JSON.stringify({ pid: child.pid, instance })}\n`, {
      mode: 0o600,
    });
    io.stdout.length = 0;
    io.stderr.length = 0;
    psHooks.calls = 0;
    psHooks.failCall = 2; // first identity read succeeds, the re-check fails
    const code = await run();
    expect(psHooks.calls).toBeGreaterThanOrEqual(2);
    expect(child.exitCode).toBeNull();
    expect(() => process.kill(child.pid as number, 0)).not.toThrow();
    expect(existsSync(record)).toBe(true);
    expect(code).toBe(1);
    expect(JSON.parse(io.stderr.join('')).message).toContain(
      `Application process ${child.pid}`,
    );
  }, 30_000);
});
