/**
 * The app shell's user app in export, import and migration (#5193): a
 * SQLite -> bundle -> SQLite round trip of the CLI's side, with a fake engine
 * injected through the `userAppEngine` seam (the real engine's fidelity is
 * covered in the app shell), against a data root shaped like the shell's
 * (application.sqlite + user-app/app.db).
 */
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
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudMigrationError,
  planCloudMigration,
  runSharedCloudMigration,
} from '../cloud-migration.js';
import {
  exportApplication,
  importApplication,
  type LogicalExportBundle,
  type PortabilityContext,
} from '../portability.js';
import {
  hasOpenUserAppDraft,
  loadUserAppEngine,
  type UserAppSection,
} from '../user-app-portability.js';
import { loadTestEngine, openCopy } from './user-app-test-support.js';

const APP_ID = 'shell-app';
const OK = { author: 't', approved: true };

const TABLES = {
  apps: 'CREATE TABLE apps (id TEXT PRIMARY KEY, slug TEXT, current_version INTEGER)',
  app_versions:
    'CREATE TABLE app_versions (id TEXT PRIMARY KEY, version INTEGER, parent INTEGER, author TEXT, summary TEXT, definition TEXT, migration TEXT, created_at TEXT, purged INTEGER)',
  app_drafts: 'CREATE TABLE app_drafts (id TEXT PRIMARY KEY, status TEXT)',
  approvals:
    'CREATE TABLE approvals (id TEXT PRIMARY KEY, status TEXT, summary TEXT)',
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface Fixture {
  directory: string;
  sourceRoot: string;
  stateRoot: string;
}

function fixture(): Fixture {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-user-app-portability-')),
  );
  directories.push(directory);
  const sourceRoot = join(directory, 'app');
  mkdirSync(join(sourceRoot, '.smrt'), { recursive: true });
  writeFileSync(
    join(sourceRoot, '.smrt', 'manifest.json'),
    JSON.stringify({
      objects: Object.fromEntries(
        Object.entries({
          apps: ['id', 'slug', 'current_version'],
          app_versions: [
            'id',
            'version',
            'parent',
            'author',
            'summary',
            'definition',
            'migration',
            'created_at',
            'purged',
          ],
          app_drafts: ['id', 'status'],
          approvals: ['id', 'status', 'summary'],
        }).map(([table, columns]) => [
          `shell:${table}`,
          {
            className: table,
            schema: {
              tableName: table,
              columns: Object.fromEntries(
                columns.map((column) => [
                  column,
                  column === 'id' ? { primaryKey: true } : {},
                ]),
              ),
            },
          },
        ]),
      ),
    }),
  );
  mkdirSync(join(directory, 'state'), { recursive: true, mode: 0o700 });
  return { directory, sourceRoot, stateRoot: join(directory, 'state') };
}

async function createShellTables(root: string) {
  mkdirSync(join(root, 'assets'), { recursive: true });
  const db = await getDatabase({
    type: 'sqlite',
    url: join(root, 'application.sqlite'),
  });
  for (const statement of Object.values(TABLES)) await db.query(statement);
  return db;
}

/** A source installation: shell tables, a real user app and its history. */
async function source(f: Fixture) {
  const root = join(f.directory, 'source-data');
  const db = await createShellTables(root);
  const { AppHost, MemoryVersionStore } = await loadTestEngine();
  const store = new MemoryVersionStore();
  const host = await AppHost.open(join(root, 'user-app'), { store });
  await host.execute(
    {
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text' },
        notes: { type: 'text' },
        secret: { type: 'text' },
      },
    },
    { author: 't' },
  );
  await host.create('Chore', { title: 'a', notes: 'note a', secret: 's-a' });
  await host.create('Chore', { title: 'b', notes: 'note b', secret: 's-b' });
  await host.execute(
    { type: 'hideField', model: 'Chore', field: 'secret' },
    { author: 't' },
  );
  await host.execute(
    { type: 'removeField', model: 'Chore', field: 'notes' },
    OK,
  );
  const versions = await store.list();
  for (const v of versions) {
    await db.query(
      'INSERT INTO app_versions (id, version, parent, author, summary, definition, migration, created_at, purged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      `v${v.version}`,
      v.version,
      v.parent ?? -1,
      v.author,
      v.summary,
      JSON.stringify(v.definition),
      v.migration ? JSON.stringify(v.migration) : '',
      v.createdAt,
      v.migration?.purged ? 1 : 0,
    );
  }
  await db.query(
    "INSERT INTO apps (id, slug, current_version) VALUES ('app-1', 'app', ?)",
    await store.current(),
  );
  await host.close();
  return { root, db, store };
}

function writeBundle(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
}

function contextFor(f: Fixture, root: string): PortabilityContext {
  return {
    appId: APP_ID,
    sourceRoot: f.sourceRoot,
    stateRoot: f.stateRoot,
    assetRoot: join(root, 'assets'),
    paths: { root, assets: join(root, 'assets') },
    runtime: {
      profile: 'local',
      providers: { database: { engine: 'sqlite' } },
    },
    env: { DATABASE_URL: join(root, 'application.sqlite') },
    userAppEngine: async () => loadTestEngine(),
  };
}

async function exportBundle(f: Fixture, root: string, name = 'bundle.json') {
  const path = join(f.directory, 'exports', name);
  const result = await exportApplication({
    ...contextFor(f, root),
    path,
  });
  return { path, result, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

async function emptyTarget(f: Fixture, name = 'target') {
  const root = join(f.directory, name);
  const db = await createShellTables(root);
  await db.close?.();
  return root;
}

async function count(root: string, table: string) {
  const db = await getDatabase({
    type: 'sqlite',
    url: join(root, 'application.sqlite'),
  });
  try {
    return Number(
      (await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n,
    );
  } finally {
    await db.close?.();
  }
}

describe('user app in export and import', () => {
  it('round trips the user app: hidden fields, timestamps, history, undo', async () => {
    const f = fixture();
    const src = await source(f);
    const exported = await exportBundle(f, src.root);
    expect(exported.result.userApp).toMatchObject({ versions: 4 });
    const bundle = exported.read() as LogicalExportBundle;
    expect(bundle.schemaVersion).toBe(3);
    const chore = bundle.userApp?.tables.find((t) => t.name.includes('chore'));
    expect(chore?.rows).toHaveLength(2);
    expect(chore?.columns).toEqual(
      expect.arrayContaining(['secret', 'created_at', 'updated_at']),
    );
    expect(bundle.userApp?.tables.some((t) => t.name === '_archive')).toBe(
      true,
    );

    const targetRoot = await emptyTarget(f);
    const imported = await importApplication({
      ...contextFor(f, targetRoot),
      path: exported.path,
    });
    expect(imported.userApp).toMatchObject({
      status: 'imported',
      digest: bundle.userApp?.digest,
    });
    expect(await count(targetRoot, 'app_versions')).toBe(4);
    const engine = await loadTestEngine();
    const check = await engine.verifyUserApp({
      dataDir: join(targetRoot, 'user-app'),
      bundle: bundle.userApp as UserAppSection,
    });
    expect(check.ok).toBe(true);

    // The copy is a working app: start it on the imported history and undo.
    const host = await openCopy(
      engine,
      join(targetRoot, 'user-app'),
      bundle.userApp as UserAppSection,
    );
    await host.execute({ type: 'undo' }, OK);
    expect((await host.list('Chore')).map((r) => r.notes).sort()).toEqual([
      'note a',
      'note b',
    ]);
    await host.close();
    await src.db.close?.();
  });

  it('is idempotent and resumes without duplicates', async () => {
    const f = fixture();
    const src = await source(f);
    const exported = await exportBundle(f, src.root);
    const bundle = exported.read() as LogicalExportBundle;
    await src.db.close?.();

    // Crash after the user app is installed, before the rows commit.
    const targetRoot = await emptyTarget(f);
    await expect(
      importApplication({
        ...contextFor(f, targetRoot),
        path: exported.path,
        onImportPhase: (phase) => {
          if (phase === 'user-app-installed') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(await count(targetRoot, 'app_versions')).toBe(0);
    expect(existsSync(join(targetRoot, 'user-app', 'app.db'))).toBe(false);

    // Rows committed by an earlier run that stopped before the user app.
    const { userApp: _section, ...withoutUserApp } = bundle;
    const partial = join(f.directory, 'exports', 'partial.json');
    writeBundle(
      partial,
      JSON.stringify({ ...withoutUserApp, schemaVersion: 2 }),
    );
    await importApplication({ ...contextFor(f, targetRoot), path: partial });
    expect(existsSync(join(targetRoot, 'user-app', 'app.db'))).toBe(false);
    // (the full bundle's rows differ in digest only through userApp; use the
    // full bundle for the completion run)
    const done = await importApplication({
      ...contextFor(f, targetRoot),
      path: exported.path,
    });
    expect(done.userApp?.status).toBe('imported');
    expect(await count(targetRoot, 'app_versions')).toBe(4);

    const again = await importApplication({
      ...contextFor(f, targetRoot),
      path: exported.path,
    });
    expect(again.userApp?.status).toBe('already-imported');
    expect(await count(targetRoot, 'app_versions')).toBe(4);
  });

  it('an older (version 2) bundle without a user app still imports', async () => {
    const f = fixture();
    const src = await source(f);
    const exported = await exportBundle(f, src.root);
    await src.db.close?.();
    const { userApp: _section, ...rest } = exported.read();
    const older = join(f.directory, 'exports', 'v2.json');
    writeBundle(older, JSON.stringify({ ...rest, schemaVersion: 2 }));
    const targetRoot = await emptyTarget(f);
    const result = await importApplication({
      ...contextFor(f, targetRoot),
      path: older,
    });
    expect(result.userApp).toBeUndefined();
    expect(await count(targetRoot, 'app_versions')).toBe(4);
    expect(existsSync(join(targetRoot, 'user-app', 'app.db'))).toBe(false);
  });

  it('refuses while a draft is open and names the way out', async () => {
    const f = fixture();
    const src = await source(f);
    await src.db.query(
      "INSERT INTO app_drafts (id, status) VALUES ('d1', 'open')",
    );
    await expect(exportBundle(f, src.root)).rejects.toThrow(
      /draft of the app is open.*publish the draft or discard it/s,
    );
    await src.db.query("UPDATE app_drafts SET status = 'published'");
    await expect(exportBundle(f, src.root)).resolves.toBeTruthy();
    expect(
      hasOpenUserAppDraft([
        {
          name: 'app_drafts',
          columns: ['id', 'status'],
          rows: [{ id: 'x', status: 'starting' }],
        },
      ]),
    ).toBe(true);
    await src.db.close?.();
  });

  it('drops outstanding approvals with a notice and keeps decided ones', async () => {
    const f = fixture();
    const src = await source(f);
    for (const [id, status] of [
      ['a1', 'pending'],
      ['a2', 'accepted'],
      ['a3', 'executing'],
      ['a4', 'approved'],
      ['a5', 'denied'],
    ])
      await src.db.query(
        'INSERT INTO approvals (id, status, summary) VALUES (?, ?, ?)',
        id,
        status,
        'x',
      );
    const exported = await exportBundle(f, src.root);
    expect(exported.result.notices?.[0]).toMatch(/3 approval/);
    const bundle = exported.read() as LogicalExportBundle;
    expect(
      bundle.tables
        .find((t) => t.name === 'approvals')
        ?.rows.map((r) => r.id)
        .sort(),
    ).toEqual(['a4', 'a5']);
    await src.db.close?.();
  });

  it('refuses a tampered user app section and a mismatched history', async () => {
    const f = fixture();
    const src = await source(f);
    const exported = await exportBundle(f, src.root);
    await src.db.close?.();
    const bundle = exported.read() as LogicalExportBundle;

    const tampered = structuredClone(bundle);
    const chore = tampered.userApp?.tables.find((t) =>
      t.name.includes('chore'),
    );
    (chore?.rows[0] as Record<string, unknown>).title = 'changed';
    const tamperedPath = join(f.directory, 'exports', 'tampered.json');
    writeBundle(tamperedPath, JSON.stringify(tampered));
    await expect(
      importApplication({
        ...contextFor(f, await emptyTarget(f, 't1')),
        path: tamperedPath,
      }),
    ).rejects.toThrow(/user app is not usable/);

    const history = structuredClone(bundle);
    const versions = history.tables.find((t) => t.name === 'app_versions');
    (versions?.rows[0] as Record<string, unknown>).summary = 'edited';
    const historyPath = join(f.directory, 'exports', 'history.json');
    writeBundle(historyPath, JSON.stringify(history));
    await expect(
      importApplication({
        ...contextFor(f, await emptyTarget(f, 't2')),
        path: historyPath,
      }),
    ).rejects.toThrow(/version history does not match/);
  });

  it('refuses a user app bundle on a hosted profile and keeps the rows out', async () => {
    const f = fixture();
    const src = await source(f);
    const exported = await exportBundle(f, src.root);
    await src.db.close?.();
    const context = contextFor(f, await emptyTarget(f, 'hosted'));
    await expect(
      importApplication({
        ...context,
        runtime: {
          profile: 'self-hosted',
          providers: { database: { engine: 'sqlite' } },
        },
        path: exported.path,
      }),
    ).rejects.toThrow(/local \(SQLite\) installation/);
  });
});

describe('user app in the cloud migration plan', () => {
  it('the planner carries the section, the shared run refuses it, verification compares digests', async () => {
    const f = fixture();
    const src = await source(f);
    const exported = await exportBundle(f, src.root);
    await src.db.close?.();
    const bundle = exported.read() as LogicalExportBundle;
    const { manifestTables } = await import('../portability.js');
    const tables = manifestTables(f.sourceRoot);
    const plan = planCloudMigration({
      bundle,
      tables,
      perUser: {
        appId: APP_ID,
        localIdentities: {
          tenantId: '11111111-1111-4111-8111-111111111111',
          ownerId: '22222222-2222-4222-8222-222222222222',
          profileId: '33333333-3333-4333-8333-333333333333',
          membershipId: '44444444-4444-4444-8444-444444444444',
        },
      },
    });
    expect(plan.bundle.userApp?.digest).toBe(bundle.userApp?.digest);
    expect(plan.bundle.schemaVersion).toBe(3);

    const { verifyCloudMigration } = await import('../cloud-migration.js');
    const same = verifyCloudMigration(plan, {
      tables: plan.bundle.tables,
      assets: plan.bundle.assets,
      userApp: plan.bundle.userApp,
    });
    expect(same.userApp?.matches).toBe(true);
    const missing = verifyCloudMigration(plan, {
      tables: plan.bundle.tables,
      assets: plan.bundle.assets,
    });
    expect(missing.ok).toBe(false);
    expect(missing.userApp?.matches).toBe(false);

    await expect(
      runSharedCloudMigration({
        plan,
        segments: {},
        transport: {} as never,
        journalPath: join(f.directory, 'journal.json'),
      }),
    ).rejects.toBeInstanceOf(CloudMigrationError);
  });
});

describe('loading the real engine from the project', () => {
  it('finds the engine in the project node_modules and explains its absence', async () => {
    const f = fixture();
    const shell = join(
      f.sourceRoot,
      'node_modules',
      '@happyvertical',
      'smrt-app-shell',
    );
    mkdirSync(shell, { recursive: true });
    writeFileSync(
      join(shell, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-app-shell',
        type: 'module',
        exports: { './engine': { import: './engine.js' } },
      }),
    );
    writeFileSync(
      join(shell, 'engine.js'),
      "export const marker = 'found-in-project';\n",
    );
    const engine = (await loadUserAppEngine(f.sourceRoot)) as unknown as {
      marker: string;
    };
    expect(engine.marker).toBe('found-in-project');

    const bare = fixture();
    await expect(loadUserAppEngine(bare.sourceRoot)).rejects.toThrow(
      /@happyvertical\/smrt-app-shell is not installed in the project/,
    );
  });
});
