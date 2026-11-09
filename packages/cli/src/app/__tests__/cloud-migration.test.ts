/**
 * Local-to-cloud migration and downgrade (#4806), in-process.
 *
 * The shared target runs the real `processSyncApplyBatch` engine over a SQL
 * collection with tenant isolation and strict inserts; the per-user target
 * runs the real `importApplication` / `exportApplication`. Every scenario runs
 * on SQLite and, when `SMRT_TEST_POSTGRES_URL` (or `DATABASE_URL`) is set, on
 * PostgreSQL (`pnpm --filter @happyvertical/smrt-cli test:postgres`).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudLinkRecord } from '@happyvertical/smrt-app-runtime';
import {
  processSyncApplyBatch,
  type SyncApplyBatchRequest,
  type SyncApplyBatchResponse,
  type SyncApplyRowLike,
} from '@happyvertical/smrt-core';
import { DEFAULT_ROLES } from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudMigrationError,
  cloudIdentityRows,
  downgradeCloudBundle,
  exportTenantBundle,
  planCloudMigration,
  runSharedCloudMigration,
  type SharedCloudTransport,
  verifyCloudMigration,
  writeCloudMigrationBundle,
} from '../cloud-migration.js';
import {
  exportApplication,
  importApplication,
  type LogicalExportBundle,
  type ManifestTable,
  manifestTables,
} from '../portability.js';
import { digestBytes, type PortableRow } from '../portability-assets.js';

const APP_ID = 'cloud-migration-app';
const pgUrl = process.env.SMRT_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
const OWNER_ROLE = DEFAULT_ROLES[0].id;
const MEMBER_ROLE = DEFAULT_ROLES[2].id;
const ASSET_BYTES = Buffer.from('family photo bytes\n');
const SEGMENTS = { notes: 'notes', profiles: 'profiles', assets: 'assets' };

const local = {
  tenantId: randomUUID(),
  ownerId: randomUUID(),
  profileId: randomUUID(),
  membershipId: randomUUID(),
};
const hosted = {
  tenantId: randomUUID(),
  ownerId: randomUUID(),
  profileId: randomUUID(),
  membershipId: randomUUID(),
};
const LOCAL_PERSON_TYPE = randomUUID();
const HOSTED_PERSON_TYPE = randomUUID();

const definitions: Array<{
  className: string;
  tableName: string;
  columns: Record<string, Record<string, unknown>>;
}> = [
  {
    className: 'Tenant',
    tableName: 'tenants',
    columns: { id: { primaryKey: true }, slug: {}, name: {} },
  },
  {
    className: 'User',
    tableName: 'users',
    columns: { id: { primaryKey: true }, email: {}, profile_id: {} },
  },
  {
    className: 'ProfileType',
    tableName: 'profile_types',
    columns: { id: { primaryKey: true }, tenant_id: {}, slug: {} },
  },
  {
    className: 'Profile',
    tableName: 'profiles',
    columns: {
      id: { primaryKey: true },
      tenant_id: { foreignKey: { table: 'tenants' } },
      type_id: { foreignKey: { table: 'profile_types' } },
      name: {},
    },
  },
  {
    className: 'Role',
    tableName: 'roles',
    columns: { id: { primaryKey: true }, tenant_id: {}, slug: {} },
  },
  {
    className: 'Membership',
    tableName: 'memberships',
    columns: {
      id: { primaryKey: true },
      tenant_id: { foreignKey: { table: 'tenants' } },
      user_id: { foreignKey: { table: 'users' } },
      role_id: { foreignKey: { table: 'roles' } },
    },
  },
  {
    className: 'Note',
    tableName: 'notes',
    columns: {
      id: { primaryKey: true },
      tenant_id: { foreignKey: { table: 'tenants' } },
      author_id: { foreignKey: { table: 'users' } },
      profile_id: { foreignKey: { table: 'profiles' } },
      parent_id: { foreignKey: { table: 'notes' } },
      meta: { type: 'JSON' },
      body: { notNull: true },
      created_at: {},
      updated_at: {},
    },
  },
  {
    className: 'Asset',
    tableName: 'assets',
    columns: {
      id: { primaryKey: true },
      tenant_id: { foreignKey: { table: 'tenants' } },
      source_uri: {},
      name: {},
    },
  },
  {
    className: 'Session',
    tableName: 'sessions',
    columns: { id: { primaryKey: true }, user_id: {}, credential_token: {} },
  },
];

function schema(engine: 'sqlite' | 'postgres'): string[] {
  const json = engine === 'postgres' ? 'jsonb' : 'TEXT';
  return [
    'CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT)',
    'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, profile_id TEXT)',
    'CREATE TABLE profile_types (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT NOT NULL)',
    'CREATE TABLE profiles (id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES tenants(id), type_id TEXT REFERENCES profile_types(id), name TEXT NOT NULL)',
    'CREATE TABLE roles (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT NOT NULL)',
    'CREATE TABLE memberships (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id), role_id TEXT NOT NULL REFERENCES roles(id))',
    `CREATE TABLE notes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), author_id TEXT REFERENCES users(id), profile_id TEXT REFERENCES profiles(id), parent_id TEXT REFERENCES notes(id), meta ${json}, body TEXT NOT NULL, created_at TEXT, updated_at TEXT)`,
    'CREATE TABLE assets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), source_uri TEXT NOT NULL, name TEXT NOT NULL)',
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, credential_token TEXT)',
  ];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function workspace() {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-cloud-migration-')),
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = privateDirectory(join(root, 'app'));
  privateDirectory(join(sourceRoot, '.smrt'));
  writeFileSync(
    join(sourceRoot, '.smrt', 'manifest.json'),
    `${JSON.stringify({
      objects: Object.fromEntries(
        definitions.map((definition) => [
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
  return { root, sourceRoot, tables: manifestTables(sourceRoot) };
}

interface Engine {
  name: 'sqlite' | 'postgres';
  open(
    label: string,
    root: string,
  ): Promise<{ db: DatabaseInterface; url: string }>;
}

const sqlite: Engine = {
  name: 'sqlite',
  async open(label, root) {
    const dir = privateDirectory(join(root, `${label}-data`));
    const url = join(dir, 'app.sqlite');
    const db = await getDatabase({
      type: 'sqlite',
      url,
      cache: false,
    } as never);
    for (const statement of schema('sqlite')) await db.query(statement);
    cleanups.push(async () => {
      await db.close?.();
    });
    return { db, url };
  },
};

const postgres: Engine = {
  name: 'postgres',
  async open(label) {
    const schemaName = `cm_${label.replace(/[^a-z0-9]/gi, '')}_${randomBytes(4).toString('hex')}`;
    const admin = await getDatabase({
      type: 'postgres',
      url: pgUrl as string,
      cache: false,
    } as never);
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.close?.();
    const separator = (pgUrl as string).includes('?') ? '&' : '?';
    const url = `${pgUrl}${separator}options=-c%20search_path%3D${schemaName}`;
    const db = await getDatabase({
      type: 'postgres',
      url,
      cache: false,
    } as never);
    for (const statement of schema('postgres')) await db.query(statement);
    cleanups.push(async () => {
      await db.close?.();
      const drop = await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
        cache: false,
      } as never);
      await drop.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await drop.close?.();
    });
    return { db, url };
  },
};

const engines: Engine[] = pgUrl ? [sqlite, postgres] : [sqlite];

function link(target: 'shared' | 'per-user' = 'shared'): CloudLinkRecord {
  return {
    protocol: 'smrt-cloud-link-v1',
    linkId: randomUUID(),
    linkPublicKey: randomBytes(32).toString('base64url'),
    installationId: randomUUID(),
    appId: APP_ID,
    origin: 'https://cloud.example.test',
    target,
    accountId: target === 'shared' ? hosted.ownerId : local.ownerId,
    tenantId: target === 'shared' ? hosted.tenantId : local.tenantId,
    localIdentities: { ...local },
    hostedIdentities: target === 'shared' ? { ...hosted } : { ...local },
    createdAt: new Date().toISOString(),
  };
}

const NOTE_ROOT = randomUUID();
const NOTE_CHILD = randomUUID();
const MEMBER_PROFILE = randomUUID();
const ASSET_ID = randomUUID();

/** A local bundle as `smrt app export` writes it (SQLite JSON as text). */
function localBundle(
  overrides: Partial<Record<string, PortableRow[]>> = {},
): LogicalExportBundle {
  const rows: Record<string, PortableRow[]> = {
    tenants: [{ id: local.tenantId, slug: 'default', name: 'Family' }],
    users: [
      {
        id: local.ownerId,
        email: 'owner@family.test',
        profile_id: local.profileId,
      },
    ],
    profile_types: [{ id: LOCAL_PERSON_TYPE, tenant_id: null, slug: 'person' }],
    profiles: [
      {
        id: local.profileId,
        tenant_id: local.tenantId,
        type_id: LOCAL_PERSON_TYPE,
        name: 'Owner',
      },
      {
        id: MEMBER_PROFILE,
        tenant_id: local.tenantId,
        type_id: LOCAL_PERSON_TYPE,
        name: 'Kid',
      },
    ],
    roles: DEFAULT_ROLES.map((role) => ({
      id: role.id,
      tenant_id: null,
      slug: role.slug,
    })),
    memberships: [
      {
        id: local.membershipId,
        tenant_id: local.tenantId,
        user_id: local.ownerId,
        role_id: OWNER_ROLE,
      },
    ],
    notes: [
      {
        id: NOTE_ROOT,
        tenant_id: local.tenantId,
        author_id: local.ownerId,
        profile_id: MEMBER_PROFILE,
        parent_id: NOTE_CHILD,
        meta: JSON.stringify({ by: local.ownerId, tags: ['a', 'b'] }),
        body: 'first capture',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: NOTE_CHILD,
        tenant_id: local.tenantId,
        author_id: local.ownerId,
        profile_id: local.profileId,
        parent_id: NOTE_ROOT,
        meta: null,
        body: 'second capture',
        created_at: '2026-01-03T00:00:00.000Z',
        updated_at: '2026-01-03T00:00:00.000Z',
      },
    ],
    assets: [
      {
        id: ASSET_ID,
        tenant_id: local.tenantId,
        source_uri: `smrt-bundle://asset/${ASSET_ID}`,
        name: 'photo.jpg',
      },
    ],
    sessions: [],
    ...overrides,
  };
  return {
    schemaVersion: 2,
    application: APP_ID,
    profile: 'local',
    exportedAt: '2026-11-08T00:00:00.000Z',
    tables: definitions.map((definition) => ({
      name: definition.tableName,
      columns: Object.keys(definition.columns),
      rows: rows[definition.tableName] ?? [],
    })),
    assets: {
      schemaVersion: 1,
      adapter: 'filesystem',
      entries: [
        {
          key: ASSET_ID,
          byteLength: ASSET_BYTES.byteLength,
          contentDigest: digestBytes(ASSET_BYTES),
          payloadPath: `assets/${ASSET_ID}`,
        },
      ],
      payloads: [
        {
          path: `assets/${ASSET_ID}`,
          encoding: 'base64',
          data: ASSET_BYTES.toString('base64'),
        },
      ],
    },
  };
}

async function insertRows(
  db: DatabaseInterface,
  table: string,
  rows: PortableRow[],
): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...columns.map((column) => row[column]),
    );
  }
}

/** The hosted shared application: its account, one other tenant, global rows. */
async function seedHosted(db: DatabaseInterface): Promise<string> {
  const otherTenant = randomUUID();
  await insertRows(db, 'tenants', [
    { id: hosted.tenantId, slug: 'acct', name: 'Hosted family' },
    { id: otherTenant, slug: 'other', name: 'Someone else' },
  ]);
  await insertRows(db, 'profile_types', [
    { id: HOSTED_PERSON_TYPE, tenant_id: null, slug: 'person' },
  ]);
  await insertRows(db, 'profiles', [
    {
      id: hosted.profileId,
      tenant_id: hosted.tenantId,
      type_id: HOSTED_PERSON_TYPE,
      name: 'Hosted owner',
    },
  ]);
  await insertRows(db, 'users', [
    {
      id: hosted.ownerId,
      email: 'owner@cloud.test',
      profile_id: hosted.profileId,
    },
  ]);
  await insertRows(
    db,
    'roles',
    DEFAULT_ROLES.map((role) => ({
      id: role.id,
      tenant_id: null,
      slug: role.slug,
    })),
  );
  await insertRows(db, 'memberships', [
    {
      id: hosted.membershipId,
      tenant_id: hosted.tenantId,
      user_id: hosted.ownerId,
      role_id: OWNER_ROLE,
    },
  ]);
  return otherTenant;
}

function camel(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * The hosted side of `sync/apply`: the real engine over a SQL collection with
 * tenant isolation (reads and the stamped tenant come from the session),
 * strict inserts and server-managed timestamps.
 */
function hostedSyncApply(
  db: DatabaseInterface,
  tables: ManifestTable[],
  tenantId: string,
  clock: () => string,
) {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const collection = (name: string) => {
    const table = byName.get(name) as ManifestTable;
    const hydrate = (raw: Record<string, unknown>): SyncApplyRowLike => {
      const row: Record<string, unknown> = {};
      for (const column of table.columns) {
        let value = raw[column];
        if (
          table.columnDefinitions[column]?.type === 'JSON' &&
          typeof value === 'string'
        ) {
          value = JSON.parse(value);
        }
        row[camel(column)] = value;
      }
      row.updated_at = raw.updated_at ?? null;
      row.save = async () => {
        const columns = table.columns.filter(
          (column) =>
            !['id', 'tenant_id', 'created_at', 'updated_at'].includes(column),
        );
        await db.query(
          `UPDATE ${name} SET ${columns.map((column) => `${column} = ?`).join(', ')}${table.columns.includes('updated_at') ? ', updated_at = ?' : ''} WHERE id = ? AND tenant_id = ?`,
          ...columns.map((column) => bind(column, row[camel(column)])),
          ...(table.columns.includes('updated_at') ? [clock()] : []),
          row.id,
          tenantId,
        );
      };
      row.delete = async () => {
        await db.query(
          `DELETE FROM ${name} WHERE id = ? AND tenant_id = ?`,
          row.id,
          tenantId,
        );
      };
      return row as unknown as SyncApplyRowLike;
    };
    const bind = (column: string, value: unknown) =>
      table.columnDefinitions[column]?.type === 'JSON' && value != null
        ? JSON.stringify(value)
        : (value ?? null);
    const get = async (id: string) => {
      const result = await db.query(
        `SELECT * FROM ${name} WHERE id = ? AND tenant_id = ?`,
        id,
        tenantId,
      );
      return result.rows[0]
        ? hydrate(result.rows[0] as Record<string, unknown>)
        : null;
    };
    return {
      get,
      async create(options: Record<string, unknown>) {
        const values: Record<string, unknown> = {
          id: options.id,
          tenant_id: tenantId,
        };
        for (const column of table.columns) {
          if (column in values) continue;
          if (column === 'created_at' || column === 'updated_at') {
            values[column] = clock();
            continue;
          }
          values[column] = bind(column, options[camel(column)]);
        }
        const columns = Object.keys(values);
        await db.query(
          `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          ...columns.map((column) => values[column]),
        );
        return (await get(String(options.id))) as SyncApplyRowLike;
      },
    };
  };
  const segmentTables = new Map(
    Object.entries(SEGMENTS).map(([t, s]) => [s, t]),
  );
  return async (
    request: SyncApplyBatchRequest,
  ): Promise<SyncApplyBatchResponse> => {
    const outcome = await processSyncApplyBatch(request, {
      resolveTarget(segment) {
        const name = segmentTables.get(segment);
        if (!name) return null;
        return {
          objectName: name,
          collection: collection(name),
          isOpAllowed: () => true,
          authorize: () => 'ok',
          prepare: (payload) => {
            const out = { ...payload };
            for (const key of ['id', 'tenantId', 'createdAt', 'updatedAt'])
              delete out[key];
            return out;
          },
        };
      },
    });
    if (outcome.status !== 200) throw new Error('batch rejected');
    return outcome.body;
  };
}

function assetStore() {
  const stored = new Map<string, { digest: string; bytes: Buffer }>();
  return {
    stored,
    async putAsset(asset: {
      key: string;
      contentDigest: string;
      bytes: Buffer;
    }) {
      const existing = stored.get(asset.key);
      if (existing) {
        if (existing.digest !== asset.contentDigest)
          throw new Error('digest mismatch');
        return 'exists' as const;
      }
      stored.set(asset.key, {
        digest: asset.contentDigest,
        bytes: asset.bytes,
      });
      return 'stored' as const;
    },
    bundle(keys: string[]) {
      const entries = keys
        .filter((key) => stored.has(key))
        .map((key) => ({
          key,
          byteLength: (stored.get(key) as { bytes: Buffer }).bytes.byteLength,
          contentDigest: (stored.get(key) as { digest: string }).digest,
          payloadPath: `assets/${key}`,
        }));
      return {
        schemaVersion: 1,
        adapter: 'filesystem' as const,
        entries,
        payloads: entries.map((entry) => ({
          path: entry.payloadPath,
          encoding: 'base64' as const,
          data: (stored.get(entry.key) as { bytes: Buffer }).bytes.toString(
            'base64',
          ),
        })),
      };
    },
  };
}

function expectRefused(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CloudMigrationError);
    expect(
      (error as CloudMigrationError).issues.map((issue) => issue.code),
    ).toContain(code);
    return error as CloudMigrationError;
  }
  throw new Error(`expected a ${code} refusal`);
}

async function count(db: DatabaseInterface, table: string): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number((result.rows[0] as { count: unknown }).count);
}

describe.each(engines)('shared cloud target ($name)', (engine) => {
  async function sharedFixture() {
    const space = workspace();
    const { db } = await engine.open('hosted', space.root);
    const otherTenant = await seedHosted(db);
    let tick = 0;
    const clock = () =>
      new Date(Date.UTC(2026, 10, 9, 0, 0, tick++)).toISOString();
    const apply = hostedSyncApply(db, space.tables, hosted.tenantId, clock);
    const assets = assetStore();
    const transport: SharedCloudTransport = {
      apply,
      putAsset: assets.putAsset,
    };
    const plan = planCloudMigration({
      bundle: localBundle(),
      tables: space.tables,
      link: link('shared'),
      globalIdentityMap: { [LOCAL_PERSON_TYPE]: HOSTED_PERSON_TYPE },
    });
    const hostedExport = async () =>
      exportTenantBundle(db as never, space.tables, {
        appId: APP_ID,
        profile: engine.name === 'postgres' ? 'self-hosted' : 'local',
        tenantId: hosted.tenantId,
        idRows: cloudIdentityRows(plan.link as CloudLinkRecord, {
          globalRows: { profile_types: [HOSTED_PERSON_TYPE] },
        }),
        assets: assets.bundle([ASSET_ID]),
      });
    return { ...space, db, otherTenant, transport, assets, plan, hostedExport };
  }

  it('round-trips local -> cloud -> local preserving every record and asset', async () => {
    const fixture = await sharedFixture();
    expect(fixture.plan.skipped).toEqual({
      identityRows: 4,
      systemRows: 4,
      omittedTables: [],
    });
    const result = await runSharedCloudMigration({
      plan: fixture.plan,
      segments: SEGMENTS,
      transport: fixture.transport,
      journalPath: join(fixture.root, 'state', 'journal.json'),
    });
    expect(result).toMatchObject({ itemCount: 6, assetCount: 1 });

    // Rewritten to the hosted identities and stamped with the hosted tenant.
    const note = (
      await fixture.db.query('SELECT * FROM notes WHERE id = ?', NOTE_ROOT)
    ).rows[0] as Record<string, unknown>;
    expect(note.tenant_id).toBe(hosted.tenantId);
    expect(note.author_id).toBe(hosted.ownerId);
    expect(note.parent_id).toBe(NOTE_CHILD);
    const meta =
      typeof note.meta === 'string' ? JSON.parse(note.meta) : note.meta;
    expect(meta).toEqual({ by: hosted.ownerId, tags: ['a', 'b'] });
    const kid = (
      await fixture.db.query(
        'SELECT * FROM profiles WHERE id = ?',
        MEMBER_PROFILE,
      )
    ).rows[0] as Record<string, unknown>;
    expect(kid.type_id).toBe(HOSTED_PERSON_TYPE);

    const hostedBundle = await fixture.hostedExport();
    // The other tenant never appears in the tenant-scoped export.
    expect(
      hostedBundle.tables
        .flatMap((table) => table.rows)
        .some((row) => Object.values(row).includes(fixture.otherTenant)),
    ).toBe(false);
    const verification = verifyCloudMigration(fixture.plan, hostedBundle);
    expect(verification.ok).toBe(true);
    expect(verification.missing).toEqual([]);
    // Timestamps are server-managed on the shared target and are reported.
    expect(verification.changedColumns).toEqual({
      notes: ['created_at', 'updated_at'],
    });

    const restored = downgradeCloudBundle({
      bundle: JSON.parse(JSON.stringify(hostedBundle)),
      tables: fixture.tables,
      link: fixture.plan.link as CloudLinkRecord,
      globalIdentityMap: fixture.plan.globalIdentityMap,
      idRows: cloudIdentityRows(fixture.plan.link as CloudLinkRecord, {
        globalRows: { profile_types: [HOSTED_PERSON_TYPE] },
      }),
    });
    const original = localBundle();
    const rowsOf = (bundle: LogicalExportBundle, table: string) =>
      new Map(
        (bundle.tables.find((t) => t.name === table)?.rows ?? []).map((row) => [
          String(row.id),
          row,
        ]),
      );
    for (const table of [
      'notes',
      'profiles',
      'assets',
      'memberships',
      'roles',
      'tenants',
      'users',
    ]) {
      const back = rowsOf(restored, table);
      for (const [id, row] of rowsOf(original, table)) {
        expect(back.has(id), `${table} ${id}`).toBe(true);
        const restoredRow = back.get(id) as PortableRow;
        for (const column of [
          'author_id',
          'profile_id',
          'parent_id',
          'tenant_id',
          'user_id',
          'role_id',
        ]) {
          if (column in row)
            expect(restoredRow[column], `${table}.${column}`).toBe(row[column]);
        }
      }
    }
    const restoredMeta = rowsOf(restored, 'notes').get(NOTE_ROOT)?.meta;
    expect(
      typeof restoredMeta === 'string'
        ? JSON.parse(restoredMeta)
        : restoredMeta,
    ).toEqual({ by: local.ownerId, tags: ['a', 'b'] });
    expect(restored.assets.entries.map((entry) => entry.contentDigest)).toEqual(
      [digestBytes(ASSET_BYTES)],
    );
    // Downgrade restores the original local identities, not the hosted ones.
    expect(rowsOf(restored, 'tenants').has(local.tenantId)).toBe(true);
    expect(rowsOf(restored, 'tenants').has(hosted.tenantId)).toBe(false);
    expect(rowsOf(restored, 'profiles').get(MEMBER_PROFILE)?.type_id).toBe(
      LOCAL_PERSON_TYPE,
    );

    // `smrt app import` accepts it, and every original record is back.
    const backPath = join(fixture.root, 'out', 'shared-back.json');
    mkdirSync(join(fixture.root, 'out'), { recursive: true, mode: 0o700 });
    writeFileSync(backPath, JSON.stringify(restored), { mode: 0o600 });
    const back = await sqlite.open('shared-back', fixture.root);
    const files = privateDirectory(join(fixture.root, 'shared-back-files'));
    const assetRoot = privateDirectory(join(files, 'assets'));
    await importApplication({
      appId: APP_ID,
      sourceRoot: fixture.sourceRoot,
      stateRoot: privateDirectory(join(files, 'state')),
      assetRoot,
      paths: { root: files, assets: assetRoot },
      runtime: {
        profile: 'local',
        providers: { database: { engine: 'sqlite' } },
      },
      env: { DATABASE_URL: back.url },
      path: backPath,
      openDatabase: async () => wrapUnclosable(back.db),
    });
    for (const table of original.tables) {
      const ids = (await back.db.query(`SELECT id FROM ${table.name}`)).rows
        .map((row) => String((row as { id: unknown }).id))
        .sort();
      expect(ids, table.name).toEqual(
        table.rows.map((row) => String(row.id)).sort(),
      );
    }
  });

  it('never exports another tenant’s row that reuses an identity or role ID', async () => {
    const fixture = await sharedFixture();
    // A member of another tenant picks the victim's hosted IDs as row IDs.
    for (const id of [hosted.ownerId, OWNER_ROLE]) {
      await insertRows(fixture.db, 'notes', [
        {
          id,
          tenant_id: fixture.otherTenant,
          author_id: null,
          profile_id: null,
          parent_id: null,
          meta: null,
          body: 'planted',
          created_at: null,
          updated_at: null,
        },
      ]);
    }
    await runSharedCloudMigration({
      plan: fixture.plan,
      segments: SEGMENTS,
      transport: fixture.transport,
      journalPath: join(fixture.root, 'state', 'journal.json'),
    });
    const hostedBundle = await fixture.hostedExport();
    const exportedNotes =
      hostedBundle.tables.find((table) => table.name === 'notes')?.rows ?? [];
    expect(exportedNotes.map((row) => row.body).sort()).toEqual([
      'first capture',
      'second capture',
    ]);
    // And a downgrade refuses such a row if a hosted export ever carried one.
    const planted = JSON.parse(JSON.stringify(hostedBundle));
    planted.tables
      .find((table: { name: string }) => table.name === 'notes')
      .rows.push({
        ...exportedNotes[0],
        id: randomUUID(),
        tenant_id: fixture.otherTenant,
      });
    expectRefused(
      () =>
        downgradeCloudBundle({
          bundle: planted,
          tables: fixture.tables,
          link: fixture.plan.link as CloudLinkRecord,
          globalIdentityMap: fixture.plan.globalIdentityMap,
        }),
      'foreign_tenant_row',
    );
  });

  it('resumes after a crash mid-migration without duplicating or dropping rows', async () => {
    const fixture = await sharedFixture();
    const journalPath = join(fixture.root, 'state', 'journal.json');
    let calls = 0;
    const crashing: SharedCloudTransport = {
      putAsset: fixture.transport.putAsset,
      async apply(request) {
        calls += 1;
        const response = await fixture.transport.apply(request);
        // The server applied the second batch but the response was lost.
        if (calls === 2) throw new Error('connection reset');
        return response;
      },
    };
    await expect(
      runSharedCloudMigration({
        plan: fixture.plan,
        segments: SEGMENTS,
        transport: crashing,
        journalPath,
        batchSize: 2,
      }),
    ).rejects.toThrow('connection reset');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(journal.acknowledgedBatches).toHaveLength(1);

    const resumed = await runSharedCloudMigration({
      plan: fixture.plan,
      segments: SEGMENTS,
      transport: fixture.transport,
      journalPath,
      batchSize: 2,
    });
    expect(resumed.resumedBatches).toBe(1);
    expect(await count(fixture.db, 'notes')).toBe(2);
    expect(await count(fixture.db, 'profiles')).toBe(2);
    expect(await count(fixture.db, 'assets')).toBe(1);
    expect(fixture.assets.stored.size).toBe(1);
    expect(
      verifyCloudMigration(fixture.plan, await fixture.hostedExport()).ok,
    ).toBe(true);

    // A crash once the update phase started also resumes cleanly.
    rmSync(journalPath);
    await fixture.db.query('DELETE FROM notes');
    await fixture.db.query('DELETE FROM profiles WHERE id = ?', MEMBER_PROFILE);
    await fixture.db.query('DELETE FROM assets');
    let updateCalls = 0;
    const crashOnUpdate: SharedCloudTransport = {
      putAsset: fixture.transport.putAsset,
      async apply(request) {
        const response = await fixture.transport.apply(request);
        if (request.items[0]?.op === 'update' && updateCalls++ === 0) {
          throw new Error('connection reset');
        }
        return response;
      },
    };
    await expect(
      runSharedCloudMigration({
        plan: fixture.plan,
        segments: SEGMENTS,
        transport: crashOnUpdate,
        journalPath,
        batchSize: 1,
      }),
    ).rejects.toThrow('connection reset');
    await runSharedCloudMigration({
      plan: fixture.plan,
      segments: SEGMENTS,
      transport: fixture.transport,
      journalPath,
      batchSize: 1,
    });
    expect(await count(fixture.db, 'notes')).toBe(2);
    expect(
      verifyCloudMigration(fixture.plan, await fixture.hostedExport()).ok,
    ).toBe(true);

    // A finished run is idempotent; a journal for another link refuses.
    await runSharedCloudMigration({
      plan: fixture.plan,
      segments: SEGMENTS,
      transport: fixture.transport,
      journalPath,
      batchSize: 1,
    });
    expect(await count(fixture.db, 'notes')).toBe(2);
    const other = planCloudMigration({
      bundle: localBundle(),
      tables: fixture.tables,
      link: link('shared'),
      globalIdentityMap: { [LOCAL_PERSON_TYPE]: HOSTED_PERSON_TYPE },
    });
    await expect(
      runSharedCloudMigration({
        plan: other,
        segments: SEGMENTS,
        transport: fixture.transport,
        journalPath,
      }),
    ).rejects.toMatchObject({ code: 'journal_mismatch' });
  });

  it('stops on an id held by another tenant and never overwrites it', async () => {
    const fixture = await sharedFixture();
    await insertRows(fixture.db, 'notes', [
      {
        id: NOTE_CHILD,
        tenant_id: fixture.otherTenant,
        author_id: null,
        profile_id: null,
        parent_id: null,
        meta: null,
        body: 'not yours',
        created_at: null,
        updated_at: null,
      },
    ]);
    await expect(
      runSharedCloudMigration({
        plan: fixture.plan,
        segments: SEGMENTS,
        transport: fixture.transport,
        journalPath: join(fixture.root, 'state', 'journal.json'),
      }),
    ).rejects.toMatchObject({
      code: 'item_refused',
      details: { rowId: NOTE_CHILD, status: 'rejected', reason: 'id_conflict' },
    });
    const row = (
      await fixture.db.query(
        'SELECT tenant_id, body FROM notes WHERE id = ?',
        NOTE_CHILD,
      )
    ).rows[0];
    expect(row).toMatchObject({
      tenant_id: fixture.otherTenant,
      body: 'not yours',
    });
  });
});

describe('shared cloud target planner', () => {
  const { tables } = workspace();
  const plan = (bundle: LogicalExportBundle, globals = true) =>
    planCloudMigration({
      bundle,
      tables,
      link: link('shared'),
      globalIdentityMap: globals
        ? { [LOCAL_PERSON_TYPE]: HOSTED_PERSON_TYPE }
        : undefined,
    });
  const note = (patch: Record<string, unknown>) => ({
    ...localBundle().tables.find((t) => t.name === 'notes')?.rows[1],
    ...patch,
  });

  it('refuses rows that would cross a tenant boundary', () => {
    expectRefused(
      () => plan(localBundle({ notes: [note({ tenant_id: randomUUID() })] })),
      'foreign_tenant_row',
    );
    expectRefused(() => plan(localBundle(), false), 'global_row');
    expectRefused(
      () =>
        plan(
          localBundle({
            users: [
              {
                id: local.ownerId,
                email: 'o@f.test',
                profile_id: local.profileId,
              },
              {
                id: randomUUID(),
                email: 'kid@f.test',
                profile_id: MEMBER_PROFILE,
              },
            ],
          }),
        ),
      'tenantless_row',
    );
  });

  it('refuses identity collisions, embedded identities and local locators', () => {
    expectRefused(
      () => plan(localBundle({ notes: [note({ author_id: hosted.ownerId })] })),
      'identity_collision',
    );
    expectRefused(
      () =>
        plan(
          localBundle({
            notes: [note({ body: `see /people/${local.ownerId}` })],
          }),
        ),
      'embedded_identity',
    );
    expectRefused(
      () =>
        plan(
          localBundle({
            notes: [note({ body: 'file:///Users/me/.ssh/id_ed25519' })],
          }),
        ),
      'local_locator',
    );
    expectRefused(
      () =>
        plan(
          localBundle({
            notes: [
              note({ meta: JSON.stringify({ thumb: 'file:///etc/passwd' }) }),
            ],
          }),
        ),
      'local_locator',
    );
  });

  it('keeps a __proto__ key in a JSON column instead of dropping it (#4827)', () => {
    // The owner id inside forces a rewrite, so the object is rebuilt.
    const meta = `{"__proto__":{"a":1},"x":2,"by":"${local.ownerId}"}`;
    const planned = plan(localBundle({ notes: [note({ meta })] }));
    const row = planned.bundle.tables.find((t) => t.name === 'notes')?.rows[0];
    const parsed = JSON.parse(String(row?.meta)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['__proto__', 'by', 'x']);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed.x).toBe(2);
    expect(parsed.by).not.toBe(local.ownerId);
  });

  it('refuses locators inside text, keeps binary values, never adopts a carried row', () => {
    expectRefused(
      () =>
        plan(
          localBundle({
            notes: [note({ body: '{"src":"FILE:///Users/me/secret.jpg"}' })],
          }),
        ),
      'local_locator',
    );
    expectRefused(
      () => plan(localBundle({ notes: [note({ body: 'x asset-local:a/b' })] })),
      'local_locator',
    );
    for (const body of ['file:etc/passwd', 'see file:\\etc\\passwd']) {
      expectRefused(
        () => plan(localBundle({ notes: [note({ body })] })),
        'local_locator',
      );
    }
    expect(() =>
      plan(localBundle({ notes: [note({ body: 'profile: kid' })] })),
    ).not.toThrow();
    const bytes = Buffer.from([0, 1, 2, 3]);
    const planned = plan(localBundle({ notes: [note({ body: bytes })] }));
    const carried = planned.bundle.tables.find((t) => t.name === 'notes')
      ?.rows[0];
    expect(carried?.body).toBe(bytes);
    expectRefused(
      () =>
        planCloudMigration({
          bundle: localBundle(),
          tables,
          link: link('shared'),
          globalIdentityMap: {
            [LOCAL_PERSON_TYPE]: HOSTED_PERSON_TYPE,
            [MEMBER_PROFILE]: randomUUID(),
          },
        }),
      'identity_collision',
    );
    expect(() =>
      planCloudMigration({
        bundle: localBundle(),
        tables,
        link: link('shared'),
        globalIdentityMap: { [LOCAL_PERSON_TYPE]: hosted.ownerId },
      }),
    ).toThrow(/touch no linked identity/);
  });

  it('refuses tampered system roles on every target', () => {
    const roles = DEFAULT_ROLES.map((role) => ({
      id: role.id,
      tenant_id: null,
      slug: role.id === MEMBER_ROLE ? 'owner' : role.slug,
    }));
    expectRefused(() => plan(localBundle({ roles })), 'modified_system_row');
    expectRefused(
      () =>
        planCloudMigration({
          bundle: localBundle({ roles }),
          tables,
          perUser: { appId: APP_ID, localIdentities: local },
        }),
      'modified_system_row',
    );
  });

  it('refuses a bundle for another application', () => {
    expect(() =>
      planCloudMigration({
        bundle: { ...localBundle(), application: 'other-app' },
        tables,
        link: link('shared'),
      }),
    ).toThrow(/different application/);
  });
});

describe('downgrade of a hostile hosted export', () => {
  const { tables } = workspace();
  const hostedNote = (patch: Record<string, unknown>) => ({
    id: randomUUID(),
    tenant_id: hosted.tenantId,
    author_id: hosted.ownerId,
    profile_id: null,
    parent_id: null,
    meta: null,
    body: 'cloud note',
    created_at: null,
    updated_at: null,
    ...patch,
  });
  const hostedBundle = (notes: PortableRow[]): LogicalExportBundle => ({
    ...localBundle({
      tenants: [{ id: hosted.tenantId, slug: 'acct', name: 'Hosted' }],
      users: [],
      profile_types: [],
      profiles: [],
      memberships: [],
      notes,
      assets: [],
    }),
    assets: {
      schemaVersion: 1,
      adapter: 'filesystem',
      entries: [],
      payloads: [],
    },
  });

  it('refuses a value naming a local identity', () => {
    expectRefused(
      () =>
        downgradeCloudBundle({
          bundle: hostedBundle([hostedNote({ profile_id: local.profileId })]),
          tables,
          link: link('shared'),
        }),
      'identity_collision',
    );
  });

  it('refuses file and local asset locators anywhere but the verified asset cell', () => {
    for (const value of [
      'file:///Users/victim/.ssh/id_ed25519',
      ' FILE:/etc/passwd',
    ]) {
      expectRefused(
        () =>
          downgradeCloudBundle({
            bundle: hostedBundle([hostedNote({ body: value })]),
            tables,
            link: link('shared'),
          }),
        'local_locator',
      );
    }
    expectRefused(
      () =>
        downgradeCloudBundle({
          bundle: hostedBundle([
            hostedNote({ meta: { nested: ['file:///etc/shadow'] } }),
          ]),
          tables,
          link: link('shared'),
        }),
      'local_locator',
    );
  });

  it('maps hosted identities back to the original local ones', () => {
    const restored = downgradeCloudBundle({
      bundle: hostedBundle([hostedNote({ meta: { by: hosted.ownerId } })]),
      tables,
      link: link('shared'),
    });
    const notes = restored.tables.find((t) => t.name === 'notes')?.rows ?? [];
    expect(notes[0]).toMatchObject({
      tenant_id: local.tenantId,
      author_id: local.ownerId,
      meta: { by: local.ownerId },
    });
  });
});

describe.each(engines)('per-user cloud target ($name)', (engine) => {
  function context(
    space: ReturnType<typeof workspace>,
    label: string,
    url: string,
    profile: 'local' | 'self-hosted',
    engineName: 'sqlite' | 'postgres',
  ) {
    const base = privateDirectory(join(space.root, `${label}-files`));
    const assets = privateDirectory(join(base, 'assets'));
    const state = privateDirectory(join(base, 'state'));
    return {
      appId: APP_ID,
      sourceRoot: space.sourceRoot,
      stateRoot: state,
      assetRoot: assets,
      paths: { root: base, assets },
      runtime: { profile, providers: { database: { engine: engineName } } },
      env: { DATABASE_URL: url },
    };
  }

  it('round-trips byte-preserving through an empty per-user database and back', async () => {
    const space = workspace();
    const plan = planCloudMigration({
      bundle: localBundle(),
      tables: space.tables,
      perUser: { appId: APP_ID, localIdentities: local },
    });
    expect(plan.skipped).toEqual({
      identityRows: 0,
      systemRows: 0,
      omittedTables: [],
    });
    const bundlePath = writeCloudMigrationBundle(
      plan,
      join(space.root, 'out', 'per-user.json'),
    );

    const cloud = await engine.open('cloud', space.root);
    const cloudContext = context(
      space,
      'cloud',
      cloud.url,
      'self-hosted',
      engine.name,
    );
    const openCloud = async () => cloud.db;
    const imported = await importApplication({
      ...cloudContext,
      path: bundlePath,
      openDatabase: async () => wrapUnclosable(await openCloud()),
    });
    expect(imported.assetCount).toBe(1);

    const exportPath = join(space.root, 'out', 'cloud-export.json');
    await exportApplication({
      ...cloudContext,
      path: exportPath,
      openDatabase: async () => wrapUnclosable(cloud.db),
    });
    const cloudBundle = JSON.parse(readFileSync(exportPath, 'utf8'));
    const verification = verifyCloudMigration(plan, cloudBundle);
    expect(verification).toMatchObject({ ok: true, exact: true });

    const downgraded = downgradeCloudBundle({
      bundle: cloudBundle,
      tables: space.tables,
      link: link('per-user'),
      sourceEngine: engine.name,
    });
    const backPath = join(space.root, 'out', 'back.json');
    writeFileSync(backPath, JSON.stringify(downgraded), { mode: 0o600 });
    const back = await sqlite.open('back', space.root);
    const backContext = context(space, 'back', back.url, 'local', 'sqlite');
    await importApplication({
      ...backContext,
      path: backPath,
      openDatabase: async () => wrapUnclosable(back.db),
    });
    for (const table of localBundle().tables) {
      const rows = (await back.db.query(`SELECT * FROM ${table.name}`)).rows;
      expect(rows.length, table.name).toBe(table.rows.length);
    }
    const note = (
      await back.db.query('SELECT * FROM notes WHERE id = ?', NOTE_ROOT)
    ).rows[0] as Record<string, unknown>;
    expect(note).toMatchObject({
      author_id: local.ownerId,
      parent_id: NOTE_CHILD,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.parse(String(note.meta))).toEqual({
      by: local.ownerId,
      tags: ['a', 'b'],
    });
    const asset = (await back.db.query('SELECT source_uri FROM assets'))
      .rows[0] as {
      source_uri: string;
    };
    expect(readFileSync(new URL(asset.source_uri))).toEqual(ASSET_BYTES);
  });

  it('refuses a per-user target that already holds the local identities', async () => {
    const space = workspace();
    const plan = planCloudMigration({
      bundle: localBundle(),
      tables: space.tables,
      perUser: { appId: APP_ID, localIdentities: local },
    });
    const bundlePath = writeCloudMigrationBundle(
      plan,
      join(space.root, 'out', 'b.json'),
    );
    const cloud = await engine.open('taken', space.root);
    await insertRows(cloud.db, 'tenants', [
      { id: local.tenantId, slug: 'x', name: 'x' },
    ]);
    await expect(
      importApplication({
        ...context(space, 'taken', cloud.url, 'self-hosted', engine.name),
        path: bundlePath,
        openDatabase: async () => wrapUnclosable(cloud.db),
      }),
    ).rejects.toThrow('Import target is not empty.');
    expect(await count(cloud.db, 'notes')).toBe(0);
  });
});

/** The portability helpers close their handle; the fixture owns it. */
function wrapUnclosable(db: DatabaseInterface): DatabaseInterface {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'close') return async () => {};
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
