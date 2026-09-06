import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMigrateInt8Command } from '../db-migrate-int8.js';
import {
  buildDeclaredUuidColumnSet,
  dbMigrateUuidCommand,
  type LiveTextColumn,
  parseRenameSpecs,
  planUuidConversions,
} from '../db-migrate-uuid.js';
import { utilityCommands } from '../utilities.js';

const sqlTestHarness = vi.hoisted(() => ({
  interceptor: undefined as undefined | ((...args: any[]) => Promise<unknown>),
  realGetDatabase: undefined as any,
}));

vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  sqlTestHarness.realGetDatabase = actual.getDatabase;
  return {
    ...actual,
    getDatabase: (...args: any[]) =>
      sqlTestHarness.interceptor
        ? sqlTestHarness.interceptor(...args)
        : actual.getDatabase(...args),
  };
});

describe('db:migrate-uuid command', () => {
  it('is registered in the utility command map', () => {
    expect(utilityCommands['db:migrate-uuid']).toBe(dbMigrateUuidCommand);
    expect(dbMigrateUuidCommand.name).toBe('db:migrate-uuid');
    expect(dbMigrateUuidCommand.aliases).toContain('migrate-uuid');
  });

  describe('parseRenameSpecs', () => {
    it('returns no specs for an empty arg', () => {
      expect(parseRenameSpecs(undefined, undefined)).toEqual([]);
      expect(parseRenameSpecs('', 'assets')).toEqual([]);
    });

    it('parses a single old:new pair against the default --table', () => {
      expect(parseRenameSpecs('parent_id:source_asset_id', 'assets')).toEqual([
        { table: 'assets', from: 'parent_id', to: 'source_asset_id' },
      ]);
    });

    it('parses multiple comma-separated pairs', () => {
      expect(
        parseRenameSpecs('parent_slug:parent_id,old_ref:new_ref', 'tags'),
      ).toEqual([
        { table: 'tags', from: 'parent_slug', to: 'parent_id' },
        { table: 'tags', from: 'old_ref', to: 'new_ref' },
      ]);
    });

    it('supports per-entry table via "table.old:new" overriding the default', () => {
      expect(
        parseRenameSpecs(
          'tags.parent_slug:parent_id,facts.parent_id:previous_fact_id',
          'assets',
        ),
      ).toEqual([
        { table: 'tags', from: 'parent_slug', to: 'parent_id' },
        { table: 'facts', from: 'parent_id', to: 'previous_fact_id' },
      ]);
    });

    it('throws when a pair is malformed', () => {
      expect(() => parseRenameSpecs('parent_id', 'assets')).toThrow(
        /Invalid --rename entry/,
      );
    });

    it('throws when no table can be resolved for a pair', () => {
      expect(() =>
        parseRenameSpecs('parent_id:source_asset_id', undefined),
      ).toThrow(/no table/);
    });
  });

  // -------------------------------------------------------------------------
  // Fix C (#1338): TEXT→uuid conversion is gated on the SMRT-declared schema.
  // Only columns the manifest declares `type: 'UUID'` are eligible — a column
  // the schema intentionally keeps TEXT (external_id, message_id, provider ids)
  // is NEVER converted even when its current data happens to be uuid-shaped,
  // and non-SMRT tables (absent from the manifest) drop out automatically.
  // -------------------------------------------------------------------------
  describe('buildDeclaredUuidColumnSet', () => {
    it('collects only columns whose declared type is UUID (table|column keys)', () => {
      const declared = buildDeclaredUuidColumnSet({
        things: {
          columns: {
            id: { type: 'UUID' },
            owner_id: { type: 'UUID' },
            // schema-intentional TEXT id that merely holds uuid-shaped values
            external_id: { type: 'TEXT' },
            slug: { type: 'TEXT' },
          },
        },
        widgets: {
          columns: {
            id: { type: 'UUID' },
            // a non-uuid id column
            message_id: { type: 'TEXT' },
          },
        },
      });

      expect([...declared].sort()).toEqual(
        ['things|id', 'things|owner_id', 'widgets|id'].sort(),
      );
      expect(declared.has('things|external_id')).toBe(false);
      expect(declared.has('widgets|message_id')).toBe(false);
    });

    it('is case-insensitive on the declared type string', () => {
      const declared = buildDeclaredUuidColumnSet({
        things: { columns: { id: { type: 'uuid' } } },
      });
      expect(declared.has('things|id')).toBe(true);
    });

    it('returns an empty set for an empty / undefined manifest (fail-closed input)', () => {
      expect(buildDeclaredUuidColumnSet({}).size).toBe(0);
      expect(
        buildDeclaredUuidColumnSet(
          undefined as unknown as Record<string, never>,
        ).size,
      ).toBe(0);
    });
  });

  describe('planUuidConversions', () => {
    const declared = new Set<string>(['things|id', 'things|owner_id']);

    it('converts ONLY schema-declared-UUID columns that also hold all-uuid data', () => {
      const live: LiveTextColumn[] = [
        // declared UUID + clean data → convert
        { table: 'things', column: 'id', hasDefault: true, nonUuid: 0 },
        { table: 'things', column: 'owner_id', hasDefault: false, nonUuid: 0 },
        // NOT declared UUID, but its data IS all uuid-shaped → still NOT converted
        {
          table: 'things',
          column: 'external_id',
          hasDefault: false,
          nonUuid: 0,
        },
      ];

      const plan = planUuidConversions(live, declared);

      expect(plan.convert.map((c) => `${c.table}.${c.column}`).sort()).toEqual([
        'things.id',
        'things.owner_id',
      ]);
      // external_id is left as TEXT precisely because the schema does not
      // declare it UUID, even though every value is a canonical UUID today.
      expect(plan.skipNotDeclared.map((c) => `${c.table}.${c.column}`)).toEqual(
        ['things.external_id'],
      );
      expect(plan.skipDirtyData).toEqual([]);
      // hasDefault is carried through so the handler can DROP DEFAULT first.
      expect(plan.convert.find((c) => c.column === 'id')?.hasDefault).toBe(
        true,
      );
    });

    it('skips a declared-UUID column whose data still has non-uuid values', () => {
      const live: LiveTextColumn[] = [
        { table: 'things', column: 'id', hasDefault: false, nonUuid: 3 },
      ];
      const plan = planUuidConversions(live, declared);
      expect(plan.convert).toEqual([]);
      expect(plan.skipDirtyData).toEqual([
        { table: 'things', column: 'id', nonUuid: 3 },
      ]);
      expect(plan.skipNotDeclared).toEqual([]);
    });

    it('converts nothing when the declared-UUID set is empty (fail-closed)', () => {
      const live: LiveTextColumn[] = [
        { table: 'things', column: 'id', hasDefault: false, nonUuid: 0 },
        {
          table: 'things',
          column: 'external_id',
          hasDefault: false,
          nonUuid: 0,
        },
      ];
      const plan = planUuidConversions(live, new Set());
      expect(plan.convert).toEqual([]);
      expect(plan.skipNotDeclared.map((c) => c.column).sort()).toEqual([
        'external_id',
        'id',
      ]);
    });
  });
});

describe('db:migrate-int8 command', () => {
  it('is registered with a dry-run maintenance-window option', () => {
    expect(utilityCommands['db:migrate-int8']).toBe(dbMigrateInt8Command);
    expect(dbMigrateInt8Command.name).toBe('db:migrate-int8');
    expect(dbMigrateInt8Command.aliases).toContain('migrate-int8');
    expect(dbMigrateInt8Command.options?.['dry-run']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fix C (#1338) end-to-end against a REAL Postgres database.
//
// Runs only when DATABASE_URL is set (the repo's `isPostgresAvailable()`
// convention — skipped in environments without a Postgres). The database is
// real; only the manifest source (ObjectRegistry.getAllSchemasAsDefinitions) is
// provided directly, exactly as a built manifest would supply it.
//
// Proves: a live TEXT `external_id` column holding all-uuid-shaped values is
// NOT converted (the schema declares it TEXT), while a declared-UUID FK column
// (`owner_id`) and the primary `id` — both holding all-uuid data — ARE.
// ---------------------------------------------------------------------------
const hasPostgres = Boolean(process.env.DATABASE_URL);
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres('db:migrate-uuid declared-UUID gating (real Postgres)', () => {
  // Unique per run so concurrent / leftover tables can't collide.
  const tableName = `mu_things_${Math.random().toString(36).slice(2, 8)}`;
  let getAllSchemasSpy: ReturnType<typeof vi.spyOn> | undefined;

  // The handler's `finally` ends the shared connection pool keyed by URL, so we
  // re-acquire a fresh handle for every setup / assertion query rather than
  // holding a long-lived connection the handler would close underneath us.
  async function freshDb(): Promise<any> {
    return getDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL as string,
    });
  }

  async function dataType(column: string): Promise<string | undefined> {
    const db = await freshDb();
    const { rows } = await db.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      tableName,
      column,
    );
    return (rows as any[])[0]?.data_type;
  }

  beforeEach(async () => {
    const db = await freshDb();
    await db.query(`DROP TABLE IF EXISTS "${tableName}"`);
    // All three id/FK columns are plain TEXT in the live DB and hold
    // canonical-UUID-shaped values. external_id is the column the schema keeps
    // as TEXT on purpose.
    await db.query(
      `CREATE TABLE "${tableName}" (
         id text PRIMARY KEY,
         owner_id text,
         external_id text
       )`,
    );
    await db.query(
      `INSERT INTO "${tableName}" (id, owner_id, external_id) VALUES ($1, $2, $3)`,
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    );

    // Inject DB config the handler reads via getPackageConfig('cli', …).
    clearCache();
    setConfig({
      packages: {
        cli: {
          database: { type: 'postgres', url: process.env.DATABASE_URL },
        },
      },
    } as any);

    // Provide the declared schema directly (only `${tableName}`), so the gating
    // sees id + owner_id as UUID and external_id as TEXT. autoDiscoverAndLoad
    // still runs but cannot override this spy.
    getAllSchemasSpy = vi
      .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
      .mockReturnValue({
        [tableName]: {
          tableName,
          ddl: '',
          columns: {
            id: { type: 'UUID', primaryKey: true },
            owner_id: { type: 'UUID' },
            external_id: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: '',
          dependencies: [],
        },
      } as any);
  });

  afterEach(async () => {
    getAllSchemasSpy?.mockRestore();
    try {
      const db = await freshDb();
      await db.query(`DROP TABLE IF EXISTS "${tableName}"`);
    } catch {
      // ignore
    }
    clearCache();
  });

  it('converts the declared-UUID id/FK columns but leaves the declared-TEXT external_id as TEXT', async () => {
    // Fail-before guard: all three start as TEXT.
    expect(await dataType('id')).toBe('text');
    expect(await dataType('owner_id')).toBe('text');
    expect(await dataType('external_id')).toBe('text');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await dbMigrateUuidCommand.handler([], { 'dry-run': false });

    logSpy.mockRestore();
    errorSpy.mockRestore();

    // Declared UUID + all-uuid data → converted to native uuid.
    expect(await dataType('id')).toBe('uuid');
    expect(await dataType('owner_id')).toBe('uuid');
    // Declared TEXT (even though every value is uuid-shaped) → untouched —
    // THIS is the over-conversion the fix prevents (data-shape alone is not
    // enough; the schema must declare the column UUID).
    expect(await dataType('external_id')).toBe('text');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Fix B (#1338): rename + convert share ONE transaction.
//
// When both phases run in one invocation, a conversion failure must roll the
// already-applied rename (which DROPs the old column) back too — the command's
// documented atomicity promise. Before the fix the rename phase COMMITted on
// its own, so a later conversion failure left a half-applied migration with the
// old column gone. We force a conversion failure (a view depends on a
// declared-UUID column, so `ALTER COLUMN … TYPE uuid` errors) and assert the
// rename was rolled back.
// ---------------------------------------------------------------------------
describePostgres(
  'db:migrate-uuid rename+convert atomicity (real Postgres)',
  () => {
    const tableName = `mu_atomic_${Math.random().toString(36).slice(2, 8)}`;
    const viewName = `${tableName}_v`;
    let getAllSchemasSpy: ReturnType<typeof vi.spyOn> | undefined;

    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    async function columnExists(column: string): Promise<boolean> {
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        tableName,
        column,
      );
      return (rows as any[]).length > 0;
    }

    async function dataType(column: string): Promise<string | undefined> {
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        tableName,
        column,
      );
      return (rows as any[])[0]?.data_type;
    }

    beforeEach(async () => {
      const db = await freshDb();
      await db.query(`DROP VIEW IF EXISTS "${viewName}"`);
      await db.query(`DROP TABLE IF EXISTS "${tableName}"`);
      // old_ref → parent_id is the R3-style rename (both TEXT, uuid-shaped data).
      // poison_id is declared UUID with clean data, but a view depends on it so
      // its `ALTER COLUMN … TYPE uuid` will FAIL — forcing the conversion phase
      // to error AFTER the rename has run inside the shared transaction.
      await db.query(
        `CREATE TABLE "${tableName}" (
         id text PRIMARY KEY,
         old_ref text,
         parent_id text,
         poison_id text
       )`,
      );
      await db.query(
        `INSERT INTO "${tableName}" (id, old_ref, parent_id, poison_id) VALUES ($1, $2, $3, $4)`,
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        null,
        '33333333-3333-3333-3333-333333333333',
      );
      await db.query(
        `CREATE VIEW "${viewName}" AS SELECT poison_id FROM "${tableName}"`,
      );

      clearCache();
      setConfig({
        packages: {
          cli: {
            database: { type: 'postgres', url: process.env.DATABASE_URL },
          },
        },
      } as any);

      getAllSchemasSpy = vi
        .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
        .mockReturnValue({
          [tableName]: {
            tableName,
            ddl: '',
            columns: {
              id: { type: 'UUID', primaryKey: true },
              parent_id: { type: 'UUID' },
              poison_id: { type: 'UUID' },
            },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
        } as any);
    });

    afterEach(async () => {
      getAllSchemasSpy?.mockRestore();
      try {
        const db = await freshDb();
        await db.query(`DROP VIEW IF EXISTS "${viewName}"`);
        await db.query(`DROP TABLE IF EXISTS "${tableName}"`);
      } catch {
        // ignore
      }
      clearCache();
    });

    it('rolls the rename back when the conversion phase fails (single transaction)', async () => {
      // Fail-before guard: rename source present, nothing converted yet.
      expect(await columnExists('old_ref')).toBe(true);
      expect(await dataType('parent_id')).toBe('text');
      expect(await dataType('poison_id')).toBe('text');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;

      // Both phases run: rename old_ref→parent_id (backfill + DROP old_ref), then
      // convert id/parent_id/poison_id. poison_id's ALTER fails (view depends on
      // it), so the WHOLE transaction — including the rename — must roll back.
      await dbMigrateUuidCommand.handler([], {
        rename: 'old_ref:parent_id',
        table: tableName,
      });

      const exitCode = process.exitCode;
      process.exitCode = undefined;
      logSpy.mockRestore();
      errorSpy.mockRestore();

      // The command reported failure …
      expect(exitCode).toBe(1);
      // … and the rename was rolled back: old_ref still exists, parent_id still
      // empty + TEXT, nothing converted. No half-applied migration.
      expect(await columnExists('old_ref')).toBe(true);
      expect(await dataType('parent_id')).toBe('text');
      expect(await dataType('poison_id')).toBe('text');
      expect(await dataType('id')).toBe('text');
    }, 30_000);
  },
);

describePostgres('db:migrate-uuid default and retry (real Postgres)', () => {
  const table = `mu_default_${Math.random().toString(36).slice(2, 8)}`;
  let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;
  async function freshDb(): Promise<any> {
    return getDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL as string,
    });
  }
  beforeEach(async () => {
    const db = await freshDb();
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    await db.query(
      `CREATE TABLE "${table}" (id text PRIMARY KEY DEFAULT '11111111-1111-1111-1111-111111111111'::text)`,
    );
    clearCache();
    setConfig({
      packages: {
        cli: { database: { type: 'postgres', url: process.env.DATABASE_URL } },
      },
    } as any);
    schemaSpy = vi
      .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
      .mockReturnValue({
        [table]: {
          tableName: table,
          ddl: '',
          columns: { id: { type: 'UUID' } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: '',
          dependencies: [],
        },
      } as any);
  });
  afterEach(async () => {
    schemaSpy?.mockRestore();
    try {
      const db = await freshDb();
      await db.query(`DROP TABLE IF EXISTS "${table}"`);
    } catch {}
    clearCache();
  });
  it('preserves a castable UUID default and retries as a no-op', async () => {
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await dbMigrateUuidCommand.handler([], {});
    expect(errors).not.toHaveBeenCalled();
    const db = await freshDb();
    const afterFirst = await freshDb();
    const first = await afterFirst.query(
      `SELECT data_type, column_default FROM information_schema.columns WHERE table_name=$1 AND column_name='id'`,
      table,
    );
    expect((first.rows as any[])[0].data_type).toBe('uuid');
    expect((first.rows as any[])[0].column_default).toContain('uuid');
    await dbMigrateUuidCommand.handler([], {});
    expect(errors).not.toHaveBeenCalled();
    const afterSecond = await freshDb();
    const row = await afterSecond.query(
      `INSERT INTO "${table}" DEFAULT VALUES RETURNING id`,
    );
    expect((row.rows as any[])[0].id).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
    quiet.mockRestore();
    errors.mockRestore();
  }, 30_000);
});

describePostgres(
  'db:migrate-uuid bounded generated TEXT bridge (real Postgres)',
  () => {
    const stem = `mu_bridge_${Math.random().toString(36).slice(2, 8)}`;
    const parent = `${stem}_parent`;
    const child = `${stem}_child`;
    const junction = `${stem}_junction`;
    let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    beforeEach(async () => {
      const db = await freshDb();
      await db.query(
        `DROP TABLE IF EXISTS "${junction}", "${child}", "${parent}" CASCADE`,
      );
      await db.query(
        `CREATE TABLE "${parent}" (id text PRIMARY KEY, _integrity_id_text text GENERATED ALWAYS AS (id) STORED)`,
      );
      await db.query(
        `CREATE UNIQUE INDEX "${parent}_bridge_uidx" ON "${parent}" USING btree (_integrity_id_text)`,
      );
      await db.query(
        `ALTER TABLE "${parent}" CLUSTER ON "${parent}_bridge_uidx"`,
      );
      await db.query(
        `CREATE TABLE "${child}" (id text PRIMARY KEY, parent_id text NOT NULL CONSTRAINT "${child}_parent_fkey" REFERENCES "${parent}"(id) ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.query(`CREATE TABLE "${junction}" (parent_text text NOT NULL)`);
      await db.query(
        `ALTER TABLE "${junction}" ADD CONSTRAINT "${junction}_bridge_fkey" FOREIGN KEY (parent_text) REFERENCES "${parent}"(_integrity_id_text) ON UPDATE CASCADE ON DELETE CASCADE NOT VALID`,
      );
      await db.query(
        `INSERT INTO "${parent}" (id) VALUES ('11111111-1111-1111-1111-111111111111')`,
      );
      await db.query(
        `INSERT INTO "${child}" (id, parent_id) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')`,
      );
      await db.query(
        `INSERT INTO "${junction}" (parent_text) VALUES ('11111111-1111-1111-1111-111111111111')`,
      );
      clearCache();
      setConfig({
        packages: {
          cli: {
            database: { type: 'postgres', url: process.env.DATABASE_URL },
          },
        },
      } as any);
      schemaSpy = vi
        .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
        .mockReturnValue({
          [parent]: {
            tableName: parent,
            ddl: '',
            columns: { id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [child]: {
            tableName: child,
            ddl: '',
            columns: { id: { type: 'UUID' }, parent_id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
        } as any);
    });

    afterEach(async () => {
      schemaSpy?.mockRestore();
      try {
        const db = await freshDb();
        await db.query(
          `DROP TABLE IF EXISTS "${junction}", "${child}", "${parent}" CASCADE`,
        );
      } catch {
        /* cleanup best effort */
      }
      clearCache();
    });

    it('rebuilds the bridge, its index, and validated/non-validated FKs while converting the UUID component', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await dbMigrateUuidCommand.handler([], { 'dry-run': false });
      expect(errorSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      const db = await freshDb();
      const { rows: types } = await db.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ($1, $2) AND column_name IN ('id', 'parent_id') ORDER BY table_name, column_name`,
        parent,
        child,
      );
      expect((types as any[]).every((row) => row.data_type === 'uuid')).toBe(
        true,
      );
      const { rows: bridge } = await db.query(
        `SELECT _integrity_id_text FROM "${parent}"`,
      );
      expect((bridge as any[])[0]._integrity_id_text).toBe(
        '11111111-1111-1111-1111-111111111111',
      );
      const { rows: bridgeIndex } = await db.query(
        `SELECT idx.indisclustered AS clustered
           FROM pg_index idx
           JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
          WHERE index_rel.relname = $1`,
        `${parent}_bridge_uidx`,
      );
      expect((bridgeIndex as any[])[0].clustered).toBe(true);
      const { rows: constraints } = await db.query(
        `SELECT conname, convalidated FROM pg_constraint WHERE conname IN ($1, $2) ORDER BY conname`,
        `${child}_parent_fkey`,
        `${junction}_bridge_fkey`,
      );
      expect(constraints).toEqual([
        { conname: `${child}_parent_fkey`, convalidated: true },
        { conname: `${junction}_bridge_fkey`, convalidated: false },
      ]);
      await expect(
        db.query(
          `INSERT INTO "${child}" (id, parent_id) VALUES ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000')`,
        ),
      ).rejects.toThrow();
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// #2740: PostgreSQL dependency migrations must execute every mutation through
// the transaction callback executor.  This fixture observes its real backend
// PID, lets the first TYPE uuid ALTER succeed, then injects a late failure.
// PostgreSQL must roll every prior DDL/data change back, including the optional
// rename and catalog-driven generated-bridge/FK recreation work.
// ---------------------------------------------------------------------------
describePostgres(
  'db:migrate-uuid callback executor affinity and late rollback (real Postgres)',
  () => {
    const stem = `mu_callback_${Math.random().toString(36).slice(2, 8)}`;
    const parent = `${stem}_parent`;
    const child = `${stem}_child`;
    const junction = `${stem}_junction`;
    const parentBridgeIndex = `${parent}_bridge_uidx`;
    const childParentFk = `${child}_parent_fkey`;
    const junctionBridgeFk = `${junction}_bridge_fkey`;
    let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    async function snapshot(): Promise<Record<string, unknown>> {
      const db = await freshDb();
      const [parentRows, childRows, junctionRows, columns, indexes, fks] =
        await Promise.all([
          db.query(
            `SELECT to_jsonb(parent) AS row FROM "${parent}" parent ORDER BY id`,
          ),
          db.query(`SELECT id, parent_id FROM "${child}" ORDER BY id`),
          db.query(
            `SELECT parent_text FROM "${junction}" ORDER BY parent_text`,
          ),
          db.query(
            `SELECT table_name, column_name, data_type, is_generated, generation_expression
               FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name IN ($1, $2, $3)
              ORDER BY table_name, ordinal_position`,
            parent,
            child,
            junction,
          ),
          db.query(
            `SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS definition
               FROM pg_index
              WHERE indexrelid = $1::regclass`,
            parentBridgeIndex,
          ),
          db.query(
            `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
               FROM pg_constraint
              WHERE conname IN ($1, $2)
              ORDER BY conname`,
            childParentFk,
            junctionBridgeFk,
          ),
        ]);
      return {
        parentRows: parentRows.rows,
        childRows: childRows.rows,
        junctionRows: junctionRows.rows,
        columns: columns.rows,
        indexes: indexes.rows,
        fks: fks.rows,
      };
    }

    beforeEach(async () => {
      const db = await freshDb();
      await db.query(
        `DROP TABLE IF EXISTS "${junction}", "${child}", "${parent}" CASCADE`,
      );
      await db.query(
        `CREATE TABLE "${parent}" (
           id text PRIMARY KEY,
           old_ref text NOT NULL,
           new_ref text,
           _integrity_id_text text GENERATED ALWAYS AS (id) STORED
         )`,
      );
      await db.query(
        `CREATE UNIQUE INDEX "${parentBridgeIndex}" ON "${parent}" USING btree (_integrity_id_text)`,
      );
      await db.query(
        `CREATE TABLE "${child}" (
           id text PRIMARY KEY,
           parent_id text NOT NULL CONSTRAINT "${childParentFk}"
             REFERENCES "${parent}"(id) ON UPDATE CASCADE ON DELETE RESTRICT
             DEFERRABLE INITIALLY DEFERRED
         )`,
      );
      await db.query(`CREATE TABLE "${junction}" (parent_text text NOT NULL)`);
      await db.query(
        `ALTER TABLE "${junction}" ADD CONSTRAINT "${junctionBridgeFk}"
           FOREIGN KEY (parent_text) REFERENCES "${parent}"(_integrity_id_text)
           ON UPDATE CASCADE ON DELETE CASCADE NOT VALID`,
      );
      await db.query(
        `INSERT INTO "${parent}" (id, old_ref) VALUES ($1, $2)`,
        '11111111-1111-1111-1111-111111111111',
        'rename-value',
      );
      await db.query(
        `INSERT INTO "${child}" (id, parent_id) VALUES ($1, $2)`,
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
      );
      await db.query(
        `INSERT INTO "${junction}" (parent_text) VALUES ($1)`,
        '11111111-1111-1111-1111-111111111111',
      );

      clearCache();
      setConfig({
        packages: {
          cli: {
            database: { type: 'postgres', url: process.env.DATABASE_URL },
          },
        },
      } as any);
      schemaSpy = vi
        .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
        .mockReturnValue({
          [parent]: {
            tableName: parent,
            ddl: '',
            columns: { id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [child]: {
            tableName: child,
            ddl: '',
            columns: { id: { type: 'UUID' }, parent_id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
        } as any);
    });

    afterEach(async () => {
      schemaSpy?.mockRestore();
      try {
        const db = await freshDb();
        await db.query(
          `DROP TABLE IF EXISTS "${junction}", "${child}", "${parent}" CASCADE`,
        );
      } catch {
        // The command closes its pool; teardown always reacquires a handle.
      }
      clearCache();
    });

    it('uses one callback backend and rolls every prior mutation back after a late failure', async () => {
      const before = await snapshot();
      const callbackPids: number[] = [];
      let injected = false;
      sqlTestHarness.interceptor = async (...args: any[]) => {
        const realDb: any = await sqlTestHarness.realGetDatabase(...args);
        return new Proxy(realDb, {
          get(target, property, receiver) {
            if (property === 'transaction') {
              return async (callback: (tx: any) => Promise<unknown>) =>
                target.transaction(async (tx: any) => {
                  const callbackTx = new Proxy(tx, {
                    get(transactionTarget, transactionProperty, txReceiver) {
                      if (transactionProperty === 'query') {
                        return async (...queryArgs: any[]) => {
                          const pid = await transactionTarget.query(
                            'SELECT pg_backend_pid() AS backend_pid',
                          );
                          callbackPids.push(
                            Number((pid.rows as any[])[0].backend_pid),
                          );
                          const result = await transactionTarget.query(
                            ...queryArgs,
                          );
                          const sql = String(queryArgs[0]);
                          if (
                            !injected &&
                            /^ALTER TABLE .* ALTER COLUMN .* TYPE uuid /i.test(
                              sql,
                            )
                          ) {
                            injected = true;
                            throw new Error(
                              'injected late failure after successful TYPE uuid ALTER',
                            );
                          }
                          return result;
                        };
                      }
                      const value = Reflect.get(
                        transactionTarget,
                        transactionProperty,
                        txReceiver,
                      );
                      return typeof value === 'function'
                        ? value.bind(transactionTarget)
                        : value;
                    },
                  });
                  return callback(callbackTx);
                });
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;

      await dbMigrateUuidCommand.handler([], {
        rename: `${parent}.old_ref:new_ref`,
      });

      const exitCode = process.exitCode;
      process.exitCode = undefined;
      sqlTestHarness.interceptor = undefined;
      logSpy.mockRestore();

      expect(injected).toBe(true);
      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'injected late failure after successful TYPE uuid ALTER',
        ),
      );
      errorSpy.mockRestore();
      expect(callbackPids.length).toBeGreaterThan(1);
      expect(new Set(callbackPids)).toHaveLength(1);

      // The failing mutation happened after a real ALTER TYPE succeeded. All
      // observable state must nevertheless exactly match the pre-run fixture:
      // data, TEXT types, rename source/destination, stored bridge, its unique
      // index, and both inbound catalog FKs.
      expect(await snapshot()).toEqual(before);

      const retryLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const retryErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      await dbMigrateUuidCommand.handler([], {
        rename: `${parent}.old_ref:new_ref`,
      });
      expect(retryErrorSpy).not.toHaveBeenCalled();
      retryLogSpy.mockRestore();
      retryErrorSpy.mockRestore();

      const afterRetry = await snapshot();
      expect(
        (afterRetry.columns as Array<Record<string, string>>)
          .filter(
            (column) =>
              [parent, child].includes(column.table_name) &&
              ['id', 'parent_id'].includes(column.column_name),
          )
          .every((column) => column.data_type === 'uuid'),
      ).toBe(true);
      expect(
        (afterRetry.columns as Array<Record<string, string>>).some(
          (column) =>
            column.table_name === parent && column.column_name === 'old_ref',
        ),
      ).toBe(false);
      expect(afterRetry.parentRows).toEqual([
        {
          row: {
            id: '11111111-1111-1111-1111-111111111111',
            new_ref: 'rename-value',
            _integrity_id_text: '11111111-1111-1111-1111-111111111111',
          },
        },
      ]);
    }, 30_000);
  },
);

// A schema can already have a native UUID id while retaining a stored TEXT
// bridge for legacy consumers.  The catalog includes both `id` and `(id)::text`
// expressions in real deployments; this representative parenthesized form
// must stay out of a component that only converts a different TEXT UUID field.
describePostgres(
  'db:migrate-uuid leaves an unrelated native-id TEXT bridge intact (real Postgres)',
  () => {
    const stem = `mu_native_bridge_${Math.random().toString(36).slice(2, 8)}`;
    const parent = `${stem}_parent`;
    const consumer = `${stem}_consumer`;
    const bridgeIndex = `${parent}_bridge_uidx`;
    const bridgeFk = `${consumer}_bridge_fkey`;
    let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    beforeEach(async () => {
      const db = await freshDb();
      await db.query(`DROP TABLE IF EXISTS "${consumer}", "${parent}" CASCADE`);
      await db.query(
        `CREATE TABLE "${parent}" (
           id uuid PRIMARY KEY,
           owner_id text NOT NULL,
           _integrity_id_text text GENERATED ALWAYS AS ((id)::text) STORED
         )`,
      );
      await db.query(
        `CREATE UNIQUE INDEX "${bridgeIndex}" ON "${parent}" (_integrity_id_text)`,
      );
      await db.query(
        `CREATE TABLE "${consumer}" (
           parent_text text NOT NULL CONSTRAINT "${bridgeFk}"
             REFERENCES "${parent}"(_integrity_id_text)
         )`,
      );
      await db.query(
        `INSERT INTO "${parent}" (id, owner_id) VALUES ($1::uuid, $2)`,
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      );
      await db.query(
        `INSERT INTO "${consumer}" (parent_text) VALUES ($1)`,
        '11111111-1111-1111-1111-111111111111',
      );
      clearCache();
      setConfig({
        packages: {
          cli: {
            database: { type: 'postgres', url: process.env.DATABASE_URL },
          },
        },
      } as any);
      schemaSpy = vi
        .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
        .mockReturnValue({
          [parent]: {
            tableName: parent,
            ddl: '',
            columns: { id: { type: 'UUID' }, owner_id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
        } as any);
    });

    afterEach(async () => {
      schemaSpy?.mockRestore();
      try {
        const db = await freshDb();
        await db.query(
          `DROP TABLE IF EXISTS "${consumer}", "${parent}" CASCADE`,
        );
      } catch {
        // Handler cleanup closes pooled handles; reacquire before teardown.
      }
      clearCache();
    });

    it('converts the declared TEXT UUID field without rebuilding the native-id bridge, index, or incoming TEXT FK', async () => {
      const db = await freshDb();
      const before = await Promise.all([
        db.query(
          `SELECT pg_get_indexdef($1::regclass) AS definition`,
          bridgeIndex,
        ),
        db.query(
          `SELECT convalidated, pg_get_constraintdef(oid) AS definition
             FROM pg_constraint WHERE conname = $1`,
          bridgeFk,
        ),
      ]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dbMigrateUuidCommand.handler([], {});

      expect(errorSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      const after = await freshDb();
      const [types, bridge, index, fk] = await Promise.all([
        after.query(
          `SELECT column_name, data_type, is_generated, generation_expression
             FROM information_schema.columns
            WHERE table_name = $1 AND column_name IN ('id', 'owner_id', '_integrity_id_text')
            ORDER BY column_name`,
          parent,
        ),
        after.query(`SELECT _integrity_id_text FROM "${parent}"`),
        after.query(
          `SELECT pg_get_indexdef($1::regclass) AS definition`,
          bridgeIndex,
        ),
        after.query(
          `SELECT convalidated, pg_get_constraintdef(oid) AS definition
             FROM pg_constraint WHERE conname = $1`,
          bridgeFk,
        ),
      ]);
      expect(types.rows).toEqual([
        {
          column_name: '_integrity_id_text',
          data_type: 'text',
          is_generated: 'ALWAYS',
          generation_expression: '(id)::text',
        },
        {
          column_name: 'id',
          data_type: 'uuid',
          is_generated: 'NEVER',
          generation_expression: null,
        },
        {
          column_name: 'owner_id',
          data_type: 'uuid',
          is_generated: 'NEVER',
          generation_expression: null,
        },
      ]);
      expect(bridge.rows).toEqual([
        { _integrity_id_text: '11111111-1111-1111-1111-111111111111' },
      ]);
      expect(index.rows).toEqual(before[0].rows);
      expect(fk.rows).toEqual(before[1].rows);
    }, 30_000);
  },
);

// A generated TEXT bridge preserves the exact source spelling. PostgreSQL's
// UUID cast would normalize upper-case text, so an otherwise UUID-shaped but
// noncanonical source must refuse the entire connected conversion component.
describePostgres(
  'db:migrate-uuid refuses noncanonical generated bridge sources atomically (real Postgres)',
  () => {
    const stem = `mu_noncanonical_${Math.random().toString(36).slice(2, 8)}`;
    const parent = `${stem}_parent`;
    const child = `${stem}_child`;
    const junction = `${stem}_junction`;
    const bridgeIndex = `${parent}_bridge_uidx`;
    const childParentFk = `${child}_parent_fkey`;
    const junctionBridgeFk = `${junction}_bridge_fkey`;
    let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    async function snapshot(): Promise<Record<string, unknown>> {
      const db = await freshDb();
      const [data, columns, indexes, constraints] = await Promise.all([
        db.query(
          `SELECT 'parent' AS source, to_jsonb(parent) AS row FROM "${parent}" parent
           UNION ALL SELECT 'child', to_jsonb(child) FROM "${child}" child
           UNION ALL SELECT 'junction', to_jsonb(junction) FROM "${junction}" junction
           ORDER BY source`,
        ),
        db.query(
          `SELECT table_name, column_name, data_type, is_generated, generation_expression
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name IN ($1, $2, $3)
            ORDER BY table_name, ordinal_position`,
          parent,
          child,
          junction,
        ),
        db.query(
          `SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS definition
             FROM pg_index WHERE indexrelid = $1::regclass`,
          bridgeIndex,
        ),
        db.query(
          `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
             FROM pg_constraint
            WHERE conname IN ($1, $2)
            ORDER BY conname`,
          childParentFk,
          junctionBridgeFk,
        ),
      ]);
      return {
        data: data.rows,
        columns: columns.rows,
        indexes: indexes.rows,
        constraints: constraints.rows,
      };
    }

    beforeEach(async () => {
      const db = await freshDb();
      await db.query(
        `DROP TABLE IF EXISTS "${junction}", "${child}", "${parent}" CASCADE`,
      );
      await db.query(
        `CREATE TABLE "${parent}" (
           id text PRIMARY KEY,
           _integrity_id_text text GENERATED ALWAYS AS ((id)::text) STORED
         )`,
      );
      await db.query(
        `CREATE UNIQUE INDEX "${bridgeIndex}" ON "${parent}" (_integrity_id_text)`,
      );
      await db.query(
        `CREATE TABLE "${child}" (
           id text PRIMARY KEY,
           parent_id text NOT NULL CONSTRAINT "${childParentFk}"
             REFERENCES "${parent}"(id)
         )`,
      );
      await db.query(`CREATE TABLE "${junction}" (parent_text text NOT NULL)`);
      await db.query(
        `ALTER TABLE "${junction}" ADD CONSTRAINT "${junctionBridgeFk}"
           FOREIGN KEY (parent_text) REFERENCES "${parent}"(_integrity_id_text)`,
      );
      // This remains UUID-shaped under PostgreSQL's case-insensitive cast and
      // planning probe, but it cannot be normalized while TEXT consumers hold
      // the original spelling through the generated bridge.
      const noncanonicalId = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
      await db.query(
        `INSERT INTO "${parent}" (id) VALUES ($1)`,
        noncanonicalId,
      );
      await db.query(
        `INSERT INTO "${child}" (id, parent_id) VALUES ($1, $2)`,
        '22222222-2222-2222-2222-222222222222',
        noncanonicalId,
      );
      await db.query(
        `INSERT INTO "${junction}" (parent_text) VALUES ($1)`,
        noncanonicalId,
      );
      clearCache();
      setConfig({
        packages: {
          cli: {
            database: { type: 'postgres', url: process.env.DATABASE_URL },
          },
        },
      } as any);
      schemaSpy = vi
        .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
        .mockReturnValue({
          [parent]: {
            tableName: parent,
            ddl: '',
            columns: { id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [child]: {
            tableName: child,
            ddl: '',
            columns: { id: { type: 'UUID' }, parent_id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
        } as any);
    });

    afterEach(async () => {
      schemaSpy?.mockRestore();
      try {
        const db = await freshDb();
        await db.query(
          `DROP TABLE IF EXISTS "${junction}", "${child}", "${parent}" CASCADE`,
        );
      } catch {
        // Handler cleanup closes pooled handles; reacquire before teardown.
      }
      clearCache();
    });

    it('reports refusal and leaves data, TEXT columns, bridge index, and both FKs untouched', async () => {
      const before = await snapshot();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;

      await dbMigrateUuidCommand.handler([], {});

      const exitCode = process.exitCode;
      process.exitCode = undefined;
      logSpy.mockRestore();
      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Refusing ${parent}.id`),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('canonical lower-case UUID text'),
      );
      errorSpy.mockRestore();
      expect(await snapshot()).toEqual(before);
    }, 30_000);
  },
);

// Safety probe: these dependencies are not reconstructable by the narrow
// bridge snapshotter. A migration must reject before DROP COLUMN can make
// PostgreSQL silently remove a CHECK/UNIQUE constraint or an expression/predicate
// index, and before re-adding the bridge loses its explicit collation.
describePostgres(
  'db:migrate-uuid refuses generated bridges with unsupported catalog dependencies (real Postgres)',
  () => {
    const stem = `mu_bridge_catalog_${Math.random().toString(36).slice(2, 8)}`;
    const parent = `${stem}_parent`;
    const child = `${stem}_child`;
    const junction = `${stem}_junction`;
    const bridgeCheck = `${parent}_bridge_check`;
    const bridgeUnique = `${parent}_bridge_unique`;
    const bridgeExpressionIndex = `${parent}_bridge_expression_idx`;
    const bridgePartialIndex = `${parent}_bridge_partial_idx`;
    const childParentFk = `${child}_parent_fkey`;
    const junctionBridgeFk = `${junction}_bridge_fkey`;
    let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    async function snapshot(): Promise<Record<string, unknown>> {
      const db = await freshDb();
      const [data, columns, constraints, indexes] = await Promise.all([
        db.query(
          `SELECT 'parent' AS source, to_jsonb(parent) AS row FROM "${parent}" parent
           UNION ALL SELECT 'child', to_jsonb(child) FROM "${child}" child
           UNION ALL SELECT 'junction', to_jsonb(junction) FROM "${junction}" junction
           ORDER BY source`,
        ),
        db.query(
          `SELECT table_name, column_name, data_type, collation_name, is_generated, generation_expression
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name IN ($1, $2, $3)
            ORDER BY table_name, ordinal_position`,
          parent,
          child,
          junction,
        ),
        db.query(
          `SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
             FROM pg_constraint
            WHERE conname IN ($1, $2, $3, $4)
            ORDER BY conname`,
          bridgeCheck,
          bridgeUnique,
          childParentFk,
          junctionBridgeFk,
        ),
        db.query(
          `SELECT index_rel.relname AS name, pg_get_indexdef(idx.indexrelid) AS definition,
                  pg_get_expr(idx.indexprs, idx.indrelid) AS expressions,
                  pg_get_expr(idx.indpred, idx.indrelid) AS predicate
             FROM pg_index idx
             JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
            WHERE index_rel.relname IN ($1, $2)
            ORDER BY name`,
          bridgeExpressionIndex,
          bridgePartialIndex,
        ),
      ]);
      return {
        data: data.rows,
        columns: columns.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
      };
    }

    beforeEach(async () => {
      const db = await freshDb();
      await db.query(
        `DROP TABLE IF EXISTS "${junction}", "${child}", "${parent}" CASCADE`,
      );
      await db.query(
        `CREATE TABLE "${parent}" (
           id text PRIMARY KEY,
           _integrity_id_text text COLLATE "C" GENERATED ALWAYS AS ((id)::text) STORED,
           CONSTRAINT "${bridgeCheck}" CHECK (_integrity_id_text <> ''),
           CONSTRAINT "${bridgeUnique}" UNIQUE (_integrity_id_text)
         )`,
      );
      await db.query(
        `CREATE INDEX "${bridgeExpressionIndex}" ON "${parent}" (lower(_integrity_id_text))`,
      );
      await db.query(
        `CREATE INDEX "${bridgePartialIndex}" ON "${parent}" (id) WHERE _integrity_id_text <> ''`,
      );
      await db.query(
        `CREATE TABLE "${child}" (
           id text PRIMARY KEY,
           parent_id text NOT NULL CONSTRAINT "${childParentFk}" REFERENCES "${parent}"(id)
         )`,
      );
      await db.query(`CREATE TABLE "${junction}" (parent_text text NOT NULL)`);
      await db.query(
        `ALTER TABLE "${junction}" ADD CONSTRAINT "${junctionBridgeFk}"
           FOREIGN KEY (parent_text) REFERENCES "${parent}"(_integrity_id_text)`,
      );
      await db.query(
        `INSERT INTO "${parent}" (id) VALUES ($1)`,
        '11111111-1111-1111-1111-111111111111',
      );
      await db.query(
        `INSERT INTO "${child}" (id, parent_id) VALUES ($1, $2)`,
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
      );
      await db.query(
        `INSERT INTO "${junction}" (parent_text) VALUES ($1)`,
        '11111111-1111-1111-1111-111111111111',
      );
      clearCache();
      setConfig({
        packages: {
          cli: {
            database: { type: 'postgres', url: process.env.DATABASE_URL },
          },
        },
      } as any);
      schemaSpy = vi
        .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
        .mockReturnValue({
          [parent]: {
            tableName: parent,
            ddl: '',
            columns: { id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [child]: {
            tableName: child,
            ddl: '',
            columns: { id: { type: 'UUID' }, parent_id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
        } as any);
    });

    afterEach(async () => {
      schemaSpy?.mockRestore();
      try {
        const db = await freshDb();
        await db.query(
          `DROP TABLE IF EXISTS "${junction}", "${child}", "${parent}" CASCADE`,
        );
      } catch {
        // Handler cleanup closes pooled handles; reacquire before teardown.
      }
      clearCache();
    });

    it('rejects before writes and retains CHECK/UNIQUE/collation/expression-predicate metadata', async () => {
      const before = await snapshot();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;

      await dbMigrateUuidCommand.handler([], {});

      const exitCode = process.exitCode;
      process.exitCode = undefined;
      logSpy.mockRestore();
      const after = await snapshot();
      // Current production behavior is intentionally exercised before any fix:
      // this equality exposes every catalog object PostgreSQL dropped or changed.
      expect(after).toEqual(before);
      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported generated dependency'),
      );
      errorSpy.mockRestore();
    }, 30_000);
  },
);

describePostgres(
  'db:migrate-uuid rejects each unsupported generated bridge catalog shape (real Postgres)',
  () => {
    const scenarios = [
      {
        name: 'a bridge CHECK constraint',
        key: 'check',
        bridgeDefinition:
          'text GENERATED ALWAYS AS ((id)::text) STORED, CONSTRAINT "BRIDGE_CHECK" CHECK (_integrity_id_text <> \'\')',
      },
      {
        name: 'a bridge UNIQUE constraint',
        key: 'unique',
        bridgeDefinition:
          'text GENERATED ALWAYS AS ((id)::text) STORED, CONSTRAINT "BRIDGE_UNIQUE" UNIQUE (_integrity_id_text)',
      },
      {
        name: 'a nondefault bridge collation',
        key: 'collation',
        bridgeDefinition:
          'text COLLATE "C" GENERATED ALWAYS AS ((id)::text) STORED',
      },
      {
        name: 'an expression index that references the bridge',
        key: 'expression_index',
        bridgeDefinition: 'text GENERATED ALWAYS AS ((id)::text) STORED',
        indexSql:
          'CREATE INDEX "BRIDGE_EXPRESSION_IDX" ON "PARENT" (lower(_integrity_id_text))',
      },
      {
        name: 'a partial-index predicate that references the bridge',
        key: 'partial_index',
        bridgeDefinition: 'text GENERATED ALWAYS AS ((id)::text) STORED',
        indexSql:
          'CREATE INDEX "BRIDGE_PARTIAL_IDX" ON "PARENT" (id) WHERE _integrity_id_text <> \'\'',
      },
      {
        name: 'an extended-statistics dependency on the bridge',
        key: 'statistics',
        bridgeDefinition: 'text GENERATED ALWAYS AS ((id)::text) STORED',
        statisticsSql:
          'CREATE STATISTICS "BRIDGE_STATISTICS" (dependencies) ON id, _integrity_id_text FROM "PARENT"',
      },
      {
        name: 'a foreign key with nondefault trigger enforcement',
        key: 'always_trigger',
        bridgeDefinition: 'text GENERATED ALWAYS AS ((id)::text) STORED',
        foreignKeyTriggerSql:
          "DO $$ DECLARE trigger_name text; BEGIN SELECT tgname INTO trigger_name FROM pg_trigger WHERE tgrelid = 'CHILD'::regclass AND tgconstraint <> 0 LIMIT 1; EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', 'CHILD', trigger_name); END $$",
      },
    ] as const;

    it.each(scenarios)('rejects $name before writes', async (scenario) => {
      const stem = `mu_bridge_reject_${scenario.key}_${Math.random().toString(36).slice(2, 8)}`;
      const parent = `${stem}_parent`;
      const child = `${stem}_child`;
      const childParentFk = `${child}_parent_fkey`;
      const checkName = `${parent}_bridge_check`;
      const uniqueName = `${parent}_bridge_unique`;
      const expressionIndex = `${parent}_bridge_expression_idx`;
      const partialIndex = `${parent}_bridge_partial_idx`;
      const statisticsName = `${parent}_bridge_statistics`;
      const bridgeDefinition = scenario.bridgeDefinition
        .replace('BRIDGE_CHECK', checkName)
        .replace('BRIDGE_UNIQUE', uniqueName);
      const indexSql = scenario.indexSql
        ?.replace('BRIDGE_EXPRESSION_IDX', expressionIndex)
        .replace('BRIDGE_PARTIAL_IDX', partialIndex)
        .replace('PARENT', parent);
      const statisticsSql = scenario.statisticsSql
        ?.replace('BRIDGE_STATISTICS', statisticsName)
        .replace('PARENT', parent);
      const foreignKeyTriggerSql = scenario.foreignKeyTriggerSql?.replaceAll(
        'CHILD',
        child,
      );

      async function db(): Promise<any> {
        return getDatabase({
          type: 'postgres',
          url: process.env.DATABASE_URL as string,
        });
      }

      async function snapshot(): Promise<Record<string, unknown>> {
        const connection = await db();
        const [data, columns, constraints, indexes, statistics] =
          await Promise.all([
            connection.query(
              `SELECT 'parent' AS source, to_jsonb(parent) AS row FROM "${parent}" parent
               UNION ALL SELECT 'child', to_jsonb(child) FROM "${child}" child
               ORDER BY source`,
            ),
            connection.query(
              `SELECT table_name, column_name, data_type, collation_name, is_generated, generation_expression
                 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name IN ($1, $2)
                ORDER BY table_name, ordinal_position`,
              parent,
              child,
            ),
            connection.query(
              `SELECT rel.relname AS table_name, conname, contype, convalidated,
                      pg_get_constraintdef(con.oid) AS definition
                 FROM pg_constraint con
                 JOIN pg_class rel ON rel.oid = con.conrelid
                WHERE rel.relname IN ($1, $2)
                ORDER BY table_name, conname`,
              parent,
              child,
            ),
            connection.query(
              `SELECT index_rel.relname AS name, pg_get_indexdef(idx.indexrelid) AS definition,
                      pg_get_expr(idx.indexprs, idx.indrelid) AS expressions,
                      pg_get_expr(idx.indpred, idx.indrelid) AS predicate
                 FROM pg_index idx
                 JOIN pg_class table_rel ON table_rel.oid = idx.indrelid
                 JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
                WHERE table_rel.relname = $1
                ORDER BY name`,
              parent,
            ),
            connection.query(
              `SELECT stxname, stxkeys::text AS keys
                 FROM pg_statistic_ext
                WHERE stxname = $1`,
              statisticsName,
            ),
          ]);
        return {
          data: data.rows,
          columns: columns.rows,
          constraints: constraints.rows,
          indexes: indexes.rows,
          statistics: statistics.rows,
        };
      }

      const connection = await db();
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await connection.query(
          `CREATE TABLE "${parent}" (
               id text PRIMARY KEY,
               _integrity_id_text ${bridgeDefinition}
             )`,
        );
        if (indexSql) await connection.query(indexSql);
        if (statisticsSql) await connection.query(statisticsSql);
        await connection.query(
          `CREATE TABLE "${child}" (
               id text PRIMARY KEY,
               parent_id text NOT NULL CONSTRAINT "${childParentFk}" REFERENCES "${parent}"(id)
             )`,
        );
        await connection.query(
          `INSERT INTO "${parent}" (id) VALUES ($1)`,
          '11111111-1111-1111-1111-111111111111',
        );
        await connection.query(
          `INSERT INTO "${child}" (id, parent_id) VALUES ($1, $2)`,
          '22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111',
        );
        if (foreignKeyTriggerSql) await connection.query(foreignKeyTriggerSql);
        clearCache();
        setConfig({
          packages: {
            cli: {
              database: { type: 'postgres', url: process.env.DATABASE_URL },
            },
          },
        } as any);
        schemaSpy = vi
          .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
          .mockReturnValue({
            [parent]: {
              tableName: parent,
              ddl: '',
              columns: { id: { type: 'UUID' } },
              indexes: [],
              triggers: [],
              foreignKeys: [],
              version: '',
              dependencies: [],
            },
            [child]: {
              tableName: child,
              ddl: '',
              columns: {
                id: { type: 'UUID' },
                parent_id: { type: 'UUID' },
              },
              indexes: [],
              triggers: [],
              foreignKeys: [],
              version: '',
              dependencies: [],
            },
          } as any);
        const before = await snapshot();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        process.exitCode = undefined;

        await dbMigrateUuidCommand.handler([], {});

        const exitCode = process.exitCode;
        process.exitCode = undefined;
        logSpy.mockRestore();
        expect(await snapshot()).toEqual(before);
        expect(exitCode).toBe(1);
        expect(errorSpy.mock.calls.flat().join('\n')).toContain('Unsupported');
        errorSpy.mockRestore();
      } finally {
        schemaSpy?.mockRestore();
        clearCache();
        const cleanup = await db();
        await cleanup.query(
          `DROP TABLE IF EXISTS "${child}", "${parent}" CASCADE`,
        );
      }
    }, 30_000);
  },
);

describePostgres(
  'db:migrate-uuid fixes only public tables under a shadow-first search_path (real Postgres)',
  () => {
    const stem = `mu_shadow_${Math.random().toString(36).slice(2, 8)}`;
    const shadowSchema = `${stem}_schema`;
    const parent = `${stem}_parent`;
    const child = `${stem}_child`;
    const bridgeIndex = `${parent}_bridge_uidx`;
    const publicBridgeComment = 'public generated bridge index';
    const shadowBridgeComment = 'shadow generated bridge index';
    const publicFk = `${child}_parent_fkey`;
    const shadowFk = `${child}_shadow_parent_fkey`;

    async function baseDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    function handlerUrl(): string {
      const url = new URL(process.env.DATABASE_URL as string);
      url.searchParams.set('options', `-c search_path=${shadowSchema},public`);
      return url.toString();
    }

    async function snapshot(): Promise<Record<string, unknown>> {
      const db = await baseDb();
      const [data, columns, foreignKeys, indexes] = await Promise.all([
        db.query(
          `SELECT 'public_parent' AS source, to_jsonb(parent) AS row FROM public."${parent}" parent
           UNION ALL SELECT 'public_child', to_jsonb(child) FROM public."${child}" child
           UNION ALL SELECT 'shadow_parent', to_jsonb(parent) FROM "${shadowSchema}"."${parent}" parent
           UNION ALL SELECT 'shadow_child', to_jsonb(child) FROM "${shadowSchema}"."${child}" child
           ORDER BY source`,
        ),
        db.query(
          `SELECT table_schema, table_name, column_name, data_type
             FROM information_schema.columns
            WHERE table_schema IN ('public', $1) AND table_name IN ($2, $3)
            ORDER BY table_schema, table_name, ordinal_position`,
          shadowSchema,
          parent,
          child,
        ),
        db.query(
          `SELECT child_ns.nspname AS child_schema, child.relname AS child_table,
                  con.conname, parent_ns.nspname AS parent_schema, parent.relname AS parent_table,
                  pg_get_constraintdef(con.oid) AS definition
             FROM pg_constraint con
             JOIN pg_class child ON child.oid = con.conrelid
             JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
             JOIN pg_class parent ON parent.oid = con.confrelid
             JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
            WHERE con.contype = 'f' AND child_ns.nspname IN ('public', $1)
              AND child.relname = $2
            ORDER BY child_schema, con.conname`,
          shadowSchema,
          child,
        ),
        db.query(
          `SELECT table_ns.nspname AS table_schema, index_rel.relname AS index_name,
                  pg_get_indexdef(idx.indexrelid) AS definition,
                  obj_description(idx.indexrelid, 'pg_class') AS comment
             FROM pg_index idx
             JOIN pg_class table_rel ON table_rel.oid = idx.indrelid
             JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
             JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
            WHERE table_ns.nspname IN ('public', $1) AND table_rel.relname = $2
              AND index_rel.relname = $3
            ORDER BY table_schema, index_name`,
          shadowSchema,
          parent,
          bridgeIndex,
        ),
      ]);
      return {
        data: data.rows,
        columns: columns.rows,
        foreignKeys: foreignKeys.rows,
        indexes: indexes.rows,
      };
    }

    beforeEach(async () => {
      const db = await baseDb();
      await db.query(`DROP SCHEMA IF EXISTS "${shadowSchema}" CASCADE`);
      await db.query(
        `DROP TABLE IF EXISTS public."${child}", public."${parent}" CASCADE`,
      );
      await db.query(`CREATE SCHEMA "${shadowSchema}"`);
      await db.query(
        `CREATE TABLE public."${parent}" (
           id text PRIMARY KEY,
           old_ref text NOT NULL,
           new_ref text,
           _integrity_id_text text GENERATED ALWAYS AS ((id)::text) STORED
         )`,
      );
      await db.query(
        `CREATE UNIQUE INDEX "${bridgeIndex}" ON public."${parent}" (_integrity_id_text)`,
      );
      await db.query(
        `COMMENT ON INDEX public."${bridgeIndex}" IS '${publicBridgeComment}'`,
      );
      await db.query(
        `CREATE TABLE public."${child}" (
           id text PRIMARY KEY,
           parent_id text NOT NULL CONSTRAINT "${publicFk}" REFERENCES public."${parent}"(id)
         )`,
      );
      await db.query(
        `CREATE TABLE "${shadowSchema}"."${parent}" (
           id text PRIMARY KEY,
           old_ref text NOT NULL,
           new_ref text,
           _integrity_id_text text GENERATED ALWAYS AS ((id)::text) STORED
         )`,
      );
      await db.query(
        `CREATE UNIQUE INDEX "${bridgeIndex}" ON "${shadowSchema}"."${parent}" (_integrity_id_text)`,
      );
      await db.query(
        `COMMENT ON INDEX "${shadowSchema}"."${bridgeIndex}" IS '${shadowBridgeComment}'`,
      );
      await db.query(
        `CREATE TABLE "${shadowSchema}"."${child}" (
           id text PRIMARY KEY,
           parent_id text NOT NULL CONSTRAINT "${shadowFk}" REFERENCES "${shadowSchema}"."${parent}"(id)
         )`,
      );
      await db.query(
        `INSERT INTO public."${parent}" (id, old_ref) VALUES ($1, $2)`,
        '11111111-1111-1111-1111-111111111111',
        'public-rename',
      );
      await db.query(
        `INSERT INTO public."${child}" (id, parent_id) VALUES ($1, $2)`,
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
      );
      await db.query(
        `INSERT INTO "${shadowSchema}"."${parent}" (id, old_ref) VALUES ($1, $2)`,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'shadow-rename',
      );
      await db.query(
        `INSERT INTO "${shadowSchema}"."${child}" (id, parent_id) VALUES ($1, $2)`,
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      );
      clearCache();
      setConfig({
        packages: {
          cli: { database: { type: 'postgres', url: handlerUrl() } },
        },
      } as any);
    });

    afterEach(async () => {
      try {
        const db = await baseDb();
        await db.query(`DROP SCHEMA IF EXISTS "${shadowSchema}" CASCADE`);
        await db.query(
          `DROP TABLE IF EXISTS public."${child}", public."${parent}" CASCADE`,
        );
      } catch {
        // The handler closes its pool; teardown reacquires a base connection.
      }
      clearCache();
    });

    it('converts and renames the public component while leaving same-named shadow tables untouched', async () => {
      const session = await getDatabase({
        type: 'postgres',
        url: handlerUrl(),
      });
      const searchPath = await session.query('SHOW search_path');
      expect((searchPath.rows as any[])[0].search_path).toContain(
        `${shadowSchema},public`,
      );
      const schemaSpy = vi
        .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
        .mockReturnValue({
          [parent]: {
            tableName: parent,
            ddl: '',
            columns: { id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [child]: {
            tableName: child,
            ddl: '',
            columns: { id: { type: 'UUID' }, parent_id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
        } as any);
      const before = await snapshot();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dbMigrateUuidCommand.handler([], {
        rename: `${parent}.old_ref:new_ref`,
      });

      expect(errorSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      schemaSpy.mockRestore();
      const after = await snapshot();
      const shadowBefore = {
        data: (before.data as any[]).filter((row) =>
          row.source.startsWith('shadow_'),
        ),
        columns: (before.columns as any[]).filter(
          (row) => row.table_schema === shadowSchema,
        ),
        foreignKeys: (before.foreignKeys as any[]).filter(
          (row) => row.child_schema === shadowSchema,
        ),
        indexes: (before.indexes as any[]).filter(
          (row) => row.table_schema === shadowSchema,
        ),
      };
      const shadowAfter = {
        data: (after.data as any[]).filter((row) =>
          row.source.startsWith('shadow_'),
        ),
        columns: (after.columns as any[]).filter(
          (row) => row.table_schema === shadowSchema,
        ),
        foreignKeys: (after.foreignKeys as any[]).filter(
          (row) => row.child_schema === shadowSchema,
        ),
        indexes: (after.indexes as any[]).filter(
          (row) => row.table_schema === shadowSchema,
        ),
      };
      expect(shadowAfter).toEqual(shadowBefore);
      expect(
        (after.columns as any[])
          .filter(
            (row) =>
              row.table_schema === 'public' &&
              ['id', 'parent_id'].includes(row.column_name),
          )
          .every((row) => row.data_type === 'uuid'),
      ).toBe(true);
      expect(
        (after.columns as any[]).some(
          (row) =>
            row.table_schema === 'public' && row.column_name === 'old_ref',
        ),
      ).toBe(false);
      expect(
        (after.data as any[]).find((row) => row.source === 'public_parent'),
      ).toEqual({
        source: 'public_parent',
        row: {
          id: '11111111-1111-1111-1111-111111111111',
          new_ref: 'public-rename',
          _integrity_id_text: '11111111-1111-1111-1111-111111111111',
        },
      });
      expect(
        (after.foreignKeys as any[]).find(
          (row) => row.child_schema === 'public',
        ),
      ).toMatchObject({
        conname: publicFk,
        parent_schema: 'public',
        parent_table: parent,
      });
      expect(
        (after.indexes as any[]).find(
          (row) =>
            row.table_schema === 'public' && row.index_name === bridgeIndex,
        ),
      ).toMatchObject({ comment: publicBridgeComment });
    }, 30_000);
  },
);
