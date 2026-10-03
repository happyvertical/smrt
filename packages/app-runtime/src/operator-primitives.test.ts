/**
 * State custody, operation lock, writer lease, stale reclamation, and
 * provider-readiness primitives shared by the web process and `smrt app`.
 *
 * Moved with their implementation from `@happyvertical/smrt-cli`
 * (`src/app/__tests__/primitives.test.ts`, review findings R1/R3 and T2) so
 * the `node:fs` interleaving hooks below still reach the code under test;
 * from the CLI the package is an externalized dependency a mock cannot touch.
 */

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withOperationLock } from './operation-lock.js';
import {
  createProviderReadinessProbe,
  resolveReadinessModule,
} from './provider-readiness.js';
import {
  prepareApplicationStateRoot,
  resolveApplicationStateRoot,
} from './state-root.js';
import { acquireWriterLease, readActiveWriterLease } from './writer-lease.js';

const fsHooks = vi.hoisted(() => ({
  beforeRm: undefined as undefined | ((path: string) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const rmSync: typeof actual.rmSync = (path, options) => {
    if (typeof path === 'string') fsHooks.beforeRm?.(path);
    return actual.rmSync(path, options);
  };
  return { ...actual, default: { ...actual, rmSync }, rmSync };
});

const DEAD_PID = 2_147_483_647;
const INSTANCE = '0123456789abcdef0123456789abcdef';
const STALE_INSTANCE = INSTANCE;
const directories: string[] = [];

function temporary(label: string): string {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `smrt-runtime-${label}-`)),
  );
  directories.push(directory);
  return directory;
}

afterEach(() => {
  fsHooks.beforeRm = undefined;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('operation lock', () => {
  it('serializes application operations with one exclusive lock', async () => {
    const directory = temporary('operation');
    let release = () => {};
    const held = withOperationLock(directory, 'first', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await expect(
      withOperationLock(directory, 'second', async () => {}),
    ).rejects.toThrow('Another application operation is active');
    release();
    await held;
    await expect(
      withOperationLock(directory, 'third', async () => 'done'),
    ).resolves.toBe('done');
    expect(existsSync(join(directory, 'operation.lock'))).toBe(false);
  });

  it('reclaims a lock whose owner process is gone', async () => {
    const directory = temporary('stale-lock');
    writeFileSync(
      join(directory, 'operation.lock'),
      `${JSON.stringify({ schemaVersion: 1, pid: DEAD_PID, operation: 'setup', instance: INSTANCE })}\n`,
    );
    await expect(
      withOperationLock(directory, 'setup', async (lock) => {
        const record = JSON.parse(readFileSync(lock.path, 'utf8'));
        expect(record).toMatchObject({ pid: process.pid, operation: 'setup' });
        expect(statSync(lock.path).mode & 0o777).toBe(0o600);
        return 'reclaimed';
      }),
    ).resolves.toBe('reclaimed');
  });

  it('fails closed on a malformed lock and leaves it for inspection', async () => {
    const directory = temporary('malformed-lock');
    writeFileSync(join(directory, 'operation.lock'), '{"pid":');
    await expect(
      withOperationLock(directory, 'setup', async () => {}),
    ).rejects.toThrow('cannot be verified');
    expect(existsSync(join(directory, 'operation.lock'))).toBe(true);
  });

  it('does not unlink a lock an operator replaced during the operation', async () => {
    const directory = temporary('repaired-lock');
    const replacement = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, operation: 'other', instance: INSTANCE })}\n`;
    await withOperationLock(directory, 'setup', async (lock) => {
      rmSync(lock.path);
      writeFileSync(lock.path, replacement);
    });
    expect(readFileSync(join(directory, 'operation.lock'), 'utf8')).toBe(
      replacement,
    );
  });

  it('elects exactly one winner among concurrent processes', async () => {
    const directory = temporary('race');
    const moduleUrl = new URL('./operation-lock.ts', import.meta.url).href;
    const script = `
      const { withOperationLock } = await import(${JSON.stringify(moduleUrl)});
      try {
        await withOperationLock(process.argv[1], 'race', () => new Promise((r) => setTimeout(r, 1500)));
        process.stdout.write('won');
      } catch (error) {
        process.stdout.write(error.message.includes('Another application operation is active') ? 'lost' : 'error:' + error.message);
      }`;
    const runs = Array.from({ length: 4 }, () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, directory],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      return new Promise<string>((resolve) =>
        child.on('exit', () => resolve(output)),
      );
    });
    const outcomes = (await Promise.all(runs)).sort();
    expect(outcomes).toEqual(['lost', 'lost', 'lost', 'won']);
    expect(existsSync(join(directory, 'operation.lock'))).toBe(false);
  });
});

describe('writer lease', () => {
  it('fails closed on live writers and removes only stale leases', () => {
    const directory = temporary('writer');
    writeFileSync(
      join(directory, 'writer.lease'),
      `${JSON.stringify({ schemaVersion: 1, pid: DEAD_PID, instance: INSTANCE })}\n`,
    );
    expect(readActiveWriterLease(directory)).toBeNull();
    expect(existsSync(join(directory, 'writer.lease'))).toBe(false);

    const lease = acquireWriterLease(directory);
    expect(readActiveWriterLease(directory)).toMatchObject({
      pid: process.pid,
    });
    expect(statSync(join(directory, 'writer.lease')).mode & 0o777).toBe(0o600);
    lease.release();
    lease.release();
    expect(readActiveWriterLease(directory)).toBeNull();
  });

  it('refuses a second writer while another live process holds the lease', () => {
    const directory = temporary('writer-live');
    const parentPid = process.ppid;
    writeFileSync(
      join(directory, 'writer.lease'),
      `${JSON.stringify({ schemaVersion: 1, pid: parentPid, instance: INSTANCE })}\n`,
    );
    expect(() => acquireWriterLease(directory)).toThrow(
      `Another application writer is active (process ${parentPid}).`,
    );
    expect(existsSync(join(directory, 'writer.lease'))).toBe(true);
  });

  it('fails closed on a malformed lease', () => {
    const directory = temporary('writer-malformed');
    writeFileSync(
      join(directory, 'writer.lease'),
      `${JSON.stringify({ schemaVersion: 2, pid: 1, instance: 'x' })}\n`,
    );
    expect(() => readActiveWriterLease(directory)).toThrow(
      'cannot be verified',
    );
  });

  it('prevents a direct writer from racing an active operator command', async () => {
    const directory = temporary('writer-operation');
    await withOperationLock(directory, 'backup', async (lock) => {
      expect(() => acquireWriterLease(directory)).toThrow(
        'application operation is active',
      );
      expect(existsSync(join(directory, 'writer.lease'))).toBe(false);
      const managedStartLease = acquireWriterLease(directory, {
        operationInstance: lock.instance,
      });
      managedStartLease.release();
    });
  });

  it('reclaims a dead operation lock before admitting a writer', () => {
    const directory = temporary('writer-stale-operation');
    writeFileSync(
      join(directory, 'operation.lock'),
      `${JSON.stringify({ schemaVersion: 1, pid: DEAD_PID, operation: 'setup', instance: INSTANCE })}\n`,
    );
    const lease = acquireWriterLease(directory);
    expect(existsSync(join(directory, 'operation.lock'))).toBe(false);
    lease.release();
  });

  it('refuses a writer when the operation lock cannot be parsed', () => {
    const directory = temporary('writer-bad-operation');
    writeFileSync(join(directory, 'operation.lock'), 'not json');
    expect(() => acquireWriterLease(directory)).toThrow(
      'The application operation lock cannot be verified.',
    );
    expect(existsSync(join(directory, 'writer.lease'))).toBe(false);
  });
});

describe('provider readiness', () => {
  it('requires deployed provider modules to return verified readiness', async () => {
    const context = { profile: 'self-hosted', provider: 'oidc' };
    const probe = (environment: Record<string, string | undefined>) =>
      createProviderReadinessProbe('authentication', context, {
        environment,
      })();
    await expect(probe({})).rejects.toThrow(
      'must name an installed provider readiness module',
    );
    await expect(
      probe({
        SMRT_AUTH_READINESS_MODULE:
          'data:text/javascript,export default async () => ({ ready: false })',
      }),
    ).rejects.toThrow('readiness check failed');
    await expect(
      probe({
        SMRT_AUTH_READINESS_MODULE: 'data:text/javascript,export const x = 1',
      }),
    ).rejects.toThrow('does not export a readiness probe');
    await expect(
      probe({
        SMRT_AUTH_READINESS_MODULE:
          'data:text/javascript,export async function checkReadiness() { return { ready: true } }',
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves relative and bare modules from the application, not the CLI', async () => {
    const sourceRoot = temporary('readiness');
    writeFileSync(join(sourceRoot, 'package.json'), '{"name":"app"}');
    writeFileSync(
      join(sourceRoot, 'ready.mjs'),
      'export default () => true;\n',
    );
    const moduleRoot = join(sourceRoot, 'node_modules', 'app-ready');
    mkdirSync(moduleRoot, { recursive: true });
    writeFileSync(
      join(moduleRoot, 'package.json'),
      JSON.stringify({
        name: 'app-ready',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      join(moduleRoot, 'index.js'),
      'export function checkReadiness({ component }) { return { ready: component === "assets" }; }\n',
    );
    const context = { profile: 'self-hosted', provider: 'local-files' };
    await expect(
      createProviderReadinessProbe('assets', context, {
        sourceRoot,
        environment: { SMRT_ASSETS_READINESS_MODULE: './ready.mjs' },
      })(),
    ).resolves.toBeUndefined();
    await expect(
      createProviderReadinessProbe('assets', context, {
        sourceRoot,
        environment: { SMRT_ASSETS_READINESS_MODULE: 'app-ready' },
      })(),
    ).resolves.toBeUndefined();
    await expect(
      createProviderReadinessProbe('assets', context, {
        sourceRoot,
        environment: { SMRT_ASSETS_READINESS_MODULE: 'not-installed-module' },
      })(),
    ).rejects.toThrow();
  });
});

describe('application state custody', () => {
  function stateOptions(directory: string, appId = 'state-proof') {
    const sourceRoot = join(directory, 'source');
    mkdirSync(sourceRoot, { recursive: true });
    return {
      appId,
      dataDirectory: join(directory, 'data'),
      sourceRoot,
      platformName: 'linux',
      homeDirectory: directory,
      environment: { XDG_STATE_HOME: join(directory, 'state-home') },
    };
  }

  it('derives one private state/lock domain from the app and data identity', () => {
    const directory = temporary('state');
    const options = stateOptions(directory);
    const stateRoot = prepareApplicationStateRoot(options);
    expect(stateRoot).toMatch(
      new RegExp(
        `^${join(directory, 'state-home', '.state-proof-').replaceAll('.', '\\.')}` +
          '[a-f0-9]{12}-state$',
      ),
    );
    expect(resolveApplicationStateRoot(options)).toBe(stateRoot);
    expect(prepareApplicationStateRoot(options)).toBe(stateRoot);
    expect(statSync(stateRoot).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(stateRoot, '.smrt-state-state-proof')).mode & 0o777,
    ).toBe(0o600);
    expect(
      resolveApplicationStateRoot({
        ...options,
        dataDirectory: join(directory, 'other-data'),
      }),
    ).not.toBe(stateRoot);
    expect(
      resolveApplicationStateRoot({
        ...options,
        platformName: 'darwin',
      }).startsWith(join(directory, 'Library', 'Application Support')),
    ).toBe(true);
  });

  it('rejects a symlinked state path component', () => {
    const directory = temporary('state-symlink');
    const options = stateOptions(directory, 'redirected');
    const redirected = join(directory, 'redirected-state');
    symlinkSync(options.sourceRoot, redirected);
    expect(() =>
      prepareApplicationStateRoot({
        ...options,
        environment: { XDG_STATE_HOME: redirected },
      }),
    ).toThrow(/unsafe/);
  });

  it('rejects a group/world-writable state ancestor', () => {
    const directory = temporary('state-writable');
    const options = stateOptions(directory);
    mkdirSync(options.environment.XDG_STATE_HOME, { mode: 0o700 });
    chmodSync(options.environment.XDG_STATE_HOME, 0o777);
    expect(() => prepareApplicationStateRoot(options)).toThrow(
      'lacks trusted custody',
    );
  });

  it('rejects a state root with the wrong mode without repairing it', () => {
    const directory = temporary('state-mode');
    const options = stateOptions(directory);
    const stateRoot = prepareApplicationStateRoot(options);
    chmodSync(stateRoot, 0o750);
    expect(() => prepareApplicationStateRoot(options)).toThrow(
      'Application state root must be current-user-owned mode 0700.',
    );
    expect(statSync(stateRoot).mode & 0o777).toBe(0o750);
  });

  it('rejects a state tree owned by another user', () => {
    const directory = temporary('state-owner');
    const options = stateOptions(directory);
    prepareApplicationStateRoot(options);
    const foreignUid = (process.getuid?.() ?? 1000) + 4242;
    expect(() =>
      prepareApplicationStateRoot({ ...options, currentUid: foreignUid }),
    ).toThrow(/lacks trusted custody|current-user-owned/);
  });

  it('rejects a tampered app-bound marker', () => {
    const directory = temporary('state-marker');
    const options = stateOptions(directory);
    const stateRoot = prepareApplicationStateRoot(options);
    const marker = join(stateRoot, '.smrt-state-state-proof');
    writeFileSync(marker, 'tampered');
    expect(() => prepareApplicationStateRoot(options)).toThrow(
      'Application state marker is unsafe.',
    );
    rmSync(marker);
    symlinkSync(join(directory, 'elsewhere'), marker);
    expect(() => prepareApplicationStateRoot(options)).toThrow(
      'Application state marker is unsafe.',
    );
  });

  it('refuses state inside the source tree', () => {
    const directory = temporary('state-in-source');
    const options = stateOptions(directory);
    expect(() =>
      prepareApplicationStateRoot({
        ...options,
        environment: { XDG_STATE_HOME: join(options.sourceRoot, 'state') },
      }),
    ).toThrow('Application state must remain outside the source tree.');
  });
});

describe('R1: stale reclamation never removes a live lock', () => {
  it('operation lock: a reclaimer paused before unlink cannot remove the next owner', async () => {
    const directory = temporary('r1-lock');
    const path = join(directory, 'operation.lock');
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 1, pid: DEAD_PID, operation: 'setup', instance: STALE_INSTANCE })}\n`,
    );
    let firstOwnerRecord: string | null = null;
    let firstOwnerHolds = false;
    let releaseFirst: () => void = () => {};
    let firstOwner: Promise<unknown> | undefined;
    // Process B has judged the lock stale and is about to unlink it; process
    // A reclaims and acquires it first.
    fsHooks.beforeRm = (target) => {
      if (target !== path || firstOwner) return;
      fsHooks.beforeRm = undefined;
      firstOwner = withOperationLock(directory, 'first', () => {
        firstOwnerHolds = true;
        firstOwnerRecord = readFileSync(path, 'utf8');
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }).catch(() => undefined);
    };
    let bothHeld = false;
    let firstRecordSurvived = true;
    const second = withOperationLock(directory, 'second', async () => {
      bothHeld = firstOwnerHolds;
      if (firstOwnerRecord !== null) {
        firstRecordSurvived = readFileSync(path, 'utf8') === firstOwnerRecord;
      }
    }).catch((error: Error) => error);
    await second;
    releaseFirst();
    await firstOwner;
    expect(bothHeld).toBe(false);
    expect(firstRecordSurvived).toBe(true);
  }, 30_000);

  it('writer lease: a reclaimer paused before unlink cannot remove the next writer', () => {
    const directory = temporary('r1-lease');
    const path = join(directory, 'writer.lease');
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 1, pid: DEAD_PID, instance: STALE_INSTANCE })}\n`,
    );
    let firstRecord: string | null = null;
    fsHooks.beforeRm = (target) => {
      if (target !== path) return;
      fsHooks.beforeRm = undefined;
      try {
        acquireWriterLease(directory);
        firstRecord = readFileSync(path, 'utf8');
      } catch {
        // Refused while another process reclaims: the safe outcome.
      }
    };
    let secondAcquired = false;
    try {
      acquireWriterLease(directory);
      secondAcquired = true;
    } catch {
      // Refused because the first writer is live: the safe outcome.
    }
    if (firstRecord !== null && secondAcquired) {
      // Both "acquired": only acceptable if the first writer's lease file
      // was never removed (same-process re-entrancy returns a no-op lease).
      expect(readFileSync(path, 'utf8')).toBe(firstRecord);
    }
    expect(firstRecord !== null || secondAcquired).toBe(true);
  }, 30_000);
});

describe('R3: readiness modules resolve with ESM import conditions', () => {
  it('loads an import-only package from the application', async () => {
    const sourceRoot = temporary('r3');
    writeFileSync(join(sourceRoot, 'package.json'), '{"name":"app"}');
    const moduleRoot = join(sourceRoot, 'node_modules', '@acme', 'ready');
    mkdirSync(join(moduleRoot, 'esm'), { recursive: true });
    writeFileSync(
      join(moduleRoot, 'package.json'),
      JSON.stringify({
        name: '@acme/ready',
        type: 'module',
        exports: {
          '.': { import: './esm/index.js' },
          './probe': { import: './esm/index.js' },
        },
      }),
    );
    writeFileSync(
      join(moduleRoot, 'esm', 'index.js'),
      'export const checkReadiness = () => ({ ready: true });\n',
    );
    for (const specifier of ['@acme/ready', '@acme/ready/probe']) {
      await expect(
        createProviderReadinessProbe(
          'secrets',
          { profile: 'cloud', provider: 'vault' },
          {
            sourceRoot,
            environment: { SMRT_SECRETS_READINESS_MODULE: specifier },
          },
        )(),
      ).resolves.toBeUndefined();
    }
  });
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
