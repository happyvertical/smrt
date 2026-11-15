/**
 * The retire step (#5005): migrate drops a table only when a package declares
 * it retired, no model declares it and the run is a whole-schema migrate. The
 * three stops are named, never thrown, and nothing undeclared is dropped.
 *
 * Runs on SQLite with foreign keys ON and on DuckDB by default; under
 * `pnpm test:pglite` on PGlite for PostgreSQL semantics. The real-server
 * counterpart is `table-retire-postgres.optional.test.ts`.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import {
  planRuntimeModelDDL,
  RetiredTableInUseError,
  registerRuntimeModel,
} from '../../runtime-model.js';
import { appModelChangesMigrations } from '../../system/app-model-changes.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import { registerBuildSchema } from '../build-schema.js';
import { classifySchemaChange, decideSchemaChange } from '../change-kinds.js';
import { SchemaComparer } from '../differ.js';
import {
  readConfirmedRetirements,
  readLastMigrateRecord,
} from '../migrate-record.js';
import {
  getPendingSchemaStatements,
  type MigrateSmrtSchemasResult,
  migrateSmrtSchemas,
} from '../orchestrate.js';
import { type RetiredTable, registerRetiredTables } from '../retired-tables.js';
import { MigrationTracker } from '../tracker.js';

const PKG = '@retire/fixture';
const OWNER = `${PKG}:Gone`;

type Engine = 'sqlite' | 'duckdb' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite', 'duckdb'];

const retired = (
  table: string,
  extra: Partial<RetiredTable> = {},
): RetiredTable => ({
  table,
  lastOwner: OWNER,
  since: '1.0.0',
  reason: `${table} moved onto the order`,
  rows: 'discard',
  // The shape `make()` creates.
  definitions: [
    {
      release: '0.9.0',
      columns: { id: { type: 'TEXT' }, v: { type: 'TEXT' } },
    },
  ],
  packageName: PKG,
  ...extra,
});

const shape = (...columns: string[]) => [
  {
    release: '0.9.0',
    columns: Object.fromEntries(
      columns.map((name) => [name, { type: 'TEXT' as const }]),
    ),
  },
];

describe.each(engines)('retire step on %s (#5005)', (engine) => {
  const hint = engine === 'pglite' ? 'postgres' : engine;
  const options =
    hint === 'postgres'
      ? { atomic: true, postgresSafe: false, useConcurrentIndexes: false }
      : {};
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let runs = 0;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    db =
      engine === 'pglite'
        ? await getTestDatabase({
            type: 'pglite',
            classes: [],
            includeSystemTables: false,
          })
        : ((await getDatabase({
            type: engine,
            url: ':memory:',
          })) as typeof db);
    if (engine === 'sqlite') {
      await db.query('PRAGMA foreign_keys = ON');
      const on = await db.query('PRAGMA foreign_keys');
      expect(Number(on.rows[0]?.foreign_keys)).toBe(1);
    }
  });
  afterEach(async () => {
    await db.close?.();
    restore();
  });

  const migrate = (extra: Record<string, unknown> = {}) =>
    migrateSmrtSchemas({
      db,
      packageName: '@retire/app',
      name: `retire_${++runs}`,
      engineHint: hint,
      ...options,
      ...extra,
    });
  const declare = (...tables: RetiredTable[]) =>
    registerRetiredTables(PKG, tables);
  const exists = async (table: string) => {
    const result = await db.query(
      engine === 'pglite'
        ? `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '${table}'`
        : `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
    );
    return result.rows.length > 0;
  };
  const make = async (table: string, rows = 0) => {
    await db.query(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, v TEXT)`);
    // Its indexes go with it, on every engine.
    await db.query(`CREATE INDEX "${table}_v_idx" ON "${table}" (v)`);
    for (let i = 0; i < rows; i++)
      await db.query(`INSERT INTO "${table}" VALUES ('${i}', 'x')`);
  };
  // PostgreSQL statements name the schema the migrator reads (R5).
  const target = (table: string) =>
    hint === 'postgres' ? `"public"."${table}"` : `"${table}"`;
  const drop = (table: string) => `DROP TABLE IF EXISTS ${target(table)}`;
  const kinds = (result: MigrateSmrtSchemasResult) =>
    result.stops.map((stop) => stop.kind);

  it('drops a declared retired table with its rows, in one atomic run', async () => {
    await make('retire_orders_old', 3);
    await make('keep_me', 1);
    declare(retired('retire_orders_old'));

    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(result.statements).toEqual([drop('retire_orders_old')]);
    expect(await exists('retire_orders_old')).toBe(false);
    // Nothing undeclared goes with it.
    expect(await exists('keep_me')).toBe(true);
  });

  it.runIf(engine === 'pglite')(
    'drops under the default PostgreSQL options (postgres-safe, concurrent indexes)',
    async () => {
      await make('retire_safe', 1);
      declare(retired('retire_safe'));
      const result = await migrate({
        postgresSafe: true,
        useConcurrentIndexes: true,
      });
      expect(result).toMatchObject({ refused: false, applied: true });
      expect(await exists('retire_safe')).toBe(false);
    },
  );

  it('is idempotent: an absent table is nothing to do', async () => {
    declare(retired('retire_never_existed'));
    const first = await migrate();
    expect(first).toMatchObject({ refused: false, applied: false });
    expect(first.statements).toEqual([]);

    await make('retire_once', 1);
    declare(retired('retire_once'));
    expect((await migrate()).applied).toBe(true);
    const again = await migrate();
    expect(again).toMatchObject({ refused: false, applied: false });
    expect(again.statements).toEqual([]);
    expect(await exists('retire_once')).toBe(false);
  });

  it('never drops a table nobody declares retired', async () => {
    await make('retire_undeclared', 2);
    await make('retire_declared_elsewhere', 0);
    // The declaration names a different table.
    declare(retired('retire_declared_elsewhere'));

    const result = await migrate();

    expect(result.refused).toBe(false);
    expect(await exists('retire_undeclared')).toBe(true);
    expect(await exists('retire_declared_elsewhere')).toBe(false);
  });

  it('stop 1: a table both declared by a model and retired, named, nothing applied', async () => {
    class Gone extends SmrtObject {
      code = '';
    }
    field({ type: 'text' })(Gone.prototype, 'code');
    ObjectRegistry.register(Gone, {
      packageName: PKG,
      tableName: 'retire_both',
    });
    // The table exists with a row, made by an earlier migrate.
    expect((await migrate()).refused).toBe(false);
    await db.query(
      `INSERT INTO "retire_both" (id, slug, context, code) VALUES ('00000000-0000-4000-8000-000000000001', 's', '', 'c')`,
    );
    await make('retire_other', 0);
    declare(retired('retire_both'), retired('retire_other'));

    const result = await migrate();

    expect(result).toMatchObject({ refused: true, applied: false });
    expect(kinds(result)).toEqual(['table.retire-declared']);
    expect(result.stops[0].message).toContain('retire_both');
    expect(result.stops[0].message).toContain(`${PKG}:Gone`);
    expect(result.stops[0].reason).toBe('loses-data');
    expect(await exists('retire_both')).toBe(true);
    // All or nothing: the other retirement waits with it.
    expect(await exists('retire_other')).toBe(true);
    expect(result.heldBack.map((item) => item.description)).toContain(
      'Retire table retire_other',
    );
  });

  it("stop 2: a retired table with rows and no rows: 'discard' is not dropped", async () => {
    await make('retire_rows', 2);
    declare(retired('retire_rows', { rows: undefined }));

    const result = await migrate();

    expect(result.refused).toBe(true);
    expect(kinds(result)).toEqual(['table.retire-rows']);
    expect(result.stops[0].message).toContain('holds 2 row(s)');
    expect(result.stops[0].message).toContain("rows: 'discard'");
    expect(await exists('retire_rows')).toBe(true);
  });

  it("rows that land between the plan's count and the drop stop the run, and survive", async () => {
    class Fresh extends SmrtObject {
      code = '';
    }
    field({ type: 'text' })(Fresh.prototype, 'code');
    ObjectRegistry.register(Fresh, {
      packageName: '@retire/other',
      tableName: 'retire_race_fresh',
    });
    await make('retire_race', 0);
    declare(retired('retire_race', { rows: undefined }));
    // An old instance of a rolling deploy writes right after the plan counted
    // the table empty (#5005 R2).
    let wrote = false;
    const racing = new Proxy(db, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== 'query' || typeof value !== 'function')
          return typeof value === 'function' ? value.bind(target) : value;
        return async (sql: string, ...args: unknown[]) => {
          const result = await value.call(target, sql, ...args);
          if (
            !wrote &&
            /COUNT\(\*\)/i.test(sql) &&
            sql.includes('retire_race')
          ) {
            wrote = true;
            await value.call(
              target,
              `INSERT INTO "retire_race" VALUES ('late', 'x')`,
            );
          }
          return result;
        };
      },
    });

    const result = await migrateSmrtSchemas({
      db: racing,
      packageName: '@retire/app',
      name: `retire_${++runs}`,
      engineHint: hint,
      ...options,
    });

    expect(wrote).toBe(true);
    expect(result).toMatchObject({ refused: true, applied: false });
    expect(kinds(result)).toEqual(['table.retire-rows']);
    expect(result.stops[0].message).toContain('retire_race');
    expect(await exists('retire_race')).toBe(true);
    const left = await db.query('SELECT COUNT(*) AS n FROM "retire_race"');
    expect(Number(left.rows[0].n)).toBe(1);
    // The count ran inside the one batch: the table it would have created
    // went back with it.
    expect(await exists('retire_race_fresh')).toBe(false);
    if (hint === 'postgres')
      expect(result.statements).toContain(
        `DO $smrt_retire$ BEGIN LOCK TABLE ${target('retire_race')} IN ACCESS EXCLUSIVE MODE; EXCEPTION WHEN undefined_table THEN NULL; END $smrt_retire$`,
      );
  });

  it("an empty retired table needs no rows: 'discard'", async () => {
    await make('retire_empty', 0);
    declare(retired('retire_empty', { rows: undefined }));
    expect((await migrate()).applied).toBe(true);
    expect(await exists('retire_empty')).toBe(false);
  });

  it('stop 3: a foreign key from an undeclared table is named, and nothing drops', async () => {
    await make('retire_parent', 1);
    await db.query(
      `CREATE TABLE "undeclared_child" (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES "retire_parent"(id))`,
    );
    await db.query(`INSERT INTO "undeclared_child" VALUES ('c', '0')`);
    declare(retired('retire_parent'));

    const result = await migrate();

    expect(result.refused).toBe(true);
    expect(kinds(result)).toEqual(['table.retire-dependent']);
    expect(result.stops[0].message).toContain(
      'foreign key undeclared_child.parent_id',
    );
    expect(await exists('retire_parent')).toBe(true);
    const child = await db.query(
      'SELECT COUNT(*) AS n FROM "undeclared_child"',
    );
    expect(Number(child.rows[0].n)).toBe(1);
  });

  it('stop 3: every dependent is named one by one', async () => {
    await make('retire_deps', 0);
    await db.query(
      `CREATE TABLE "child_a" (id TEXT PRIMARY KEY, p TEXT REFERENCES "retire_deps"(id))`,
    );
    await db.query(
      `CREATE TABLE "child_b" (id TEXT PRIMARY KEY, p TEXT REFERENCES "retire_deps"(id))`,
    );
    await db.query(
      `CREATE VIEW "retire_deps_view" AS SELECT id FROM "retire_deps"`,
    );
    if (engine !== 'duckdb') {
      await db.query(`CREATE TABLE "audited" (id TEXT PRIMARY KEY)`);
      if (engine === 'sqlite') {
        await db.query(
          `CREATE TRIGGER "audit_trg" AFTER INSERT ON "audited" BEGIN INSERT INTO "retire_deps"(id) VALUES (new.id); END`,
        );
      } else {
        await db.query(
          `CREATE FUNCTION "audit_fn"() RETURNS trigger AS $$ BEGIN INSERT INTO "retire_deps"(id) VALUES (NEW.id); RETURN NEW; END $$ LANGUAGE plpgsql`,
        );
        await db.query(
          `CREATE TRIGGER "audit_trg" AFTER INSERT ON "audited" FOR EACH ROW EXECUTE FUNCTION "audit_fn"()`,
        );
      }
    }
    declare(retired('retire_deps'));

    const result = await migrate();

    expect(result.refused).toBe(true);
    const messages = result.stops.map((stop) => stop.message).join('\n');
    expect(messages).toContain('foreign key child_a.p');
    expect(messages).toContain('foreign key child_b.p');
    expect(messages).toContain('view retire_deps_view');
    if (engine !== 'duckdb')
      expect(messages).toContain('trigger audit_trg on audited');
    expect(new Set(kinds(result))).toEqual(new Set(['table.retire-dependent']));
    expect(result.stops).toHaveLength(engine === 'duckdb' ? 3 : 4);
    expect(await exists('retire_deps')).toBe(true);
    expect(await exists('child_a')).toBe(true);
  });

  it('drops tables that reference each other in one run, referencing table first', async () => {
    await make('retire_p', 1);
    await db.query(
      `CREATE TABLE "retire_c" (id TEXT PRIMARY KEY, p TEXT REFERENCES "retire_p"(id))`,
    );
    await db.query(`INSERT INTO "retire_c" VALUES ('c', '0')`);
    declare(
      retired('retire_p'),
      retired('retire_c', { definitions: shape('id', 'p') }),
    );

    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(result.statements).toEqual([drop('retire_c'), drop('retire_p')]);
    expect(await exists('retire_p')).toBe(false);
    expect(await exists('retire_c')).toBe(false);
  });

  it('drops a self-referencing retired table that holds rows', async () => {
    await db.query(
      `CREATE TABLE "retire_tree" (id TEXT PRIMARY KEY, parent TEXT REFERENCES "retire_tree"(id))`,
    );
    await db.query(`INSERT INTO "retire_tree" VALUES ('root', NULL)`);
    await db.query(`INSERT INTO "retire_tree" VALUES ('leaf', 'root')`);
    declare(retired('retire_tree', { definitions: shape('id', 'parent') }));

    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(await exists('retire_tree')).toBe(false);
  });

  const registerKeep = (tableName = 'retire_keep') => {
    class Keep extends SmrtObject {
      code = '';
    }
    field({ type: 'text' })(Keep.prototype, 'code');
    ObjectRegistry.register(Keep, { packageName: '@retire/other', tableName });
  };

  it('a run limited to unrelated tables goes ahead, neither planning nor reporting the retirement (R1)', async () => {
    registerKeep();
    await make('retire_limited', 1);
    declare(retired('retire_limited'));

    const limited = await migrate({ tables: ['retire_keep'] });

    expect(limited).toMatchObject({ refused: false, applied: true });
    expect(limited.stops).toEqual([]);
    expect(limited.statements.join('\n')).not.toContain('retire_limited');
    expect(await exists('retire_keep')).toBe(true);
    // Retiring waits for the next whole-schema migrate.
    expect(await exists('retire_limited')).toBe(true);

    const whole = await migrate();
    expect(whole).toMatchObject({ refused: false, applied: true });
    expect(await exists('retire_limited')).toBe(false);
  });

  it('requireComplete (lazy activation, the model editor) is not held back by a retirement that would stop (R1)', async () => {
    registerKeep();
    await make('retire_stopping', 2);
    // A whole-schema migrate stops on its rows; a limited run is unrelated.
    declare(retired('retire_stopping', { rows: undefined }));

    const limited = await migrate({
      tables: ['retire_keep'],
      requireComplete: true,
    });

    expect(limited).toMatchObject({ refused: false, applied: true });
    expect(await exists('retire_keep')).toBe(true);
    expect(await exists('retire_stopping')).toBe(true);
    expect(kinds(await migrate())).toEqual(['table.retire-rows']);
  });

  it('a run limited to tables stops when it would create a table under a retired name (R1, R10)', async () => {
    registerKeep('retire_reused');
    declare(retired('retire_reused'));

    const limited = await migrate({ tables: ['retire_reused'] });

    expect(limited).toMatchObject({ refused: true, applied: false });
    expect(limited.stops).toHaveLength(1);
    expect(limited.stops[0]).toMatchObject({ reason: 'retired-table' });
    expect(limited.stops[0].message).toContain('retire_reused');
    expect(limited.stops[0].message).toContain(PKG);
    expect(await exists('retire_reused')).toBe(false);
  });

  it('a run limited to tables stops when it would add to a live table under a retired name', async () => {
    registerKeep('retire_reused_live');
    await db.query(`CREATE TABLE "retire_reused_live" (id TEXT PRIMARY KEY)`);
    declare(retired('retire_reused_live'));

    const limited = await migrate({ tables: ['retire_reused_live'] });

    expect(limited.refused).toBe(true);
    expect(new Set(limited.stops.map((stop) => stop.reason))).toEqual(
      new Set(['retired-table']),
    );
  });

  it.runIf(engine !== 'duckdb')(
    'a run-time list stored in the app model journal counts as a declarer, even unregistered (R10)',
    async () => {
      // An app model editor made a list "Note" (table notes) and its rows; the
      // process running db:migrate never registered that run-time model.
      const tracker = new MigrationTracker({ db, engineHint: hint });
      await tracker.applyAll(
        appModelChangesMigrations(hint === 'postgres' ? 'postgres' : 'sqlite'),
        { postgresSafe: false, reconcile: false },
      );
      const doc = (lists: Record<string, unknown>) =>
        JSON.stringify({
          $schema: 'x',
          version: 1,
          models: { version: 1, packageName: '@retire/app', lists, fields: {} },
        });
      await db.query(
        `INSERT INTO _smrt_app_model_changes (application, tenant_id, revision, request_id, actor, command, before_doc, after_doc, status) VALUES ('app', '00000000-0000-4000-8000-0000000000aa', 1, 'r1', 'a', 'add', '${doc({})}', '${doc({ note: { label: 'Notes', icon: 'n', displayField: 'title', fields: {} } })}', 'applied')`,
      );
      await make('notes', 2);
      declare(retired('notes'));

      const result = await migrate();

      expect(result).toMatchObject({ refused: true, applied: false });
      expect(kinds(result)).toEqual(['table.retire-declared']);
      expect(result.stops[0].message).toContain('@retire/app:note');
      expect(await exists('notes')).toBe(true);
    },
  );

  it('planRuntimeModelDDL refuses to create a run-time table under a retired name (R10)', async () => {
    declare(retired('retire_runtime_items'));
    const name = registerRuntimeModel({
      packageName: '@retire/app',
      name: 'RetireRuntimeItem',
      tableName: 'retire_runtime_items',
      fields: { title: { type: 'text' } },
    });
    const refused = await planRuntimeModelDDL(name, hint, async () => null)
      .then(() => undefined)
      .catch((error: unknown) => error);
    // The named stop a run limited to tables returns, not a bare error (T3).
    expect(refused).toBeInstanceOf(RetiredTableInUseError);
    expect((refused as RetiredTableInUseError).stop).toMatchObject({
      kind: 'table.add',
      reason: 'retired-table',
      table: 'retire_runtime_items',
    });
    expect((refused as Error).message).toMatch(
      /retire_runtime_items.*declared retired/,
    );
    const adding = await planRuntimeModelDDL(name, hint, async () => ['id'])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect((adding as RetiredTableInUseError).stop.kind).toBe('column.add');
  });

  it('stops when the live table is not the one the declaration describes (R3: the table, not the name)', async () => {
    // Another table under the retired name: same name, other columns.
    await db.query(
      `CREATE TABLE "retire_collide" (id TEXT PRIMARY KEY, payload TEXT, amount INTEGER)`,
    );
    await db.query(`INSERT INTO "retire_collide" VALUES ('a', 'keep me', 3)`);
    declare(retired('retire_collide'));

    const result = await migrate();

    expect(result).toMatchObject({ refused: true, applied: false });
    expect(kinds(result)).toEqual(['table.retire-mismatch']);
    expect(result.stops[0].message).toContain('column v is missing');
    expect(result.stops[0].message).toContain(
      'column payload is not in the definition',
    );
    expect(await exists('retire_collide')).toBe(true);
  });

  it('stops on a declared type the live column does not have', async () => {
    await db.query(
      `CREATE TABLE "retire_typed" (id TEXT PRIMARY KEY, v INTEGER)`,
    );
    declare(retired('retire_typed'));
    const result = await migrate();
    expect(kinds(result)).toEqual(['table.retire-mismatch']);
    expect(result.stops[0].message).toMatch(/column v is .*declared TEXT/i);
    expect(await exists('retire_typed')).toBe(true);
  });

  // M3: the operator confirms a mismatch for named tables. Only the mismatch
  // stop is lifted; rows, dependents and declarations still stop.
  describe('a confirmed mismatch (confirmRetireTables)', () => {
    const collide = async (table: string, rows = 1) => {
      await db.query(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, payload TEXT)`,
      );
      for (let i = 0; i < rows; i++)
        await db.query(`INSERT INTO "${table}" VALUES ('${i}', 'x')`);
    };

    it('names the flag, the code form and the differences in the stop', async () => {
      await collide('retire_confirm_msg');
      declare(retired('retire_confirm_msg'));
      const result = await migrate();
      expect(kinds(result)).toEqual(['table.retire-mismatch']);
      const [stopped] = result.stops;
      expect(stopped.message).toContain(
        'release 0.9.0: column payload is not in the definition; column v is missing',
      );
      expect(stopped.message).toContain(
        "rerun with --confirm-retire-table retire_confirm_msg (in code: confirmRetireTables: ['retire_confirm_msg']) to retire it anyway; rows, dependents and declarations still stop.",
      );
    });

    it('drops the mismatching table and records who confirmed which differences', async () => {
      await collide('retire_confirm_drop', 2);
      await make('retire_confirm_keep', 0);
      declare(retired('retire_confirm_drop'));

      const result = await migrate({
        confirmRetireTables: ['retire_confirm_drop'],
      });

      expect(result.stops).toEqual([]);
      expect(result).toMatchObject({ refused: false, applied: true });
      expect(result.statements).toEqual([drop('retire_confirm_drop')]);
      expect(await exists('retire_confirm_drop')).toBe(false);
      expect(await exists('retire_confirm_keep')).toBe(true);
      expect(result.notices.join()).not.toContain('Ignoring');

      const records = await readConfirmedRetirements(db, { engineHint: hint });
      expect(records).toHaveLength(1);
      expect(records[0].retirements).toEqual([
        {
          table: 'retire_confirm_drop',
          packageName: PKG,
          lastOwner: OWNER,
          since: '1.0.0',
          by: 'code',
          differences: [
            'release 0.9.0: column payload is not in the definition; column v is missing',
          ],
        },
      ]);
      // A later run with nothing to confirm adds no confirmation.
      expect((await migrate()).refused).toBe(false);
      expect(
        await readConfirmedRetirements(db, { engineHint: hint }),
      ).toHaveLength(1);
    });

    it('plans the confirmed drop with its differences in getPendingSchemaStatements', async () => {
      await collide('retire_confirm_plan', 0);
      declare(retired('retire_confirm_plan'));
      const pending = await getPendingSchemaStatements(db, {
        engineHint: hint,
        confirmRetireTables: ['retire_confirm_plan'],
      });
      const change = pending.diff.changes.find(
        (item) => item.table === 'retire_confirm_plan',
      );
      expect(change?.kindHint).toBe('table.retire');
      expect(change?.retirement?.confirmed).toEqual({
        by: 'code',
        differences: [
          'release 0.9.0: column payload is not in the definition; column v is missing',
        ],
      });
      expect(change?.note).toContain(
        'Confirmed by confirmRetireTables in code',
      );
      expect(await exists('retire_confirm_plan')).toBe(true);
    });

    it("still stops on rows without rows: 'discard'", async () => {
      await collide('retire_confirm_rows', 2);
      declare(retired('retire_confirm_rows', { rows: undefined }));
      const result = await migrate({
        confirmRetireTables: ['retire_confirm_rows'],
      });
      expect(result).toMatchObject({ refused: true, applied: false });
      expect(kinds(result)).toEqual(['table.retire-rows']);
      expect(result.stops[0].message).toContain('holds 2 row(s)');
      expect(await exists('retire_confirm_rows')).toBe(true);
      expect(await readConfirmedRetirements(db, { engineHint: hint })).toEqual(
        [],
      );
    });

    it('still stops on a dependent', async () => {
      await collide('retire_confirm_parent', 1);
      await db.query(
        `CREATE TABLE "confirm_child" (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES "retire_confirm_parent"(id))`,
      );
      await db.query(`INSERT INTO "confirm_child" VALUES ('c', '0')`);
      declare(retired('retire_confirm_parent'));
      const result = await migrate({
        confirmRetireTables: ['retire_confirm_parent'],
      });
      expect(result.refused).toBe(true);
      expect(kinds(result)).toEqual(['table.retire-dependent']);
      expect(result.stops[0].message).toContain(
        'foreign key confirm_child.parent_id',
      );
      expect(await exists('retire_confirm_parent')).toBe(true);
    });

    it('still stops while a model declares the table', async () => {
      class Still extends SmrtObject {
        code = '';
      }
      field({ type: 'text' })(Still.prototype, 'code');
      ObjectRegistry.register(Still, {
        packageName: '@retire/still',
        tableName: 'retire_confirm_declared',
      });
      expect((await migrate()).refused).toBe(false);
      declare(retired('retire_confirm_declared'));
      const result = await migrate({
        confirmRetireTables: ['retire_confirm_declared'],
      });
      expect(result.refused).toBe(true);
      expect(kinds(result)).toEqual(['table.retire-declared']);
      expect(await exists('retire_confirm_declared')).toBe(true);
    });

    it('takes exact names only: no patterns, no prefixes; case as the engine compares names (R4)', async () => {
      await collide('retire_confirm_exact', 0);
      declare(retired('retire_confirm_exact'));
      for (const name of [
        'retire_confirm_%',
        'retire_confirm_*',
        'retire_confirm',
        'retire_confirm_exact ',
      ]) {
        const result = await migrate({ confirmRetireTables: [name] });
        expect(kinds(result)).toEqual(['table.retire-mismatch']);
        expect(result.notices).toContain(
          `Ignoring confirmRetireTables ${name}: no declared retirement of exactly this table stops on a definition mismatch.`,
        );
      }
      const upper = await migrate({
        confirmRetireTables: ['RETIRE_CONFIRM_EXACT'],
      });
      if (hint === 'postgres') {
        // PostgreSQL names the table exactly.
        expect(kinds(upper)).toEqual(['table.retire-mismatch']);
        expect(await exists('retire_confirm_exact')).toBe(true);
      } else {
        expect(upper).toMatchObject({ refused: false, applied: true });
        expect(await exists('retire_confirm_exact')).toBe(false);
      }
    });
  });

  it('stops on an entry that fails its checks however it arrived (R3, R9)', async () => {
    await make('retire_forged', 0);
    // A build description registered directly skips every loader.
    registerBuildSchema({
      tables: {},
      packages: [],
      source: 'forged',
      retired: [retired('retire_forged', { lastOwner: '@else/where:Gone' })],
    });
    try {
      const result = await migrate();
      expect(result.refused).toBe(true);
      expect(kinds(result)).toEqual(['table.retire-owner']);
      expect(result.stops[0].message).toContain('belongs to another package');
      expect(await exists('retire_forged')).toBe(true);
    } finally {
      registerBuildSchema(undefined);
    }
  });

  it('matches names without case where the engine does, and stops on a model spelled otherwise (R4)', async () => {
    class Shout extends SmrtObject {
      code = '';
    }
    field({ type: 'text' })(Shout.prototype, 'code');
    ObjectRegistry.register(Shout, {
      packageName: '@retire/other',
      tableName: 'RETIRE_SHOUT',
    });
    expect((await migrate()).refused).toBe(false);
    declare(retired('retire_shout'));
    const result = await migrate();
    if (hint === 'postgres') {
      // "RETIRE_SHOUT" is another table on PostgreSQL: nothing is live.
      expect(result.stops).toEqual([]);
    } else {
      expect(kinds(result)).toEqual(['table.retire-declared']);
      expect(result.stops[0].message).toContain('@retire/other');
    }
    expect(await exists('RETIRE_SHOUT')).toBe(true);
  });

  it.runIf(engine !== 'pglite')(
    'drops a mixed-case live table its lower-case declaration names (R4)',
    async () => {
      await db.query(
        `CREATE TABLE "Retire_Mixed" (id TEXT PRIMARY KEY, v TEXT)`,
      );
      declare(retired('retire_mixed'));
      const result = await migrate();
      expect(result).toMatchObject({ refused: false, applied: true });
      expect(await exists('Retire_Mixed')).toBe(false);
    },
  );

  it('stops while a single-table-inheritance subclass in another package declares the table', async () => {
    const object = (
      packageName: string,
      className: string,
      extra: Record<string, unknown>,
    ) =>
      ({
        name: className.toLowerCase(),
        className,
        collection: `${className.toLowerCase()}s`,
        filePath: `/${packageName}/${className}.ts`,
        fields: { code: { type: 'text' } },
        methods: {},
        packageName,
        ...extra,
      }) as never;
    ObjectRegistry.registerFromManifest(
      '@retire/base:RetireBase',
      object('@retire/base', 'RetireBase', {
        decoratorConfig: { tableStrategy: 'sti', tableName: 'retire_sti' },
        extends: 'SmrtObject',
      }),
      '@retire/base',
    );
    ObjectRegistry.registerFromManifest(
      '@retire/sti-child:RetireSub',
      object('@retire/sti-child', 'RetireSub', {
        decoratorConfig: {},
        extends: '@retire/base:RetireBase',
      }),
      '@retire/sti-child',
    );
    expect((await migrate()).refused).toBe(false);
    expect(await exists('retire_sti')).toBe(true);
    declare(retired('retire_sti'));
    const result = await migrate();
    expect(kinds(result)).toEqual(['table.retire-declared']);
    expect(result.stops[0].message).toContain('@retire/sti-child:RetireSub');
    expect(await exists('retire_sti')).toBe(true);
  });

  it('two packages retiring one table: dropped once, and only when both let the rows go', async () => {
    const OTHER = '@retire/second';
    await make('retire_shared', 1);
    const second = (extra: Partial<RetiredTable> = {}) =>
      retired('retire_shared', {
        lastOwner: `${OTHER}:Gone`,
        packageName: OTHER,
        ...extra,
      });
    declare(retired('retire_shared'));
    registerRetiredTables(OTHER, [second({ rows: undefined })]);

    const kept = await migrate();
    expect(kinds(kept)).toEqual(['table.retire-rows']);
    expect(kept.stops[0].message).toContain(`${OTHER}:Gone`);
    expect(await exists('retire_shared')).toBe(true);

    registerRetiredTables(OTHER, [second()]);
    const dropped = await migrate();
    expect(dropped).toMatchObject({ refused: false, applied: true });
    expect(dropped.statements).toEqual([drop('retire_shared')]);
    expect(await exists('retire_shared')).toBe(false);
  });

  it.runIf(engine === 'sqlite')(
    'names a foreign key with SQLite foreign keys off, where DROP would not refuse',
    async () => {
      await db.query('PRAGMA foreign_keys = OFF');
      await make('retire_fk_off', 1);
      await db.query(
        `CREATE TABLE "fk_off_child" (id TEXT PRIMARY KEY, p TEXT REFERENCES "retire_fk_off"(id))`,
      );
      await db.query(`INSERT INTO "fk_off_child" VALUES ('c', '0')`);
      declare(retired('retire_fk_off'));
      const result = await migrate();
      expect(kinds(result)).toEqual(['table.retire-dependent']);
      expect(result.stops[0].message).toContain('foreign key fk_off_child.p');
      expect(await exists('retire_fk_off')).toBe(true);
    },
  );

  it.runIf(engine === 'duckdb')(
    'names a DuckDB macro that reads the table',
    async () => {
      await make('retire_macro_src', 0);
      await db.query(
        `CREATE MACRO retire_macro_count() AS (SELECT count(*) FROM retire_macro_src)`,
      );
      declare(retired('retire_macro_src'));
      const result = await migrate();
      expect(kinds(result)).toEqual(['table.retire-dependent']);
      expect(result.stops[0].message).toContain('macro retire_macro_count');
    },
  );

  it.runIf(engine === 'duckdb')(
    'the JSON adapter never drops, and records no migrate while the table is live (R7)',
    async () => {
      await make('retire_json', 0);
      declare(retired('retire_json'));
      const refused = await migrate({ engineHint: 'json' });
      expect(refused.refused).toBe(true);
      expect(kinds(refused)).toEqual(['table.retire-unsupported']);
      expect(await exists('retire_json')).toBe(true);
      expect((await readLastMigrateRecord(db)).state).toBe('none');

      await db.query('DROP TABLE "retire_json"');
      const clean = await migrate({ engineHint: 'json' });
      expect(clean.refused).toBe(false);
      expect((await readLastMigrateRecord(db)).state).toBe('recorded');
    },
  );

  it.runIf(engine === 'pglite')(
    'reads, counts and drops the public table whatever the search_path (R5)',
    async () => {
      await make('retire_sp', 0);
      await db.query('CREATE SCHEMA IF NOT EXISTS "retire_other"');
      await db.query(
        `CREATE TABLE "retire_other"."retire_sp" (id TEXT PRIMARY KEY, v TEXT)`,
      );
      await db.query(
        `INSERT INTO "retire_other"."retire_sp" VALUES ('keep', 'x')`,
      );
      declare(retired('retire_sp', { rows: undefined }));
      await db.query('SET search_path TO "retire_other", public');
      try {
        const result = await migrate();
        expect(result).toMatchObject({ refused: false, applied: true });
        expect(result.statements).toContain(drop('retire_sp'));
      } finally {
        await db.query('SET search_path TO public');
      }
      expect(await exists('retire_sp')).toBe(false);
      const other = await db.query(
        `SELECT COUNT(*) AS n FROM "retire_other"."retire_sp"`,
      );
      expect(Number(other.rows[0].n)).toBe(1);
    },
  );

  it.runIf(engine === 'pglite')(
    'names every PostgreSQL dependent pg_depend records, and functions whose body names the table (R6)',
    async () => {
      await db.query(
        `CREATE TABLE "retire_pgdeps" (id TEXT PRIMARY KEY, v TEXT)`,
      );
      await db.query(
        'CREATE SEQUENCE "retire_pgdeps_seq" OWNED BY "retire_pgdeps"."v"',
      );
      // Another table's default uses the sequence it owns.
      await db.query(
        `CREATE TABLE "pgdeps_seq_user" (id TEXT PRIMARY KEY, n BIGINT DEFAULT nextval('retire_pgdeps_seq'))`,
      );
      // A column of its row type.
      await db.query(
        `CREATE TABLE "pgdeps_rowtype" (id TEXT PRIMARY KEY, snap "retire_pgdeps")`,
      );
      // A table that inherits it.
      await db.query(
        `CREATE TABLE "pgdeps_child" (extra TEXT) INHERITS ("retire_pgdeps")`,
      );
      // A policy on another table that reads it.
      await db.query(`CREATE TABLE "pgdeps_guarded" (id TEXT PRIMARY KEY)`);
      await db.query(
        `CREATE POLICY "pgdeps_policy" ON "pgdeps_guarded" USING (EXISTS (SELECT 1 FROM "retire_pgdeps" r WHERE r.id = "pgdeps_guarded".id))`,
      );
      // A function, not a trigger, whose body names it.
      await db.query(
        `CREATE FUNCTION "pgdeps_count"() RETURNS bigint AS $$ BEGIN RETURN (SELECT count(*) FROM retire_pgdeps); END $$ LANGUAGE plpgsql`,
      );
      // Not a dependent: a function naming a longer table.
      await db.query(
        `CREATE FUNCTION "pgdeps_unrelated"() RETURNS bigint AS $$ BEGIN RETURN (SELECT count(*) FROM pgdeps_guarded) + length('retire_pgdeps_x'); END $$ LANGUAGE plpgsql`,
      );
      declare(retired('retire_pgdeps'));
      try {
        const result = await migrate();
        expect(result.refused).toBe(true);
        expect(new Set(kinds(result))).toEqual(
          new Set(['table.retire-dependent']),
        );
        const messages = result.stops.map((stop) => stop.message).join('\n');
        expect(messages).toContain('column default pgdeps_seq_user.n');
        expect(messages).toContain('column pgdeps_rowtype.snap');
        expect(messages).toContain('inheriting table pgdeps_child');
        expect(messages).toContain('policy pgdeps_policy on pgdeps_guarded');
        expect(messages).toContain('function pgdeps_count()');
        expect(messages).not.toContain('pgdeps_unrelated');
        expect(await exists('retire_pgdeps')).toBe(true);
      } finally {
        await db.query(
          'DROP TABLE IF EXISTS "pgdeps_seq_user", "pgdeps_rowtype", "pgdeps_child", "pgdeps_guarded", "retire_pgdeps" CASCADE',
        );
        await db.query(
          'DROP FUNCTION IF EXISTS "pgdeps_count"(), "pgdeps_unrelated"()',
        );
      }
    },
  );

  // M1, M6: a column the ordinary migrate would converge without losing data
  // is the same table; the check proves identity, not convergence.
  const typed = (
    table: string,
    columns: Record<
      string,
      RetiredTable['definitions'][number]['columns'][string]
    >,
    extra: Partial<RetiredTable> = {},
  ) =>
    retired(table, {
      definitions: [{ release: '0.9.0', columns }],
      ...extra,
    });

  it('matches a live int4 column declared INTEGER', async () => {
    await db.query(`CREATE TABLE "retire_int4" (id TEXT PRIMARY KEY, n INT4)`);
    await db.query(`INSERT INTO "retire_int4" VALUES ('a', 3)`);
    declare(
      typed('retire_int4', { id: { type: 'TEXT' }, n: { type: 'INTEGER' } }),
    );
    const result = await migrate();
    expect(result.stops).toEqual([]);
    expect(result).toMatchObject({ refused: false, applied: true });
    expect(await exists('retire_int4')).toBe(false);
  });

  it('matches a live VARCHAR(n) column declared TEXT', async () => {
    await db.query(
      `CREATE TABLE "retire_varchar" (id TEXT PRIMARY KEY, code VARCHAR(40))`,
    );
    await db.query(`INSERT INTO "retire_varchar" VALUES ('a', 'x')`);
    declare(
      typed('retire_varchar', { id: { type: 'TEXT' }, code: { type: 'TEXT' } }),
    );
    const result = await migrate();
    expect(result.stops).toEqual([]);
    expect(await exists('retire_varchar')).toBe(false);
  });

  it('matches a uuid held as text, for an id and a reference', async () => {
    await db.query(
      `CREATE TABLE "retire_uuid_text" (id TEXT PRIMARY KEY, owner_id TEXT)`,
    );
    await db.query(
      `INSERT INTO "retire_uuid_text" VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')`,
    );
    declare(
      typed('retire_uuid_text', {
        id: { type: 'UUID', referenceKind: 'id' },
        owner_id: { type: 'UUID', referenceKind: 'foreignKey' },
      }),
    );
    const result = await migrate();
    expect(result.stops).toEqual([]);
    expect(await exists('retire_uuid_text')).toBe(false);
  });

  it('a live timestamp column declared TIMESTAMP: on PostgreSQL only with postgresTimestampMigration, as the ordinary migrate (M1, M2)', async () => {
    await db.query(
      `CREATE TABLE "retire_ts" (id TEXT PRIMARY KEY, seen_at TIMESTAMP)`,
    );
    await db.query(
      `INSERT INTO "retire_ts" VALUES ('a', '2024-01-02 03:04:05')`,
    );
    declare(
      typed('retire_ts', {
        id: { type: 'TEXT' },
        seen_at: { type: 'TIMESTAMP' },
      }),
    );
    if (hint === 'postgres') {
      // Without the opt-in the ordinary migrate stops on timestamp ->
      // timestamptz, so the retirement does too.
      const plain = await migrate();
      expect(kinds(plain)).toEqual(['table.retire-mismatch']);
      expect(plain.stops[0].message).toContain('column seen_at is');
      expect(plain.stops[0].message).toContain('release 0.9.0');
      expect(await exists('retire_ts')).toBe(true);
    }
    const result = await migrate({
      postgresTimestampMigration: { legacyTimezone: 'UTC' },
    });
    expect(result.stops).toEqual([]);
    expect(await exists('retire_ts')).toBe(false);
  });

  it.runIf(engine === 'pglite')(
    'honours emptyTextAsNull: empty text in a column declared TIMESTAMP (M2)',
    async () => {
      await db.query(
        `CREATE TABLE "retire_empty_ts" (id TEXT PRIMARY KEY, at TEXT)`,
      );
      await db.query(
        `INSERT INTO "retire_empty_ts" VALUES ('a', ''), ('b', '2024-01-02T03:04:05Z')`,
      );
      declare(
        typed('retire_empty_ts', {
          id: { type: 'TEXT' },
          at: { type: 'TIMESTAMP' },
        }),
      );
      expect(kinds(await migrate())).toEqual(['table.retire-mismatch']);
      const result = await migrate({ emptyTextAsNull: true });
      expect(result.stops).toEqual([]);
      expect(await exists('retire_empty_ts')).toBe(false);
    },
  );

  it("compares with the run's opt-ins: postgresTimestampMigration, emptyTextAsNull, relaxColumns (M2)", async () => {
    await make('retire_optins', 0);
    declare(retired('retire_optins'));
    const seen: Array<Record<string, unknown>> = [];
    // A plain wrapper: record the comparer's options, then compare as usual.
    const original = SchemaComparer.prototype.compareTable;
    SchemaComparer.prototype.compareTable = async function (
      this: SchemaComparer,
      ...args: Parameters<SchemaComparer['compareTable']>
    ) {
      if (String(args[1]?.version).startsWith('retired:'))
        seen.push(
          (this as unknown as { options: Record<string, unknown> }).options,
        );
      return original.apply(this, args);
    };
    try {
      await migrate({
        postgresTimestampMigration: { legacyTimezone: 'UTC' },
        emptyTextAsNull: true,
        relaxColumns: true,
      });
    } finally {
      SchemaComparer.prototype.compareTable = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      postgresTimestampMigration: { legacyTimezone: 'UTC' },
      emptyTextAsNull: true,
      relaxColumns: true,
    });
    expect(await exists('retire_optins')).toBe(false);
  });

  // T7: shapes that are not the declared table.
  it('stops when the definition lists only some of the live columns', async () => {
    await db.query(
      `CREATE TABLE "retire_subset" (id TEXT PRIMARY KEY, v TEXT, extra TEXT)`,
    );
    declare(retired('retire_subset'));
    const result = await migrate();
    expect(kinds(result)).toEqual(['table.retire-mismatch']);
    expect(result.stops[0].message).toContain(
      'column extra is not in the definition',
    );
    expect(result.stops[0].message).not.toContain('is missing');
    expect(await exists('retire_subset')).toBe(true);
  });

  it('stops when the live table lacks a declared column', async () => {
    await db.query(`CREATE TABLE "retire_short" (id TEXT PRIMARY KEY)`);
    declare(retired('retire_short'));
    const result = await migrate();
    expect(kinds(result)).toEqual(['table.retire-mismatch']);
    expect(result.stops[0].message).toContain('column v is missing');
    expect(await exists('retire_short')).toBe(true);
  });

  it.runIf(engine === 'sqlite')(
    'reads every live column, generated ones included (T8)',
    async () => {
      await db.query(
        `CREATE TABLE "retire_gen" (id TEXT PRIMARY KEY, v TEXT, g TEXT GENERATED ALWAYS AS (v) VIRTUAL)`,
      );
      declare(retired('retire_gen'));
      const result = await migrate();
      expect(kinds(result)).toEqual(['table.retire-mismatch']);
      expect(result.stops[0].message).toContain(
        'column g is not in the definition',
      );
      expect(await exists('retire_gen')).toBe(true);
    },
  );

  it('a database at an older table shape matches that release of the definitions, and only that', async () => {
    // The table as release 0.9.0 left it; 1.0.0 added a column.
    await make('retire_older', 1);
    const v1 = {
      release: '1.0.0',
      columns: {
        id: { type: 'TEXT' as const },
        v: { type: 'TEXT' as const },
        w: { type: 'TEXT' as const },
      },
    };
    declare(retired('retire_older', { definitions: [v1] }));
    const latestOnly = await migrate();
    expect(kinds(latestOnly)).toEqual(['table.retire-mismatch']);
    expect(latestOnly.stops[0].message).toContain(
      'release 1.0.0: column w is missing',
    );
    expect(await exists('retire_older')).toBe(true);

    declare(
      retired('retire_older', {
        definitions: [...retired('x').definitions, v1],
      }),
    );
    const both = await migrate();
    expect(both).toMatchObject({ refused: false, applied: true });
    expect(await exists('retire_older')).toBe(false);
  });

  it.runIf(engine !== 'duckdb')(
    'a journal that is not there is nothing; one that cannot be read stops the retirement (T7)',
    async () => {
      await make('retire_journal', 0);
      declare(retired('retire_journal'));
      const tracker = new MigrationTracker({ db, engineHint: hint });
      await tracker.applyAll(
        appModelChangesMigrations(hint === 'postgres' ? 'postgres' : 'sqlite'),
        { postgresSafe: false, reconcile: false },
      );
      await db.query(
        `INSERT INTO _smrt_app_model_changes (application, tenant_id, revision, request_id, actor, command, before_doc, after_doc, status) VALUES ('app', '00000000-0000-4000-8000-0000000000aa', 1, 'r1', 'a', 'add', '{}', 'not json', 'applied')`,
      );
      const result = await migrate();
      expect(kinds(result)).toEqual(['table.retire-declared']);
      expect(result.stops[0].message).toContain('is not valid JSON');
      expect(await exists('retire_journal')).toBe(true);

      await db.query('DROP TABLE _smrt_app_model_changes');
      const clean = await migrate();
      expect(clean).toMatchObject({ refused: false, applied: true });
      expect(await exists('retire_journal')).toBe(false);
    },
  );

  it.runIf(engine === 'sqlite')(
    'drops with SQLite foreign keys off when nothing depends on the table',
    async () => {
      await db.query('PRAGMA foreign_keys = OFF');
      await make('retire_fk_off_free', 2);
      declare(retired('retire_fk_off_free'));
      const result = await migrate();
      expect(result).toMatchObject({ refused: false, applied: true });
      expect(await exists('retire_fk_off_free')).toBe(false);
    },
  );

  // T2: two migrate runs at once both plan the drop. The second finds the
  // table gone and ends cleanly: nothing to do.
  it.each([
    ['without', undefined],
    ['with', 'discard' as const],
  ])("two concurrent whole-schema runs both end cleanly, %s rows: 'discard' (T2)", async (_label, rows) => {
    await make('retire_twice', 0);
    declare(retired('retire_twice', { rows }));
    const [first, second] = await Promise.all([migrate(), migrate()]);
    for (const result of [first, second]) {
      expect(result.refused).toBe(false);
      expect(result.stops).toEqual([]);
    }
    expect(await exists('retire_twice')).toBe(false);
    expect((await migrate()).statements).toEqual([]);
  });

  it('a run whose planned table another run dropped before its batch ends cleanly (T2)', async () => {
    await make('retire_gone_meanwhile', 0);
    declare(retired('retire_gone_meanwhile', { rows: undefined }));
    // The other run's drop commits right after this run's plan counted rows.
    let dropped = false;
    const racing = new Proxy(db, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== 'query' || typeof value !== 'function')
          return typeof value === 'function' ? value.bind(target) : value;
        return async (sql: string, ...args: unknown[]) => {
          const result = await value.call(target, sql, ...args);
          if (
            !dropped &&
            /^SELECT COUNT\(\*\) AS n FROM/.test(sql) &&
            sql.includes('retire_gone_meanwhile')
          ) {
            dropped = true;
            await value.call(target, 'DROP TABLE "retire_gone_meanwhile"');
          }
          return result;
        };
      },
    });
    const result = await migrateSmrtSchemas({
      db: racing,
      packageName: '@retire/app',
      name: `retire_${++runs}`,
      engineHint: hint,
      ...options,
    });
    expect(dropped).toBe(true);
    expect(result).toMatchObject({ refused: false });
    expect(result.stops).toEqual([]);
    expect(await exists('retire_gone_meanwhile')).toBe(false);
  });

  it('a run whose count finds the table already dropped by another run plans nothing for it (T2)', async () => {
    await make('retire_gone_first', 0);
    declare(retired('retire_gone_first', { rows: undefined }));
    let dropped = false;
    const racing = new Proxy(db, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== 'query' || typeof value !== 'function')
          return typeof value === 'function' ? value.bind(target) : value;
        return async (sql: string, ...args: unknown[]) => {
          if (
            !dropped &&
            /^SELECT COUNT\(\*\) AS n FROM/.test(sql) &&
            sql.includes('retire_gone_first')
          ) {
            dropped = true;
            await value.call(target, 'DROP TABLE "retire_gone_first"');
          }
          return value.call(target, sql, ...args);
        };
      },
    });
    const result = await migrateSmrtSchemas({
      db: racing,
      packageName: '@retire/app',
      name: `retire_${++runs}`,
      engineHint: hint,
      ...options,
    });
    expect(dropped).toBe(true);
    expect(result).toMatchObject({ refused: false, applied: false });
    expect(result.stops).toEqual([]);
  });

  it.runIf(engine === 'duckdb')(
    'DuckDB: a row another connection commits after the batch began stops the drop, and survives (T1)',
    async () => {
      // Two connections to one database: the adapter opens its own instance,
      // so share one through DuckDB's instance cache for this test.
      const sqlDir = path.dirname(
        realpathSync(
          path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../node_modules/@happyvertical/sql/package.json',
          ),
        ),
      );
      const { DuckDBInstance } = createRequire(
        path.join(sqlDir, 'package.json'),
      )('@duckdb/node-api') as {
        DuckDBInstance: {
          create: (...args: unknown[]) => Promise<unknown>;
          fromCache: (...args: unknown[]) => Promise<unknown>;
        };
      };
      const dir = mkdtempSync(path.join(tmpdir(), 'retire-duck-'));
      const file = path.join(dir, 'race.duckdb');
      const create = DuckDBInstance.create;
      DuckDBInstance.create = (...args) => DuckDBInstance.fromCache(...args);
      let mine: typeof db | undefined;
      let other: typeof db | undefined;
      try {
        mine = (await getDatabase({ type: 'duckdb', url: file })) as typeof db;
        other = (await getDatabase({ type: 'duckdb', url: file })) as typeof db;
      } finally {
        DuckDBInstance.create = create;
      }
      try {
        await mine.query(
          `CREATE TABLE "retire_duck_race" (id TEXT PRIMARY KEY, v TEXT)`,
        );
        // Both connections see one database.
        expect(
          Number(
            (await other.query('SELECT COUNT(*) AS n FROM "retire_duck_race"'))
              .rows[0].n,
          ),
        ).toBe(0);
        declare(retired('retire_duck_race', { rows: undefined }));
        let wrote = false;
        const writer = other;
        const racing = new Proxy(mine, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (key !== 'transaction' || typeof value !== 'function')
              return typeof value === 'function' ? value.bind(target) : value;
            return (work: (tx: typeof db) => Promise<unknown>) =>
              value.call(target, async (tx: typeof db) =>
                work({
                  ...tx,
                  query: async (sql: string, ...args: unknown[]) => {
                    if (!wrote && sql.includes('smrt_retire_guard_rows')) {
                      wrote = true;
                      // The batch's snapshot is taken; then an old instance
                      // commits a row on its own connection.
                      await tx.query('SELECT COUNT(*) FROM "retire_duck_race"');
                      await writer.query(
                        `INSERT INTO "retire_duck_race" VALUES ('late', 'x')`,
                      );
                    }
                    return tx.query(sql, ...(args as []));
                  },
                } as typeof db),
              );
          },
        });
        const result = await migrateSmrtSchemas({
          db: racing,
          packageName: '@retire/app',
          name: `retire_${++runs}`,
          engineHint: 'duckdb',
        });
        expect(wrote).toBe(true);
        expect(result).toMatchObject({ refused: true, applied: false });
        expect(kinds(result)).toEqual(['table.retire-rows']);
        const left = await other.query(
          'SELECT COUNT(*) AS n FROM "retire_duck_race"',
        );
        expect(Number(left.rows[0].n)).toBe(1);
      } finally {
        await other?.close?.().catch(() => {});
        await mine?.close?.().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(engine === 'duckdb')(
    'the JSON adapter stops end to end and never drops (R7, T7)',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'retire-json-'));
      const json = (await getDatabase({
        type: 'json',
        url: dir,
      } as never)) as typeof db;
      try {
        await json.query(
          `CREATE TABLE "retire_json_e2e" (id TEXT PRIMARY KEY, v TEXT)`,
        );
        declare(retired('retire_json_e2e'));
        const result = await migrateSmrtSchemas({
          db: json,
          packageName: '@retire/app',
          name: `retire_${++runs}`,
        });
        expect(result.refused).toBe(true);
        expect(kinds(result)).toEqual(['table.retire-unsupported']);
        const still = await json.query(
          `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'retire_json_e2e'`,
        );
        expect(Number(still.rows[0].n)).toBe(1);
      } finally {
        await json.close?.();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('classifies every retire change in the table of kinds', async () => {
    await make('retire_kinds', 1);
    declare(retired('retire_kinds', { rows: undefined }));
    const result = await migrate();
    for (const stop of result.stops) {
      expect(classifySchemaChange(stop.change)).toBe('table.retire-rows');
      expect(decideSchemaChange(stop.change, hint).decision).toBe('stop');
    }
    expect(result.stops).toHaveLength(1);
  });
});
