import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeclaredUuidColumnSet,
  dbMigrateUuidCommand,
  type LiveTextColumn,
  parseRenameSpecs,
  planUuidConversions,
} from '../db-migrate-uuid.js';
import { utilityCommands } from '../utilities.js';

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
