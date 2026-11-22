/**
 * #5452: migrate never decides from rows PostgreSQL row-level security hides
 * from the migrating role. The plan stops with MigrationRowSecurityError
 * before anything runs, and statements inside the migration transaction run
 * with `row_security = off`, so a read the policy would filter raises.
 *
 * PostgreSQL semantics run on PGlite under `pnpm test:pglite` (a non-superuser
 * owner role under FORCE ROW LEVEL SECURITY, reached with SET ROLE). The
 * default run checks the SQLite side: nothing changes there.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaChange } from '../../schema/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import { createMigrationDefinition } from '../generator.js';
import { readLastMigrateRecord } from '../migrate-record.js';
import {
  preflightMinorUnitsRescale,
  rescaleMoneyColumnsToMinorUnits,
} from '../minor-units.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { retireLockSql, retireRowsGuardSql } from '../retire-guard.js';
import {
  clearRegisteredRetiredTables,
  type RetiredTable,
  registerRetiredTables,
  snapshotRegisteredRetiredTables,
} from '../retired-tables.js';
import {
  findRowSecurityTables,
  MigrationRowSecurityError,
  rowSecurityFailure,
  tablesMigrateReads,
  withRowSecurityOff,
} from '../row-security.js';
import { MigrationTracker, planPostgresStatements } from '../tracker.js';

const PKG = '@rls5452/app';
const ROLE = 'smrt_rls_migrator';

type Db = Awaited<ReturnType<typeof getTestDatabase>>;

function registerItem(version: 1 | 2) {
  class RlsItem extends SmrtObject {
    tenantId = '';
    note = '';
  }
  field({ type: 'text' })(RlsItem.prototype, 'tenantId');
  field(
    version === 2
      ? { type: 'text', required: true, default: null as never }
      : { type: 'text' },
  )(RlsItem.prototype, 'note');
  ObjectRegistry.register(RlsItem, {
    packageName: PKG,
    tableName: 'rls_items',
  });
}

const retired = (table: string): RetiredTable => ({
  table,
  lastOwner: `${PKG}:Gone`,
  since: '1.0.0',
  reason: `${table} moved`,
  definitions: [
    {
      release: '0.9.0',
      columns: { id: { type: 'TEXT' }, v: { type: 'TEXT' } },
    },
  ],
  packageName: PKG,
});

describe('tables a migration reads (#5452)', () => {
  it('names the table of every applied or stopped change and each foreign key parent', () => {
    const changes: SchemaChange[] = [
      {
        type: 'add_foreign_key',
        table: 'rls_child',
        foreignKey: {
          column: 'parent_id',
          referencesTable: 'rls_parent',
          referencesColumn: 'id',
        },
        sql: 'ALTER TABLE "rls_child" ADD CONSTRAINT "fk" FOREIGN KEY ("parent_id") REFERENCES "rls_parent" ("id")',
      },
      {
        type: 'orphan_column',
        table: 'rls_reported_only',
        name: 'legacy',
        advisory: { severity: 'info', message: 'kept' },
      },
      { type: 'add_table', table: 'rls_new', sql: 'CREATE TABLE "rls_new" ()' },
      {
        type: 'retire_table',
        kindHint: 'table.retire',
        table: 'rls_gone',
        sql: 'DROP TABLE IF EXISTS "public"."rls_gone"',
      },
    ];
    expect(tablesMigrateReads(changes, 'postgres')).toEqual([
      { table: 'rls_child' },
      { table: 'rls_parent' },
      // The retire step reads its table and the run-time model journal,
      // both in public.
      { schema: 'public', table: 'rls_gone' },
      { schema: 'public', table: '_smrt_app_model_changes' },
    ]);
  });

  it('keeps every step of a retirement in the transaction after a deferred VALIDATE (#5452)', () => {
    const retirement = [
      retireLockSql('"public"."rls_gone"'),
      retireRowsGuardSql('"public"."rls_gone"'),
      'DROP TABLE IF EXISTS "public"."rls_gone"',
    ];
    const { regular, concurrent } = planPostgresStatements(
      [
        'ALTER TABLE "child" ADD CONSTRAINT "child_fk" FOREIGN KEY ("p") REFERENCES "parent" ("id") NOT VALID',
        'ALTER TABLE "child" VALIDATE CONSTRAINT "child_fk"',
        ...retirement,
        'UPDATE "child" SET "p" = NULL WHERE "p" = \'x\'',
      ],
      true,
    );
    expect(regular).toEqual([
      'ALTER TABLE "child" ADD CONSTRAINT "child_fk" FOREIGN KEY ("p") REFERENCES "parent" ("id") NOT VALID',
      ...retirement,
    ]);
    expect(concurrent).toEqual([
      'ALTER TABLE "child" VALIDATE CONSTRAINT "child_fk"',
      'UPDATE "child" SET "p" = NULL WHERE "p" = \'x\'',
    ]);
  });

  it('finds no row-level security on SQLite and leaves its migrate alone', async () => {
    const restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      registerItem(1);
      const result = await migrateSmrtSchemas({
        db,
        packageName: PKG,
        name: 'rls_sqlite_1',
        engineHint: 'sqlite',
      });
      expect(result).toMatchObject({ refused: false, applied: true });
      expect(await findRowSecurityTables(db, ['rls_items'], 'sqlite')).toEqual(
        [],
      );
    } finally {
      await db.close?.();
      restore();
    }
  });
});

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'migrate under row-level security on PostgreSQL (#5452)',
  () => {
    let db: Db;
    let restoreRegistry: () => void;
    let restoreRetired: () => void;
    let runs = 0;

    beforeEach(async () => {
      restoreRegistry = snapshotObjectRegistryState();
      restoreRetired = snapshotRegisteredRetiredTables();
      ObjectRegistry.clear();
      clearRegisteredRetiredTables();
      db = await getTestDatabase({
        type: 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      await db.query(`CREATE ROLE ${ROLE} NOSUPERUSER NOBYPASSRLS`);
      await db.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}`);
    });
    afterEach(async () => {
      await db.query('RESET ROLE');
      await db.close?.();
      restoreRetired();
      restoreRegistry();
    });

    const migrate = () =>
      migrateSmrtSchemas({
        db,
        packageName: PKG,
        name: `rls_${++runs}`,
        engineHint: 'postgres',
        postgresSafe: false,
        useConcurrentIndexes: false,
      });
    /** The migrating role owns `table`; a policy hides every row from it. */
    const hideRows = async (
      table: string,
      { force = true }: { force?: boolean } = {},
    ) => {
      await db.query(`ALTER TABLE "${table}" OWNER TO ${ROLE}`);
      await db.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      if (force)
        await db.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await db.query(
        `CREATE POLICY "${table}_hidden" ON "${table}" USING (false)`,
      );
    };
    const asMigrator = () => db.query(`SET ROLE ${ROLE}`);
    const asAdmin = () => db.query('RESET ROLE');
    const count = async (table: string) =>
      Number(
        (await db.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0]?.n,
      );
    const exists = async (table: string) =>
      (
        await db.query(
          `SELECT 1 FROM pg_class WHERE relname = '${table}' AND relkind = 'r'`,
        )
      ).rows.length > 0;
    const makeRetired = async (table: string) => {
      await db.query(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, v TEXT)`);
      for (let i = 0; i < 3; i++)
        await db.query(`INSERT INTO "${table}" VALUES ('${i}', 'kept')`);
    };

    it('stops before dropping a retired table whose rows the role cannot see, and keeps them', async () => {
      await makeRetired('rls_gone');
      await hideRows('rls_gone');
      registerRetiredTables(PKG, [retired('rls_gone')]);
      await asMigrator();

      const error = await migrate().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MigrationRowSecurityError);
      expect((error as MigrationRowSecurityError).tables).toEqual(['rls_gone']);
      expect((error as Error).message).toContain('BYPASSRLS');
      expect((error as Error).message).toContain('FORCE ROW LEVEL SECURITY');
      await asAdmin();
      expect(await count('rls_gone')).toBe(3);
    });

    it('stops before tightening a column whose NULLs the role cannot see', async () => {
      registerItem(1);
      await asMigrator();
      expect((await migrate()).refused).toBe(false);
      await asAdmin();
      await db.query(
        `INSERT INTO "rls_items" (id, slug, tenant_id, note) VALUES ('00000000-0000-4000-8000-000000000001', 's1', 't', NULL)`,
      );
      await hideRows('rls_items');
      ObjectRegistry.clear();
      registerItem(2);
      await asMigrator();

      await expect(migrate()).rejects.toBeInstanceOf(MigrationRowSecurityError);
      await asAdmin();
      const column = await db.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'rls_items' AND column_name = 'note'`,
      );
      expect(column.rows[0]?.is_nullable).toBe('YES');
    });

    it('raises, and names the table, when a statement in the migration reads rows a policy hides', async () => {
      await makeRetired('rls_raced');
      await hideRows('rls_raced');
      await asMigrator();
      // The retire step's in-batch row check and drop, as the plan writes them
      // for a table it counted empty before the policy came into force.
      const tracker = new MigrationTracker({ db, engineHint: 'postgres' });
      const results = await tracker.applyAll(
        [
          createMigrationDefinition('rls_raced_retire', [
            retireRowsGuardSql('"public"."rls_raced"'),
            'DROP TABLE IF EXISTS "public"."rls_raced"',
          ]),
        ],
        { atomic: true },
      );
      const failed = results.find((result) => !result.success);
      expect(failed).toBeDefined();
      const named = await rowSecurityFailure(db, failed?.error, [], 'postgres');
      expect(named).toBeInstanceOf(MigrationRowSecurityError);
      expect(named?.tables).toEqual(['rls_raced']);
      await asAdmin();
      expect(await exists('rls_raced')).toBe(true);
      expect(await count('rls_raced')).toBe(3);
    });

    it('leaves a failure that is not row-level security as it is', async () => {
      const refused = Object.assign(new Error('permission denied'), {
        code: '42501',
      });
      expect(
        await rowSecurityFailure(db, refused, [], 'postgres'),
      ).toBeUndefined();
      expect(
        await rowSecurityFailure(db, new Error('other'), [], 'postgres'),
      ).toBeUndefined();
    });

    it('migrates as the owner when row-level security is enabled without FORCE', async () => {
      await makeRetired('rls_owner_gone');
      await hideRows('rls_owner_gone', { force: false });
      registerRetiredTables(PKG, [retired('rls_owner_gone')]);
      await asMigrator();

      const result = await migrate();

      // The owner sees every row, so the retire check counts them and stops.
      expect(result.refused).toBe(true);
      expect(result.stops.map((stop) => stop.kind)).toEqual([
        'table.retire-rows',
      ]);
      expect(result.stops[0].message).toContain('holds 3 row(s)');
    });

    it('migrates as a BYPASSRLS role under FORCE ROW LEVEL SECURITY', async () => {
      await db.query(`ALTER ROLE ${ROLE} BYPASSRLS`);
      registerItem(1);
      await asMigrator();
      expect((await migrate()).refused).toBe(false);
      await asAdmin();
      await hideRows('rls_items');
      await db.query(
        `INSERT INTO "rls_items" (id, slug, tenant_id, note) VALUES ('00000000-0000-4000-8000-000000000002', 's2', 't', 'n')`,
      );
      ObjectRegistry.clear();
      registerItem(2);
      await asMigrator();

      const result = await migrate();

      expect(result).toMatchObject({ refused: false, applied: true });
      await asAdmin();
      const column = await db.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'rls_items' AND column_name = 'note'`,
      );
      expect(column.rows[0]?.is_nullable).toBe('NO');
    });

    it('sets row_security back when the work succeeds', async () => {
      await db.transaction?.(async (tx) => {
        const seen = await withRowSecurityOff(tx, async () =>
          String(
            (await tx.query(`SELECT current_setting('row_security') AS v`))
              .rows[0]?.v,
          ),
        );
        expect(seen).toBe('off');
        const after = await tx.query(
          `SELECT current_setting('row_security') AS v`,
        );
        expect(after.rows[0]?.v).toBe('on');
      });
    });

    it('stops a retirement when the run-time model journal it reads is hidden', async () => {
      await makeRetired('rls_journal_gone');
      await db.query(
        'CREATE TABLE public._smrt_app_model_changes (id TEXT PRIMARY KEY, application TEXT, before_doc TEXT, after_doc TEXT)',
      );
      await db.query(
        `INSERT INTO public._smrt_app_model_changes VALUES ('c1', 'app', NULL, '{"models":{"packageName":"@x/app","lists":{"keep":{"tableName":"rls_journal_gone"}}}}')`,
      );
      await db.query(`ALTER TABLE "rls_journal_gone" OWNER TO ${ROLE}`);
      await hideRows('_smrt_app_model_changes');
      registerRetiredTables(PKG, [
        { ...retired('rls_journal_gone'), rows: 'discard' },
      ]);
      await asMigrator();

      const error = await migrate().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MigrationRowSecurityError);
      expect((error as MigrationRowSecurityError).tables).toEqual([
        '_smrt_app_model_changes',
      ]);
      await asAdmin();
      expect(await count('rls_journal_gone')).toBe(3);
    });

    it('runs a deferred data statement after a VALIDATE with row_security off', async () => {
      await db.query('CREATE TABLE rls_parent (id TEXT PRIMARY KEY)');
      await db.query(
        'CREATE TABLE rls_child (id TEXT PRIMARY KEY, parent_id TEXT, note TEXT)',
      );
      await db.query(`INSERT INTO rls_child VALUES ('c1', NULL, NULL)`);
      for (const table of ['rls_parent', 'rls_child'])
        await db.query(`ALTER TABLE ${table} OWNER TO ${ROLE}`);
      await hideRows('rls_child');
      await asMigrator();
      const tracker = new MigrationTracker({
        db,
        engineHint: 'postgres',
        useConcurrentIndexes: true,
      });
      const results = await tracker.applyAll(
        [
          createMigrationDefinition('rls_deferred_update', [
            'ALTER TABLE rls_child ADD CONSTRAINT rls_child_fk FOREIGN KEY (parent_id) REFERENCES rls_parent (id) NOT VALID',
            'ALTER TABLE rls_child VALIDATE CONSTRAINT rls_child_fk',
            `UPDATE rls_child SET note = 'filled' WHERE note IS NULL`,
          ]),
        ],
        { atomic: true, postgresSafe: true },
      );
      // Filtered, the UPDATE would touch no row and report success.
      expect(results.some((result) => !result.success)).toBe(true);
      await asAdmin();
      expect(
        (await db.query(`SELECT note FROM rls_child WHERE id = 'c1'`)).rows[0]
          ?.note,
      ).toBeNull();
      expect(
        (await db.query(`SELECT current_setting('row_security') AS v`)).rows[0]
          ?.v,
      ).toBe('on');
    });

    it('refuses to read a migrate record row-level security hides', async () => {
      registerItem(1);
      await asMigrator();
      expect((await migrate()).refused).toBe(false);
      await asAdmin();
      await hideRows('_smrt_migrate_runs');
      await asMigrator();

      await expect(
        readLastMigrateRecord(db, { engineHint: 'postgres' }),
      ).rejects.toBeInstanceOf(MigrationRowSecurityError);
      await expect(migrate()).rejects.toBeInstanceOf(MigrationRowSecurityError);
    });

    it('refuses the money rescale and its preflight on rows the role cannot see', async () => {
      await db.query(
        'CREATE TABLE rls_prices (id TEXT PRIMARY KEY, amount DOUBLE PRECISION)',
      );
      await db.query(`INSERT INTO rls_prices VALUES ('a', 19.995)`);
      await hideRows('rls_prices');
      await asMigrator();
      const targets = [{ table: 'rls_prices', columns: ['amount'] }];

      await expect(
        preflightMinorUnitsRescale(db, targets, { engineHint: 'postgres' }),
      ).rejects.toBeInstanceOf(MigrationRowSecurityError);
      await expect(
        rescaleMoneyColumnsToMinorUnits(db, targets, {
          backfillName: 'rls_prices:v1',
          engineHint: 'postgres',
        }),
      ).rejects.toBeInstanceOf(MigrationRowSecurityError);
      await asAdmin();
      const row = (await db.query(`SELECT amount FROM rls_prices`)).rows[0];
      expect(Number(row?.amount)).toBe(19.995);
    });

    it('resolves each table to the relation a statement would read, not a same-named one elsewhere', async () => {
      await db.query('CREATE SCHEMA rls_shadow');
      await db.query('CREATE TABLE public.rls_twin (id TEXT PRIMARY KEY)');
      await db.query('CREATE TABLE rls_shadow.rls_twin (id TEXT PRIMARY KEY)');
      await db.query(`ALTER TABLE rls_shadow.rls_twin OWNER TO ${ROLE}`);
      await db.query(`GRANT USAGE ON SCHEMA rls_shadow TO ${ROLE}`);
      await db.query(
        'ALTER TABLE rls_shadow.rls_twin ENABLE ROW LEVEL SECURITY',
      );
      await db.query(
        'ALTER TABLE rls_shadow.rls_twin FORCE ROW LEVEL SECURITY',
      );
      await db.query(`ALTER TABLE public.rls_twin OWNER TO ${ROLE}`);
      await asMigrator();
      await db.query('SET search_path TO public, rls_shadow');

      expect(await findRowSecurityTables(db, ['rls_twin'], 'postgres')).toEqual(
        [],
      );
      expect(
        await findRowSecurityTables(
          db,
          [{ schema: 'rls_shadow', table: 'rls_twin' }],
          'postgres',
        ),
      ).toEqual(['rls_twin']);
      await db.query('RESET search_path');
    });

    it('names the stop from the catalog when the server message is not in English', async () => {
      await makeRetired('rls_localized');
      await hideRows('rls_localized');
      await asMigrator();
      const translated = Object.assign(
        new Error(
          'la consulta se vería afectada por una política de seguridad',
        ),
        { code: '42501' },
      );

      const named = await rowSecurityFailure(db, translated, [], 'postgres');

      expect(named).toBeInstanceOf(MigrationRowSecurityError);
      expect(named?.tables).toEqual(['rls_localized']);
      expect(named?.cause).toBe(translated);
    });
  },
);
