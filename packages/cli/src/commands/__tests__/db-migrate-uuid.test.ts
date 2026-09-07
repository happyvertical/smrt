import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMigrateAgentScheduleSlugsCommand } from '../db-migrate-agent-schedule-slugs.js';
import { dbMigrateInt8Command } from '../db-migrate-int8.js';
import {
  buildDeclaredUuidColumnSet,
  dbMigrateUuidCommand,
  type ForeignKeyEdge,
  type LiveTextColumn,
  parseRenameSpecs,
  planUuidConversions,
  propagateBlockedForeignKeyPartners,
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

    it('skips a declared-UUID column whose values normalize to duplicate uuids', () => {
      const live: LiveTextColumn[] = [
        {
          table: 'things',
          column: 'id',
          hasDefault: false,
          nonUuid: 0,
          duplicateNormalized: 1,
        },
      ];
      const plan = planUuidConversions(live, declared);
      expect(plan.convert).toEqual([]);
      expect(plan.skipDirtyData).toEqual([
        { table: 'things', column: 'id', nonUuid: 0, duplicateNormalized: 1 },
      ]);
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

  describe('propagateBlockedForeignKeyPartners', () => {
    it('blocks a convertible column whose FK partner is skipped for dirty data', () => {
      const plan = planUuidConversions(
        [
          { table: 'parent', column: 'id', hasDefault: false, nonUuid: 1 },
          {
            table: 'child',
            column: 'parent_id',
            hasDefault: false,
            nonUuid: 0,
          },
        ],
        new Set(['parent|id', 'child|parent_id']),
      );
      const edges: ForeignKeyEdge[] = [
        {
          name: 'child_parent_fkey',
          childTable: 'child',
          childColumn: 'parent_id',
          parentTable: 'parent',
          parentColumn: 'id',
        },
      ];

      const result = propagateBlockedForeignKeyPartners(plan, edges);

      expect(result.convert).toEqual([]);
      expect(
        result.skipBlockedPartner?.map((c) => `${c.table}.${c.column}`),
      ).toEqual(['child.parent_id']);
      expect(result.skipBlockedPartner?.[0]?.reason).toContain(
        'child_parent_fkey',
      );
    });

    it('blocks a convertible column whose FK partner the schema keeps TEXT', () => {
      const plan = planUuidConversions(
        [
          { table: 'parent', column: 'id', hasDefault: false, nonUuid: 0 },
          {
            table: 'child',
            column: 'parent_id',
            hasDefault: false,
            nonUuid: 0,
          },
        ],
        // parent.id is NOT declared UUID.
        new Set(['child|parent_id']),
      );
      const edges: ForeignKeyEdge[] = [
        {
          name: 'child_parent_fkey',
          childTable: 'child',
          childColumn: 'parent_id',
          parentTable: 'parent',
          parentColumn: 'id',
        },
      ];

      const result = propagateBlockedForeignKeyPartners(plan, edges);

      expect(result.convert).toEqual([]);
      expect(
        result.skipBlockedPartner?.map((c) => `${c.table}.${c.column}`),
      ).toEqual(['child.parent_id']);
      expect(result.skipBlockedPartner?.[0]?.reason).toContain(
        'not schema-declared UUID',
      );
    });

    it('propagates the block transitively across a two-hop chain', () => {
      const plan = planUuidConversions(
        [
          { table: 'gp', column: 'id', hasDefault: false, nonUuid: 0 },
          { table: 'p', column: 'id', hasDefault: false, nonUuid: 0 },
          { table: 'c', column: 'parent_id', hasDefault: false, nonUuid: 0 },
          { table: 'c', column: 'id', hasDefault: false, nonUuid: 0 },
        ],
        // gp.id is NOT declared UUID; everything else is.
        new Set(['p|id', 'c|parent_id', 'c|id']),
      );
      const edges: ForeignKeyEdge[] = [
        {
          name: 'p_gp_fkey',
          childTable: 'p',
          childColumn: 'id',
          parentTable: 'gp',
          parentColumn: 'id',
        },
        {
          name: 'c_parent_fkey',
          childTable: 'c',
          childColumn: 'parent_id',
          parentTable: 'p',
          parentColumn: 'id',
        },
      ];

      const result = propagateBlockedForeignKeyPartners(plan, edges);

      expect(result.convert.map((c) => `${c.table}.${c.column}`)).toEqual([
        'c.id',
      ]);
      expect(
        result.skipBlockedPartner?.map((c) => `${c.table}.${c.column}`).sort(),
      ).toEqual(['c.parent_id', 'p.id']);
    });

    it('leaves the plan unchanged when every FK partner also converts', () => {
      const plan = planUuidConversions(
        [
          { table: 'parent', column: 'id', hasDefault: false, nonUuid: 0 },
          {
            table: 'child',
            column: 'parent_id',
            hasDefault: false,
            nonUuid: 0,
          },
        ],
        new Set(['parent|id', 'child|parent_id']),
      );
      const edges: ForeignKeyEdge[] = [
        {
          name: 'child_parent_fkey',
          childTable: 'child',
          childColumn: 'parent_id',
          parentTable: 'parent',
          parentColumn: 'id',
        },
      ];

      const result = propagateBlockedForeignKeyPartners(plan, edges);

      expect(
        result.convert.map((c) => `${c.table}.${c.column}`).sort(),
      ).toEqual(['child.parent_id', 'parent.id']);
      expect(result.skipBlockedPartner).toEqual([]);
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

describe('db:migrate-agent-schedule-slugs command', () => {
  it('is registered as an explicit dry-run-capable repair', () => {
    expect(utilityCommands['db:migrate-agent-schedule-slugs']).toBe(
      dbMigrateAgentScheduleSlugsCommand,
    );
    expect(dbMigrateAgentScheduleSlugsCommand.aliases).toContain(
      'migrate-agent-schedule-slugs',
    );
    expect(
      dbMigrateAgentScheduleSlugsCommand.options?.['dry-run'],
    ).toBeDefined();
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
              old_ref: { type: 'UUID' },
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

    it('does not report a completed dry run before a successful rename+convert run mutates', async () => {
      const db = await freshDb();
      await db.query(`DROP VIEW "${viewName}"`);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dbMigrateUuidCommand.handler([], {
        rename: 'old_ref:parent_id',
        table: tableName,
      });

      const output = logSpy.mock.calls.flat().join('\n');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(output).not.toContain('Dry run complete — no changes applied');
      expect(output).toContain('✓ Converted 3 column(s) to uuid.');
      expect(await columnExists('old_ref')).toBe(false);
      expect(await dataType('parent_id')).toBe('uuid');
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }, 30_000);

    it('projects dropped rename sources out of the rename+convert dry-run plan', async () => {
      const db = await freshDb();
      await db.query(`DROP VIEW "${viewName}"`);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dbMigrateUuidCommand.handler([], {
        'dry-run': true,
        rename: 'old_ref:parent_id',
        table: tableName,
      });

      const output = logSpy.mock.calls.flat().join('\n');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(output).toContain(
        `ALTER TABLE "public"."${tableName}" DROP COLUMN "old_ref";`,
      );
      expect(output).toContain(
        `ALTER TABLE "public"."${tableName}" ALTER COLUMN "parent_id" TYPE uuid`,
      );
      expect(output).not.toContain(
        `ALTER TABLE "public"."${tableName}" ALTER COLUMN "old_ref" TYPE uuid`,
      );
      expect(await columnExists('old_ref')).toBe(true);
      expect(await dataType('parent_id')).toBe('text');
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }, 30_000);

    it('projects dirty values copied into an empty rename destination as a dry-run skip', async () => {
      const db = await freshDb();
      await db.query(`DROP VIEW "${viewName}"`);
      await db.query(`UPDATE "${tableName}" SET old_ref = 'dirty-source'`);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await dbMigrateUuidCommand.handler([], {
        'dry-run': true,
        rename: 'old_ref:parent_id',
        table: tableName,
      });
      const output = logSpy.mock.calls.flat().join('\n');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(output).toContain(`SKIP ${tableName}.parent_id: 1 non-uuid`);
      expect(output).not.toContain(`ALTER COLUMN "parent_id" TYPE uuid`);
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }, 30_000);

    it('does not project a dirty rename source over an already populated destination', async () => {
      const db = await freshDb();
      await db.query(`DROP VIEW "${viewName}"`);
      await db.query(
        `UPDATE "${tableName}" SET old_ref = 'dirty-source', parent_id = '22222222-2222-2222-2222-222222222222'`,
      );
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await dbMigrateUuidCommand.handler([], {
        'dry-run': true,
        rename: 'old_ref:parent_id',
        table: tableName,
      });
      const output = logSpy.mock.calls.flat().join('\n');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(output).toContain(`ALTER COLUMN "parent_id" TYPE uuid`);
      expect(output).not.toContain(`SKIP ${tableName}.parent_id:`);
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }, 30_000);

    it('skips an already-dropped rename source during dry-run projection', async () => {
      const db = await freshDb();
      await db.query(`DROP VIEW "${viewName}"`);
      await db.query(`ALTER TABLE "${tableName}" DROP COLUMN old_ref`);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await dbMigrateUuidCommand.handler([], {
        'dry-run': true,
        rename: 'old_ref:parent_id',
        table: tableName,
      });
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    }, 30_000);
  },
);

describePostgres('db:migrate-uuid inheritance race (real Postgres)', () => {
  const stem = `mu_inherit_race_${Math.random().toString(36).slice(2, 8)}`;
  const parent = `${stem}_parent`;
  const child = `${stem}_child`;
  let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

  async function freshDb(): Promise<any> {
    return getDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL as string,
    });
  }

  async function snapshot() {
    const db = await freshDb();
    const { rows: columns } = await db.query(
      `SELECT table_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ($1, $2)
            AND column_name = 'id' ORDER BY table_name`,
      parent,
      child,
    );
    const { rows: parentRows } = await db.query(
      `SELECT id::text AS id FROM ONLY "${parent}" ORDER BY id`,
    );
    const { rows: childRows } = await db.query(
      `SELECT id::text AS id FROM "${child}" ORDER BY id`,
    );
    return { childRows, columns, parentRows };
  }

  beforeEach(async () => {
    const db = await freshDb();
    await db.query(`DROP TABLE IF EXISTS "${child}"`);
    await db.query(`DROP TABLE IF EXISTS "${parent}"`);
    await db.query(`CREATE TABLE "${parent}" (id text PRIMARY KEY)`);
    await db.query(`CREATE TABLE "${child}" (id text PRIMARY KEY)`);
    await db.query(
      `INSERT INTO "${parent}" (id) VALUES ('11111111-1111-1111-1111-111111111111')`,
    );
    await db.query(
      `INSERT INTO "${child}" (id) VALUES ('22222222-2222-2222-2222-222222222222')`,
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
          columns: { id: { type: 'UUID', primaryKey: true } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: '',
          dependencies: [],
        },
      } as any);
  });

  afterEach(async () => {
    sqlTestHarness.interceptor = undefined;
    schemaSpy?.mockRestore();
    try {
      const db = await freshDb();
      await db.query(`DROP TABLE IF EXISTS "${child}"`);
      await db.query(`DROP TABLE IF EXISTS "${parent}"`);
    } catch {
      // The command closes its pool; teardown reacquires a handle.
    }
    clearCache();
  });

  it('refuses an undeclared child attached after preflight and before the first lock', async () => {
    const before = await snapshot();
    let inherited = false;
    let externalBackendPid: number | undefined;
    let migrationBackendPid: number | undefined;
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
                        const sql = String(queryArgs[0]);
                        if (!inherited && /^LOCK TABLE /i.test(sql)) {
                          inherited = true;
                          const externalUrl = new URL(
                            process.env.DATABASE_URL as string,
                          );
                          externalUrl.searchParams.set(
                            'application_name',
                            'smrt-uuid-inheritance-race',
                          );
                          const external: any =
                            await sqlTestHarness.realGetDatabase({
                              type: 'postgres',
                              url: externalUrl.toString(),
                            });
                          const { rows: externalPids } = await external.query(
                            'SELECT pg_backend_pid() AS backend_pid',
                          );
                          externalBackendPid = Number(
                            (externalPids as any[])[0].backend_pid,
                          );
                          try {
                            await external.query(
                              `ALTER TABLE "${child}" INHERIT "${parent}"`,
                            );
                          } finally {
                            const close =
                              external.close ?? external.client?.end;
                            if (typeof close === 'function')
                              await close.call(
                                external.close ? external : external.client,
                              );
                          }
                        }
                        if (
                          migrationBackendPid === undefined &&
                          /^LOCK TABLE /i.test(sql)
                        ) {
                          const { rows: migrationPids } =
                            await transactionTarget.query(
                              'SELECT pg_backend_pid() AS backend_pid',
                            );
                          migrationBackendPid = Number(
                            (migrationPids as any[])[0].backend_pid,
                          );
                        }
                        return transactionTarget.query(...queryArgs);
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

    await dbMigrateUuidCommand.handler([], {});

    const exitCode = process.exitCode;
    process.exitCode = undefined;
    logSpy.mockRestore();
    expect(inherited).toBe(true);
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unsupported table shape'),
    );
    errorSpy.mockRestore();
    expect(externalBackendPid).toBeTypeOf('number');
    expect(migrationBackendPid).toBeTypeOf('number');
    expect(externalBackendPid).not.toBe(migrationBackendPid);
    expect(await snapshot()).toEqual(before);
  }, 30_000);
});

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
        `ALTER TABLE "${parent}" ALTER COLUMN _integrity_id_text SET STATISTICS 777`,
      );
      await db.query(
        `ALTER TABLE "${parent}" ALTER COLUMN _integrity_id_text SET COMPRESSION pglz`,
      );
      await db.query(
        `CREATE UNIQUE INDEX "${parent}_bridge_uidx" ON "${parent}" USING btree (_integrity_id_text)`,
      );
      await db.query(
        `COMMENT ON INDEX "${parent}_bridge_uidx" IS 'generated bridge index'`,
      );
      await db.query(
        `ALTER TABLE "${parent}" CLUSTER ON "${parent}_bridge_uidx"`,
      );
      await db.query(
        `CREATE UNIQUE INDEX "${parent}_replica_uidx" ON "${parent}" (id) INCLUDE (_integrity_id_text)`,
      );
      await db.query(
        `ALTER TABLE "${parent}" REPLICA IDENTITY USING INDEX "${parent}_replica_uidx"`,
      );
      await db.query(
        `CREATE TABLE "${child}" (id text PRIMARY KEY, parent_id text NOT NULL CONSTRAINT "${child}_parent_fkey" REFERENCES "${parent}"(id) ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.query(
        `COMMENT ON CONSTRAINT "${child}_parent_fkey" ON "${child}" IS 'generated bridge inbound FK'`,
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
      const { rows: bridgeAttributes } = await db.query(
        `SELECT attstattarget AS statistics_target, attcompression AS compression
           FROM pg_attribute attribute
           JOIN pg_class relation ON relation.oid = attribute.attrelid
          WHERE relation.relname = $1 AND attribute.attname = '_integrity_id_text'`,
        parent,
      );
      expect(bridgeAttributes).toEqual([
        { statistics_target: 777, compression: 'p' },
      ]);
      const { rows: bridgeIndex } = await db.query(
        `SELECT index_rel.relname AS name, idx.indisclustered AS clustered,
                idx.indisreplident AS replica_identity
           FROM pg_index idx
           JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
          WHERE index_rel.relname IN ($1, $2)
          ORDER BY index_rel.relname`,
        `${parent}_bridge_uidx`,
        `${parent}_replica_uidx`,
      );
      expect(bridgeIndex).toEqual([
        {
          name: `${parent}_bridge_uidx`,
          clustered: true,
          replica_identity: false,
        },
        {
          name: `${parent}_replica_uidx`,
          clustered: false,
          replica_identity: true,
        },
      ]);
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

    it('restores both generated bridges before recreating a shared INCLUDE index once', async () => {
      const db = await freshDb();
      await db.query(
        `ALTER TABLE "${parent}" ADD COLUMN bridge_b text GENERATED ALWAYS AS (id) STORED`,
      );
      const indexName = `${parent}_shared_idx`;
      await db.query(
        `CREATE INDEX "${indexName}" ON "${parent}" (_integrity_id_text) INCLUDE (bridge_b)`,
      );
      await db.query(
        `COMMENT ON INDEX "${indexName}" IS 'shared bridge index'`,
      );
      const snapshot = async () =>
        (
          await (
            await freshDb()
          ).query(
            `SELECT pg_get_indexdef(c.oid) AS definition, obj_description(c.oid, 'pg_class') AS comment
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = $1`,
            indexName,
          )
        ).rows;
      const before = await snapshot();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await dbMigrateUuidCommand.handler([], { 'dry-run': true });
        expect(errorSpy).not.toHaveBeenCalled();
        const statements = logSpy.mock.calls.flat().map(String);
        const creates = statements.filter(
          (line) => line.includes('CREATE INDEX') && line.includes(indexName),
        );
        expect(creates).toHaveLength(1);
        const output = statements.join('\n');
        expect(output.indexOf('ADD COLUMN "bridge_b"')).toBeLessThan(
          output.indexOf(creates[0]),
        );
        expect(output.indexOf('ADD COLUMN "_integrity_id_text"')).toBeLessThan(
          output.indexOf(creates[0]),
        );
        await dbMigrateUuidCommand.handler([], {});
        expect(errorSpy).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
        const { rows } = await (await freshDb()).query(
          `SELECT id::text AS id, _integrity_id_text, bridge_b FROM "${parent}"`,
        );
        expect(rows).toEqual([
          {
            id: '11111111-1111-1111-1111-111111111111',
            _integrity_id_text: '11111111-1111-1111-1111-111111111111',
            bridge_b: '11111111-1111-1111-1111-111111111111',
          },
        ]);
        await dbMigrateUuidCommand.handler([], {});
        expect(errorSpy).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    }, 30_000);

    it('renders every bridge restoration statement in the dry-run plan', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dbMigrateUuidCommand.handler([], { 'dry-run': true });

      expect(errorSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('COMMENT ON INDEX "public"."');
      expect(output).toContain('generated bridge index');
      expect(output).toContain(
        `COMMENT ON CONSTRAINT "${child}_parent_fkey" ON "public"."${child}" IS 'generated bridge inbound FK';`,
      );
      expect(output).toContain('SET STATISTICS 777');
      expect(output).toContain('SET COMPRESSION pglz');
      expect(output).toContain(`CLUSTER ON "${parent}_bridge_uidx"`);
      expect(output).toContain(
        `REPLICA IDENTITY USING INDEX "${parent}_replica_uidx"`,
      );
      expect(output.indexOf(`${parent}_bridge_uidx`)).toBeLessThan(
        output.indexOf(`${parent}_replica_uidx`),
      );
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }, 30_000);

    it('preserves the server-default statistics target across PostgreSQL versions', async () => {
      const db = await freshDb();
      await db.query(
        `ALTER TABLE "${parent}" ALTER COLUMN _integrity_id_text SET STATISTICS -1`,
      );
      const before = await db.query(
        `SELECT attstattarget FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid WHERE relation.relname = $1 AND attribute.attname = '_integrity_id_text'`,
        parent,
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dbMigrateUuidCommand.handler([], {});

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
      const after = await freshDb();
      const restored = await after.query(
        `SELECT attstattarget FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid WHERE relation.relname = $1 AND attribute.attname = '_integrity_id_text'`,
        parent,
      );
      expect(restored.rows).toEqual(before.rows);
    }, 30_000);

    it('leaves an unrelated stored generated column on a converted table intact', async () => {
      const db = await freshDb();
      await db.query(
        `ALTER TABLE "${parent}" ADD COLUMN title text NOT NULL DEFAULT 'Title'`,
      );
      await db.query(
        `ALTER TABLE "${parent}" ADD COLUMN title_lower text GENERATED ALWAYS AS (lower(title)) STORED`,
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dbMigrateUuidCommand.handler([], {});

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
      const after = await freshDb();
      const { rows } = await after.query(
        `SELECT data_type, is_generated FROM information_schema.columns WHERE table_name = $1 AND column_name = 'title_lower'`,
        parent,
      );
      expect(rows).toEqual([{ data_type: 'text', is_generated: 'ALWAYS' }]);
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
           id text PRIMARY KEY DEFAULT '11111111-1111-1111-1111-111111111111',
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

    it.each([
      { name: '--skip-convert', options: { 'skip-convert': true } },
      { name: 'an empty declared manifest', options: {} },
    ])('pins and rolls back a late rename-only failure for $name', async ({
      options,
    }) => {
      const before = await snapshot();
      const callbackPids: number[] = [];
      let injected = false;
      if (Object.keys(options).length === 0)
        schemaSpy?.mockReturnValue({} as any);
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
                            /^ALTER TABLE .* DROP COLUMN /i.test(sql)
                          ) {
                            injected = true;
                            throw new Error(
                              'injected late failure after rename-only DROP COLUMN',
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
        ...options,
      });

      const exitCode = process.exitCode;
      process.exitCode = undefined;
      sqlTestHarness.interceptor = undefined;
      logSpy.mockRestore();
      expect(injected).toBe(true);
      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'injected late failure after rename-only DROP COLUMN',
        ),
      );
      errorSpy.mockRestore();
      expect(callbackPids.length).toBeGreaterThan(1);
      expect(new Set(callbackPids)).toHaveLength(1);
      expect(await snapshot()).toEqual(before);
    }, 30_000);

    it.each([
      { name: '--skip-convert', options: { 'skip-convert': true } },
      { name: 'an empty declared manifest', options: {} },
    ])('refuses unpinned rename-only $name before writes', async ({
      options,
    }) => {
      const before = await snapshot();
      if (Object.keys(options).length === 0)
        schemaSpy?.mockReturnValue({} as any);
      sqlTestHarness.interceptor = async (...args: any[]) => {
        const realDb: any = await sqlTestHarness.realGetDatabase(...args);
        return new Proxy(realDb, {
          get(target, property, receiver) {
            if (property === 'transaction') return undefined;
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
        ...options,
      });

      const exitCode = process.exitCode;
      process.exitCode = undefined;
      sqlTestHarness.interceptor = undefined;
      logSpy.mockRestore();
      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('refusing to run unpinned DDL'),
      );
      errorSpy.mockRestore();
      expect(await snapshot()).toEqual(before);
    }, 30_000);

    it('refuses a replaced source attribute after planning and before locks', async () => {
      let replacedAttribute = false;
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
                          const sql = String(queryArgs[0]);
                          if (!replacedAttribute && /^LOCK TABLE /i.test(sql)) {
                            replacedAttribute = true;
                            // Inject the catalog change at the exact race
                            // boundary. An external session can commit the
                            // same ALTER between the pre-plan read and lock;
                            // keeping it on this transaction avoids a test
                            // harness lock deadlock while exercising the
                            // source identity guard. The nullable child FK has
                            // no default, so the prior default-only guard would
                            // have let this stale replacement through.
                            await transactionTarget.query(
                              `ALTER TABLE "${child}" RENAME COLUMN parent_id TO replaced_parent_id`,
                            );
                          }
                          return transactionTarget.query(...queryArgs);
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
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;

      await dbMigrateUuidCommand.handler([], {});

      const exitCode = process.exitCode;
      process.exitCode = undefined;
      sqlTestHarness.interceptor = undefined;
      expect(replacedAttribute).toBe(true);
      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'source identity, type, or default changed while locks were acquired',
        ),
      );
      errorSpy.mockRestore();
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='parent_id'`,
        child,
      );
      expect(rows).toEqual([
        {
          data_type: 'text',
        },
      ]);
    }, 30_000);

    it('refuses a source default changed after planning and before locks', async () => {
      let changedDefault = false;
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
                          const sql = String(queryArgs[0]);
                          if (!changedDefault && /^LOCK TABLE /i.test(sql)) {
                            changedDefault = true;
                            // An external session can commit this ALTER at the
                            // plan/lock boundary; keep it in the callback here
                            // only to avoid a harness-induced lock deadlock.
                            await transactionTarget.query(
                              `ALTER TABLE "${parent}" ALTER COLUMN id SET DEFAULT '22222222-2222-2222-2222-222222222222'`,
                            );
                          }
                          return transactionTarget.query(...queryArgs);
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
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;

      await dbMigrateUuidCommand.handler([], {});

      const exitCode = process.exitCode;
      process.exitCode = undefined;
      sqlTestHarness.interceptor = undefined;
      expect(changedDefault).toBe(true);
      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'source identity, type, or default changed while locks were acquired',
        ),
      );
      errorSpy.mockRestore();
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT data_type, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'`,
        parent,
      );
      expect(rows).toEqual([
        {
          data_type: 'text',
          column_default: "'11111111-1111-1111-1111-111111111111'::text",
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
        name: 'bridge column options',
        key: 'column_options',
        bridgeDefinition: 'text GENERATED ALWAYS AS ((id)::text) STORED',
        optionsSql:
          'ALTER TABLE "PARENT" ALTER COLUMN _integrity_id_text SET (n_distinct = -0.5)',
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
      const optionsSql = scenario.optionsSql?.replace('PARENT', parent);
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
        if (optionsSql) await connection.query(optionsSql);
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

describePostgres(
  'db:migrate-uuid propagates blocked FK partners to a fixpoint (real Postgres)',
  () => {
    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    async function dataType(
      table: string,
      column: string,
    ): Promise<string | undefined> {
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        table,
        column,
      );
      return (rows as any[])[0]?.data_type;
    }

    async function fkExists(constraintName: string): Promise<boolean> {
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND contype = 'f'`,
        constraintName,
      );
      return (rows as any[]).length > 0;
    }

    describe('a dirty parent blocks its convertible declared-UUID child', () => {
      const stem = `mu_fkblk_dirty_${Math.random().toString(36).slice(2, 8)}`;
      const parent = `${stem}_parent`;
      const child = `${stem}_child`;
      const fkName = `${child}_parent_fkey`;
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

      beforeEach(async () => {
        const db = await freshDb();
        await db.query(`DROP TABLE IF EXISTS "${child}", "${parent}" CASCADE`);
        await db.query(`CREATE TABLE "${parent}" (id text PRIMARY KEY)`);
        await db.query(
          `CREATE TABLE "${child}" (
             id text PRIMARY KEY,
             parent_id text NOT NULL CONSTRAINT "${fkName}" REFERENCES "${parent}"(id)
           )`,
        );
        // parent has one clean row and one dirty (non-uuid) row — the column
        // as a whole is skipped for dirty data (Gate 2 fails).
        await db.query(
          `INSERT INTO "${parent}" (id) VALUES ($1), ($2)`,
          '11111111-1111-1111-1111-111111111111',
          'legacy-parent-slug',
        );
        // child only ever references the clean parent row, so child.parent_id
        // is itself entirely UUID-shaped — it would convert on its own merits.
        // child.id is unrelated to the FK entirely and should still convert.
        await db.query(
          `INSERT INTO "${child}" (id, parent_id) VALUES ($1, $2)`,
          '22222222-2222-2222-2222-222222222222',
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
            `DROP TABLE IF EXISTS "${child}", "${parent}" CASCADE`,
          );
        } catch {
          // Handler cleanup closes pooled handles; reacquire before teardown.
        }
        clearCache();
      });

      it('blocks child.parent_id, leaves parent.id TEXT, still converts child.id, and the FK survives', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        process.exitCode = undefined;

        await dbMigrateUuidCommand.handler([], { 'dry-run': false });

        const exitCode = process.exitCode;
        process.exitCode = undefined;
        expect(exitCode).toBeUndefined();
        expect(errorSpy).not.toHaveBeenCalled();
        const dryRunLog = logSpy.mock.calls.flat().map(String).join('\n');
        logSpy.mockRestore();
        errorSpy.mockRestore();

        // Parent stays TEXT: dirty data blocks conversion of its own column.
        expect(await dataType(parent, 'id')).toBe('text');
        // Child's parent_id is blocked purely because its FK partner is
        // skipped — even though child.parent_id's own data is 100% clean.
        expect(await dataType(child, 'parent_id')).toBe('text');
        // The rest converts: child.id has no FK dependency on the dirty pair.
        expect(await dataType(child, 'id')).toBe('uuid');
        // The FK constraint is never dropped since neither endpoint converts.
        expect(await fkExists(fkName)).toBe(true);
        expect(dryRunLog).toContain(`SKIP ${parent}.id`);
        expect(dryRunLog).toContain(`SKIP ${child}.parent_id`);
      }, 30_000);

      it('lists the propagated skip in --dry-run output without mutating anything', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        await dbMigrateUuidCommand.handler([], { 'dry-run': true });

        const output = logSpy.mock.calls.flat().map(String).join('\n');
        logSpy.mockRestore();
        errorSpy.mockRestore();

        expect(output).toMatch(
          new RegExp(`SKIP ${child}\\.parent_id: blocked by foreign key`),
        );
        // Dry run never mutates.
        expect(await dataType(parent, 'id')).toBe('text');
        expect(await dataType(child, 'parent_id')).toBe('text');
        expect(await dataType(child, 'id')).toBe('text');
      }, 30_000);

      it('is a no-op on a second run', async () => {
        const quiet1 = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errors1 = vi.spyOn(console, 'error').mockImplementation(() => {});
        await dbMigrateUuidCommand.handler([], { 'dry-run': false });
        quiet1.mockRestore();
        errors1.mockRestore();

        const quiet2 = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errors2 = vi.spyOn(console, 'error').mockImplementation(() => {});
        await dbMigrateUuidCommand.handler([], { 'dry-run': false });
        expect(errors2).not.toHaveBeenCalled();
        quiet2.mockRestore();
        errors2.mockRestore();

        expect(await dataType(parent, 'id')).toBe('text');
        expect(await dataType(child, 'parent_id')).toBe('text');
        expect(await dataType(child, 'id')).toBe('uuid');
        expect(await fkExists(fkName)).toBe(true);
      }, 30_000);
    });

    describe('a declared-TEXT parent blocks its convertible declared-UUID child', () => {
      const stem = `mu_fkblk_text_${Math.random().toString(36).slice(2, 8)}`;
      const parent = `${stem}_parent`;
      const child = `${stem}_child`;
      const fkName = `${child}_parent_fkey`;
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

      beforeEach(async () => {
        const db = await freshDb();
        await db.query(`DROP TABLE IF EXISTS "${child}", "${parent}" CASCADE`);
        await db.query(`CREATE TABLE "${parent}" (id text PRIMARY KEY)`);
        await db.query(
          `CREATE TABLE "${child}" (
             id text PRIMARY KEY,
             parent_id text NOT NULL CONSTRAINT "${fkName}" REFERENCES "${parent}"(id)
           )`,
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

        clearCache();
        setConfig({
          packages: {
            cli: {
              database: { type: 'postgres', url: process.env.DATABASE_URL },
            },
          },
        } as any);
        // parent.id is declared TEXT on purpose — the schema never converts
        // it, so its declared-UUID child.parent_id must stay TEXT too.
        schemaSpy = vi
          .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
          .mockReturnValue({
            [parent]: {
              tableName: parent,
              ddl: '',
              columns: { id: { type: 'TEXT' } },
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
            `DROP TABLE IF EXISTS "${child}", "${parent}" CASCADE`,
          );
        } catch {
          // Handler cleanup closes pooled handles; reacquire before teardown.
        }
        clearCache();
      });

      it('blocks child.parent_id, still converts child.id, and the FK survives', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        await dbMigrateUuidCommand.handler([], { 'dry-run': false });

        expect(errorSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        errorSpy.mockRestore();

        expect(await dataType(parent, 'id')).toBe('text');
        expect(await dataType(child, 'parent_id')).toBe('text');
        expect(await dataType(child, 'id')).toBe('uuid');
        expect(await fkExists(fkName)).toBe(true);
      }, 30_000);
    });

    describe('a two-hop chain propagates the block through both hops', () => {
      const stem = `mu_fkblk_chain_${Math.random().toString(36).slice(2, 8)}`;
      const grandparent = `${stem}_gp`;
      const parent = `${stem}_p`;
      const child = `${stem}_c`;
      const parentFk = `${parent}_gp_fkey`;
      const childFk = `${child}_parent_fkey`;
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

      beforeEach(async () => {
        const db = await freshDb();
        await db.query(
          `DROP TABLE IF EXISTS "${child}", "${parent}", "${grandparent}" CASCADE`,
        );
        // Shared-PK chain: parent.id itself is a FK to grandparent.id, and
        // child.parent_id is a FK to parent.id.
        await db.query(`CREATE TABLE "${grandparent}" (id text PRIMARY KEY)`);
        await db.query(
          `CREATE TABLE "${parent}" (
             id text PRIMARY KEY CONSTRAINT "${parentFk}" REFERENCES "${grandparent}"(id)
           )`,
        );
        await db.query(
          `CREATE TABLE "${child}" (
             id text PRIMARY KEY,
             parent_id text NOT NULL CONSTRAINT "${childFk}" REFERENCES "${parent}"(id)
           )`,
        );
        await db.query(
          `INSERT INTO "${grandparent}" (id) VALUES ($1)`,
          '00000000-0000-0000-0000-000000000000',
        );
        await db.query(
          `INSERT INTO "${parent}" (id) VALUES ($1)`,
          '00000000-0000-0000-0000-000000000000',
        );
        await db.query(
          `INSERT INTO "${child}" (id, parent_id) VALUES ($1, $2)`,
          '11111111-1111-1111-1111-111111111111',
          '00000000-0000-0000-0000-000000000000',
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
            // grandparent.id is declared TEXT on purpose: the ultimate,
            // never-converts source of the block.
            [grandparent]: {
              tableName: grandparent,
              ddl: '',
              columns: { id: { type: 'TEXT' } },
              indexes: [],
              triggers: [],
              foreignKeys: [],
              version: '',
              dependencies: [],
            },
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
            `DROP TABLE IF EXISTS "${child}", "${parent}", "${grandparent}" CASCADE`,
          );
        } catch {
          // Handler cleanup closes pooled handles; reacquire before teardown.
        }
        clearCache();
      });

      it('blocks parent.id (hop 1) and child.parent_id (hop 2), still converts child.id, and both FKs survive', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        await dbMigrateUuidCommand.handler([], { 'dry-run': false });

        expect(errorSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        errorSpy.mockRestore();

        expect(await dataType(grandparent, 'id')).toBe('text');
        expect(await dataType(parent, 'id')).toBe('text');
        expect(await dataType(child, 'parent_id')).toBe('text');
        expect(await dataType(child, 'id')).toBe('uuid');
        expect(await fkExists(parentFk)).toBe(true);
        expect(await fkExists(childFk)).toBe(true);
      }, 30_000);
    });
  },
);

describePostgres(
  'db:migrate-uuid accepts bare 32-hex UUID shapes (real Postgres)',
  () => {
    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    async function dataType(
      table: string,
      column: string,
    ): Promise<string | undefined> {
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        table,
        column,
      );
      return (rows as any[])[0]?.data_type;
    }

    async function fkExists(constraintName: string): Promise<boolean> {
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND contype = 'f'`,
        constraintName,
      );
      return (rows as any[]).length > 0;
    }

    describe('a column of bare-hex values', () => {
      const table = `mu_barehex_${Math.random().toString(36).slice(2, 8)}`;
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

      beforeEach(async () => {
        const db = await freshDb();
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, owner_id text)`,
        );
        // Bare 32-hex, no hyphens — the hyphen-stripped form of a canonical
        // uuid, which PostgreSQL's ::uuid cast accepts as the same value.
        // owner_id (not "val") so it matches db:migrate-uuid's id/FK naming
        // filter (`column_name = 'id' OR column_name ~* '(_id|Id)$'`).
        await db.query(
          `INSERT INTO "${table}" (id, owner_id) VALUES ($1, $2)`,
          '11111111-1111-1111-1111-111111111111',
          '11111111111111111111111111111111',
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
            [table]: {
              tableName: table,
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
          await db.query(`DROP TABLE IF EXISTS "${table}"`);
        } catch {
          // Handler cleanup closes pooled handles; reacquire before teardown.
        }
        clearCache();
      });

      it('converts instead of being reported dirty', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        await dbMigrateUuidCommand.handler([], { 'dry-run': false });

        expect(errorSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        errorSpy.mockRestore();

        expect(await dataType(table, 'owner_id')).toBe('uuid');
        const db = await freshDb();
        const { rows } = await db.query(
          `SELECT owner_id::text AS owner_id FROM "${table}"`,
        );
        expect((rows as any[])[0].owner_id).toBe(
          '11111111-1111-1111-1111-111111111111',
        );
      }, 30_000);
    });

    describe('a mixed canonical/bare-hex FK pair', () => {
      const stem = `mu_barehex_fk_${Math.random().toString(36).slice(2, 8)}`;
      const parent = `${stem}_parent`;
      const child = `${stem}_child`;
      const fkName = `${child}_parent_fkey`;
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

      beforeEach(async () => {
        const db = await freshDb();
        await db.query(`DROP TABLE IF EXISTS "${child}", "${parent}" CASCADE`);
        await db.query(`CREATE TABLE "${parent}" (id text PRIMARY KEY)`);
        await db.query(
          `CREATE TABLE "${child}" (
             id text PRIMARY KEY,
             parent_id text NOT NULL CONSTRAINT "${fkName}" REFERENCES "${parent}"(id)
           )`,
        );
        // Row 1: canonical hyphenated form on both sides.
        await db.query(
          `INSERT INTO "${parent}" (id) VALUES ($1)`,
          '33333333-3333-3333-3333-333333333333',
        );
        await db.query(
          `INSERT INTO "${child}" (id, parent_id) VALUES ($1, $2)`,
          '55555555-5555-5555-5555-555555555555',
          '33333333-3333-3333-3333-333333333333',
        );
        // Row 2: bare 32-hex form on both sides (a distinct uuid value).
        await db.query(
          `INSERT INTO "${parent}" (id) VALUES ($1)`,
          '44444444444444444444444444444444',
        );
        await db.query(
          `INSERT INTO "${child}" (id, parent_id) VALUES ($1, $2)`,
          '66666666-6666-6666-6666-666666666666',
          '44444444444444444444444444444444',
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
            `DROP TABLE IF EXISTS "${child}", "${parent}" CASCADE`,
          );
        } catch {
          // Handler cleanup closes pooled handles; reacquire before teardown.
        }
        clearCache();
      });

      it('converts both endpoints and recreates the FK', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        await dbMigrateUuidCommand.handler([], { 'dry-run': false });

        expect(errorSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        errorSpy.mockRestore();

        expect(await dataType(parent, 'id')).toBe('uuid');
        expect(await dataType(child, 'parent_id')).toBe('uuid');
        expect(await fkExists(fkName)).toBe(true);
        const db = await freshDb();
        const { rows } = await db.query(
          `SELECT id::text AS id FROM "${parent}" ORDER BY id`,
        );
        expect((rows as any[]).map((row) => row.id)).toEqual([
          '33333333-3333-3333-3333-333333333333',
          '44444444-4444-4444-4444-444444444444',
        ]);
      }, 30_000);
    });

    describe('a value with 31 hex characters', () => {
      const table = `mu_barehex31_${Math.random().toString(36).slice(2, 8)}`;
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

      beforeEach(async () => {
        const db = await freshDb();
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, owner_id text)`,
        );
        // 31 hex characters — one short of the bare-32 form, and not
        // hyphenated either. PostgreSQL's ::uuid cast rejects this shape.
        // owner_id (not "val") so it matches db:migrate-uuid's id/FK naming
        // filter (`column_name = 'id' OR column_name ~* '(_id|Id)$'`).
        await db.query(
          `INSERT INTO "${table}" (id, owner_id) VALUES ($1, $2)`,
          '77777777-7777-7777-7777-777777777777',
          '1111111111111111111111111111111',
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
            [table]: {
              tableName: table,
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
          await db.query(`DROP TABLE IF EXISTS "${table}"`);
        } catch {
          // Handler cleanup closes pooled handles; reacquire before teardown.
        }
        clearCache();
      });

      it('is still reported dirty and left as TEXT', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        await dbMigrateUuidCommand.handler([], { 'dry-run': false });

        const output = logSpy.mock.calls.flat().map(String).join('\n');
        expect(errorSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        errorSpy.mockRestore();

        expect(await dataType(table, 'owner_id')).toBe('text');
        expect(output).toContain(`SKIP ${table}.owner_id: 1 non-uuid value(s)`);
      }, 30_000);
    });

    describe('a generated TEXT bridge holding a bare-hex source value', () => {
      // A bare-hex bridge value must NOT be accepted: uuid::text always
      // renders the canonical hyphenated form, so re-adding the bridge over
      // the now-native column would silently rewrite the exact literal the
      // bridge exists to preserve for its TEXT FK children. The shape probes
      // that gate the TYPE conversion accept bare hex; the bridge's own
      // sample probe stays canonical-hyphenated-only and refuses instead.
      const stem = `mu_barehex_bridge_${Math.random().toString(36).slice(2, 8)}`;
      const table = `${stem}_t`;
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

      beforeEach(async () => {
        const db = await freshDb();
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await db.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, _integrity_id_text text GENERATED ALWAYS AS (id) STORED)`,
        );
        await db.query(
          `CREATE UNIQUE INDEX "${table}_bridge_uidx" ON "${table}" USING btree (_integrity_id_text)`,
        );
        // Bare 32-hex — the shape probe on the *converting* id column would
        // accept this, but the bridge sample probe must not.
        await db.query(
          `INSERT INTO "${table}" (id) VALUES ($1)`,
          '88888888888888888888888888888888',
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
        } catch {
          // Handler cleanup closes pooled handles; reacquire before teardown.
        }
        clearCache();
      });

      it('refuses instead of silently re-hyphenating the bridge value', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        process.exitCode = undefined;

        await dbMigrateUuidCommand.handler([], { 'dry-run': false });

        const exitCode = process.exitCode;
        process.exitCode = undefined;
        // Read call history BEFORE mockRestore() — restoring also clears it.
        const errorOutput = errorSpy.mock.calls.flat().map(String).join('\n');
        logSpy.mockRestore();
        errorSpy.mockRestore();

        expect(exitCode).toBe(1);
        expect(errorOutput).toContain('canonical lower-case UUID text');
        // Refused before any write: id and the bridge stay exactly as-is.
        expect(await dataType(table, 'id')).toBe('text');
        const db = await freshDb();
        const { rows } = await db.query(
          `SELECT _integrity_id_text FROM "${table}"`,
        );
        expect((rows as any[])[0]._integrity_id_text).toBe(
          '88888888888888888888888888888888',
        );
      }, 30_000);
    });
  },
);

describePostgres(
  'db:migrate-uuid skips post-normalization duplicate collisions instead of aborting (real Postgres)',
  () => {
    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    async function dataType(
      table: string,
      column: string,
    ): Promise<string | undefined> {
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        table,
        column,
      );
      return (rows as any[])[0]?.data_type;
    }

    const stem = `mu_dupnorm_${Math.random().toString(36).slice(2, 8)}`;
    // Two DISTINCT TEXT primary-key rows that normalize to the SAME uuid —
    // one hyphenated, one bare-hex. This is legal, coexisting TEXT data (the
    // PK constraint compares raw TEXT, not the eventual uuid), but converting
    // this column to native uuid would collide on the PK/unique index.
    const collidingTable = `${stem}_colliding`;
    // An unrelated, clean, declared-UUID table — must still convert even
    // though the colliding table in the same run does not.
    const cleanTable = `${stem}_clean`;
    // A non-unique declared-UUID column whose rows repeat the SAME raw TEXT
    // value (an ordinary one-to-many FK shape, e.g. several children
    // pointing at the same parent). This is NOT a collision — no unique
    // index is violated by rows that were already byte-identical TEXT — and
    // must still convert.
    const repeatedTable = `${stem}_repeated`;
    // Two DISTINCT TEXT primary-key rows that differ only by leading
    // whitespace and normalize to the SAME uuid (the conversion's own
    // `USING NULLIF(btrim(...), '')::uuid` clause btrims before casting).
    // Counting DISTINCT *trimmed* forms would hide this collision.
    const whitespaceTable = `${stem}_whitespace`;
    // A non-unique declared-UUID column (no PK/unique index on ref_id) whose
    // rows spell the SAME uuid two different ways (hyphenated vs bare-hex).
    // Normalizing them to one value at ALTER time is harmless — no unique
    // index is rebuilt — so this must NOT be treated as a collision.
    const nonUniqueMixedTable = `${stem}_nonunique_mixed`;
    // A composite UNIQUE(tenant_id, slug) index — the same shape SMRT itself
    // generates on tenant-scoped tables. Two rows sharing the SAME `slug`
    // but spelling `tenant_id` two different ways for the same uuid DO
    // collide on this index (every other key column matches), even though
    // neither the single-key colliding-PK check nor a plain non-unique
    // check would catch it.
    const compositeUniqueTable = `${stem}_composite`;
    let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(async () => {
      const db = await freshDb();
      await db.query(
        `DROP TABLE IF EXISTS "${collidingTable}", "${cleanTable}", "${repeatedTable}", "${whitespaceTable}", "${nonUniqueMixedTable}", "${compositeUniqueTable}"`,
      );
      await db.query(`CREATE TABLE "${collidingTable}" (id text PRIMARY KEY)`);
      await db.query(
        `INSERT INTO "${collidingTable}" (id) VALUES ($1), ($2)`,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      await db.query(`CREATE TABLE "${cleanTable}" (id text PRIMARY KEY)`);
      await db.query(
        `INSERT INTO "${cleanTable}" (id) VALUES ($1)`,
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      );
      await db.query(
        `CREATE TABLE "${repeatedTable}" (row_id serial PRIMARY KEY, parent_id text)`,
      );
      await db.query(
        `INSERT INTO "${repeatedTable}" (parent_id) VALUES ($1), ($1), ($1)`,
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
      );
      await db.query(`CREATE TABLE "${whitespaceTable}" (id text PRIMARY KEY)`);
      await db.query(
        `INSERT INTO "${whitespaceTable}" (id) VALUES ($1), ($2)`,
        'dddddddd-dddd-dddd-dddd-dddddddddddd',
        ' dddddddd-dddd-dddd-dddd-dddddddddddd',
      );
      await db.query(
        `CREATE TABLE "${nonUniqueMixedTable}" (row_id serial PRIMARY KEY, ref_id text)`,
      );
      await db.query(
        `INSERT INTO "${nonUniqueMixedTable}" (ref_id) VALUES ($1), ($2)`,
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      );
      await db.query(
        `CREATE TABLE "${compositeUniqueTable}" (
           row_id serial PRIMARY KEY,
           tenant_id text,
           slug text,
           UNIQUE (tenant_id, slug)
         )`,
      );
      await db.query(
        `INSERT INTO "${compositeUniqueTable}" (tenant_id, slug) VALUES ($1, $2), ($3, $2)`,
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        'same-slug',
        'ffffffffffffffffffffffffffffffff',
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
          [collidingTable]: {
            tableName: collidingTable,
            ddl: '',
            columns: { id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [cleanTable]: {
            tableName: cleanTable,
            ddl: '',
            columns: { id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [repeatedTable]: {
            tableName: repeatedTable,
            ddl: '',
            columns: { parent_id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [whitespaceTable]: {
            tableName: whitespaceTable,
            ddl: '',
            columns: { id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [nonUniqueMixedTable]: {
            tableName: nonUniqueMixedTable,
            ddl: '',
            columns: { ref_id: { type: 'UUID' } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            version: '',
            dependencies: [],
          },
          [compositeUniqueTable]: {
            tableName: compositeUniqueTable,
            ddl: '',
            columns: { tenant_id: { type: 'UUID' } },
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
          `DROP TABLE IF EXISTS "${collidingTable}", "${cleanTable}", "${repeatedTable}", "${whitespaceTable}", "${nonUniqueMixedTable}", "${compositeUniqueTable}"`,
        );
      } catch {
        // Handler cleanup closes pooled handles; reacquire before teardown.
      }
      clearCache();
    });

    it('skips unique-indexed (single-key and composite) collisions; converts the unrelated clean, repeated-value, and non-unique mixed-spelling columns', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dbMigrateUuidCommand.handler([], { 'dry-run': false });

      // Read call history BEFORE mockRestore() — restoring also clears it.
      const output = logSpy.mock.calls.flat().map(String).join('\n');
      logSpy.mockRestore();
      errorSpy.mockRestore();

      expect(errorSpy).not.toHaveBeenCalled();
      // Colliding column stays TEXT — skipped, not a whole-run abort.
      expect(await dataType(collidingTable, 'id')).toBe('text');
      // The unrelated clean column in the SAME run still converts: no
      // whole-transaction rollback from the collision elsewhere.
      expect(await dataType(cleanTable, 'id')).toBe('uuid');
      // An ordinary non-unique column repeating the SAME raw TEXT value
      // across rows is NOT a collision and must still convert.
      expect(await dataType(repeatedTable, 'parent_id')).toBe('uuid');
      // A whitespace-only difference is ALSO a collision on a unique/PK
      // column (the conversion trims before casting) — must be caught, not
      // silently aborted.
      expect(await dataType(whitespaceTable, 'id')).toBe('text');
      // A non-unique column with two DIFFERENT spellings of the same uuid
      // has no unique index to violate — normalizing to one value is
      // harmless, so it must still convert, not be flagged as dirty.
      expect(await dataType(nonUniqueMixedTable, 'ref_id')).toBe('uuid');
      // A composite UNIQUE(tenant_id, slug) collision — two rows sharing
      // `slug` but spelling `tenant_id` differently — must be caught too,
      // not just single-key PK/unique collisions.
      expect(await dataType(compositeUniqueTable, 'tenant_id')).toBe('text');
      expect(output).toContain(
        `SKIP ${collidingTable}.id: 1 duplicate value(s) after normalization`,
      );
      expect(output).toContain(
        `SKIP ${whitespaceTable}.id: 1 duplicate value(s) after normalization`,
      );
      expect(output).toContain(
        `SKIP ${compositeUniqueTable}.tenant_id: 1 duplicate value(s) after normalization`,
      );
      expect(output).not.toContain(`${repeatedTable}.parent_id`);
      expect(output).not.toContain(`${nonUniqueMixedTable}.ref_id`);
    }, 30_000);

    it('is a no-op on a second run', async () => {
      const quiet1 = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errors1 = vi.spyOn(console, 'error').mockImplementation(() => {});
      await dbMigrateUuidCommand.handler([], { 'dry-run': false });
      quiet1.mockRestore();
      errors1.mockRestore();

      const quiet2 = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errors2 = vi.spyOn(console, 'error').mockImplementation(() => {});
      await dbMigrateUuidCommand.handler([], { 'dry-run': false });
      expect(errors2).not.toHaveBeenCalled();
      quiet2.mockRestore();
      errors2.mockRestore();

      expect(await dataType(collidingTable, 'id')).toBe('text');
      expect(await dataType(cleanTable, 'id')).toBe('uuid');
      expect(await dataType(repeatedTable, 'parent_id')).toBe('uuid');
      expect(await dataType(whitespaceTable, 'id')).toBe('text');
      expect(await dataType(nonUniqueMixedTable, 'ref_id')).toBe('uuid');
      expect(await dataType(compositeUniqueTable, 'tenant_id')).toBe('text');
    }, 30_000);
  },
);
