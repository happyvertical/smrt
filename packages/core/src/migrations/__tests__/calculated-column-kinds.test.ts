/**
 * Calculated columns (#4915) through the one table of change kinds (#4925),
 * all-or-nothing migrate (#4927), the table-limited guard (P22) and the
 * SQLite/DuckDB rebuilds (#4937).
 *
 * - add to an existing table: `column.add` (additive); DuckDB refuses before
 *   planning (VALIDATION_GENERATED_DIALECT).
 * - changed expression: `column.generated-replace`, applied (recalculated),
 *   never by a table-limited run on a build table.
 * - ordinary to calculated: `column.generated-from-ordinary`, stops (the
 *   stored values would be discarded).
 * - calculated to ordinary: `column.generated-to-ordinary`, applied on
 *   PostgreSQL (DROP EXPRESSION keeps values), stops on SQLite and DuckDB
 *   (the VIRTUAL values would become the default or NULL).
 * - a rebuild for another column keeps the calculated column calculated.
 * - PostgreSQL compares renderings with EXPLAIN; an expression that reads a
 *   column this run adds is not probed (the probe could only fail).
 *
 * SQLite and DuckDB run here; PostgreSQL runs on PGlite under `test:pglite`.
 */
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
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

  it('stops making an ordinary column calculated: it would discard stored values', async () => {
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
      'loses-data:column.generated-from-ordinary',
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
