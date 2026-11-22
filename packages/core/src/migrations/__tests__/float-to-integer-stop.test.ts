/**
 * #5454: a floating-point column whose field becomes integer stops the migrate
 * on every engine with `type.float-to-integer`, pointing at the money rescale.
 * migrate cannot tell money in major units (a field declared `= 0.0` before
 * v0.41) from any other number, and casting `10.00` dollars to `10` would read
 * as ten cents. Whole values are not proof of the unit, so they stop too.
 *
 * Runs on SQLite and DuckDB by default; under `pnpm test:pglite` on PGlite for
 * PostgreSQL semantics.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import { classifySchemaChange, decideSchemaChange } from '../change-kinds.js';
import { SchemaComparer } from '../differ.js';
import { createMigrationDefinition } from '../generator.js';
import { rescaleMoneyColumnsToMinorUnits } from '../minor-units.js';
import {
  getPendingSchemaStatements,
  type MigrateSmrtSchemasResult,
  migrateSmrtSchemas,
} from '../orchestrate.js';
import { MigrationTracker } from '../tracker.js';

const PKG = '@money5454/app';

type Engine = 'sqlite' | 'duckdb' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite', 'duckdb'];

describe.each(
  engines,
)('a floating-point column becoming integer on %s (#5454)', (engine) => {
  const hint = engine === 'pglite' ? 'postgres' : engine;
  const options =
    hint === 'postgres'
      ? { postgresSafe: false, useConcurrentIndexes: false }
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
        : ((await getDatabase({ type: engine, url: ':memory:' })) as typeof db);
  });
  afterEach(async () => {
    await db.close?.();
    restore();
  });

  const migrate = (): Promise<MigrateSmrtSchemasResult> =>
    migrateSmrtSchemas({
      db,
      packageName: PKG,
      name: `money_${++runs}`,
      engineHint: hint,
      ...options,
    });
  /** `price` is declared `type`; `withNote` adds an unrelated new model. */
  const register = (type: 'decimal' | 'integer', withNote = false) => {
    ObjectRegistry.clear();
    class MoneyPlan extends SmrtObject {
      price = 0;
      label = '';
    }
    field({ type })(MoneyPlan.prototype, 'price');
    field({ type: 'text' })(MoneyPlan.prototype, 'label');
    ObjectRegistry.register(MoneyPlan, {
      packageName: PKG,
      tableName: 'money_plans',
    });
    if (withNote) {
      class MoneyNote extends SmrtObject {
        body = '';
      }
      field({ type: 'text' })(MoneyNote.prototype, 'body');
      ObjectRegistry.register(MoneyNote, {
        packageName: PKG,
        tableName: 'money_notes',
      });
    }
  };
  const insert = async (slug: string, price: number) =>
    db.query(
      `INSERT INTO money_plans (id, slug, price, label) VALUES ('${crypto.randomUUID()}', '${slug}', ${price}, 'x')`,
    );
  const prices = async () =>
    (
      (await db.query('SELECT price FROM money_plans ORDER BY slug'))
        .rows as Array<{
        price: unknown;
      }>
    ).map((row) => Number(row.price));
  const tableExists = async (table: string) => {
    const sql =
      hint === 'postgres'
        ? `SELECT 1 FROM information_schema.tables WHERE table_name = '${table}'`
        : hint === 'duckdb'
          ? `SELECT 1 FROM duckdb_tables() WHERE table_name = '${table}'`
          : `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${table}'`;
    return (await db.query(sql)).rows.length > 0;
  };

  it('stops on whole values instead of reading dollars as cents, and holds everything back', async () => {
    register('decimal');
    expect((await migrate()).refused).toBe(false);
    await insert('a', 10);
    await insert('b', 25);
    await insert('c', 500);

    register('integer', true);
    const result = await migrate();

    expect(result).toMatchObject({ refused: true, applied: false });
    expect(result.stops.map((stop) => stop.kind)).toEqual([
      'type.float-to-integer',
    ]);
    const [stop] = result.stops;
    expect(stop.reason).toBe('loses-data');
    expect(stop.message).toContain('money_plans.price');
    expect(stop.message).toContain('rescaleMoneyColumnsToMinorUnits');
    expect(await prices()).toEqual([10, 25, 500]);
    expect(await tableExists('money_notes')).toBe(false);
  });

  it('stops on fractional values with the same named stop', async () => {
    register('decimal');
    expect((await migrate()).refused).toBe(false);
    // 19.75 is exact in single precision (DuckDB's REAL) too.
    await insert('a', 19.75);

    register('integer');
    const result = await migrate();

    expect(result.refused).toBe(true);
    expect(result.stops.map((stop) => stop.kind)).toEqual([
      'type.float-to-integer',
    ]);
    expect(await prices()).toEqual([19.75]);
  });

  const declaredPriceType = async () =>
    hint === 'sqlite'
      ? String(
          (
            (await db.query('PRAGMA table_info("money_plans")')).rows as Array<{
              name: string;
              type: string;
            }>
          ).find((row) => row.name === 'price')?.type,
        )
      : String(
          (
            await db.query(
              `SELECT data_type FROM information_schema.columns WHERE table_name = 'money_plans' AND column_name = 'price'`,
            )
          ).rows[0]?.data_type,
        );

  // PostgreSQL: the rescale changes the type. SQLite: it rewrites the values
  // and records the column, and migrate rebuilds the declaration.
  it.runIf(hint !== 'duckdb')(
    'converts after the money rescale, and the next migrate has nothing to stop on',
    async () => {
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      await insert('a', 19.75);

      const rescale = await rescaleMoneyColumnsToMinorUnits(
        db,
        [{ table: 'money_plans', columns: ['price'] }],
        { backfillName: 'money5454:v1', engineHint: hint },
      );
      expect(rescale.ran).toBe(true);
      expect(await prices()).toEqual([1975]);

      register('integer', true);
      const result = await migrate();
      expect(result.refused).toBe(false);
      expect(result.stops).toEqual([]);
      expect(await prices()).toEqual([1975]);
      expect(await declaredPriceType()).toMatch(/^(INTEGER|bigint)$/i);
      expect(await tableExists('money_notes')).toBe(true);
      // Settled: nothing left to change.
      expect(await migrate()).toMatchObject({ refused: false, applied: false });
    },
  );

  it.runIf(hint === 'sqlite')(
    'still stops on a whole-valued column the rescale did not record',
    async () => {
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      await insert('a', 1975);
      // Another column of the table was rescaled; this one was not.
      await rescaleMoneyColumnsToMinorUnits(db, [], {
        backfillName: 'money5454:other',
        engineHint: hint,
      });

      register('integer');
      const result = await migrate();
      expect(result.stops.map((stop) => stop.kind)).toEqual([
        'type.float-to-integer',
      ]);
      expect(result.stops[0].message).toContain('rebuilt by hand');
      expect(await declaredPriceType()).toBe('REAL');
    },
  );

  it.runIf(hint === 'sqlite')(
    'still stops when a recorded column holds a fractional value again',
    async () => {
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      await insert('a', 19.75);
      await rescaleMoneyColumnsToMinorUnits(
        db,
        [{ table: 'money_plans', columns: ['price'] }],
        { backfillName: 'money5454:v1', engineHint: hint },
      );
      // A writer still on the old code stores major units after the rescale.
      await insert('b', 3.5);

      register('integer');
      const result = await migrate();
      expect(result.stops.map((stop) => stop.kind)).toEqual([
        'type.float-to-integer',
      ]);
      expect(await prices()).toEqual([1975, 3.5]);
    },
  );

  const rescalePrice = () =>
    rescaleMoneyColumnsToMinorUnits(
      db,
      [{ table: 'money_plans', columns: ['price'] }],
      { backfillName: 'money5454:v1', engineHint: hint },
    );
  const moneyMarkers = async () =>
    (
      await db.query(
        "SELECT name FROM _smrt_backfills WHERE name LIKE 'smrt:minor-units:%'",
      )
    ).rows.length;

  it.runIf(hint === 'sqlite')(
    'still stops when a whole value was written after the rescale (it may be major units)',
    async () => {
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      await insert('a', 19.75);
      await rescalePrice();
      // A writer still on the old code stores 10 dollars as 10.
      await insert('b', 10);

      register('integer');
      const result = await migrate();
      expect(result.stops.map((stop) => stop.kind)).toEqual([
        'type.float-to-integer',
      ]);
      expect(await declaredPriceType()).toBe('REAL');
      expect(await prices()).toEqual([1975, 10]);
    },
  );

  it.runIf(hint === 'sqlite')(
    'fails the rebuild when the column changes between planning and applying',
    async () => {
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      await insert('a', 19.75);
      await rescalePrice();
      register('integer');
      const pending = await getPendingSchemaStatements(db, {
        engineHint: hint,
      });
      expect(pending.decision.stops).toEqual([]);
      // Written after the plan vouched for the column, before it applies.
      await insert('b', 3.5);

      const results = await new MigrationTracker({ db }).applyAll(
        [createMigrationDefinition('money_race', pending.statements)],
        { atomic: true },
      );
      expect(results.some((result) => !result.success)).toBe(true);
      expect(await declaredPriceType()).toBe('REAL');
      expect(await prices()).toEqual([1975, 3.5]);
      expect(await moneyMarkers()).toBe(1);
    },
  );

  it.runIf(hint === 'sqlite')(
    'removes the marker it consumed, so a later float column does not inherit it',
    async () => {
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      await insert('a', 19.75);
      await rescalePrice();
      register('integer');
      expect((await migrate()).refused).toBe(false);
      expect(await moneyMarkers()).toBe(0);

      // Back to decimal (applies), then integer again: nothing vouches now.
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      register('integer');
      expect((await migrate()).stops.map((stop) => stop.kind)).toEqual([
        'type.float-to-integer',
      ]);
    },
  );

  it.runIf(hint === 'sqlite')(
    'keeps the rowids of surviving rows through the rebuild',
    async () => {
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      await insert('a', 1);
      await insert('b', 2);
      await insert('c', 3);
      await db.query("DELETE FROM money_plans WHERE slug = 'b'");
      const rowids = async () =>
        (
          await db.query(
            'SELECT rowid AS r, slug FROM money_plans ORDER BY slug',
          )
        ).rows.map((row) => `${row.slug}:${row.r}`);
      const before = await rowids();
      await rescalePrice();
      register('integer');
      expect((await migrate()).refused).toBe(false);
      expect(await rowids()).toEqual(before);
    },
  );

  it.runIf(hint === 'sqlite')(
    'refuses to rebuild an AUTOINCREMENT table rather than reset its sequence',
    async () => {
      await db.query(
        'CREATE TABLE money_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL)',
      );
      await db.query('INSERT INTO money_ledger (amount) VALUES (1.5), (2.5)');
      await db.query('DELETE FROM money_ledger WHERE id = 2');
      await rescaleMoneyColumnsToMinorUnits(
        db,
        [{ table: 'money_ledger', columns: ['amount'] }],
        { backfillName: 'money_ledger:v1', engineHint: hint },
      );
      const diff = await new SchemaComparer(db, {
        engineHint: 'sqlite',
      }).compare({
        money_ledger: {
          tableName: 'money_ledger',
          columns: {
            id: { type: 'INTEGER', primaryKey: true },
            amount: { type: 'INTEGER' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      });
      const change = diff.changes.find((item) => item.name === 'amount');
      expect(classifySchemaChange(change as never)).toBe(
        'type.rebuild-unavailable',
      );
      expect(change?.sql).toContain('AUTOINCREMENT');
    },
  );

  // This in-memory DuckDB handle is one the rescale treats as JSON-backed: it
  // rewrites the values but not the declared type.
  it.runIf(hint === 'duckdb')(
    'keeps stopping after a rescale that leaves the declared type, and says why',
    async () => {
      register('decimal');
      expect((await migrate()).refused).toBe(false);
      await insert('a', 19.75);
      await rescaleMoneyColumnsToMinorUnits(
        db,
        [{ table: 'money_plans', columns: ['price'] }],
        { backfillName: 'money5454:v1', engineHint: hint },
      );
      expect(await prices()).toEqual([1975]);

      register('integer');
      const result = await migrate();
      expect(result.stops.map((stop) => stop.kind)).toEqual([
        'type.float-to-integer',
      ]);
      expect(result.stops[0].message).toContain('converted by hand');
      expect(await prices()).toEqual([1975]);
    },
  );

  it('still converts other columns: an integer column becoming decimal applies', async () => {
    register('integer');
    expect((await migrate()).refused).toBe(false);
    await insert('a', 7);

    register('decimal');
    const result = await migrate();

    expect(result.refused).toBe(false);
    expect(await prices()).toEqual([7]);
  });
});

describe('the float-to-integer kind (#5454)', () => {
  it('is a loses-data stop on every engine', () => {
    const change = {
      type: 'type_mismatch',
      table: 'money_plans',
      name: 'price',
      kindHint: 'type.float-to-integer' as const,
      mismatch: { expected: 'INTEGER', actual: 'REAL' },
    };
    expect(classifySchemaChange(change)).toBe('type.float-to-integer');
    for (const engine of ['postgres', 'sqlite', 'duckdb'] as const) {
      const verdict = decideSchemaChange(change, engine);
      expect(verdict.decision).toBe('stop');
      expect(verdict.stop?.reason).toBe('loses-data');
    }
  });
});
