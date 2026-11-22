/**
 * Calculated columns (#4915) through the one table of change kinds (#4925),
 * all-or-nothing migrate (#4927), the table-limited guard (P22) and the
 * SQLite/DuckDB rebuilds (#4937).
 *
 * - add to an existing table: `column.add` (additive); DuckDB refuses before
 *   planning (VALIDATION_GENERATED_DIALECT).
 * - changed expression: `column.generated-replace`, applied (recalculated),
 *   never by a table-limited run on a build table.
 * - ordinary to calculated: applied while no stored value differs from the
 *   expression, otherwise `column.generated-from-ordinary-differs`, a stop (the
 *   stored values would be discarded); see `calculated-column-recompute.test.ts`.
 * - calculated to ordinary: `column.generated-to-ordinary`, applied on
 *   PostgreSQL (DROP EXPRESSION keeps values), stops on SQLite and DuckDB
 *   (the VIRTUAL values would become the default or NULL).
 * - a rebuild for another column keeps the calculated column calculated.
 * - PostgreSQL compares renderings with EXPLAIN; an expression that reads a
 *   column this run adds is not probed (the probe could only fail).
 *
 * SQLite and DuckDB run here; PostgreSQL runs on PGlite under `test:pglite`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { checkLiveSchemaParity } from '../../schema/live-parity.js';
import { stiHardeningChecks } from '../../schema/sti-hardening.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { getTestDatabase } from '../../testing/database.js';
import { registerBuildSchema } from '../build-schema.js';
import { decideSchemaChange } from '../change-kinds.js';
import { SchemaComparer } from '../differ.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

type Engine = 'sqlite' | 'duckdb' | 'postgres';
const ENGINES: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['postgres'] : ['sqlite', 'duckdb'];

const times = (col: string, right: unknown) =>
  ({ op: 'mul', left: { col }, right }) as unknown as NonNullable<
    SchemaDefinition['columns'][string]['generated']
  >;
const table = (columns: SchemaDefinition['columns']): SchemaDefinition => ({
  tableName: 'items',
  columns: {
    id: { type: 'TEXT', primaryKey: true, notNull: true },
    ...columns,
  },
  indexes: [],
  foreignKeys: [],
  triggers: [],
  dependencies: [],
  version: '',
});
const doubled = {
  type: 'INTEGER' as const,
  generated: times('qty', { value: 2 }),
};

describe.each(ENGINES)('calculated columns on %s', (engine) => {
  let db: DatabaseInterface;
  let run = 0;
  beforeEach(async () => {
    db =
      engine === 'postgres'
        ? await getTestDatabase({
            type: 'pglite',
            classes: [],
            includeSystemTables: false,
          })
        : await getDatabase({ type: engine, url: ':memory:' });
    registerBuildSchema({
      fingerprint: 'stamp',
      tables: { items: ['@app/a'] },
      packages: ['@app/a'],
      source: 'registered',
    });
  });
  afterEach(async () => {
    registerBuildSchema(undefined);
    vi.restoreAllMocks();
    await db.close?.();
  });

  const declare = (schema: SchemaDefinition) => {
    vi.restoreAllMocks();
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      items: schema,
    });
  };
  const migrate = (tables?: string[]) =>
    migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      engineHint: engine,
      name: `calc_${engine}_${++run}`,
      ...(tables ? { tables } : {}),
      relaxColumns: true,
      ...(engine === 'postgres'
        ? { atomic: true, postgresSafe: false, useConcurrentIndexes: false }
        : {}),
    });
  const rows = async () =>
    (await db.query('SELECT * FROM items ORDER BY id')).rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          typeof v === 'bigint' ? Number(v) : v,
        ]),
      ),
    );
  /** The table as migrate creates it, with one row (qty 3). */
  const created = async (columns: SchemaDefinition['columns']) => {
    declare(table(columns));
    expect(await migrate()).toMatchObject({ applied: true });
    await db.query("INSERT INTO items (id, qty) VALUES ('a', 3)");
  };
  const stopKinds = (result: Awaited<ReturnType<typeof migrate>>) =>
    result.stops.map((stop) => `${stop.reason}:${stop.kind}`);

  it('adds a calculated column to an existing table, also in a table-limited run', async () => {
    for (const tables of [undefined, ['items']]) {
      await db.query('DROP TABLE IF EXISTS items');
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, qty INTEGER)',
      );
      await db.query("INSERT INTO items (id, qty) VALUES ('a', 3)");
      declare(table({ qty: { type: 'INTEGER' }, total: doubled }));
      if (engine === 'duckdb') {
        await expect(migrate(tables)).rejects.toThrow(
          expect.objectContaining({ code: 'VALIDATION_GENERATED_DIALECT' }),
        );
        continue;
      }
      expect(await migrate(tables)).toMatchObject({
        applied: true,
        refused: false,
      });
      expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 6 }]);
    }
  });

  it('applies a changed expression and recalculates; a table-limited run refuses it', async () => {
    await created({ qty: { type: 'INTEGER' }, total: doubled });
    declare(
      table({
        qty: { type: 'INTEGER' },
        total: { type: 'INTEGER', generated: times('qty', { value: 5 }) },
      }),
    );
    if (engine === 'duckdb') {
      await expect(migrate()).rejects.toThrow(
        expect.objectContaining({ code: 'VALIDATION_GENERATED_DIALECT' }),
      );
      return;
    }
    const limited = await migrate(['items']);
    expect(limited).toMatchObject({ applied: false, refused: true });
    expect(limited.stops.some((stop) => stop.reason === 'build-table')).toBe(
      true,
    );
    expect(await migrate()).toMatchObject({ applied: true });
    expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 15 }]);
  });

  it('applies an expression that reads a column the same run adds, without probing it', async () => {
    await created({ qty: { type: 'INTEGER' }, total: doubled });
    declare(
      table({
        qty: { type: 'INTEGER' },
        price: { type: 'INTEGER', defaultValue: 4 },
        total: {
          type: 'INTEGER',
          generated: times('qty', { col: 'price' }),
          generatedInputTypes: { qty: 'number', price: 'number' },
        },
      }),
    );
    if (engine === 'duckdb') {
      await expect(migrate()).rejects.toThrow(
        expect.objectContaining({ code: 'VALIDATION_GENERATED_DIALECT' }),
      );
      return;
    }
    expect(await migrate()).toMatchObject({ applied: true });
    expect(await rows()).toEqual([{ id: 'a', qty: 3, price: 4, total: 12 }]);
  });

  it('stops making an ordinary column calculated when it would discard stored values', async () => {
    await created({ qty: { type: 'INTEGER' }, total: { type: 'INTEGER' } });
    await db.query('UPDATE items SET total = 99');
    declare(table({ qty: { type: 'INTEGER' }, total: doubled }));
    if (engine === 'duckdb') {
      await expect(migrate()).rejects.toThrow(
        expect.objectContaining({ code: 'VALIDATION_GENERATED_DIALECT' }),
      );
      return;
    }
    const result = await migrate();
    expect(result).toMatchObject({ applied: false, refused: true });
    expect(stopKinds(result)).toEqual([
      'loses-data:column.generated-from-ordinary-differs',
    ]);
    expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 99 }]);
  });

  it('makes a calculated column ordinary only where its values survive', async () => {
    await created({ qty: { type: 'INTEGER' }, total: doubled });
    declare(table({ qty: { type: 'INTEGER' }, total: { type: 'INTEGER' } }));
    const result = await migrate();
    if (engine === 'postgres') {
      expect(result).toMatchObject({ applied: true });
      await db.query('UPDATE items SET qty = 4');
      expect(await rows()).toEqual([{ id: 'a', qty: 4, total: 6 }]);
      return;
    }
    expect(result).toMatchObject({ applied: false, refused: true });
    expect(stopKinds(result)).toEqual([
      'loses-data:column.generated-to-ordinary',
    ]);
    expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 6 }]);
  });

  it('keeps a calculated column calculated through a rebuild for another column', async () => {
    declare(
      table({
        qty: { type: 'INTEGER' },
        note: { type: 'TEXT', notNull: true },
        total: doubled,
      }),
    );
    expect(await migrate()).toMatchObject({ applied: true });
    await db.query("INSERT INTO items (id, qty, note) VALUES ('a', 3, 'n')");
    declare(
      table({
        qty: { type: 'INTEGER' },
        note: { type: 'TEXT' },
        total: doubled,
      }),
    );
    expect(await migrate()).toMatchObject({ applied: true, refused: false });
    await db.query('UPDATE items SET qty = 4');
    expect(await rows()).toEqual([{ id: 'a', qty: 4, note: 'n', total: 8 }]);
    expect(await migrate()).toMatchObject({ applied: false, refused: false });
  });

  it('reports a live calculated column the model dropped as column.orphan (#5013)', async () => {
    // Created by hand, never recorded: no previous schema and no declaration
    // names `total`, so nothing but the live column list can reveal it.
    const generated = engine === 'postgres' ? ' STORED' : '';
    await db.query(
      `CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, qty INTEGER, total INTEGER GENERATED ALWAYS AS (qty * 2)${generated})`,
    );
    const changes = (
      await new SchemaComparer(db, { engineHint: engine }).compare({
        items: table({ qty: { type: 'INTEGER' } }),
      })
    ).changes;
    const orphans = changes.filter((change) => change.type === 'orphan_column');
    expect(orphans.map((change) => change.name)).toEqual(['total']);
    expect(decideSchemaChange(orphans[0] as never, engine).kind).toBe(
      'column.orphan',
    );
    // The same live column is an `extra_column` in live-schema parity.
    const parity = await checkLiveSchemaParity({
      db,
      schemas: { items: table({ qty: { type: 'INTEGER' } }) },
      engineHint: engine,
      includeSystemTables: false,
      reportExtraTables: false,
    });
    expect(
      parity.findings
        .filter((finding) => finding.kind === 'extra_column')
        .map((finding) => finding.target),
    ).toEqual(['total']);
  });

  // #5008 case 1: a column's type change and a calculated column that reads it
  // getting a new expression in one run. PostgreSQL refuses to convert a column
  // a calculated column depends on (0A000), so the swap's DROP runs first, the
  // conversion second, and the swap's ADD last.
  it('converts a column and swaps the calculated column that reads it in one run, whichever column is declared first', async () => {
    if (engine === 'duckdb') return; // DuckDB refuses any expression change (VALIDATION_GENERATED_DIALECT)
    for (const swapFirst of [false, true]) {
      await db.query('DROP TABLE IF EXISTS items');
      const inputs = { generatedInputTypes: { qty: 'number' as const } };
      const total = (factor: number) => ({
        type: 'INTEGER' as const,
        generated: times('qty', { value: factor }),
        ...inputs,
      });
      const declared = (qty: 'INTEGER' | 'REAL', factor: number) =>
        swapFirst
          ? { total: total(factor), qty: { type: qty } }
          : { qty: { type: qty }, total: total(factor) };
      declare(table(declared('INTEGER', 2)));
      expect(await migrate()).toMatchObject({ applied: true });
      await db.query("INSERT INTO items (id, qty) VALUES ('a', 3)");
      declare(table(declared('REAL', 5)));
      const result = await migrate();
      expect(stopKinds(result)).toEqual([]);
      expect(result).toMatchObject({ applied: true, refused: false });
      expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 15 }]);
      expect(await migrate()).toMatchObject({ applied: false, refused: false });
    }
  });

  it('adds the new calculated column after a column its expression reads, declared later (#5008)', async () => {
    if (engine === 'duckdb') return;
    await created({ qty: { type: 'INTEGER' }, total: doubled });
    declare(
      table({
        total: {
          type: 'INTEGER',
          generated: times('qty', { col: 'price' }),
          generatedInputTypes: { qty: 'number', price: 'number' },
        },
        qty: { type: 'INTEGER' },
        price: { type: 'INTEGER', defaultValue: 4 },
      }),
    );
    expect(await migrate()).toMatchObject({ applied: true, refused: false });
    expect(await rows()).toEqual([{ id: 'a', qty: 3, price: 4, total: 12 }]);
  });

  // #5008 case 2: a required calculated column whose new expression is NULL for
  // a stored row used to fail mid-run with a raw NOT NULL error.
  it('stops, by name, when a required calculated column would be NULL for a stored row', async () => {
    if (engine === 'duckdb') return;
    const required = (factor: number) => ({
      type: 'INTEGER' as const,
      notNull: true,
      generated: times('qty', { value: factor }),
    });
    declare(table({ qty: { type: 'INTEGER' }, total: doubled }));
    expect(await migrate()).toMatchObject({ applied: true });
    await db.query("INSERT INTO items (id, qty) VALUES ('a', 3)");
    await db.query("INSERT INTO items (id, qty) VALUES ('b', NULL)");
    declare(table({ qty: { type: 'INTEGER' }, total: required(7) }));
    const result = await migrate();
    expect(result).toMatchObject({ applied: false, refused: true });
    expect(stopKinds(result)).toEqual([
      'invents-data:column.generated-required-null',
    ]);
    expect(result.stops[0]?.message).toContain('items.total');
    expect(await rows()).toEqual([
      { id: 'a', qty: 3, total: 6 },
      { id: 'b', qty: null, total: null },
    ]);
    // Once every row has a value the same swap applies.
    await db.query("DELETE FROM items WHERE id = 'b'");
    expect(await migrate()).toMatchObject({ applied: true, refused: false });
    expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 21 }]);
  });

  it('judges a required calculated column on the rows the run leaves: PostgreSQL replays a fill, SQLite stops by name (#5008)', async () => {
    if (engine === 'duckdb') return;
    declare(table({ qty: { type: 'INTEGER' }, total: doubled }));
    expect(await migrate()).toMatchObject({ applied: true });
    await db.query("INSERT INTO items (id, qty) VALUES ('b', NULL)");
    declare(
      table({
        qty: { type: 'INTEGER', notNull: true, backfill: '0' },
        total: {
          type: 'INTEGER',
          notNull: true,
          generated: times('qty', { value: 5 }),
        },
      }),
    );
    const result = await migrate();
    if (engine === 'postgres') {
      // The run fills qty with 0 first, so the new total is 0, never NULL.
      expect(result).toMatchObject({ applied: true, refused: false });
      expect(await rows()).toEqual([{ id: 'b', qty: 0, total: 0 }]);
      return;
    }
    // SQLite rebuilds the table to fill qty; the planner does not replay it.
    expect(result).toMatchObject({ applied: false, refused: true });
    expect(stopKinds(result)).toEqual([
      'unresolved-non-data-stop:column.generated-required-unprojectable',
    ]);
    expect(result.stops[0]?.message).toContain('qty');
  });

  // #5008 case 4: SQLite refuses DROP COLUMN while something it tracks reads
  // the column. The planner asks SQLite (a dry run in a savepoint) and stops by
  // name instead of failing mid-run.
  it.skipIf(engine !== 'sqlite')(
    'stops, by name, when SQLite would refuse to drop the calculated column',
    async () => {
      // SQLite drops and re-adds a column under a view or trigger without
      // complaint (they read it again once it is back); an index is what it
      // refuses.
      for (const setup of [
        'CREATE INDEX items_total_hand ON items (total)',
        'CREATE INDEX items_total_partial ON items (qty) WHERE total > 0',
      ]) {
        await db.query('DROP TABLE IF EXISTS items');
        await created({ qty: { type: 'INTEGER' }, total: doubled });
        await db.query(setup);
        const before = (
          await db.query(
            'SELECT type, name, sql FROM sqlite_master ORDER BY type, name',
          )
        ).rows;
        declare(
          table({
            qty: { type: 'INTEGER' },
            total: { type: 'INTEGER', generated: times('qty', { value: 5 }) },
          }),
        );
        const result = await migrate();
        expect(result).toMatchObject({ applied: false, refused: true });
        expect(stopKinds(result)).toEqual([
          'loses-data:column.generated-replace-dependents',
        ]);
        expect(result.stops[0]?.message).toContain('SQLite refuses');
        // The dry run left no trace.
        expect(
          (
            await db.query(
              'SELECT type, name, sql FROM sqlite_master ORDER BY type, name',
            )
          ).rows,
        ).toEqual(before);
        expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 6 }]);
      }
    },
  );

  it.skipIf(engine !== 'sqlite')(
    'runs the SQLite drop probe on one connection of a file database',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'smrt-5008-'));
      const file = getDatabase({ type: 'sqlite', url: join(dir, 'a.db') });
      await db.close?.();
      db = await file;
      try {
        await created({ qty: { type: 'INTEGER' }, total: doubled });
        await db.query('CREATE INDEX items_total_hand ON items (total)');
        declare(
          table({
            qty: { type: 'INTEGER' },
            total: { type: 'INTEGER', generated: times('qty', { value: 5 }) },
          }),
        );
        expect(stopKinds(await migrate())).toEqual([
          'loses-data:column.generated-replace-dependents',
        ]);
        expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 6 }]);
        await db.query('DROP INDEX items_total_hand');
        expect(await migrate()).toMatchObject({ applied: true });
        expect(await rows()).toEqual([{ id: 'a', qty: 3, total: 15 }]);
      } finally {
        await db.close?.();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('reports no change on a second migrate', async () => {
    declare(table({ qty: { type: 'INTEGER' }, total: doubled }));
    expect(await migrate()).toMatchObject({ applied: true });
    expect(await migrate()).toMatchObject({
      applied: false,
      refused: false,
      stops: [],
    });
  });
});

/**
 * Review r7 (C1): on PostgreSQL, replacing a calculated column (DROP COLUMN,
 * ADD COLUMN) also drops every object PostgreSQL ties to that column. The
 * shared-table CHECKs smrt declares are put back in the same atomic run;
 * anything smrt did not declare, and so cannot put back, stops the plan by
 * name instead of being lost.
 */
describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'replacing a calculated column keeps what PostgreSQL ties to it',
  () => {
    const STRICT = '@app/a:Strict';
    const [rule] = stiHardeningChecks(
      'items',
      (name) => name,
      [],
      [
        {
          className: STRICT,
          fields: [['total', { type: 'integer', required: true }]],
        },
      ],
    );
    const coalesced = {
      op: 'mul',
      left: { op: 'coalesce', operands: [{ col: 'qty' }, { value: 0 }] },
      right: { value: 2 },
    } as unknown as NonNullable<
      SchemaDefinition['columns'][string]['generated']
    >;
    const shared = (
      generated: NonNullable<SchemaDefinition['columns'][string]['generated']>,
      withRule = true,
      qty: SchemaDefinition['columns'][string] = { type: 'INTEGER' },
    ): SchemaDefinition => ({
      ...table({
        _meta_type: { type: 'TEXT' },
        qty,
        total: { type: 'INTEGER', generated },
      }),
      ...(withRule ? { checks: [rule] } : {}),
    });

    let db: DatabaseInterface;
    let run = 0;
    beforeEach(async () => {
      db = await getTestDatabase({
        type: 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      registerBuildSchema({
        fingerprint: 'stamp',
        tables: { items: ['@app/a'] },
        packages: ['@app/a'],
        source: 'registered',
      });
    });
    afterEach(async () => {
      registerBuildSchema(undefined);
      vi.restoreAllMocks();
      await db.close?.();
    });
    const declare = (schema: SchemaDefinition) => {
      vi.restoreAllMocks();
      vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
        items: schema,
      });
    };
    const migrate = () =>
      migrateSmrtSchemas({
        db,
        packageName: '@app/a',
        engineHint: 'postgres',
        name: `calc_check_${++run}`,
        relaxColumns: true,
        atomic: true,
        postgresSafe: false,
        useConcurrentIndexes: false,
      });
    const liveChecks = async () =>
      (
        await db.query(
          "SELECT conname FROM pg_constraint WHERE conrelid = 'items'::regclass AND contype = 'c' ORDER BY conname",
        )
      ).rows.map((row) => String(row.conname));
    const totals = async () =>
      (await db.query('SELECT id, total FROM items ORDER BY id')).rows.map(
        (row) => [row.id, row.total === null ? null : Number(row.total)],
      );
    const insertStrict = (id: string, qty: number | null) =>
      db.query('INSERT INTO items (id, _meta_type, qty) VALUES ($1, $2, $3)', [
        id,
        STRICT,
        qty,
      ]);

    it('puts back the shared-table CHECK that reads the column', async () => {
      declare(shared(times('qty', { value: 2 })));
      expect(await migrate()).toMatchObject({ applied: true });
      await insertStrict('a', 3);
      expect(await liveChecks()).toEqual([rule.name]);

      declare(shared(times('qty', { value: 5 })));
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      expect(await totals()).toEqual([['a', 15]]);
      expect(await liveChecks()).toEqual([rule.name]);
      await expect(insertStrict('b', null)).rejects.toThrow(rule.name);
      expect(await migrate()).toMatchObject({
        applied: false,
        refused: false,
        stops: [],
      });
    });

    it('judges a rule added in the same run against the new values', async () => {
      // Live: qty * 2, so a Strict row with no qty holds NULL. The new
      // expression gives it 0, so the new rule holds for every row.
      declare(shared(times('qty', { value: 2 }), false));
      expect(await migrate()).toMatchObject({ applied: true });
      await insertStrict('a', null);
      declare(shared(coalesced));
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      expect(await totals()).toEqual([['a', 0]]);
      expect(await liveChecks()).toEqual([rule.name]);
    });

    it('stops a rule added in the same run that the new values would break', async () => {
      declare(shared(coalesced, false));
      expect(await migrate()).toMatchObject({ applied: true });
      await insertStrict('a', null);
      declare(shared(times('qty', { value: 2 })));
      const result = await migrate();
      expect(result).toMatchObject({ applied: false, refused: true });
      expect(
        result.stops.map((stop) => `${stop.reason}:${stop.kind}`),
      ).toContain('invents-data:check.violated');
      expect(await totals()).toEqual([['a', 0]]);
      expect(await liveChecks()).toEqual([]);
    });

    // Review r8 (C1): the run fills qty before total is recalculated, so the
    // rule is judged on the filled qty, never on the NULL it held before.
    const fiveOrNullAtZero = {
      op: 'if',
      condition: { op: 'isNull', operand: { col: 'qty' } },
      // biome-ignore lint/suspicious/noThenProperty: the calculated-field grammar names this branch then.
      then: { value: 1 },
      else: {
        op: 'if',
        condition: { op: 'gt', left: { col: 'qty' }, right: { value: 0 } },
        // biome-ignore lint/suspicious/noThenProperty: the calculated-field grammar names this branch then.
        then: { op: 'mul', left: { col: 'qty' }, right: { value: 5 } },
        else: { value: null },
      },
    } as unknown as NonNullable<
      SchemaDefinition['columns'][string]['generated']
    >;
    it.each([
      ['a declared backfill', { backfill: '0' }],
      ['the declared default', { defaultValue: 0 }],
    ] as const)('judges the rule on the rows after %s fills an existing column', async (_label, fill) => {
      declare(shared(coalesced));
      expect(await migrate()).toMatchObject({ applied: true });
      await insertStrict('a', null);
      declare(
        shared(times('qty', { value: 5 }), true, {
          type: 'INTEGER',
          notNull: true,
          ...fill,
        }),
      );
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      expect(await totals()).toEqual([['a', 0]]);
      expect(await liveChecks()).toEqual([rule.name]);
      await expect(insertStrict('b', null)).rejects.toThrow();
    });

    it('stops when the values the run fills in break the rule', async () => {
      // Before the fill, total would read qty = NULL and give 1; the run
      // fills qty with 0, which gives NULL for a class that requires total.
      declare(shared(coalesced));
      expect(await migrate()).toMatchObject({ applied: true });
      await insertStrict('a', null);
      declare(
        shared(fiveOrNullAtZero, true, {
          type: 'INTEGER',
          notNull: true,
          backfill: '0',
        }),
      );
      const result = await migrate();
      expect(result).toMatchObject({ applied: false, refused: true });
      expect(
        result.stops.map((stop) => `${stop.reason}:${stop.kind}`),
      ).toContain('invents-data:check.violated');
      expect(await totals()).toEqual([['a', 0]]);
      expect(await liveChecks()).toEqual([rule.name]);
    });

    // #5008 case 3. Constraint drift of a column is judged once its type is
    // settled, so a release that converts qty and requires it fills qty only
    // on the next run. Folding the fill into the conversion run would plan
    // NOT NULL and defaults against a column whose type, default and NULLs the
    // conversion itself rewrites, so the planner does not; a rule that rests
    // on that fill stops by name instead.
    it('names a rule that rests on a fill deferred by a type conversion (#5008)', async () => {
      // qty widens INTEGER to REAL: a conversion migrate plans (REAL to
      // INTEGER is a stop of its own, #5454).
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, _meta_type TEXT, qty INTEGER, total INTEGER GENERATED ALWAYS AS ((COALESCE(qty, 0) * 2)::integer) STORED)',
      );
      await insertStrict('a', null);
      declare(
        shared(times('qty', { value: 5 }), true, {
          type: 'REAL',
          notNull: true,
          backfill: '0',
        }),
      );
      const result = await migrate();
      expect(result).toMatchObject({ applied: false, refused: true });
      expect(result.stops.map((stop) => `${stop.reason}:${stop.kind}`)).toEqual(
        ['invents-data:check.deferred-fill'],
      );
      expect(
        result.stops.find((stop) => stop.kind === 'check.deferred-fill')
          ?.message,
      ).toContain('planned only on the next run');
      // Nothing ran: the conversion waits for the stop to be resolved.
      expect(await totals()).toEqual([['a', 0]]);
    });

    it('stops, never guesses, when the run also writes rows in a way the probe cannot replay', async () => {
      declare(shared(times('qty', { value: 2 }), false));
      expect(await migrate()).toMatchObject({ applied: true });
      await insertStrict('a', null);
      const comparer = new SchemaComparer(db, { engineHint: 'postgres' });
      const live = await db.getTableSchema?.('items');
      const unknown = 'UPDATE "items" SET "qty" = 1';
      const changes = await (
        comparer as unknown as {
          compareTableChecks: (
            table: string,
            manifest: SchemaDefinition,
            live: unknown,
            columnChanges: unknown[],
          ) => Promise<Array<{ kindHint?: string; advisory?: unknown }>>;
        }
      ).compareTableChecks('items', shared(times('qty', { value: 2 })), live, [
        { type: 'alter_column', table: 'items', name: 'qty', sql: unknown },
      ]);
      expect(changes.map((change) => change.kindHint)).toEqual([
        'check.unprojectable',
      ]);
      expect(decideSchemaChange(changes[0] as never, 'postgres').decision).toBe(
        'stop',
      );
      expect(
        (changes[0]?.advisory as { message?: string } | undefined)?.message,
      ).toContain(unknown);
    });

    it('replaces two calculated columns that share a declared composite index in one run', async () => {
      const pair = (factor: number): SchemaDefinition => {
        const schema = table({
          qty: { type: 'INTEGER' },
          a: { type: 'INTEGER', generated: times('qty', { value: factor }) },
          b: {
            type: 'INTEGER',
            generated: times('qty', { value: factor + 1 }),
          },
        });
        schema.indexes = [{ name: 'items_ab_idx', columns: ['a', 'b'] }];
        return schema;
      };
      declare(pair(2));
      expect(await migrate()).toMatchObject({ applied: true });
      await db.query("INSERT INTO items (id, qty) VALUES ('x', 3)");
      declare(pair(5));
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      const live = (
        await db.query('SELECT a, b FROM items ORDER BY id')
      ).rows.map((row) => [Number(row.a), Number(row.b)]);
      expect(live).toEqual([[15, 18]]);
      const indexes = (
        await db.query(
          "SELECT indexname FROM pg_indexes WHERE tablename = 'items' AND indexname = 'items_ab_idx'",
        )
      ).rows;
      expect(indexes).toHaveLength(1);
      expect(await migrate()).toMatchObject({ applied: false, stops: [] });
    });

    it('does not stop for what the replacement re-creates: UNIQUE, declared and partial indexes', async () => {
      const indexed = (
        generated: NonNullable<
          SchemaDefinition['columns'][string]['generated']
        >,
      ): SchemaDefinition => {
        const schema = shared(generated);
        schema.columns.total = { ...schema.columns.total, unique: true };
        schema.indexes = [
          { name: 'items_total_idx', columns: ['total'] },
          {
            name: 'items_qty_positive_idx',
            columns: ['qty'],
            where: 'total > 0',
          },
        ];
        return schema;
      };
      declare(indexed(times('qty', { value: 2 })));
      expect(await migrate()).toMatchObject({ applied: true });
      await insertStrict('a', 3);
      declare(indexed(times('qty', { value: 5 })));
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      expect(await totals()).toEqual([['a', 15]]);
      const indexes = (
        await db.query(
          "SELECT indexname FROM pg_indexes WHERE tablename = 'items' ORDER BY indexname",
        )
      ).rows.map((row) => String(row.indexname));
      expect(indexes).toEqual(
        expect.arrayContaining(['items_total_idx', 'items_qty_positive_idx']),
      );
      expect(await liveChecks()).toEqual([rule.name]);
      expect(await migrate()).toMatchObject({
        applied: false,
        refused: false,
        stops: [],
      });
    });

    it('stops, naming them, when objects smrt did not declare read the column', async () => {
      declare(shared(times('qty', { value: 2 })));
      expect(await migrate()).toMatchObject({ applied: true });
      await insertStrict('a', 3);
      await db.query('CREATE INDEX items_total_hand ON items ((total + 1))');
      await db.query(
        'ALTER TABLE items ADD CONSTRAINT items_total_hand_ck CHECK (total >= 0)',
      );
      await db.query("COMMENT ON COLUMN items.total IS 'kept by hand'");
      declare(shared(times('qty', { value: 5 })));
      const result = await migrate();
      expect(result).toMatchObject({ applied: false, refused: true });
      const stop = result.stops.find(
        (item) => item.kind === 'column.generated-replace-dependents',
      );
      expect(stop?.reason).toBe('loses-data');
      expect(stop?.message).toContain('items_total_hand');
      expect(stop?.message).toContain('items_total_hand_ck');
      expect(stop?.message).toContain('comment');
      expect(await totals()).toEqual([['a', 6]]);
      expect(await liveChecks()).toEqual(
        ['items_total_hand_ck', rule.name].sort(),
      );
    });
  },
);
