/**
 * Replacing a calculated column on a real PostgreSQL server (reviews r7 C1,
 * r8 R8-1 and R8-C1), end to end through `migrateSmrtSchemas`, as the role the
 * suite connects with (in CI a NOSUPERUSER role).
 *
 * A changed expression drops and re-adds the column. Everything PostgreSQL
 * ties to the column is read from `pg_depend` and decided one by one: what the
 * re-added column brings back (its expression, NOT NULL, UNIQUE, CHECK), what
 * smrt re-creates (declared indexes, shared-table CHECKs), and what smrt did
 * not declare (stops, by name). PGlite is PostgreSQL 17, which keeps NOT NULL
 * out of `pg_constraint`; from PostgreSQL 18 it is a catalog row, so this file
 * is where that row is exercised.
 *
 * Each run gets its own database, created by this role and dropped afterwards,
 * so the migration tracker tables never meet another suite's. Needs
 * `SMRT_TEST_POSTGRES_URL` (`pnpm test:postgres`); not run in the default
 * suite.
 *
 * It also holds the real-server cases of making an ordinary column calculated
 * only when no stored value changes (#5018); `calculated-column-recompute.test.ts`
 * runs the same cases on PGlite.
 */
import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { dropScratchDatabase } from '../../__tests__/fixtures/postgres-scratch-database.js';
import { ObjectRegistry } from '../../registry.js';
import { stiHardeningChecks } from '../../schema/sti-hardening.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { registerBuildSchema } from '../build-schema.js';
import { SchemaComparer } from '../differ.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

type Generated = NonNullable<SchemaDefinition['columns'][string]['generated']>;
type Column = SchemaDefinition['columns'][string];

const STRICT = '@app/a:Strict';
const times = (factor: number): Generated =>
  ({
    op: 'mul',
    left: { col: 'qty' },
    right: { value: factor },
  }) as unknown as Generated;
const coalesced = {
  op: 'mul',
  left: { op: 'coalesce', operands: [{ col: 'qty' }, { value: 0 }] },
  right: { value: 2 },
} as unknown as Generated;
/** 1 while qty is NULL; NULL once qty is 0. */
const nullAtZero = {
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
} as unknown as Generated;

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

function items(
  columns: SchemaDefinition['columns'],
  extra: Partial<SchemaDefinition> = {},
): SchemaDefinition {
  return {
    tableName: 'items',
    columns: {
      id: { type: 'TEXT', primaryKey: true, notNull: true },
      _meta_type: { type: 'TEXT' },
      ...columns,
    },
    indexes: [],
    foreignKeys: [],
    triggers: [],
    dependencies: [],
    version: '',
    ...extra,
  };
}

const total = (generated: Generated, extra: Partial<Column> = {}): Column => ({
  type: 'INTEGER',
  generated,
  ...extra,
});

describe.skipIf(!pgUrl)(
  'replacing a calculated column on a real PostgreSQL server',
  () => {
    const name = `smrt_calc_swap_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DatabaseInterface;
    let db: DatabaseInterface;
    let run = 0;

    beforeAll(async () => {
      admin = await getDatabase({ type: 'postgres', url: pgUrl });
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(pgUrl as string);
      url.pathname = `/${name}`;
      db = await getDatabase({ type: 'postgres', url: url.toString() });
    });
    afterAll(async () => {
      await db?.close?.();
      await dropScratchDatabase(admin, `"${name}"`);
      await admin?.close?.();
    });
    beforeEach(async () => {
      await db.query('DROP VIEW IF EXISTS items_view');
      await db.query('DROP TABLE IF EXISTS items_child');
      await db.query('DROP TABLE IF EXISTS items CASCADE');
      await db.query('DROP PUBLICATION IF EXISTS items_pub');
      registerBuildSchema({
        fingerprint: 'stamp',
        tables: { items: ['@app/a'] },
        packages: ['@app/a'],
        source: 'registered',
      });
    });
    afterEach(() => {
      registerBuildSchema(undefined);
      vi.restoreAllMocks();
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
        name: `calc_swap_${++run}`,
        relaxColumns: true,
        atomic: true,
        postgresSafe: false,
        useConcurrentIndexes: false,
      });
    const unchanged = async () =>
      expect(await migrate()).toMatchObject({
        applied: false,
        refused: false,
        stops: [],
      });
    const kinds = (result: Awaited<ReturnType<typeof migrate>>) =>
      result.stops.map((stop) => `${stop.reason}:${stop.kind}`);
    const insert = (id: string, qty: number | null, type = STRICT) =>
      db.query('INSERT INTO items (id, _meta_type, qty) VALUES ($1, $2, $3)', [
        id,
        type,
        qty,
      ]);
    const rows = async () =>
      (await db.query('SELECT id, qty, total FROM items ORDER BY id')).rows.map(
        (row) => [
          row.id,
          row.qty === null ? null : Number(row.qty),
          row.total === null ? null : Number(row.total),
        ],
      );
    const totalNotNull = async () =>
      (
        await db.query(
          "SELECT attnotnull FROM pg_attribute WHERE attrelid = 'items'::regclass AND attname = 'total'",
        )
      ).rows[0]?.attnotnull === true;
    const liveChecks = async () =>
      (
        await db.query(
          "SELECT conname FROM pg_constraint WHERE conrelid = 'items'::regclass AND contype = 'c' ORDER BY conname",
        )
      ).rows.map((row) => String(row.conname));

    it('runs as a role that is not a superuser', async () => {
      const { rows: roles } = await db.query(
        'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
      );
      // The CI lane (a managed database) connects as NOSUPERUSER, so every
      // catalog read below is proven open to such a role there. A local run
      // against DATABASE_URL may use any role.
      if (process.env.CI_POSTGRES_MANAGED === '1')
        expect(roles[0]?.rolsuper).toBe(false);
      else expect(typeof roles[0]?.rolsuper).toBe('boolean');
    });

    it('applies a new expression for a required calculated column and keeps it NOT NULL', async () => {
      declare(
        items({
          qty: { type: 'INTEGER', notNull: true, defaultValue: 0 },
          total: total(times(2), { notNull: true }),
        }),
      );
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', 3);
      expect(await totalNotNull()).toBe(true);

      declare(
        items({
          qty: { type: 'INTEGER', notNull: true, defaultValue: 0 },
          total: total(times(5), { notNull: true }),
        }),
      );
      const result = await migrate();
      expect(kinds(result)).toEqual([]);
      expect(result).toMatchObject({ applied: true, refused: false });
      expect(await rows()).toEqual([['a', 3, 15]]);
      expect(await totalNotNull()).toBe(true);
      await unchanged();
    });

    it('drops NOT NULL from a calculated column the code no longer requires, as a named change', async () => {
      declare(
        items({
          qty: { type: 'INTEGER' },
          total: total(times(2), { notNull: true }),
        }),
      );
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', 3);
      declare(items({ qty: { type: 'INTEGER' }, total: total(times(5)) }));
      const result = await migrate();
      expect(kinds(result)).toEqual([]);
      expect(result).toMatchObject({ applied: true, refused: false });
      expect(await rows()).toEqual([['a', 3, 15]]);
      expect(await totalNotNull()).toBe(false);
      await unchanged();
    });

    it('puts back the shared-table CHECK of a subclass that requires the calculated field', async () => {
      declare(
        items(
          { qty: { type: 'INTEGER' }, total: total(times(2)) },
          { checks: [rule] },
        ),
      );
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', 3);
      await insert('b', null, '@app/a:Loose');
      declare(
        items(
          { qty: { type: 'INTEGER' }, total: total(times(5)) },
          { checks: [rule] },
        ),
      );
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      expect(await rows()).toEqual([
        ['a', 3, 15],
        ['b', null, null],
      ]);
      expect(await liveChecks()).toEqual([rule.name]);
      await expect(insert('c', null)).rejects.toThrow(rule.name);
      await insert('d', null, '@app/a:Loose');
      await unchanged();
    });

    it('replaces two calculated columns that share a declared composite index in one run', async () => {
      const pair = (factor: number) =>
        items(
          {
            qty: { type: 'INTEGER' },
            a: total(times(factor)),
            b: total(times(factor + 1)),
          },
          { indexes: [{ name: 'items_ab_idx', columns: ['a', 'b'] }] },
        );
      declare(pair(2));
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('x', 3);
      declare(pair(5));
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      expect(
        (await db.query('SELECT a, b FROM items')).rows.map((row) => [
          Number(row.a),
          Number(row.b),
        ]),
      ).toEqual([[15, 18]]);
      expect(
        (
          await db.query(
            "SELECT indexname FROM pg_indexes WHERE indexname = 'items_ab_idx'",
          )
        ).rows,
      ).toHaveLength(1);
      await unchanged();
    });

    it('re-creates declared indexes over the column and its own UNIQUE', async () => {
      const indexed = (generated: Generated) =>
        items(
          {
            qty: { type: 'INTEGER' },
            total: total(generated, { unique: true }),
          },
          {
            checks: [rule],
            indexes: [
              { name: 'items_total_idx', columns: ['total'] },
              {
                name: 'items_qty_positive_idx',
                columns: ['qty'],
                where: 'total > 0',
              },
            ],
          },
        );
      declare(indexed(times(2)));
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', 3);
      declare(indexed(times(5)));
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      expect(await rows()).toEqual([['a', 3, 15]]);
      const indexes = (
        await db.query(
          "SELECT indexname FROM pg_indexes WHERE tablename = 'items' ORDER BY indexname",
        )
      ).rows.map((row) => String(row.indexname));
      expect(indexes).toEqual(
        expect.arrayContaining([
          'items_total_idx',
          'items_qty_positive_idx',
          'items_total_key',
        ]),
      );
      expect(await liveChecks()).toEqual([rule.name]);
      await unchanged();
    });

    // Each object PostgreSQL ties to the column and smrt did not declare: the
    // replacement would drop it (or DROP COLUMN would refuse), so the plan
    // stops and names it. `label` is what the stop message must contain.
    it.each([
      [
        'an index',
        'index items_total_hand',
        ['CREATE INDEX items_total_hand ON items ((total + 1))'],
      ],
      [
        'a CHECK constraint',
        'CHECK constraint items_total_hand_ck',
        [
          'ALTER TABLE items ADD CONSTRAINT items_total_hand_ck CHECK (total >= 0)',
        ],
      ],
      [
        'a UNIQUE constraint and its index',
        'UNIQUE constraint items_total_hand_key',
        [
          'ALTER TABLE items ADD CONSTRAINT items_total_hand_key UNIQUE (total)',
        ],
      ],
      [
        'an exclusion constraint',
        'exclusion constraint items_total_hand_ex',
        [
          'ALTER TABLE items ADD CONSTRAINT items_total_hand_ex EXCLUDE USING btree (total WITH =)',
        ],
      ],
      [
        'a foreign key from another table',
        'foreign key items_child_total_fkey',
        [
          'ALTER TABLE items ADD CONSTRAINT items_total_hand_key UNIQUE (total)',
          'CREATE TABLE items_child (total INTEGER REFERENCES items (total))',
        ],
      ],
      [
        'a NOT NULL the code does not declare',
        'column.drop-not-null',
        ['ALTER TABLE items ALTER COLUMN total SET NOT NULL'],
      ],
      [
        'a view',
        'view items_view',
        ['CREATE VIEW items_view AS SELECT total FROM items'],
      ],
      [
        'a trigger',
        'trigger items_total_hand_tg',
        [
          'CREATE OR REPLACE FUNCTION items_total_hand_fn() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
          'CREATE TRIGGER items_total_hand_tg BEFORE UPDATE OF total ON items FOR EACH ROW EXECUTE FUNCTION items_total_hand_fn()',
        ],
      ],
      [
        'extended statistics',
        'statistics items_total_hand_st',
        ['CREATE STATISTICS items_total_hand_st ON qty, total FROM items'],
      ],
      [
        'a row-level security policy',
        'policy items_total_hand_pol',
        ['CREATE POLICY items_total_hand_pol ON items USING (total > 0)'],
      ],
      [
        'a column comment',
        'the column comment',
        ["COMMENT ON COLUMN items.total IS 'kept by hand'"],
      ],
      [
        'a column grant',
        'column-level privileges',
        ['GRANT SELECT (total) ON items TO PUBLIC'],
      ],
    ] as const)('stops and names %s', async (_what, label, setup) => {
      declare(
        items(
          { qty: { type: 'INTEGER' }, total: total(times(2)) },
          { checks: [rule] },
        ),
      );
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', 3);
      for (const sql of setup) await db.query(sql);
      declare(
        items(
          { qty: { type: 'INTEGER' }, total: total(times(5)) },
          { checks: [rule] },
        ),
      );
      const result = await migrate();
      if (label === 'column.drop-not-null') {
        // Not a stop: the code declares the column nullable, so the plan
        // drops NOT NULL as its own change, as for an ordinary column.
        expect(result).toMatchObject({ applied: true, refused: false });
        expect(await totalNotNull()).toBe(false);
        expect(await rows()).toEqual([['a', 3, 15]]);
        return;
      }
      expect(result).toMatchObject({ applied: false, refused: true });
      expect(kinds(result)).toEqual([
        'loses-data:column.generated-replace-dependents',
      ]);
      expect(result.stops[0]?.message).toContain(label);
      expect(await rows()).toEqual([['a', 3, 6]]);
      expect(await liveChecks()).toEqual(expect.arrayContaining([rule.name]));
    });

    it('stops and names a publication column list', async () => {
      declare(items({ qty: { type: 'INTEGER' }, total: total(times(2)) }));
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', 3);
      try {
        await db.query(
          'CREATE PUBLICATION items_pub FOR TABLE items (id, total)',
        );
      } catch {
        // A role without CREATE on the database cannot make one; nothing to test.
        return;
      }
      declare(items({ qty: { type: 'INTEGER' }, total: total(times(5)) }));
      const result = await migrate();
      expect(kinds(result)).toEqual([
        'loses-data:column.generated-replace-dependents',
      ]);
      expect(result.stops[0]?.message).toContain('publication items_pub');
    });

    // Review r8 (C1): the probe reads the rows as the run leaves them.
    it.each([
      ['a declared backfill', { backfill: '0' }],
      ['the declared default', { defaultValue: 0 }],
    ] as const)('judges the rule after %s fills an existing column', async (_label, fill) => {
      declare(
        items(
          { qty: { type: 'INTEGER' }, total: total(coalesced) },
          { checks: [rule] },
        ),
      );
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', null);
      declare(
        items(
          {
            qty: { type: 'INTEGER', notNull: true, ...fill },
            total: total(times(5)),
          },
          { checks: [rule] },
        ),
      );
      const result = await migrate();
      expect(kinds(result)).toEqual([]);
      expect(result).toMatchObject({ applied: true, refused: false });
      expect(await rows()).toEqual([['a', 0, 0]]);
      expect(await liveChecks()).toEqual([rule.name]);
      await unchanged();
    });

    it('stops when the values the run fills in break the rule', async () => {
      declare(
        items(
          { qty: { type: 'INTEGER' }, total: total(coalesced) },
          { checks: [rule] },
        ),
      );
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', null);
      declare(
        items(
          {
            qty: { type: 'INTEGER', notNull: true, backfill: '0' },
            total: total(nullAtZero),
          },
          { checks: [rule] },
        ),
      );
      const result = await migrate();
      expect(result).toMatchObject({ applied: false, refused: true });
      expect(kinds(result)).toContain('invents-data:check.violated');
      expect(await rows()).toEqual([['a', null, 0]]);
    });

    it('judges the rule through a type conversion, its preflight and a replacement in one run', async () => {
      // qty is REAL live; the run converts it (after a read-only preflight)
      // and replaces total, which reads qty. The old total is dropped before
      // the conversion and the new one added after it (#5008): PostgreSQL
      // refuses to convert a column a calculated column reads.
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, _meta_type TEXT, qty REAL, total INTEGER GENERATED ALWAYS AS ((COALESCE(qty, 0) * 2)::integer) STORED)',
      );
      await insert('a', 2);
      await insert('b', null, '@app/a:Loose');
      declare(
        items(
          {
            qty: { type: 'INTEGER' },
            total: total(times(5)),
          },
          { checks: [rule] },
        ),
      );
      const result = await migrate();
      expect(kinds(result)).toEqual([]);
      expect(result).toMatchObject({ applied: true, refused: false });
      expect(await rows()).toEqual([
        ['a', 2, 10],
        ['b', null, null],
      ]);
      expect(await liveChecks()).toEqual([rule.name]);
    });

    it('converts a column and swaps the calculated column that reads it, whichever is declared first', async () => {
      const reads = (factor: number): Column => ({
        ...total(times(factor)),
        generatedInputTypes: { qty: 'number' },
      });
      for (const swapFirst of [false, true]) {
        await db.query('DROP TABLE IF EXISTS items');
        const declared = (qty: 'INTEGER' | 'REAL', factor: number) =>
          swapFirst
            ? { total: reads(factor), qty: { type: qty } }
            : { qty: { type: qty }, total: reads(factor) };
        declare(items(declared('INTEGER', 2)));
        expect(await migrate()).toMatchObject({ applied: true });
        await insert('a', 3);
        declare(items(declared('REAL', 5)));
        const result = await migrate();
        expect(kinds(result)).toEqual([]);
        expect(result).toMatchObject({ applied: true, refused: false });
        expect(await rows()).toEqual([['a', 3, 15]]);
        await unchanged();
      }
    });

    it('stops, by name, when a required calculated column would be NULL for a stored row (#5008)', async () => {
      declare(items({ qty: { type: 'INTEGER' }, total: total(times(2)) }));
      expect(await migrate()).toMatchObject({ applied: true });
      await insert('a', 3);
      await insert('b', null, '@app/a:Loose');
      declare(
        items({
          qty: { type: 'INTEGER' },
          total: total(times(5), { notNull: true }),
        }),
      );
      const result = await migrate();
      expect(result).toMatchObject({ applied: false, refused: true });
      expect(kinds(result)).toEqual([
        'invents-data:column.generated-required-null',
      ]);
      expect(result.stops[0]?.message).toContain('items.total');
      expect(await rows()).toEqual([
        ['a', 3, 6],
        ['b', null, null],
      ]);
      await db.query("DELETE FROM items WHERE id = 'b'");
      expect(await migrate()).toMatchObject({ applied: true, refused: false });
      expect(await totalNotNull()).toBe(true);
    });

    it('stops a rule a type conversion leaves broken in the same run', async () => {
      // The run converts qty but fills it only on the next run (a column
      // whose type drifts compares its NOT NULL once the type is settled),
      // so the Strict row still has no total when the rule would be added:
      // a named stop, `check.deferred-fill`, not a bare `check.violated`.
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, _meta_type TEXT, qty REAL, total INTEGER GENERATED ALWAYS AS ((COALESCE(qty, 0) * 2)::integer) STORED)',
      );
      await insert('a', null);
      declare(
        items(
          {
            qty: { type: 'INTEGER', notNull: true, backfill: '0' },
            total: total(times(5)),
          },
          { checks: [rule] },
        ),
      );
      const result = await migrate();
      expect(result).toMatchObject({ applied: false, refused: true });
      expect(kinds(result)).toEqual(['invents-data:check.deferred-fill']);
    });
    describe('an ordinary column made calculated when no value changes (#5018)', () => {
      const convertMigrate = (
        options: { tables?: string[]; confirm?: string[] } = {},
      ) =>
        migrateSmrtSchemas({
          db,
          packageName: '@app/a',
          engineHint: 'postgres',
          name: `calc_recompute_${++run}`,
          ...(options.tables ? { tables: options.tables } : {}),
          ...(options.confirm ? { confirmRecompute: options.confirm } : {}),
          relaxColumns: true,
          atomic: true,
          postgresSafe: false,
          useConcurrentIndexes: false,
        });
      const ordinary = (live: string) =>
        db.query(
          `CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, _meta_type TEXT, qty BIGINT, total ${live})`,
        );
      const put = (id: string, qty: number | null, value: unknown) =>
        db.query(
          'INSERT INTO items (id, _meta_type, qty, total) VALUES ($1, $2, $3, $4)',
          [id, STRICT, qty, value],
        );
      const inputs = { qty: 'number' } as const;
      const doubled = () => ({
        ...total(times(2)),
        generatedInputTypes: inputs,
      });
      const isCalculated = async () =>
        (
          await db.query(
            "SELECT attgenerated FROM pg_attribute WHERE attrelid = 'items'::regclass AND attname = 'total'",
          )
        ).rows[0]?.attgenerated === 's';
      const recorded = async () =>
        JSON.parse(
          String(
            (
              await db.query(
                'SELECT recomputes FROM _smrt_migrate_runs ORDER BY created_at DESC, id DESC LIMIT 1',
              )
            ).rows[0]?.recomputes ?? 'null',
          ),
        );

      it('applies when every stored value equals the expression, NULLs on both sides included', async () => {
        await ordinary('BIGINT');
        await put('a', 3, 6);
        await put('b', 0, 0);
        await put('c', null, null);
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        expect(await convertMigrate()).toMatchObject({
          applied: true,
          refused: false,
        });
        expect(await isCalculated()).toBe(true);
        expect(await rows()).toEqual([
          ['a', 3, 6],
          ['b', 0, 0],
          ['c', null, null],
        ]);
        await unchanged();
      });

      it('converts to a REQUIRED calculated column when every stored value matches and none is NULL', async () => {
        await ordinary('BIGINT');
        await db.query('ALTER TABLE items ALTER COLUMN total SET NOT NULL');
        await put('a', 3, 6);
        await put('b', 0, 0);
        declare(
          items({
            qty: { type: 'INTEGER' },
            total: { ...doubled(), notNull: true },
          }),
        );
        const result = await convertMigrate();
        expect(kinds(result)).toEqual([]);
        expect(result).toMatchObject({ applied: true, refused: false });
        expect(await isCalculated()).toBe(true);
        expect(await rows()).toEqual([
          ['a', 3, 6],
          ['b', 0, 0],
        ]);
      });

      it('stops on one differing row, names it, and changes nothing', async () => {
        await ordinary('BIGINT');
        await put('a', 3, 6);
        await put('b', 4, 99);
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        const result = await convertMigrate();
        expect(result).toMatchObject({ applied: false, refused: true });
        expect(kinds(result)).toEqual([
          'loses-data:column.generated-from-ordinary-differs',
        ]);
        expect(result.stops[0].message).toContain('1 stored row(s)');
        expect(result.stops[0].message).toContain(
          'id=b: stored 99, computed 8',
        );
        expect(await isCalculated()).toBe(false);
        expect(await rows()).toEqual([
          ['a', 3, 6],
          ['b', 4, 99],
        ]);
      });

      it('compares text 1.50 with a computed 1.5 by value, and stops on text that is no number', async () => {
        await ordinary('TEXT');
        await put('a', 3, '1.50');
        await put('b', 4, '2');
        const half = {
          type: 'REAL' as const,
          generated: times(0.5),
          generatedInputTypes: inputs,
        };
        declare(items({ qty: { type: 'INTEGER' }, total: half }));
        expect(await convertMigrate()).toMatchObject({ applied: true });
        expect(await isCalculated()).toBe(true);

        await db.query('DROP TABLE items');
        await ordinary('TEXT');
        await put('a', 3, 'two');
        const result = await convertMigrate();
        expect(result).toMatchObject({ applied: false, refused: true });
        expect(kinds(result)).toEqual([
          'unresolved-non-data-stop:column.generated-from-ordinary-unprojectable',
        ]);
        expect(await isCalculated()).toBe(false);
      });

      it('compares floating point exactly and booleans as booleans', async () => {
        await ordinary('DOUBLE PRECISION');
        // bigint * numeric 0.1 is exactly 0.3 in PostgreSQL.
        await put('a', 3, 0.3);
        const tenth = {
          type: 'REAL' as const,
          generated: times(0.1),
          generatedInputTypes: inputs,
        };
        declare(items({ qty: { type: 'INTEGER' }, total: tenth }));
        expect(await convertMigrate()).toMatchObject({ applied: true });

        await db.query('DROP TABLE items');
        await ordinary('DOUBLE PRECISION');
        await put('a', 3, 3 * 0.1);
        expect(kinds(await convertMigrate())).toEqual([
          'loses-data:column.generated-from-ordinary-differs',
        ]);

        await db.query('DROP TABLE items');
        await ordinary('BOOLEAN');
        await put('a', 3, true);
        await put('b', 1, false);
        await put('c', null, null);
        const big = {
          type: 'BOOLEAN' as const,
          generated: {
            op: 'gt',
            left: { col: 'qty' },
            right: { value: 2 },
          } as unknown as Generated,
          generatedInputTypes: inputs,
        };
        declare(items({ qty: { type: 'INTEGER' }, total: big }));
        expect(await convertMigrate()).toMatchObject({ applied: true });
      });

      it('aborts the run when a row written between plan and apply differs', async () => {
        await ordinary('BIGINT');
        await put('a', 3, 6);
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        const compare = SchemaComparer.prototype.compare;
        vi.spyOn(SchemaComparer.prototype, 'compare').mockImplementation(
          async function (this: SchemaComparer, ...args) {
            const diff = await compare.apply(this, args);
            // The plan counted zero; now a row arrives that the expression cannot match.
            await put('z', 1, 500);
            return diff;
          },
        );
        await expect(convertMigrate()).rejects.toThrow(
          /stored value now differs|P0001/,
        );
        vi.restoreAllMocks();
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        expect(await isCalculated()).toBe(false);
        expect(await rows()).toEqual([
          ['a', 3, 6],
          ['z', 1, 500],
        ]);
      });

      it('waits for a writer that is still open, then aborts when its row differs', async () => {
        await ordinary('BIGINT');
        await put('a', 3, 6);
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        // A writer whose transaction is open while the migrate plans and
        // applies: its row is invisible to the plan's count (zero).
        const writer = await (
          db as unknown as {
            beginTransaction(): Promise<{
              query(sql: string, ...params: unknown[]): Promise<unknown>;
              commit(): Promise<void>;
              rollback(): Promise<void>;
            }>;
          }
        ).beginTransaction();
        let migrated: Promise<unknown> | undefined;
        try {
          await writer.query(
            'INSERT INTO items (id, _meta_type, qty, total) VALUES ($1, $2, $3, $4)',
            'z',
            STRICT,
            1,
            500,
          );
          migrated = convertMigrate().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          // The run must be held behind the writer (the table lock), not past it.
          let waiting = false;
          for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
            const { rows: blocked } = await db.query(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%LOCK TABLE%'",
            );
            waiting = blocked.length > 0;
            if (!waiting) await new Promise((r) => setTimeout(r, 100));
          }
          expect(waiting).toBe(true);
          await writer.commit();
        } catch (error) {
          await writer.rollback().catch(() => undefined);
          throw error;
        }
        const outcome = (await migrated) as { error?: unknown };
        expect(String((outcome.error as Error)?.message)).toMatch(
          /stored value now differs|P0001/,
        );
        expect(await isCalculated()).toBe(false);
        expect(await rows()).toEqual([
          ['a', 3, 6],
          ['z', 1, 500],
        ]);
      });

      it('stops on a value that only equals the expression after a lossy cast', async () => {
        await ordinary('DOUBLE PRECISION');
        await put('a', 3, 6.4);
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        const stopped = await convertMigrate();
        expect(stopped).toMatchObject({ applied: false, refused: true });
        expect(kinds(stopped)).toEqual([
          'loses-data:column.generated-from-ordinary-differs',
        ]);
        expect(await isCalculated()).toBe(false);

        await db.query('DROP TABLE items');
        await ordinary('NUMERIC');
        await put('a', 1, '0.1234567890123456789');
        declare(
          items({
            qty: { type: 'INTEGER' },
            total: {
              type: 'REAL',
              generated: times(0.12345678901234568),
              generatedInputTypes: inputs,
            },
          }),
        );
        expect(kinds(await convertMigrate())).toEqual([
          'loses-data:column.generated-from-ordinary-differs',
        ]);

        // A whole double and a numeric a double holds exactly still convert.
        await db.query('DROP TABLE items');
        await ordinary('DOUBLE PRECISION');
        await put('a', 3, 6);
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        expect(await convertMigrate()).toMatchObject({ applied: true });
      });

      it('refuses the conversion in a table-limited run', async () => {
        await ordinary('BIGINT');
        await put('a', 3, 6);
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        const limited = await convertMigrate({ tables: ['items'] });
        expect(limited).toMatchObject({ applied: false, refused: true });
        expect(limited.stops.map((stop) => stop.reason)).toEqual([
          'build-table',
        ]);
        expect(await isCalculated()).toBe(false);
      });

      it('recalculates on request and records it in the run', async () => {
        await ordinary('BIGINT');
        await put('a', 3, 6);
        await put('b', 4, 99);
        declare(items({ qty: { type: 'INTEGER' }, total: doubled() }));
        const result = await convertMigrate({ confirm: ['items.total'] });
        expect(result).toMatchObject({ applied: true, refused: false });
        expect(result.recomputed).toEqual([
          { table: 'items', column: 'total', rows: 1 },
        ]);
        expect(await rows()).toEqual([
          ['a', 3, 6],
          ['b', 4, 8],
        ]);
        expect(await recorded()).toEqual([
          { table: 'items', column: 'total', rows: 1 },
        ]);
      });
    });
  },
);
