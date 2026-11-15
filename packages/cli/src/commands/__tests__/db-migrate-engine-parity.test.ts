/**
 * #4937: one set of change-kind scenarios, run on SQLite, DuckDB and
 * PostgreSQL (PGlite, in process). Every kind that applies on PostgreSQL has to
 * apply on the other two engines, with the rows kept and the schema converged;
 * every kind that stops on one engine has to say so on the others, or be listed
 * in `DIFFERENCES` with its reason.
 */
import { PGlite } from '@electric-sql/pglite';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { migrateSmrtSchemas } from '@happyvertical/smrt-core/migrations';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Engine = 'sqlite' | 'duckdb' | 'postgres';
const ENGINES: Engine[] = ['postgres', 'sqlite', 'duckdb'];

const table = (
  name: string,
  columns: SchemaDefinition['columns'],
  extra: Partial<SchemaDefinition> = {},
): SchemaDefinition => ({
  tableName: name,
  columns: { id: { type: 'TEXT', primaryKey: true }, ...columns },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '4937',
  ...extra,
});
const itemKey = {
  column: 'item_id',
  referencesTable: 'items',
  referencesColumn: 'id',
};
const child = () =>
  table(
    'child',
    { item_id: { type: 'TEXT' } },
    { foreignKeys: [itemKey], dependencies: ['items'] },
  );
const childDdl =
  'CREATE TABLE child (id TEXT PRIMARY KEY, item_id TEXT REFERENCES items(id))';

interface Scenario {
  name: string;
  /** Statements that build the live database before the migrate. */
  setup: string[];
  schemas: Record<string, SchemaDefinition>;
  options?: Record<string, unknown>;
  /** What the migrate does, by engine. */
  outcome:
    | Partial<Record<Engine, 'applied' | 'refused'>>
    | 'applied'
    | 'refused';
  /** The change kind that stops the run, for the engines that refuse. */
  stopKind?: string;
  /** Rows and shape after an applied migrate. */
  verify?: (db: DatabaseInterface) => Promise<void>;
}

const indexed = [{ name: 'items_v_idx', columns: ['v'] }];
const SCENARIOS: Scenario[] = [
  {
    name: 'drops NOT NULL by default',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT NOT NULL)',
      "INSERT INTO items VALUES ('a', 'kept')",
    ],
    schemas: { items: table('items', { v: { type: 'TEXT' } }) },
    outcome: 'applied',
    verify: async (db) => {
      await db.query("INSERT INTO items (id, v) VALUES ('b', NULL)");
      expect(
        (await db.query("SELECT v FROM items WHERE id = 'a'")).rows,
      ).toEqual([{ v: 'kept' }]);
    },
  },
  {
    name: 'drops NOT NULL on an indexed table that another table references',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT NOT NULL)',
      'CREATE INDEX items_v_idx ON items (v)',
      childDdl,
      "INSERT INTO items VALUES ('a', 'kept')",
      "INSERT INTO child VALUES ('c', 'a')",
    ],
    schemas: {
      items: table('items', { v: { type: 'TEXT' } }, { indexes: indexed }),
      child: child(),
    },
    outcome: 'applied',
    verify: async (db) => {
      expect((await db.query('SELECT * FROM child')).rows).toEqual([
        { id: 'c', item_id: 'a' },
      ]);
      await db.query("INSERT INTO items (id, v) VALUES ('b', NULL)");
    },
  },
  {
    name: 'sets a default on an indexed table that another table references',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT)',
      'CREATE INDEX items_v_idx ON items (v)',
      childDdl,
      "INSERT INTO items VALUES ('a', 'kept')",
      "INSERT INTO child VALUES ('c', 'a')",
    ],
    schemas: {
      items: table(
        'items',
        { v: { type: 'TEXT', defaultValue: 'new' } },
        { indexes: indexed },
      ),
      child: child(),
    },
    outcome: 'applied',
    verify: async (db) => {
      await db.query("INSERT INTO items (id) VALUES ('b')");
      expect(
        (await db.query("SELECT v FROM items WHERE id = 'b'")).rows,
      ).toEqual([{ v: 'new' }]);
      expect((await db.query('SELECT * FROM child')).rows).toHaveLength(1);
    },
  },
  {
    name: 'drops a stale default only with relaxColumns',
    setup: [
      "CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT DEFAULT 'old')",
      "INSERT INTO items VALUES ('a', 'kept')",
    ],
    schemas: { items: table('items', { v: { type: 'TEXT' } }) },
    options: { relaxColumns: true },
    outcome: 'applied',
    verify: async (db) => {
      await db.query("INSERT INTO items (id) VALUES ('b')");
      expect(
        (await db.query("SELECT v FROM items WHERE id = 'b'")).rows,
      ).toEqual([{ v: null }]);
    },
  },
  {
    name: 'enforces NOT NULL after filling NULLs from the default',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT)',
      'CREATE INDEX items_v_idx ON items (v)',
      childDdl,
      "INSERT INTO items VALUES ('a', NULL), ('b', 'kept')",
      "INSERT INTO child VALUES ('c', 'a')",
    ],
    schemas: {
      items: table(
        'items',
        { v: { type: 'TEXT', notNull: true, defaultValue: 'filled' } },
        { indexes: indexed },
      ),
      child: child(),
    },
    outcome: 'applied',
    verify: async (db) => {
      expect(
        (await db.query('SELECT id, v FROM items ORDER BY id')).rows,
      ).toEqual([
        { id: 'a', v: 'filled' },
        { id: 'b', v: 'kept' },
      ]);
      expect((await db.query('SELECT * FROM child')).rows).toHaveLength(1);
    },
  },
  {
    name: 'enforces NOT NULL after filling NULLs from a backfill',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT)',
      "INSERT INTO items VALUES ('a', NULL), ('b', 'kept')",
    ],
    schemas: {
      items: table('items', {
        v: { type: 'TEXT', notNull: true, backfill: "'row:' || id" },
      }),
    },
    outcome: 'applied',
    verify: async (db) => {
      expect(
        (await db.query('SELECT id, v FROM items ORDER BY id')).rows,
      ).toEqual([
        { id: 'a', v: 'row:a' },
        { id: 'b', v: 'kept' },
      ]);
    },
  },
  {
    name: 'retypes a column of an indexed table that another table references',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY, v INTEGER)',
      'CREATE INDEX items_v_idx ON items (v)',
      childDdl,
      "INSERT INTO items VALUES ('a', 3)",
      "INSERT INTO child VALUES ('c', 'a')",
    ],
    schemas: {
      items: table('items', { v: { type: 'REAL' } }, { indexes: indexed }),
      child: child(),
    },
    outcome: 'applied',
    verify: async (db) => {
      expect(Number((await db.query('SELECT v FROM items')).rows[0].v)).toBe(3);
      expect((await db.query('SELECT * FROM child')).rows).toHaveLength(1);
    },
  },
  {
    name: 'stops at NULLs that have no default to fill them',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT)',
      "INSERT INTO items VALUES ('a', NULL)",
    ],
    schemas: {
      items: table('items', { v: { type: 'TEXT', notNull: true } }),
    },
    outcome: 'refused',
    stopKind: 'column.required-nulls',
  },
  {
    name: 'adds a required column with a default',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY)',
      "INSERT INTO items VALUES ('a')",
    ],
    schemas: {
      items: table('items', {
        w: { type: 'TEXT', notNull: true, defaultValue: 'd' },
      }),
    },
    outcome: 'applied',
    verify: async (db) => {
      expect((await db.query('SELECT w FROM items')).rows).toEqual([
        { w: 'd' },
      ]);
    },
  },
  {
    name: 'adds a required column filled from a backfill',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY)',
      childDdl,
      "INSERT INTO items VALUES ('a')",
      "INSERT INTO child VALUES ('c', 'a')",
    ],
    schemas: {
      items: table('items', {
        w: { type: 'TEXT', notNull: true, backfill: "'closed:' || id" },
      }),
      child: child(),
    },
    outcome: 'applied',
    verify: async (db) => {
      expect((await db.query('SELECT w FROM items')).rows).toEqual([
        { w: 'closed:a' },
      ]);
      expect((await db.query('SELECT * FROM child')).rows).toHaveLength(1);
    },
  },
  {
    name: 'adds a foreign key to an existing column',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY)',
      'CREATE TABLE child (id TEXT PRIMARY KEY, item_id TEXT)',
      "INSERT INTO items VALUES ('a')",
      "INSERT INTO child VALUES ('c', 'a')",
    ],
    schemas: { items: table('items', {}), child: child() },
    outcome: 'applied',
    verify: async (db) => {
      expect((await db.query('SELECT * FROM child')).rows).toEqual([
        { id: 'c', item_id: 'a' },
      ]);
      await expect(
        db.query("INSERT INTO child VALUES ('x', 'missing')"),
      ).rejects.toThrow();
    },
  },
  {
    name: 'stops at rows that have no parent, so the key would delete data',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY)',
      'CREATE TABLE child (id TEXT PRIMARY KEY, item_id TEXT)',
      "INSERT INTO child VALUES ('c', 'ghost')",
    ],
    schemas: { items: table('items', {}), child: child() },
    outcome: 'refused',
    stopKind: 'foreign-key.orphans',
  },
  {
    // PostgreSQL stops: the SQL adapter does not give it the live constraint
    // name. The other two rebuild the table. See `DIFFERENCES`.
    name: 'drops a foreign key the manifest disabled',
    setup: [
      'CREATE TABLE items (id TEXT PRIMARY KEY)',
      childDdl,
      "INSERT INTO items VALUES ('a')",
      "INSERT INTO child VALUES ('c', 'a')",
    ],
    schemas: {
      items: table('items', {}),
      child: table(
        'child',
        { item_id: { type: 'TEXT' } },
        {
          foreignKeys: [{ ...itemKey, engines: ['json'] } as never],
          dependencies: ['items'],
        },
      ),
    },
    outcome: { postgres: 'refused', sqlite: 'applied', duckdb: 'applied' },
    stopKind: 'foreign-key.drop-unavailable',
    verify: async (db) => {
      await db.query("INSERT INTO child VALUES ('x', 'missing')");
    },
  },
];

/** Where the engines still differ, and why. Each entry is a scenario above. */
const DIFFERENCES: Record<string, string> = {
  'drops a foreign key the manifest disabled':
    'PostgreSQL cannot name the live constraint, so it stops; SQLite and DuckDB rebuild the table.',
};

const outcomeFor = (
  scenario: Scenario,
  engine: Engine,
): 'applied' | 'refused' =>
  typeof scenario.outcome === 'string'
    ? scenario.outcome
    : (scenario.outcome[engine] ?? 'applied');

function postgresView(db: DatabaseInterface): DatabaseInterface {
  return {
    ...db,
    url: 'postgresql://pglite/4937',
    close: async () => {},
    transaction: async <T>(work: (tx: DatabaseInterface) => Promise<T>) => {
      if (!db.transaction) throw new Error('Transaction support required');
      return db.transaction((tx) => work(postgresView(tx)));
    },
  };
}

describe.each(ENGINES)('change kinds on %s (#4937)', (engine) => {
  let db: DatabaseInterface;
  let client: PGlite | undefined;
  beforeEach(async () => {
    if (engine === 'postgres') {
      client = new PGlite();
      db = postgresView(await getDatabase({ type: 'pglite', client }));
    } else {
      db = await getDatabase({ type: engine, url: ':memory:' });
      if (engine === 'sqlite') await db.query('PRAGMA foreign_keys = ON');
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (engine === 'postgres') await client?.close();
    else await db.close?.();
  });

  it.each(SCENARIOS)('$name', async (scenario) => {
    for (const sql of scenario.setup) await db.query(sql);
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue(
      scenario.schemas,
    );
    const run = () =>
      migrateSmrtSchemas({
        db,
        packageName: '@test/parity',
        engineHint: engine,
        ...scenario.options,
      });
    const expected = outcomeFor(scenario, engine);
    const result = await run();
    if (expected === 'refused') {
      expect(result.refused).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.stops.map((stop) => stop.kind)).toEqual([
        scenario.stopKind,
      ]);
      return;
    }
    expect(result.refused).toBeFalsy();
    expect(result.applied).toBe(true);
    await scenario.verify?.(db);
    // Converges: a second migrate finds nothing to do.
    const again = await run();
    expect(again.refused).toBeFalsy();
    expect(again.applied).toBe(false);
  });
});

describe('the remaining engine differences are all recorded', () => {
  it('lists every scenario whose outcome differs by engine', () => {
    const differing = SCENARIOS.filter(
      (scenario) =>
        new Set(ENGINES.map((engine) => outcomeFor(scenario, engine))).size > 1,
    );
    expect(differing.map((scenario) => scenario.name).sort()).toEqual(
      Object.keys(DIFFERENCES).sort(),
    );
  });
});
