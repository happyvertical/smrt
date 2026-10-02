/**
 * Independent-review findings R1, R3–R6 on the `smrt app` port (#3371).
 * Each case reproduces the reported interleaving or input deterministically.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAppCommand } from '../cli.js';
import { resolveApplicationStateRoot } from '../identity.js';
import { withOperationLock } from '../operation-lock.js';
import { exportApplication, importApplication } from '../portability.js';
import { matchesApplicationProcess } from '../process-record.js';
import { createProviderReadinessProbe } from '../provider-readiness.js';
import { acquireWriterLease } from '../writer-lease.js';

const fsHooks = vi.hoisted(() => ({
  beforeRm: undefined as undefined | ((path: string) => void),
  keepImportJournal: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const rmSync: typeof actual.rmSync = (path, options) => {
    if (typeof path === 'string') {
      fsHooks.beforeRm?.(path);
      // Simulate a crash after the import transaction committed but before
      // the asset journal was removed.
      if (fsHooks.keepImportJournal && path.includes('.smrt-asset-import-')) {
        return;
      }
    }
    return actual.rmSync(path, options);
  };
  return { ...actual, default: { ...actual, rmSync }, rmSync };
});

const DEAD_PID = 2_147_483_647;
const STALE_INSTANCE = '0123456789abcdef0123456789abcdef';
const roots: string[] = [];
const children: number[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['SMRT_DATA_DIR', 'XDG_STATE_HOME', 'PORT', 'SMRT_APP_ID'];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  fsHooks.beforeRm = undefined;
  fsHooks.keepImportJournal = false;
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
    mkdtempSync(join(realpathSync(tmpdir()), `smrt-review-${label}-`)),
  );
  roots.push(directory);
  return directory;
}

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

describe('R4: a failed start never orphans a live writer', () => {
  it('confirms the child exited (or keeps its record) when it ignores SIGTERM', async () => {
    const root = temporary('r4');
    const app = join(root, 'app');
    mkdirSync(join(app, 'build'), { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"r4-app"}');
    writeFileSync(
      join(app, 'build', 'index.js'),
      `import { createServer } from 'node:http';
       import { writeFileSync } from 'node:fs';
       process.on('SIGTERM', () => {});
       writeFileSync('pid.txt', String(process.pid));
       createServer((_q, r) => r.end(JSON.stringify({ status: 'ready', application: 'r4-app', instance: 'wrong' })))
         .listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    process.env.SMRT_DATA_DIR = join(root, 'data');
    process.env.XDG_STATE_HOME = join(root, 'state-home');
    const socket = createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, '127.0.0.1', resolve),
    );
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    process.env.PORT = String(address.port);
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const stderr: string[] = [];
    const code = await runAppCommand(['start'], {
      cwd: app,
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      dependencies: {
        resolveRuntime: async () =>
          resolveApplicationRuntime({ profile: 'local' }) as never,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 20)),
      },
    });
    expect(code).toBe(1);
    const pid = Number(readFileSync(join(app, 'pid.txt'), 'utf8'));
    children.push(pid);
    const stateRoot = resolveApplicationStateRoot({
      appId: 'r4-app',
      dataDirectory: join(root, 'data'),
      sourceRoot: app,
    });
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      // Still serving: it must remain recorded so `smrt app stop` can act.
      expect(existsSync(join(stateRoot, 'app.pid'))).toBe(true);
      expect(stderr.join('')).toContain(String(pid));
    }
    expect(alive).toBe(false);
    expect(existsSync(join(stateRoot, 'app.pid'))).toBe(false);
  }, 60_000);
});

describe('R4: an unkillable failed start stays recorded', () => {
  it('keeps app.pid and names the process when it survives SIGTERM and SIGKILL', async () => {
    const root = temporary('r4-kept');
    const app = join(root, 'app');
    mkdirSync(join(app, 'build'), { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"r4-kept"}');
    writeFileSync(
      join(app, 'build', 'index.js'),
      `import { writeFileSync } from 'node:fs';
       writeFileSync('pid.txt', String(process.pid));
       setInterval(() => {}, 1000);`,
    );
    process.env.SMRT_DATA_DIR = join(root, 'data');
    process.env.XDG_STATE_HOME = join(root, 'state-home');
    process.env.PORT = '9';
    const signals: string[] = [];
    const stderr: string[] = [];
    const code = await runAppCommand(['start'], {
      cwd: app,
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      dependencies: {
        resolveRuntime: async () =>
          resolveApplicationRuntime({ profile: 'local' }) as never,
        fetch: (async () => {
          throw new Error('unreachable');
        }) as never,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
        // Simulates a process this user cannot terminate.
        signal: (_pid, signal) => {
          signals.push(signal);
        },
      },
    });
    expect(code).toBe(1);
    const pid = Number(readFileSync(join(app, 'pid.txt'), 'utf8'));
    children.push(pid);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    const stateRoot = resolveApplicationStateRoot({
      appId: 'r4-kept',
      dataDirectory: join(root, 'data'),
      sourceRoot: app,
    });
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'app.pid'), 'utf8')).pid,
    ).toBe(pid);
    const message = JSON.parse(stderr.join('')).message as string;
    expect(message).toContain(`Application process ${pid} did not exit`);
    expect(message).toContain('pnpm app:stop');
  }, 60_000);
});

describe('R5: process identity matches exact argv tokens', () => {
  const instance = 'abcdefabcdefabcdefabcdefabcdefab';
  it.each([
    `node /srv/not-smrt-web.mjs.bak --smrt-instance=${instance}`,
    `node /srv/evil-smrt-web.mjs --smrt-instance=${instance}`,
    `node /srv/smrt-web.mjs --smrt-instance=${instance}0`,
    `node /srv/smrt-web.mjs --smrt-instance=${instance}-x`,
    `node /srv/other.mjs smrt-web.mjs--smrt-instance=${instance}`,
    `node /srv/other.mjs --note=smrt-web.mjs --smrt-instance=${instance}`,
    `node /srv/smrt-web.mjs --x --smrt-instance=${instance} --extra`,
  ])('rejects the deceptive command line %s', (command) => {
    expect(matchesApplicationProcess({ instance }, command)).toBe(false);
  });

  it.each([
    `node scripts/smrt-web.mjs --smrt-instance=${instance}`,
    `/opt/node/bin/node /home/u/app/node_modules/@happyvertical/smrt-cli/bin/smrt-web.mjs --smrt-instance=${instance}`,
    `/home/u/my app/node /home/u/my app/bin/smrt-web.mjs --smrt-instance=${instance}`,
    `"C:\\Program Files\\nodejs\\node.exe" "C:\\app\\scripts\\smrt-web.mjs" --smrt-instance=${instance}`,
  ])('accepts the launcher command line %s', (command) => {
    expect(matchesApplicationProcess({ instance }, command)).toBe(true);
  });
});

describe('R6: interrupted-import recovery needs evidence tied to the bundle', () => {
  const APP_ID = 'r6-app';
  const ASSET = Buffer.from('r6 asset bytes\n');

  function privateDirectory(path: string): string {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  }

  async function scenario() {
    const root = temporary('r6');
    const sourceRoot = join(root, 'app');
    mkdirSync(join(sourceRoot, '.smrt'), { recursive: true });
    writeFileSync(
      join(sourceRoot, '.smrt', 'manifest.json'),
      JSON.stringify({
        objects: {
          'r6:Asset': {
            className: 'Asset',
            schema: {
              tableName: 'assets',
              columns: { id: { primaryKey: true }, source_uri: {} },
            },
          },
          'r6:Item': {
            className: 'Item',
            schema: {
              tableName: 'items',
              columns: { id: { primaryKey: true }, title: {} },
            },
          },
        },
      }),
    );
    const runtime = {
      profile: 'local',
      providers: { database: { engine: 'sqlite' } },
    };
    const make = async (name: string) => {
      const data = privateDirectory(join(root, name, 'data'));
      const assets = privateDirectory(join(data, 'assets'));
      const state = privateDirectory(join(root, name, 'state'));
      const database = join(data, 'app.sqlite');
      const db = await getDatabase({ type: 'sqlite', url: database });
      await db.query(
        'CREATE TABLE assets (id TEXT PRIMARY KEY, source_uri TEXT)',
      );
      await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT)');
      await db.close?.();
      return {
        database,
        state,
        context: {
          appId: APP_ID,
          sourceRoot,
          stateRoot: state,
          runtime,
          env: { DATABASE_URL: database },
          paths: { root: data, assets },
          assetRoot: assets,
        },
      };
    };
    const source = await make('source');
    writeFileSync(join(source.context.assetRoot, 'blob.bin'), ASSET, {
      mode: 0o600,
    });
    const seed = await getDatabase({ type: 'sqlite', url: source.database });
    await seed.query(
      'INSERT INTO assets (id, source_uri) VALUES (?, ?)',
      'asset-1',
      pathToFileURL(join(source.context.assetRoot, 'blob.bin')).href,
    );
    await seed.query("INSERT INTO items VALUES ('item-1', 'Original')");
    await seed.close?.();
    const bundle = join(root, 'export.json');
    await exportApplication({ ...source.context, path: bundle });
    const target = await make('target');
    // First import commits, then "crashes" before the journal is removed.
    fsHooks.keepImportJournal = true;
    await importApplication({ ...target.context, path: bundle });
    fsHooks.keepImportJournal = false;
    const journalName = readdirSync(target.state).find((name) =>
      name.startsWith('.smrt-asset-import-'),
    );
    expect(journalName).toBe(
      `.smrt-asset-import-${createHash('sha256').update(APP_ID).digest('hex').slice(0, 16)}.json`,
    );
    const journalPath = join(target.state, journalName as string);
    return { bundle, target, journalPath };
  }

  function dropCommitMarker(journalPath: string): void {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    delete journal.committedAt;
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  }

  it('refuses count-preserving modified rows when no commit marker proves the import', async () => {
    const { bundle, target, journalPath } = await scenario();
    dropCommitMarker(journalPath);
    const db = await getDatabase({ type: 'sqlite', url: target.database });
    await db.query("UPDATE items SET title = 'Tampered' WHERE id = 'item-1'");
    await db.close?.();
    await expect(
      importApplication({ ...target.context, path: bundle }),
    ).rejects.toThrow('asset-recovery-target-mismatch');
    expect(existsSync(journalPath)).toBe(true);
  });

  it('recovers an unmodified committed import from row content alone', async () => {
    const { bundle, target, journalPath } = await scenario();
    dropCommitMarker(journalPath);
    await expect(
      importApplication({ ...target.context, path: bundle }),
    ).resolves.toMatchObject({ rowCount: 2, assetCount: 1 });
    expect(existsSync(journalPath)).toBe(false);
  });

  it('records a commit marker for this bundle before removing the journal', async () => {
    const { bundle, target, journalPath } = await scenario();
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(journal.phase).toBe('published');
    expect(typeof journal.committedAt).toBe('string');
    await expect(
      importApplication({ ...target.context, path: bundle }),
    ).resolves.toMatchObject({ rowCount: 2 });
    expect(existsSync(journalPath)).toBe(false);
  });
});
