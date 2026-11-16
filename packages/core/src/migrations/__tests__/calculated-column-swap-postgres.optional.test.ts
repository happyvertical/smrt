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
import { ObjectRegistry } from '../../registry.js';
import { stiHardeningChecks } from '../../schema/sti-hardening.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { registerBuildSchema } from '../build-schema.js';
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
      await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
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
  },
);
