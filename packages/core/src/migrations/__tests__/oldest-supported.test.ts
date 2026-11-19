import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { SMRT_SCHEMA_VERSION } from '../../system/schema.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
  readRecordedSystemSchema,
  recordSuccessfulMigrate,
} from '../migrate-record.js';
import { decideMigrationRun } from '../migration-run-decision.js';
import {
  checkOldestSupportedRelease,
  checkUnrecordedDatabaseAge,
  compareReleases,
  OLDEST_SUPPORTED_RELEASE,
  OLDEST_SUPPORTED_SYSTEM_SCHEMA,
} from '../oldest-supported.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@happyvertical/logger', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@happyvertical/logger')>();
  return {
    ...original,
    createLogger: (...args: Parameters<typeof original.createLogger>) =>
      Object.assign(original.createLogger(...args), { warn }),
  };
});

/** One patch below a version: a system schema older than the floor's. */
function versionBelow(version: string): string {
  const [major, minor] = version.split('.').map(Number);
  return minor > 0 ? `${major}.${minor - 1}.0` : `${major - 1}.99.0`;
}

describe('release floor (#4933)', () => {
  it('orders numeric releases, prereleases and build tags', () => {
    expect(compareReleases('0.60.9', '0.60.17')).toBe(-1);
    expect(compareReleases('v0.60.17', '0.60.17+build.1')).toBe(0);
    expect(compareReleases('0.61.0-rc.2', '0.61.0-rc.10')).toBe(-1);
    expect(compareReleases('0.61.0-rc.1', '0.61.0')).toBe(-1);
    expect(compareReleases('0.61.0-beta', '0.61.0-alpha')).toBe(1);
    expect(compareReleases('0.61.0-1', '0.61.0-alpha')).toBe(-1);
    expect(compareReleases('0.61.0-alpha', '0.61.0-alpha.1')).toBe(-1);
    expect(() => compareReleases('unknown', '0.60.17')).toThrow(
      'Invalid smrt release',
    );
  });
  it.each([
    null,
    OLDEST_SUPPORTED_RELEASE,
    '999.0.0',
  ])('permits %s', (release) => {
    expect(checkOldestSupportedRelease(release)).toEqual({ ok: true });
    expect(
      decideMigrationRun({
        changes: [],
        engine: 'postgres',
        recordedRelease: release,
      }),
    ).toMatchObject({ proceed: true, releaseStop: null });
  });
  it('refuses old releases, holds back the full plan and names the first hop', () => {
    const decision = decideMigrationRun({
      changes: [],
      addedTables: [{ tableName: 'posts' }],
      engine: 'postgres',
      recordedRelease: '0.0.1',
    });
    expect(decision).toMatchObject({
      proceed: false,
      releaseStop: { message: expect.stringContaining('smrt 0.0.1') },
      heldBack: [{ table: 'posts' }],
    });
    expect(decision.releaseStop?.message).toContain(
      `supports upgrades from ${OLDEST_SUPPORTED_RELEASE}`,
    );
    expect(decision.releaseStop?.message).toContain(
      'First upgrade the database with smrt',
    );
  });
  it('does not silently trust a malformed release record', () => {
    expect(checkOldestSupportedRelease('unknown')).toMatchObject({
      ok: false,
      message: expect.stringContaining('unreadable'),
    });
  });
});

describe('release floor for a database with no migrate record', () => {
  const floor = OLDEST_SUPPORTED_SYSTEM_SCHEMA as string;

  it('knows the system schema of the oldest supported release', () => {
    expect(floor).toMatch(/^\d+\.\d+\.\d+$/);
    // The floor is a past release: its system schema cannot be ahead of ours.
    expect(compareReleases(floor, SMRT_SCHEMA_VERSION)).toBeLessThanOrEqual(0);
  });

  it('warns about system tables older than the floor, and does not refuse', () => {
    const older = versionBelow(floor);
    const warning = checkUnrecordedDatabaseAge(older);
    expect(warning).toContain(
      `its system tables were last prepared by a smrt release older than ${OLDEST_SUPPORTED_RELEASE} (system schema ${older}; smrt ${OLDEST_SUPPORTED_RELEASE} has ${floor})`,
    );
    expect(warning).toContain('cannot tell from the database');
    expect(warning).toContain('is safe to continue');
    // The record check is unchanged: no record is no refusal.
    expect(checkOldestSupportedRelease(null)).toEqual({ ok: true });
    expect(
      decideMigrationRun({
        changes: [],
        addedTables: [{ tableName: 'posts' }],
        engine: 'postgres',
        recordedRelease: null,
      }),
    ).toMatchObject({ proceed: true, releaseStop: null });
  });

  it.each([
    ['no system tables', null],
    ["the floor's own system schema", floor],
    ["this build's system schema", SMRT_SCHEMA_VERSION],
    ['a stamp that is not a version', 'not-a-version'],
  ])('does not warn for %s', (_name, systemSchema) => {
    expect(checkUnrecordedDatabaseAge(systemSchema)).toBeNull();
  });

  it('keeps the record check as it was', () => {
    expect(checkOldestSupportedRelease(OLDEST_SUPPORTED_RELEASE)).toEqual({
      ok: true,
    });
    expect(checkOldestSupportedRelease('0.0.1')).toMatchObject({
      ok: false,
      recorded: '0.0.1',
      oldest: OLDEST_SUPPORTED_RELEASE,
    });
  });
});

describe('migrate release refusal (real SQLite)', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      posts: {
        tableName: 'posts',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          note: { type: 'TEXT' },
        },
        indexes: [],
        foreignKeys: [],
        triggers: [],
        dependencies: [],
        version: '',
      },
    });
    await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY)');
    await db.query("INSERT INTO posts VALUES ('old-row')");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });
  it('older last record refuses without applying a column or updating the record', async () => {
    await recordSuccessfulMigrate(db, {
      input: { ...collectMigrateRecordInput(), release: '0.0.1' },
    });
    const before = await readLastMigrateRecord(db);
    const result = await migrateSmrtSchemas({ db, packageName: '@test/gate' });
    expect(result).toMatchObject({
      refused: true,
      applied: false,
      releaseStop: { message: expect.stringContaining('smrt 0.0.1') },
      results: [],
    });
    expect((await db.getTableSchema?.('posts'))?.columns).not.toHaveProperty(
      'note',
    );
    expect(await readLastMigrateRecord(db)).toEqual(before);
  });
  it.each([
    null,
    OLDEST_SUPPORTED_RELEASE,
    '999.0.0',
  ])('equal/newer/no record %s proceeds', async (release) => {
    if (release)
      await recordSuccessfulMigrate(db, {
        input: { ...collectMigrateRecordInput(), release },
      });
    const result = await migrateSmrtSchemas({ db, packageName: '@test/gate' });
    expect(result).toMatchObject({
      refused: false,
      releaseStop: null,
      applied: true,
    });
    expect((await db.getTableSchema?.('posts'))?.columns).toHaveProperty(
      'note',
    );
    expect((await db.query('SELECT * FROM posts')).rows).toEqual([
      { id: 'old-row', note: null },
    ]);
  });
});

describe.each([
  'sqlite',
  'duckdb',
] as const)('migrate dates a database without a record by its system tables (%s)', (engine) => {
  const floor = OLDEST_SUPPORTED_SYSTEM_SCHEMA as string;
  let db: DatabaseInterface;

  /** The ledger as an earlier release left it: one stamp per system schema. */
  async function stampSystemSchema(...versions: string[]) {
    await db.query(`CREATE TABLE IF NOT EXISTS _smrt_migrations (
      id TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, description TEXT, checksum TEXT)`);
    for (const version of versions)
      await db.query(
        'INSERT INTO _smrt_migrations (id, version, description) VALUES (?, ?, ?)',
        `stamp-${version}`,
        version,
        'earlier release',
      );
  }
  const stamps = async () =>
    (
      await db.query('SELECT version FROM _smrt_migrations ORDER BY version')
    ).rows.map((row) => String(row.version));
  const columns = async () =>
    (
      await db.query(
        "SELECT name FROM pragma_table_info('posts') ORDER BY name",
      )
    ).rows.map((row) => String(row.name));
  const migrate = () =>
    migrateSmrtSchemas({ db, packageName: '@test/gate', engineHint: engine });

  beforeEach(async () => {
    db = await getDatabase({ type: engine, url: ':memory:' });
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      posts: {
        tableName: 'posts',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          note: { type: 'TEXT' },
        },
        indexes: [],
        foreignKeys: [],
        triggers: [],
        dependencies: [],
        version: '',
      },
    });
    await db.query('CREATE TABLE posts (id TEXT PRIMARY KEY)');
    await db.query("INSERT INTO posts VALUES ('old-row')");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  it('reads the highest stamp, ignoring suffixes and anything that is not a version', async () => {
    expect(await readRecordedSystemSchema(db, { engineHint: engine })).toBe(
      null,
    );
    await stampSystemSchema(
      '1.9.0',
      '1.11.1',
      '1.11.1+deferred-compat',
      'unreadable',
    );
    expect(await readRecordedSystemSchema(db, { engineHint: engine })).toBe(
      '1.11.1',
    );
  });

  it('upgrades a database whose system tables are older than the floor, with a warning', async () => {
    const older = versionBelow(floor);
    await stampSystemSchema('1.0.0', older, `${older}+deferred-compat`);
    warn.mockClear();

    const result = await migrate();

    expect(result).toMatchObject({
      refused: false,
      releaseStop: null,
      applied: true,
    });
    expect(await columns()).toEqual(['id', 'note']);
    expect(warn.mock.calls.flat().join('\n')).toContain(
      `older than ${OLDEST_SUPPORTED_RELEASE} (system schema ${older}`,
    );
  });

  it('upgrades a database the oldest supported release prepared', async () => {
    await stampSystemSchema('1.0.0', floor);

    const result = await migrate();

    expect(result).toMatchObject({
      refused: false,
      releaseStop: null,
      applied: true,
    });
    expect(await columns()).toEqual(['id', 'note']);
    expect(
      await readLastMigrateRecord(db, { engineHint: engine }),
    ).toMatchObject({ state: 'recorded' });
  });

  it('trusts a migrate record over older stamps', async () => {
    await recordSuccessfulMigrate(db, {
      input: {
        ...collectMigrateRecordInput(),
        release: OLDEST_SUPPORTED_RELEASE,
      },
      engineHint: engine,
    });
    await db.query('DELETE FROM _smrt_migrations');
    await stampSystemSchema(versionBelow(floor));

    expect(await migrate()).toMatchObject({ refused: false, applied: true });
    expect(await columns()).toEqual(['id', 'note']);
  });
});
