import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
} from '../migrations/migrate-record.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { assertDatabaseMigratedForBuild } from '../migrations/startup-guard.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectDefinition } from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { verifyPersistenceTable } from './table-verifier.js';

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
const PKG = '@test4929/startup';
const KEY = `${PKG}:Startup4929`;
const TABLE = 'startup4929';
class Startup4929 extends SmrtObject {
  name = '';
}
class Startups extends SmrtCollection<Startup4929> {
  static readonly _itemClass = Startup4929;
}

function register(extra = false) {
  const definition = {
    name: 'startup4929',
    className: 'Startup4929',
    collection: TABLE,
    filePath: '/fixture/startup.ts',
    extends: 'SmrtObject',
    fields: {
      name: { type: 'text' },
      ...(extra ? { added: { type: 'text' } } : {}),
    },
    methods: {},
    decoratorConfig: { tableName: TABLE },
    packageName: PKG,
  } as SmartObjectDefinition;
  const manifest = new ManifestGenerator().generateManifest(
    [{ filePath: definition.filePath, objects: [definition], errors: [] }],
    { packageName: PKG },
  );
  ObjectRegistry.register(Startup4929, {
    name: 'Startup4929',
    packageName: PKG,
    _manifest: manifest,
    _manifestKey: KEY,
  });
}

describe.each([
  'sqlite',
  'duckdb',
] as const)('startup migration gate on %s (#4929)', (engine) => {
  let db: DatabaseInterface;
  let restore: () => void;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
    db = await getDatabase({
      type: engine,
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    register();
    warn.mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    restore();
    await db.close?.();
  });

  it('refuses first production persistence use without a migrate record', async () => {
    await db.query(`CREATE TABLE ${TABLE} (id TEXT)`);
    await expect(verifyPersistenceTable(db, TABLE, KEY)).rejects.toThrow(
      'smrt db:migrate',
    );
    expect(await readLastMigrateRecord(db, { engineHint: engine })).toEqual({
      state: 'none',
    });
    expect(await db.tableExists('_smrt_migrate_runs')).toBe(false);
  });

  it('refuses a collection query and object save after one declaration changes', async () => {
    await migrateSmrtSchemas({ db, packageName: PKG, engineHint: engine });
    const found = collectMigrateRecordInput().fingerprint;
    register(true);
    const expected = collectMigrateRecordInput().fingerprint;
    expect(expected).not.toBe(found);
    const collection = await Startups.create({ db });
    await expect(collection.count()).rejects.toThrow('smrt db:migrate');
    const object = new Startup4929({ db });
    await object.initialize();
    await expect(object.save()).rejects.toMatchObject({
      code: 'DB_MIGRATION_REQUIRED',
    });
    await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
      `expected ${expected.slice(0, 12)}, found ${found.slice(0, 12)}`,
    );
    await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
      'restarted old copy or code rolled back',
    );
    // Migration still runs after refusal, then the same handle can start.
    await migrateSmrtSchemas({
      db,
      packageName: PKG,
      engineHint: engine,
      name: 'startup4929_add_column',
    });
    await expect(collection.count()).resolves.toBe(0);
  });

  it('also refuses rolled-back code against a newer database record', async () => {
    register(true);
    await migrateSmrtSchemas({ db, packageName: PKG, engineHint: engine });
    ObjectRegistry.clear();
    register();
    await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
      'smrt db:migrate',
    );
  });

  it('starts after migrate and shares one record read across concurrent first uses', async () => {
    await migrateSmrtSchemas({ db, packageName: PKG, engineHint: engine });
    const query = vi.spyOn(db, 'query');
    await Promise.all(
      Array.from({ length: 5 }, () => verifyPersistenceTable(db, TABLE, KEY)),
    );
    await assertDatabaseMigratedForBuild(db);
    expect(
      query.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('SELECT release, packages, fingerprint'),
      ),
    ).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('shares the successful record read across handles with the same database key', async () => {
    await recordSuccessfulMigrate(db, { engineHint: engine });
    // Give both views the same stable explicit identity. An independent memory
    // database without this identity must not share the success (next test).
    const key = `startup4929-${crypto.randomUUID()}`;
    const view = (query: DatabaseInterface['query']) =>
      new Proxy(db, {
        get(target, property) {
          if (property === 'dbid') return key;
          if (property === 'query') return query;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const read = vi.fn(db.query.bind(db));
    await assertDatabaseMigratedForBuild(view(read));
    const unexpectedRead = vi.fn(db.query.bind(db));
    await assertDatabaseMigratedForBuild(view(unexpectedRead));
    expect(
      read.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('SELECT release, packages, fingerprint'),
      ),
    ).toHaveLength(1);
    expect(unexpectedRead).not.toHaveBeenCalled();
  });

  it('retries a refused record read rather than caching it as ready', async () => {
    await recordSuccessfulMigrate(db, { engineHint: engine });
    vi.spyOn(db, 'query').mockRejectedValueOnce(
      new Error('record probe unavailable'),
    );
    await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
      'smrt db:migrate',
    );
    await expect(assertDatabaseMigratedForBuild(db)).resolves.toBeUndefined();
  });

  it('uses the existing unset NODE_ENV development default', async () => {
    vi.stubEnv('NODE_ENV', undefined);
    await assertDatabaseMigratedForBuild(db);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Continuing in development mode'),
    );
  });

  it('does not cache refusals as success', async () => {
    await recordSuccessfulMigrate(db, {
      engineHint: engine,
      input: { ...collectMigrateRecordInput(), fingerprint: 'a'.repeat(64) },
    });
    const query = vi.spyOn(db, 'query');
    for (let i = 0; i < 2; i++)
      await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
        'smrt db:migrate',
      );
    expect(
      query.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('SELECT release, packages, fingerprint'),
      ),
    ).toHaveLength(2);
    await recordSuccessfulMigrate(db, { engineHint: engine });
    await expect(assertDatabaseMigratedForBuild(db)).resolves.toBeUndefined();
  });

  it('does not reuse another in-memory database success', async () => {
    await recordSuccessfulMigrate(db, { engineHint: engine });
    await assertDatabaseMigratedForBuild(db);
    const other = await getDatabase({
      type: engine,
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    try {
      await expect(assertDatabaseMigratedForBuild(other)).rejects.toThrow(
        'no migrate record',
      );
    } finally {
      await other.close?.();
    }
  });

  it('warns once in development with no record', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await Promise.all([
      assertDatabaseMigratedForBuild(db),
      assertDatabaseMigratedForBuild(db),
    ]);
    await assertDatabaseMigratedForBuild(db);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Continuing in development mode'),
    );
  });

  it('warns once in development with a different record', async () => {
    await recordSuccessfulMigrate(db, {
      engineHint: engine,
      input: { ...collectMigrateRecordInput(), fingerprint: 'b'.repeat(64) },
    });
    vi.stubEnv('NODE_ENV', 'development');
    await assertDatabaseMigratedForBuild(db);
    await assertDatabaseMigratedForBuild(db);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('found bbbbbbbbbbbb'),
    );
  });

  it('exempts NODE_ENV=test without queries or warning noise', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const query = vi.spyOn(db, 'query');
    await assertDatabaseMigratedForBuild(db);
    expect(query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('exempts only handles prepared by getTestDatabase even in production mode', async () => {
    const testDb = await getTestDatabase({ type: engine, classes: [KEY] });
    try {
      const query = vi.spyOn(testDb, 'query');
      await assertDatabaseMigratedForBuild(testDb);
      expect(query).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
        'smrt db:migrate',
      );
    } finally {
      await testDb.close?.();
    }
  });

  it.each([
    false,
    true,
  ])('logs every overridden database start, including matching=%s', async (matching) => {
    if (matching) await recordSuccessfulMigrate(db, { engineHint: engine });
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '1');
    await assertDatabaseMigratedForBuild(db);
    await assertDatabaseMigratedForBuild(db);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /expected [a-f0-9]{12}, found .*Check overridden by SMRT_ALLOW_UNMIGRATED_START=1/,
      ),
    );
    const other = await getDatabase({
      type: engine,
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    try {
      await assertDatabaseMigratedForBuild(other);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      await other.close?.();
    }
  });

  it('requires the exact override value 1', async () => {
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', 'true');
    await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
      'smrt db:migrate',
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
