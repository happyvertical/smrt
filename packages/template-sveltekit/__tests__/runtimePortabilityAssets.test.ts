import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_ASSET_COUNT,
  bundleContentDigest,
  publishFilesystemAssets,
  stageFilesystemAssets,
  verifyFilesystemAssets,
} from '../template/scripts/smrt-portability-assets.mjs';
import {
  exportApplication,
  importApplication,
} from '../template/scripts/smrt-portability.mjs';

const APP_ID = 'runtime-profile-reference';
const ASSET_ID = 'asset-reference-1';
const ASSET_BYTES = Buffer.from('{"fixture":"runtime-profile-reference"}\n');
const SESSION_CREDENTIAL = 'must-never-enter-the-portability-bundle';

const tableDefinitions = [
  {
    className: 'Session',
    tableName: 'sessions',
    columns: { id: { primaryKey: true }, credential_token: {} },
  },
  {
    className: 'Profile',
    tableName: 'profiles',
    columns: { id: { primaryKey: true }, name: {} },
  },
  {
    className: 'Tenant',
    tableName: 'tenants',
    columns: { id: { primaryKey: true }, slug: {} },
  },
  {
    className: 'Membership',
    tableName: 'tenant_memberships',
    columns: {
      id: { primaryKey: true },
      profile_id: { foreignKey: { table: 'profiles' } },
      tenant_id: { foreignKey: { table: 'tenants' } },
      role: {},
    },
  },
  {
    className: 'ReferenceWorkItem',
    tableName: 'reference_work_items',
    columns: {
      id: { primaryKey: true },
      tenant_id: { foreignKey: { table: 'tenants' } },
      title: {},
      status: {},
    },
  },
  {
    className: 'Asset',
    tableName: 'assets',
    columns: {
      id: { primaryKey: true },
      tenant_id: { foreignKey: { table: 'tenants' } },
      owner_profile_id: { foreignKey: { table: 'profiles' } },
      source_uri: {},
      name: {},
    },
  },
  {
    className: 'ReferenceWorkItemAsset',
    tableName: 'reference_work_item_assets',
    columns: {
      id: { primaryKey: true },
      reference_work_item_id: {
        foreignKey: { table: 'reference_work_items' },
      },
      asset_id: { foreignKey: { table: 'assets' } },
      role: {},
    },
  },
];

const createStatements = [
  'CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
  'CREATE TABLE sessions (id TEXT PRIMARY KEY, credential_token TEXT NOT NULL)',
  'CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL)',
  'CREATE TABLE tenant_memberships (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), tenant_id TEXT NOT NULL REFERENCES tenants(id), role TEXT NOT NULL)',
  'CREATE TABLE reference_work_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), title TEXT NOT NULL, status TEXT NOT NULL)',
  'CREATE TABLE assets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), owner_profile_id TEXT NOT NULL REFERENCES profiles(id), source_uri TEXT NOT NULL, name TEXT NOT NULL)',
  'CREATE TABLE reference_work_item_assets (id TEXT PRIMARY KEY, reference_work_item_id TEXT NOT NULL REFERENCES reference_work_items(id), asset_id TEXT NOT NULL REFERENCES assets(id), role TEXT NOT NULL)',
];

interface FixtureContext {
  directory: string;
  sourceRoot: string;
  sourceDataRoot: string;
  sourceAssetRoot: string;
  stateRoot: string;
  bundlePath: string;
}

const temporaryDirectories: string[] = [];

function makePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixtureContext(): FixtureContext {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-portability-assets-')),
  );
  temporaryDirectories.push(directory);
  const sourceRoot = join(directory, 'app');
  const sourceDataRoot = join(directory, 'source-data');
  const sourceAssetRoot = join(sourceDataRoot, 'assets');
  const stateRoot = join(directory, 'source-state');
  makePrivateDirectory(join(sourceRoot, '.smrt'));
  makePrivateDirectory(sourceDataRoot);
  makePrivateDirectory(sourceAssetRoot);
  makePrivateDirectory(stateRoot);
  writeFileSync(
    join(sourceRoot, '.smrt', 'manifest.json'),
    `${JSON.stringify({
      objects: Object.fromEntries(
        tableDefinitions.map((definition) => [
          `fixture:${definition.className}`,
          {
            className: definition.className,
            schema: {
              tableName: definition.tableName,
              columns: definition.columns,
            },
          },
        ]),
      ),
    })}\n`,
  );
  return {
    directory,
    sourceRoot,
    sourceDataRoot,
    sourceAssetRoot,
    stateRoot,
    bundlePath: join(directory, 'exports', 'reference.smrt-portable.json'),
  };
}

async function createSchema(url: string, type: 'sqlite' | 'postgres' = 'sqlite') {
  const db = await getDatabase({ type, url });
  for (const statement of createStatements) await db.query(statement);
  return db;
}

async function seedSource(fixture: FixtureContext, assetPath?: string) {
  const blobPath = assetPath || join(fixture.sourceAssetRoot, 'reference.json');
  if (!assetPath) writeFileSync(blobPath, ASSET_BYTES, { mode: 0o600 });
  const databasePath = join(fixture.sourceDataRoot, 'app.sqlite');
  const db = await createSchema(databasePath);
  await db.query('PRAGMA foreign_keys = ON');
  await db.query('INSERT INTO profiles (id, name) VALUES (?, ?)', 'profile-1', 'Reference Owner');
  await db.query(
    'INSERT INTO sessions (id, credential_token) VALUES (?, ?)',
    'session-1',
    SESSION_CREDENTIAL,
  );
  await db.query('INSERT INTO tenants (id, slug) VALUES (?, ?)', 'tenant-1', 'default-tenant');
  await db.query(
    'INSERT INTO tenant_memberships (id, profile_id, tenant_id, role) VALUES (?, ?, ?, ?)',
    'membership-1',
    'profile-1',
    'tenant-1',
    'owner',
  );
  await db.query(
    'INSERT INTO reference_work_items (id, tenant_id, title, status) VALUES (?, ?, ?, ?)',
    'work-item-1',
    'tenant-1',
    'Reference workload',
    'draft',
  );
  await db.query(
    'INSERT INTO assets (id, tenant_id, owner_profile_id, source_uri, name) VALUES (?, ?, ?, ?, ?)',
    ASSET_ID,
    'tenant-1',
    'profile-1',
    pathToFileURL(blobPath).href,
    'Reference asset',
  );
  await db.query(
    'INSERT INTO reference_work_item_assets (id, reference_work_item_id, asset_id, role) VALUES (?, ?, ?, ?)',
    'association-1',
    'work-item-1',
    ASSET_ID,
    'reference-attachment',
  );
  await db.close?.();
  return databasePath;
}

function runtime(profile: 'local' | 'self-hosted', engine: 'sqlite' | 'postgres') {
  return {
    profile,
    providers: {
      database: { engine },
      assets: { provider: 'local-files' },
    },
  };
}

function portabilityContext(
  fixture: FixtureContext,
  databasePath: string,
  assetRoot: string,
  stateRoot: string,
  profile: 'local' | 'self-hosted' = 'local',
  engine: 'sqlite' | 'postgres' = 'sqlite',
) {
  return {
    appId: APP_ID,
    sourceRoot: fixture.sourceRoot,
    stateRoot,
    assetRoot,
    paths: { root: dirname(databasePath), assets: assetRoot },
    runtime: runtime(profile, engine),
    env: { DATABASE_URL: databasePath },
  };
}

async function exportFixture(fixture: FixtureContext) {
  const databasePath = await seedSource(fixture);
  const result = await exportApplication({
    ...portabilityContext(
      fixture,
      databasePath,
      fixture.sourceAssetRoot,
      fixture.stateRoot,
    ),
    path: fixture.bundlePath,
  });
  return { databasePath, result };
}

async function emptyTarget(fixture: FixtureContext, name = 'target') {
  const root = join(fixture.directory, name);
  const databaseRoot = join(root, 'data');
  const assetRoot = join(databaseRoot, 'assets');
  const stateRoot = join(root, 'state');
  makePrivateDirectory(databaseRoot);
  makePrivateDirectory(assetRoot);
  makePrivateDirectory(stateRoot);
  const databasePath = join(databaseRoot, 'app.sqlite');
  const db = await createSchema(databasePath);
  await db.close?.();
  return {
    databasePath,
    assetRoot,
    stateRoot,
    context: portabilityContext(
      fixture,
      databasePath,
      assetRoot,
      stateRoot,
    ),
  };
}

function readBundle(fixture: FixtureContext) {
  return JSON.parse(readFileSync(fixture.bundlePath, 'utf8'));
}

function writeBundle(path: string, bundle: unknown): void {
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, {
    flag: 'w',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('asset-aware runtime portability', () => {
  it('round-trips the owner, tenant, record, association, bytes, and digest through a mode-0600 bundle', async () => {
    const fixture = fixtureContext();
    const { result } = await exportFixture(fixture);
    const serialized = readFileSync(fixture.bundlePath, 'utf8');
    const bundle = JSON.parse(serialized);

    expect(result).toMatchObject({ assetsIncluded: true, assetCount: 1 });
    expect(lstatSync(fixture.bundlePath).mode & 0o777).toBe(0o600);
    expect(bundle).toMatchObject({
      schemaVersion: 2,
      application: APP_ID,
      assets: {
        schemaVersion: 1,
        adapter: 'filesystem',
        entries: [
          {
            key: ASSET_ID,
            byteLength: ASSET_BYTES.byteLength,
            contentDigest: `sha256:${hash(ASSET_BYTES)}`,
            payloadPath: expect.stringMatching(/^payloads\/[a-f0-9]{64}$/),
          },
        ],
      },
    });
    expect(serialized).not.toContain(fixture.sourceAssetRoot);
    expect(serialized).not.toContain(SESSION_CREDENTIAL);
    await expect(
      exportApplication({
        ...portabilityContext(
          fixture,
          join(fixture.sourceDataRoot, 'app.sqlite'),
          fixture.sourceAssetRoot,
          fixture.stateRoot,
        ),
        path: fixture.bundlePath,
      }),
    ).rejects.toThrow(/already exists/);
    expect(readFileSync(fixture.bundlePath, 'utf8')).toBe(serialized);

    const target = await emptyTarget(fixture);
    await expect(
      importApplication({ ...target.context, path: fixture.bundlePath }),
    ).resolves.toMatchObject({ assetsIncluded: true, assetCount: 1 });

    const db = await getDatabase({ type: 'sqlite', url: target.databasePath });
    expect((await db.query('SELECT role FROM tenant_memberships')).rows).toEqual([
      { role: 'owner' },
    ]);
    expect(Number((await db.query('SELECT COUNT(*) AS count FROM sessions')).rows[0].count)).toBe(0);
    expect((await db.query('SELECT slug FROM tenants')).rows).toEqual([
      { slug: 'default-tenant' },
    ]);
    expect((await db.query('SELECT title, status FROM reference_work_items')).rows).toEqual([
      { title: 'Reference workload', status: 'draft' },
    ]);
    expect((await db.query('SELECT asset_id, role FROM reference_work_item_assets')).rows).toEqual([
      { asset_id: ASSET_ID, role: 'reference-attachment' },
    ]);
    const asset = (await db.query('SELECT source_uri FROM assets')).rows[0];
    await db.close?.();
    const restored = readFileSync(new URL(asset.source_uri));
    expect(restored).toEqual(ASSET_BYTES);
    expect(hash(restored)).toBe(hash(ASSET_BYTES));
    expect(lstatSync(new URL(asset.source_uri)).mode & 0o777).toBe(0o600);

    const backupRoot = join(fixture.directory, 'local-backup');
    cpSync(join(target.databasePath, '..'), backupRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(
      readFileSync(join(backupRoot, 'assets', 'portable', hash(ASSET_ID))),
    ).toEqual(ASSET_BYTES);
  });

  it('fails closed on digest, size, path, duplicate, missing payload, and bounded-count tampering', async () => {
    const fixture = fixtureContext();
    await exportFixture(fixture);
    const baseline = readBundle(fixture);
    const cases: Array<[string, (bundle: any) => void, RegExp]> = [
      [
        'digest',
        (bundle) => {
          bundle.assets.entries[0].contentDigest = `sha256:${'0'.repeat(64)}`;
        },
        /asset-digest-mismatch/,
      ],
      [
        'size',
        (bundle) => {
          bundle.assets.entries[0].byteLength += 1;
        },
        /asset-size-mismatch/,
      ],
      [
        'traversal',
        (bundle) => {
          bundle.assets.entries[0].payloadPath = '../secret';
        },
        /unsafe-payload-path/,
      ],
      [
        'duplicate',
        (bundle) => {
          const path = `payloads/${'f'.repeat(64)}`;
          bundle.assets.entries.push({
            ...bundle.assets.entries[0],
            payloadPath: path,
          });
          bundle.assets.payloads.push({
            ...bundle.assets.payloads[0],
            path,
          });
        },
        /duplicate-asset-key/,
      ],
      [
        'missing',
        (bundle) => {
          bundle.assets.payloads = [];
        },
        /asset-payload-count-mismatch/,
      ],
      [
        'count',
        (bundle) => {
          bundle.assets.entries = Array.from({ length: MAX_ASSET_COUNT + 1 }, () => ({
            ...bundle.assets.entries[0],
          }));
        },
        /too-many-assets/,
      ],
    ];
    for (const [name, mutate, expected] of cases) {
      const bundle = structuredClone(baseline);
      mutate(bundle);
      const path = join(fixture.directory, `${name}.json`);
      writeBundle(path, bundle);
      const target = await emptyTarget(fixture, `target-${name}`);
      await expect(
        importApplication({ ...target.context, path }),
      ).rejects.toThrow(expected);
      expect(readdirSync(target.assetRoot)).toEqual([]);
      const db = await getDatabase({ type: 'sqlite', url: target.databasePath });
      expect(
        Number((await db.query('SELECT COUNT(*) AS count FROM profiles')).rows[0].count),
      ).toBe(0);
      await db.close?.();
    }
  });

  it('rejects source and bundle symlinks before following them', async () => {
    const fixture = fixtureContext();
    const realBlob = join(fixture.sourceAssetRoot, 'real.json');
    const linkedBlob = join(fixture.sourceAssetRoot, 'linked.json');
    writeFileSync(realBlob, ASSET_BYTES, { mode: 0o600 });
    symlinkSync(realBlob, linkedBlob);
    const databasePath = await seedSource(fixture, linkedBlob);
    await expect(
      exportApplication({
        ...portabilityContext(
          fixture,
          databasePath,
          fixture.sourceAssetRoot,
          fixture.stateRoot,
        ),
        path: fixture.bundlePath,
      }),
    ).rejects.toThrow(/asset-not-regular/);

    rmSync(linkedBlob);
    const db = await getDatabase({ type: 'sqlite', url: databasePath });
    await db.query(
      'UPDATE assets SET source_uri = ? WHERE id = ?',
      pathToFileURL(realBlob).href,
      ASSET_ID,
    );
    await db.close?.();
    await exportApplication({
      ...portabilityContext(
        fixture,
        databasePath,
        fixture.sourceAssetRoot,
        fixture.stateRoot,
      ),
      path: fixture.bundlePath,
    });
    const linkedBundle = join(fixture.directory, 'linked-bundle.json');
    symlinkSync(fixture.bundlePath, linkedBundle);
    const target = await emptyTarget(fixture);
    await expect(
      importApplication({ ...target.context, path: linkedBundle }),
    ).rejects.toThrow(/unsafe-bundle-file/);
  });

  it('rejects non-empty and unsafe destinations without publishing an asset', async () => {
    const fixture = fixtureContext();
    await exportFixture(fixture);
    const wrongApplication = await emptyTarget(fixture, 'wrong-application');
    await expect(
      importApplication({
        ...wrongApplication.context,
        appId: 'different-application',
        path: fixture.bundlePath,
      }),
    ).rejects.toThrow(/different application/);
    expect(readdirSync(wrongApplication.assetRoot)).toEqual([]);

    const target = await emptyTarget(fixture, 'non-empty');
    const db = await getDatabase({ type: 'sqlite', url: target.databasePath });
    await db.query('INSERT INTO profiles (id, name) VALUES (?, ?)', 'existing', 'Existing');
    await db.close?.();
    await expect(
      importApplication({ ...target.context, path: fixture.bundlePath }),
    ).rejects.toThrow(/not empty/);
    expect(readdirSync(target.assetRoot)).toEqual([]);

    const unsafe = await emptyTarget(fixture, 'unsafe');
    rmSync(unsafe.assetRoot, { recursive: true });
    symlinkSync(fixture.sourceAssetRoot, unsafe.assetRoot);
    await expect(
      importApplication({ ...unsafe.context, path: fixture.bundlePath }),
    ).rejects.toThrow(/unsafe-asset-root/);
  });

  it('rolls back interruptions before and after publication and remains retryable', async () => {
    const fixture = fixtureContext();
    await exportFixture(fixture);
    for (const phase of ['assets-staged', 'assets-published']) {
      const target = await emptyTarget(fixture, `interrupt-${phase}`);
      await expect(
        importApplication({
          ...target.context,
          path: fixture.bundlePath,
          onImportPhase(current: string) {
            if (current === phase) throw new Error(`interrupted-${phase}`);
          },
        }),
      ).rejects.toThrow(`interrupted-${phase}`);
      expect(readdirSync(target.assetRoot)).toEqual([]);
      expect(readdirSync(target.stateRoot)).toEqual([]);
      await expect(
        importApplication({ ...target.context, path: fixture.bundlePath }),
      ).resolves.toMatchObject({ assetCount: 1 });
    }
  });

  it('recovers an interrupted partial publication journal before retrying', async () => {
    const fixture = fixtureContext();
    await exportFixture(fixture);
    const target = await emptyTarget(fixture);
    const serialized = readFileSync(fixture.bundlePath, 'utf8');
    const bundle = JSON.parse(serialized);
    const verified = verifyFilesystemAssets({
      assetBundle: bundle.assets,
      tables: bundle.tables,
      sourceRoot: fixture.sourceRoot,
      assetRoot: target.assetRoot,
    });
    const staged = stageFilesystemAssets({
      verified,
      stateRoot: target.stateRoot,
      appId: APP_ID,
      bundleDigest: bundleContentDigest(serialized),
    });
    publishFilesystemAssets(staged);
    expect(readdirSync(target.assetRoot)).toEqual(['portable']);

    await expect(
      importApplication({ ...target.context, path: fixture.bundlePath }),
    ).resolves.toMatchObject({ assetCount: 1 });
    expect(readdirSync(target.stateRoot)).toEqual([]);
  });

  it('makes the DB-only compatibility decision explicit', async () => {
    const fixture = fixtureContext();
    const target = await emptyTarget(fixture);
    const legacy = join(fixture.directory, 'legacy.json');
    writeBundle(legacy, { schemaVersion: 1, application: APP_ID, tables: [] });
    await expect(
      importApplication({ ...target.context, path: legacy }),
    ).rejects.toThrow(/Database-only logical export bundles are not importable/);
  });
});

const postgresUrl = process.env.SMRT_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('asset-aware SQLite to PostgreSQL portability', () => {
  it('imports the same record, authorization links, association, and verified blob', async () => {
    const fixture = fixtureContext();
    await exportFixture(fixture);
    const assetRoot = join(fixture.directory, 'postgres-assets');
    const stateRoot = join(fixture.directory, 'postgres-state');
    makePrivateDirectory(assetRoot);
    makePrivateDirectory(stateRoot);
    const db = await getDatabase({ type: 'postgres', url: postgresUrl as string });
    for (const table of [...tableDefinitions].reverse()) {
      await db.query(`DROP TABLE IF EXISTS "${table.tableName}" CASCADE`);
    }
    for (const statement of createStatements) await db.query(statement);
    await db.close?.();
    const context = portabilityContext(
      fixture,
      postgresUrl as string,
      assetRoot,
      stateRoot,
      'self-hosted',
      'postgres',
    );
    try {
      await importApplication({ ...context, path: fixture.bundlePath });
      const verification = await getDatabase({
        type: 'postgres',
        url: postgresUrl as string,
      });
      expect((await verification.query('SELECT role FROM tenant_memberships')).rows).toEqual([
        { role: 'owner' },
      ]);
      const asset = (await verification.query('SELECT source_uri FROM assets')).rows[0];
      await verification.close?.();
      expect(readFileSync(new URL(asset.source_uri))).toEqual(ASSET_BYTES);
    } finally {
      const cleanup = await getDatabase({
        type: 'postgres',
        url: postgresUrl as string,
      });
      for (const table of [...tableDefinitions].reverse()) {
        await cleanup.query(`DROP TABLE IF EXISTS "${table.tableName}" CASCADE`);
      }
      await cleanup.close?.();
    }
  });
});
