/**
 * Second review round on the `smrt app` port (#3371): T1 (an unavailable
 * process query must never drop a live writer's record) and T2 (readiness
 * packages resolve with Node's own `exports` selection rules).
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
const { createProviderReadinessProbe } = await import(
  '../provider-readiness.js'
);

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

describe('T2: exports follow Node selection rules', () => {
  function application(exportsField: unknown, files: string[]): string {
    const sourceRoot = temporary('t2');
    writeFileSync(join(sourceRoot, 'package.json'), '{"name":"app"}');
    const root = join(sourceRoot, 'node_modules', 'pk');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'pk', type: 'module', exports: exportsField }),
    );
    for (const file of files) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(
        join(root, file),
        `export const checkReadiness = () => ({ ready: true });\nexport const file = ${JSON.stringify(file)};\n`,
      );
    }
    return sourceRoot;
  }

  async function probe(sourceRoot: string, specifier: string) {
    return createProviderReadinessProbe(
      'assets',
      { profile: 'cloud', provider: 's3' },
      { sourceRoot, environment: { SMRT_ASSETS_READINESS_MODULE: specifier } },
    )();
  }

  async function resolved(sourceRoot: string, specifier: string) {
    const { resolveReadinessModule } = await import('../provider-readiness.js');
    const url = await resolveReadinessModule(specifier, sourceRoot);
    return url.slice(
      url.indexOf('/node_modules/pk/') + '/node_modules/pk/'.length,
    );
  }

  it('prefers the more specific pattern regardless of key order', async () => {
    const sourceRoot = application(
      {
        './*': './generic/*.js',
        './*.js': './specific/*.js',
        './feature/*': './feature-generic/*.js',
        './feature/*.js': './feature-specific/*.js',
      },
      [
        'generic/a.js',
        'specific/a.js',
        'generic/a.js.js',
        'feature-generic/x.js',
        'feature-specific/x.js',
        'feature-generic/x.js.js',
      ],
    );
    expect(await resolved(sourceRoot, 'pk/a.js')).toBe('specific/a.js');
    expect(await resolved(sourceRoot, 'pk/a')).toBe('generic/a.js');
    expect(await resolved(sourceRoot, 'pk/feature/x.js')).toBe(
      'feature-specific/x.js',
    );
    expect(await resolved(sourceRoot, 'pk/feature/x')).toBe(
      'feature-generic/x.js',
    );
  });

  it('treats a matched null condition as excluding the subpath', async () => {
    const sourceRoot = application(
      {
        '.': { node: null, default: './fallback.js' },
        './hidden/*': null,
        './*': './*.js',
      },
      ['fallback.js', 'hidden/x.js', 'open.js'],
    );
    await expect(probe(sourceRoot, 'pk')).rejects.toThrow();
    await expect(probe(sourceRoot, 'pk/hidden/x')).rejects.toThrow();
    await expect(probe(sourceRoot, 'pk/open')).resolves.toBeUndefined();
  });

  it('honours condition order as written, exact keys before patterns, and array fallbacks', async () => {
    const sourceRoot = application(
      {
        '.': { import: './esm.js', node: './node.js' },
        './x': './exact.js',
        './*': './pattern/*.js',
        './arr': ['not-relative', './array.js'],
        './bad': '../escape.js',
      },
      ['esm.js', 'node.js', 'exact.js', 'pattern/x.js', 'array.js'],
    );
    expect(await resolved(sourceRoot, 'pk')).toBe('esm.js');
    expect(await resolved(sourceRoot, 'pk/x')).toBe('exact.js');
    expect(await resolved(sourceRoot, 'pk/arr')).toBe('array.js');
    await expect(probe(sourceRoot, 'pk/bad')).rejects.toThrow();
  });
});
