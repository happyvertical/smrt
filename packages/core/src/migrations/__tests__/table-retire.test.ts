/**
 * The retire step (#5005): migrate drops a table only when a package declares
 * it retired, no model declares it and the run is a whole-schema migrate. The
 * three stops are named, never thrown, and nothing undeclared is dropped.
 *
 * Runs on SQLite with foreign keys ON and on DuckDB by default; under
 * `pnpm test:pglite` on PGlite for PostgreSQL semantics. The real-server
 * counterpart is `table-retire-postgres.optional.test.ts`.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import { classifySchemaChange, decideSchemaChange } from '../change-kinds.js';
import {
  type MigrateSmrtSchemasResult,
  migrateSmrtSchemas,
} from '../orchestrate.js';
import type { RetiredTable } from '../retired-tables.js';

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
  packageName: PKG,
  ...extra,
});

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
    ObjectRegistry.registerRetiredTables(PKG, tables);
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
  const kinds = (result: MigrateSmrtSchemasResult) =>
    result.stops.map((stop) => stop.kind);

  it('drops a declared retired table with its rows, in one atomic run', async () => {
    await make('retire_orders_old', 3);
    await make('keep_me', 1);
    declare(retired('retire_orders_old'));

    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(result.statements).toEqual([
      'DROP TABLE IF EXISTS "retire_orders_old"',
    ]);
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
        'LOCK TABLE "retire_race" IN ACCESS EXCLUSIVE MODE',
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
    declare(retired('retire_p'), retired('retire_c'));

    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(result.statements).toEqual([
      'DROP TABLE IF EXISTS "retire_c"',
      'DROP TABLE IF EXISTS "retire_p"',
    ]);
    expect(await exists('retire_p')).toBe(false);
    expect(await exists('retire_c')).toBe(false);
  });

  it('drops a self-referencing retired table that holds rows', async () => {
    await db.query(
      `CREATE TABLE "retire_tree" (id TEXT PRIMARY KEY, parent TEXT REFERENCES "retire_tree"(id))`,
    );
    await db.query(`INSERT INTO "retire_tree" VALUES ('root', NULL)`);
    await db.query(`INSERT INTO "retire_tree" VALUES ('leaf', 'root')`);
    declare(retired('retire_tree'));

    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(await exists('retire_tree')).toBe(false);
  });

  it('a run limited to named tables refuses the retirement and drops nothing', async () => {
    class Keep extends SmrtObject {
      code = '';
    }
    field({ type: 'text' })(Keep.prototype, 'code');
    ObjectRegistry.register(Keep, {
      packageName: '@retire/other',
      tableName: 'retire_keep',
    });
    await make('retire_limited', 1);
    declare(retired('retire_limited'));

    const limited = await migrate({ tables: ['retire_keep'] });

    expect(limited).toMatchObject({ refused: true, applied: false });
    expect(limited.stops).toHaveLength(1);
    expect(limited.stops[0]).toMatchObject({
      kind: 'table.retire',
      reason: 'whole-schema-only',
    });
    expect(limited.stops[0].message).toContain('smrt db:migrate');
    expect(await exists('retire_limited')).toBe(true);
    // Nothing of the limited run was created either.
    expect(await exists('retire_keep')).toBe(false);

    const whole = await migrate();
    expect(whole).toMatchObject({ refused: false, applied: true });
    expect(await exists('retire_limited')).toBe(false);
    expect(await exists('retire_keep')).toBe(true);
  });

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
