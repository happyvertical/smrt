/**
 * Making an ordinary column calculated when no stored value changes (#5018).
 *
 * The conversion applies only while every stored row already holds what the
 * expression gives (compared as the column's declared type, a NULL equal to a
 * NULL). One differing row stops the run, naming the count and example rows
 * (`column.generated-from-ordinary-differs`). The run counts again right
 * before it converts and aborts if a row written since planning differs.
 * `confirmRecompute` replaces the values on purpose and records it.
 *
 * SQLite and DuckDB run here (DuckDB keeps refusing at planning); PostgreSQL
 * runs on PGlite under `test:pglite`. The same cases run on a real server in
 * `calculated-column-swap-postgres.optional.test.ts`.
 */
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { getTestDatabase } from '../../testing/database.js';
import { registerBuildSchema } from '../build-schema.js';
import { SchemaComparer } from '../differ.js';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '../orchestrate.js';

type Engine = 'sqlite' | 'duckdb' | 'postgres';
const ENGINES: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['postgres'] : ['sqlite', 'duckdb'];

type Generated = NonNullable<SchemaDefinition['columns'][string]['generated']>;
const node = (value: unknown) => value as unknown as Generated;
const times = (factor: number): Generated =>
  node({ op: 'mul', left: { col: 'qty' }, right: { value: factor } });
const inputs = { qty: 'number' } as const;
const table = (columns: SchemaDefinition['columns']): SchemaDefinition => ({
  tableName: 'items',
  columns: {
    id: { type: 'TEXT', primaryKey: true, notNull: true },
    qty: { type: 'INTEGER' },
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
  generated: times(2),
  generatedInputTypes: inputs,
};

describe.each(ENGINES)('ordinary to calculated on %s', (engine) => {
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
  const migrate = (options: { tables?: string[]; confirm?: string[] } = {}) =>
    migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      engineHint: engine,
      name: `recompute_${engine}_${++run}`,
      ...(options.tables ? { tables: options.tables } : {}),
      ...(options.confirm ? { confirmRecompute: options.confirm } : {}),
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
  /** The ordinary table, made by hand so a column can hold another live type. */
  const ordinary = async (live: string, extra = '') => {
    const int = engine === 'postgres' ? 'BIGINT' : 'INTEGER';
    await db.query(
      `CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, qty ${int}, v ${live}${extra})`,
    );
  };
  const stopKinds = (result: Awaited<ReturnType<typeof migrate>>) =>
    result.stops.map((stop) => `${stop.reason}:${stop.kind}`);
  const generatedNow = async (column: string) => {
    // A calculated column cannot be written; an ordinary one can.
    try {
      await db.query(`UPDATE items SET ${column} = ${column}`);
      return false;
    } catch {
      return true;
    }
  };
  const convert = (column: SchemaDefinition['columns'][string]) =>
    declare(table({ v: column }));

  it('applies when every stored value already equals the expression, NULLs included', async () => {
    await ordinary(engine === 'postgres' ? 'BIGINT' : 'INTEGER');
    await db.query(
      "INSERT INTO items (id, qty, v) VALUES ('a', 3, 6), ('b', 0, 0), ('c', NULL, NULL)",
    );
    convert(doubled);
    if (engine === 'duckdb') {
      await expect(migrate()).rejects.toThrow(
        expect.objectContaining({ code: 'VALIDATION_GENERATED_DIALECT' }),
      );
      return;
    }
    const result = await migrate();
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(await generatedNow('v')).toBe(true);
    expect(await rows()).toEqual([
      { id: 'a', qty: 3, v: 6 },
      { id: 'b', qty: 0, v: 0 },
      { id: 'c', qty: null, v: null },
    ]);
    await db.query("INSERT INTO items (id, qty) VALUES ('d', 5)");
    expect((await rows()).at(-1)).toEqual({ id: 'd', qty: 5, v: 10 });
  });

  it('stops when one row differs, naming the count and the row, and changes nothing', async () => {
    await ordinary(engine === 'postgres' ? 'BIGINT' : 'INTEGER');
    await db.query(
      "INSERT INTO items (id, qty, v) VALUES ('a', 3, 6), ('b', 4, 99), ('c', 5, 10)",
    );
    convert(doubled);
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
    expect(result.stops[0].message).toContain('1 stored row(s)');
    expect(result.stops[0].message).toContain('id=b: stored 99, computed 8');
    expect(result.stops[0].message).toContain('--confirm-recompute items.v');
    expect(await generatedNow('v')).toBe(false);
    expect(await rows()).toEqual([
      { id: 'a', qty: 3, v: 6 },
      { id: 'b', qty: 4, v: 99 },
      { id: 'c', qty: 5, v: 10 },
    ]);
    // The plan carries the same facts for `smrt doctor --db`.
    const pending = await getPendingSchemaStatements(db, {
      engineHint: engine,
      relaxColumns: true,
    });
    expect(pending.diff.changes[0].recompute).toEqual({
      count: 1,
      confirmed: false,
      examples: [{ key: { id: 'b' }, stored: '99', computed: '8' }],
    });
  });

  it('recalculates on request, records it, and ignores a confirmation that matches nothing', async () => {
    await ordinary(engine === 'postgres' ? 'BIGINT' : 'INTEGER');
    await db.query(
      "INSERT INTO items (id, qty, v) VALUES ('a', 3, 6), ('b', 4, 99)",
    );
    convert(doubled);
    if (engine === 'duckdb') {
      await expect(migrate({ confirm: ['items.v'] })).rejects.toThrow(
        expect.objectContaining({ code: 'VALIDATION_GENERATED_DIALECT' }),
      );
      return;
    }
    const result = await migrate({ confirm: ['items.v', 'items.nope'] });
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(result.recomputed).toEqual([
      { table: 'items', column: 'v', rows: 1 },
    ]);
    expect(result.notices.join('\n')).toContain(
      'Ignoring --confirm-recompute items.nope',
    );
    expect(await rows()).toEqual([
      { id: 'a', qty: 3, v: 6 },
      { id: 'b', qty: 4, v: 8 },
    ]);
    const recorded = (
      await db.query(
        'SELECT recomputes FROM _smrt_migrate_runs ORDER BY created_at DESC, id DESC LIMIT 1',
      )
    ).rows[0];
    expect(JSON.parse(String(recorded.recomputes))).toEqual([
      { table: 'items', column: 'v', rows: 1 },
    ]);
  });

  it('refuses the conversion in a table-limited run, even when nothing differs', async () => {
    await ordinary(engine === 'postgres' ? 'BIGINT' : 'INTEGER');
    await db.query("INSERT INTO items (id, qty, v) VALUES ('a', 3, 6)");
    convert(doubled);
    if (engine === 'duckdb') {
      await expect(migrate({ tables: ['items'] })).rejects.toThrow(
        expect.objectContaining({ code: 'VALIDATION_GENERATED_DIALECT' }),
      );
      return;
    }
    const limited = await migrate({ tables: ['items'] });
    expect(limited).toMatchObject({ applied: false, refused: true });
    expect(limited.stops.map((stop) => stop.reason)).toEqual(['build-table']);
    expect(await generatedNow('v')).toBe(false);
  });

  it('aborts the run when a row written between plan and apply differs', async () => {
    await ordinary(engine === 'postgres' ? 'BIGINT' : 'INTEGER');
    await db.query("INSERT INTO items (id, qty, v) VALUES ('a', 3, 6)");
    convert(doubled);
    if (engine === 'duckdb') return;
    const compare = SchemaComparer.prototype.compare;
    vi.spyOn(SchemaComparer.prototype, 'compare').mockImplementation(
      async function (this: SchemaComparer, ...args) {
        const diff = await compare.apply(this, args);
        // The plan counted zero; now a row arrives that the expression cannot match.
        await db.query("INSERT INTO items (id, qty, v) VALUES ('z', 1, 500)");
        return diff;
      },
    );
    await expect(migrate()).rejects.toThrow(
      /stored value now differs|CHECK constraint failed|code=P0001/,
    );
    vi.restoreAllMocks();
    declare(table({ v: doubled }));
    expect(await generatedNow('v')).toBe(false);
    expect(await rows()).toEqual([
      { id: 'a', qty: 3, v: 6 },
      { id: 'z', qty: 1, v: 500 },
    ]);
    // The next plan sees the row and stops by name.
    expect(stopKinds(await migrate())).toEqual([
      'loses-data:column.generated-from-ordinary-differs',
    ]);
  });

  describe('equality is judged as the declared type', () => {
    const half = (type: 'REAL' | 'INTEGER' = 'REAL') => ({
      type,
      generated: times(0.5),
      generatedInputTypes: inputs,
    });

    it('treats text 1.50 and a computed 1.5 as equal by value', async () => {
      await ordinary('TEXT');
      await db.query(
        "INSERT INTO items (id, qty, v) VALUES ('a', 3, '1.50'), ('b', 4, '2'), ('c', NULL, NULL)",
      );
      convert(half());
      if (engine === 'duckdb') return;
      expect(await migrate()).toMatchObject({ applied: true });
      expect(await generatedNow('v')).toBe(true);
    });

    it('stops on text that is not that number', async () => {
      await ordinary('TEXT');
      await db.query(
        "INSERT INTO items (id, qty, v) VALUES ('a', 3, '1.50'), ('b', 4, 'two')",
      );
      convert(half());
      if (engine === 'duckdb') return;
      const result = await migrate();
      expect(result).toMatchObject({ applied: false, refused: true });
      // PostgreSQL cannot cast 'two' to a number, so it cannot compare at all.
      expect(stopKinds(result)).toEqual([
        engine === 'postgres'
          ? 'unresolved-non-data-stop:column.generated-from-ordinary-unprojectable'
          : 'loses-data:column.generated-from-ordinary-differs',
      ]);
      expect(await generatedNow('v')).toBe(false);
    });

    it('compares floating point exactly', async () => {
      await ordinary(engine === 'postgres' ? 'DOUBLE PRECISION' : 'REAL');
      // PostgreSQL multiplies by the numeric literal 0.1 and gets exactly 0.3;
      // SQLite multiplies floats. The comparison is with what the engine gives.
      const same = engine === 'postgres' ? 0.3 : 3 * 0.1;
      await db.query('INSERT INTO items (id, qty, v) VALUES ($1, 3, $2)', [
        'a',
        same,
      ]);
      const tenth = {
        type: 'REAL' as const,
        generated: times(0.1),
        generatedInputTypes: inputs,
      };
      convert(tenth);
      if (engine === 'duckdb') return;
      expect(await migrate()).toMatchObject({ applied: true });

      // One representable step away is a different value.
      await db.query('DROP TABLE items');
      await ordinary(engine === 'postgres' ? 'DOUBLE PRECISION' : 'REAL');
      await db.query('INSERT INTO items (id, qty, v) VALUES ($1, 3, $2)', [
        'a',
        engine === 'postgres' ? 3 * 0.1 : 0.3,
      ]);
      convert(tenth);
      expect(stopKinds(await migrate())).toEqual([
        'loses-data:column.generated-from-ordinary-differs',
      ]);
    });

    it('compares booleans as the engine stores them', async () => {
      await ordinary(engine === 'postgres' ? 'BOOLEAN' : 'INTEGER');
      const yes = engine === 'postgres' ? 'true' : '1';
      const no = engine === 'postgres' ? 'false' : '0';
      await db.query(
        `INSERT INTO items (id, qty, v) VALUES ('a', 3, ${yes}), ('b', 1, ${no}), ('c', NULL, NULL)`,
      );
      const big = {
        type: 'BOOLEAN' as const,
        generated: node({
          op: 'gt',
          left: { col: 'qty' },
          right: { value: 2 },
        }),
        generatedInputTypes: inputs,
      };
      convert(big);
      if (engine === 'duckdb') return;
      expect(await migrate()).toMatchObject({ applied: true });

      await db.query('DROP TABLE items');
      await ordinary(engine === 'postgres' ? 'BOOLEAN' : 'INTEGER');
      await db.query(`INSERT INTO items (id, qty, v) VALUES ('a', 3, ${no})`);
      convert(big);
      expect(stopKinds(await migrate())).toEqual([
        'loses-data:column.generated-from-ordinary-differs',
      ]);
    });
  });

  // PostgreSQL cannot generate a datetime (the cast depends on the session), so
  // the time-zone case exists on SQLite only; DuckDB refuses before comparing.
  it.skipIf(engine !== 'sqlite')(
    'compares timestamps as instants, whatever UTC offset they are written with',
    async () => {
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, qty INTEGER, at DATETIME, v DATETIME)',
      );
      await db.query(
        "INSERT INTO items (id, qty, at, v) VALUES ('a', 1, '2024-01-01T10:00:00+02:00', '2024-01-01T08:00:00.000Z'), ('b', 2, NULL, NULL)",
      );
      const next = {
        type: 'TIMESTAMP' as const,
        generated: node({
          op: 'coalesce',
          operands: [{ col: 'at' }, { col: 'at' }],
        }),
        generatedInputTypes: { at: 'datetime' } as const,
      };
      const schema = table({ at: { type: 'TIMESTAMP' }, v: next });
      declare(schema);
      expect(await migrate()).toMatchObject({ applied: true });

      await db.query('DROP TABLE items');
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, qty INTEGER, at DATETIME, v DATETIME)',
      );
      await db.query(
        "INSERT INTO items (id, qty, at, v) VALUES ('a', 1, '2024-01-01T10:00:00+02:00', '2024-01-01T09:00:00.000Z')",
      );
      declare(schema);
      expect(stopKinds(await migrate())).toEqual([
        'loses-data:column.generated-from-ordinary-differs',
      ]);
    },
  );

  it('stops by name when the run also changes a column the expression reads', async () => {
    if (engine === 'duckdb') return;
    await ordinary(engine === 'postgres' ? 'BIGINT' : 'INTEGER');
    await db.query("INSERT INTO items (id, qty, v) VALUES ('a', 3, 6)");
    declare(
      table({
        w: { type: 'INTEGER', notNull: true, defaultValue: 1 },
        v: {
          type: 'INTEGER',
          generated: node({
            op: 'add',
            left: { col: 'w' },
            right: { col: 'qty' },
          }),
          generatedInputTypes: { w: 'number', qty: 'number' },
        },
      }),
    );
    const result = await migrate();
    if (engine === 'postgres') {
      // The projection replays the added column, so the comparison is judged.
      expect(stopKinds(result)).toEqual([
        'loses-data:column.generated-from-ordinary-differs',
      ]);
    } else {
      expect(stopKinds(result)).toEqual([
        'unresolved-non-data-stop:column.generated-from-ordinary-unprojectable',
      ]);
    }
  });

  it('plans through a bare SchemaComparer the same way', async () => {
    if (engine === 'duckdb') return;
    await ordinary(engine === 'postgres' ? 'BIGINT' : 'INTEGER');
    await db.query("INSERT INTO items (id, qty, v) VALUES ('a', 3, 6)");
    const schema = table({ v: doubled });
    const plain = await new SchemaComparer(db, { engineHint: engine }).compare({
      items: schema,
    });
    expect(plain.changes.map((change) => change.kindHint)).toEqual([
      'column.generated-from-ordinary',
    ]);
    // PostgreSQL holds writers off (share row exclusive) before it counts, so
    // no row can land between the count and the conversion.
    const statements = plain.changes[0].sqlStatements ?? [];
    if (engine === 'postgres') {
      expect(statements[0]).toBe(
        'LOCK TABLE "items" IN SHARE ROW EXCLUSIVE MODE',
      );
      expect(statements[1]).toMatch(/^DO \$\$/);
    } else expect(statements[0]).toMatch(/^DROP TABLE IF EXISTS temp/);
  });

  describe.skipIf(engine !== 'postgres')(
    'a live type the declared type cannot hold losslessly',
    () => {
      it('stops on a double that only equals the expression once cast to an integer', async () => {
        await ordinary('DOUBLE PRECISION');
        await db.query("INSERT INTO items (id, qty, v) VALUES ('a', 3, 6.4)");
        convert(doubled);
        const result = await migrate();
        expect(result).toMatchObject({ applied: false, refused: true });
        expect(stopKinds(result)).toEqual([
          'loses-data:column.generated-from-ordinary-differs',
        ]);
        expect(await generatedNow('v')).toBe(false);
        expect(await rows()).toEqual([{ id: 'a', qty: 3, v: 6.4 }]);
      });

      it('applies a double that holds a whole number', async () => {
        await ordinary('DOUBLE PRECISION');
        await db.query("INSERT INTO items (id, qty, v) VALUES ('a', 3, 6.0)");
        convert(doubled);
        expect(await migrate()).toMatchObject({ applied: true });
        expect(await generatedNow('v')).toBe(true);
      });

      it('stops on a numeric with more digits than the declared floating type keeps', async () => {
        await ordinary('NUMERIC');
        await db.query(
          "INSERT INTO items (id, qty, v) VALUES ('a', 1, 0.1234567890123456789)",
        );
        convert({
          type: 'REAL',
          generated: times(0.12345678901234568),
          generatedInputTypes: inputs,
        });
        const result = await migrate();
        expect(stopKinds(result)).toEqual([
          'loses-data:column.generated-from-ordinary-differs',
        ]);
        expect(await generatedNow('v')).toBe(false);
      });

      it('applies a numeric that a floating type holds exactly', async () => {
        await ordinary('NUMERIC');
        await db.query("INSERT INTO items (id, qty, v) VALUES ('a', 3, 1.5)");
        convert({
          type: 'REAL',
          generated: times(0.5),
          generatedInputTypes: inputs,
        });
        expect(await migrate()).toMatchObject({ applied: true });
        expect(await generatedNow('v')).toBe(true);
      });
    },
  );
});
