/**
 * #4937: every change kind that applies on PostgreSQL applies on SQLite.
 *
 * Real in-memory SQLite. Each scenario plans with the differ, applies the plan
 * the way `db:migrate` does (one atomic unit through the tracker) and checks
 * three things a rebuild must never get wrong: the rows survive, the objects
 * that died with the dropped table come back, and the schema converges.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { classifySchemaChange } from '../change-kinds.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { createMigrationDefinition } from '../generator.js';
import {
  removeInlineReferences,
  replaceColumnDefault,
  rewriteSqliteCreateTable,
} from '../sqlite-rebuild.js';
import { MigrationTracker } from '../tracker.js';

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

describe('#4937 SQLite: rewriting a column definition in place', () => {
  it('sets, replaces and removes a default without touching the rest', () => {
    expect(replaceColumnDefault('"a" TEXT', "'x'")).toBe(
      `"a" TEXT DEFAULT 'x'`,
    );
    expect(
      replaceColumnDefault(`"a" TEXT DEFAULT 'old, value' NOT NULL`, "'x'"),
    ).toBe(`"a" TEXT DEFAULT 'x' NOT NULL`);
    expect(replaceColumnDefault(`"a" TEXT DEFAULT 'old' NOT NULL`, null)).toBe(
      `"a" TEXT NOT NULL`,
    );
    expect(
      replaceColumnDefault('"a" INTEGER DEFAULT -1 CHECK ("a" < 5)', '2'),
    ).toBe('"a" INTEGER DEFAULT 2 CHECK ("a" < 5)');
    expect(
      replaceColumnDefault('"a" TEXT DEFAULT (datetime(\'now\'))', null),
    ).toBe('"a" TEXT');
    expect(
      replaceColumnDefault("\"a\" TEXT DEFAULT strftime('%s', 'now')", '1'),
    ).toBe('"a" TEXT DEFAULT 1');
  });

  it('refuses to edit a definition that holds a comment', () => {
    expect(replaceColumnDefault(`"a" TEXT -- note`, "'x'")).toBeNull();
  });

  it('removes an inline REFERENCES with its actions and leaves the other clauses', () => {
    expect(
      removeInlineReferences(
        '"p" TEXT NOT NULL REFERENCES "parents" ("id") ON DELETE SET NULL ON UPDATE CASCADE DEFAULT \'x\'',
      ),
    ).toBe(`"p" TEXT NOT NULL DEFAULT 'x'`);
    expect(
      removeInlineReferences(
        '"p" TEXT CONSTRAINT fk REFERENCES parents(id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY DEFERRED',
      ),
    ).toBe('"p" TEXT');
    expect(removeInlineReferences('"p" TEXT NOT NULL')).toBe(
      '"p" TEXT NOT NULL',
    );
  });

  it('adds a table-level key, removes a table-level one, and refuses a missing column', () => {
    const sql = `CREATE TABLE "t" ("id" TEXT PRIMARY KEY, "p" TEXT, "q" TEXT, FOREIGN KEY ("q") REFERENCES "o" ("id"))`;
    const rewritten = rewriteSqliteCreateTable(sql, {
      tableName: 't2',
      columnTypes: new Map(),
      removeForeignKeyColumns: new Set(['q']),
      appendConstraints: [
        'CONSTRAINT "k" FOREIGN KEY ("p") REFERENCES "o" ("id")',
      ],
    });
    expect(rewritten).toContain('CONSTRAINT "k" FOREIGN KEY ("p")');
    expect(rewritten).not.toContain('FOREIGN KEY ("q")');
    expect(
      rewriteSqliteCreateTable(sql, {
        tableName: 't2',
        columnTypes: new Map(),
        setDefaults: new Map([['missing', "'x'"]]),
      }),
    ).toBeNull();
  });
});

describe('#4937 SQLite change kinds apply by table rebuild', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query('PRAGMA foreign_keys = ON');
  });
  afterEach(async () => {
    await db.close?.();
  });

  const comparer = (options = {}) =>
    new SchemaComparer(db, { engineHint: 'sqlite', ...options });
  async function plan(schemas: Record<string, SchemaDefinition>, options = {}) {
    const diff = await comparer(options).compare(schemas);
    for (const change of diff.changes)
      expect(classifySchemaChange(change)).not.toBe('unlisted');
    return diff;
  }
  let applied = 0;
  async function apply(statements: string[]) {
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    return tracker.applyAll(
      [
        createMigrationDefinition(
          `parity_${++applied}`,
          statements.filter((sql) => !sql.startsWith('--')),
        ),
      ],
      { atomic: true },
    );
  }
  async function migrate(
    schemas: Record<string, SchemaDefinition>,
    options = {},
  ) {
    const diff = await plan(schemas, options);
    const results = await apply(getSQLFromDiff(diff));
    expect(
      results.map((result) =>
        typeof result.error === 'string' ? result.error : result.error?.message,
      ),
    ).toEqual(results.map(() => undefined));
    // Converges: the second plan has nothing left to do.
    expect((await plan(schemas, options)).changes).toEqual([]);
    return diff;
  }

  it('sets and drops a default, keeping rows, indexes, triggers and rowids', async () => {
    await db.query(
      "CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT DEFAULT 'old', w TEXT)",
    );
    await db.query('CREATE INDEX items_w_idx ON items (w)');
    await db.query(
      'CREATE TRIGGER items_guard BEFORE DELETE ON items BEGIN SELECT 1; END',
    );
    await db.query(
      "INSERT INTO items (rowid, id, v, w) VALUES (7, 'a', 'x', 'y')",
    );
    const schemas = {
      items: table(
        'items',
        { v: { type: 'TEXT' }, w: { type: 'TEXT', defaultValue: 'd' } },
        { indexes: [{ name: 'items_w_idx', columns: ['w'] }] },
      ),
    };
    await migrate(schemas, { relaxColumns: true });
    expect((await db.query('SELECT rowid, id, v, w FROM items')).rows).toEqual([
      { rowid: 7, id: 'a', v: 'x', w: 'y' },
    ]);
    await db.query("INSERT INTO items (id) VALUES ('b')");
    expect(
      (await db.query("SELECT v, w FROM items WHERE id = 'b'")).rows,
    ).toEqual([{ v: null, w: 'd' }]);
    const objects = (
      await db.query(
        "SELECT name FROM sqlite_master WHERE tbl_name = 'items' AND name IN ('items_w_idx', 'items_guard') ORDER BY name",
      )
    ).rows;
    expect(objects).toEqual([{ name: 'items_guard' }, { name: 'items_w_idx' }]);
  });

  it('keeps a stale default until relaxColumns is set, as on PostgreSQL', async () => {
    await db.query(
      "CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT DEFAULT 'd')",
    );
    const schemas = { items: table('items', { v: { type: 'TEXT' } }) };
    const report = await plan(schemas);
    expect(report.changes.map(classifySchemaChange)).toEqual([
      'column.relaxation-report',
    ]);
    expect(getSQLFromDiff(report)).toEqual([]);
  });

  it('enforces NOT NULL, filling NULLs from the default or the backfill', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT, w TEXT)');
    await db.query(
      "INSERT INTO items VALUES ('a', NULL, NULL), ('b', 'keep', 'keep')",
    );
    await migrate({
      items: table('items', {
        v: { type: 'TEXT', notNull: true, defaultValue: 'filled' },
        w: { type: 'TEXT', notNull: true, backfill: "'row:' || id" },
      }),
    });
    expect(
      (await db.query('SELECT id, v, w FROM items ORDER BY id')).rows,
    ).toEqual([
      { id: 'a', v: 'filled', w: 'row:a' },
      { id: 'b', v: 'keep', w: 'keep' },
    ]);
    await expect(
      db.query("INSERT INTO items (id, v, w) VALUES ('c', 'x', NULL)"),
    ).rejects.toThrow(/NOT NULL/);
  });

  it('stops, and writes nothing, when live NULLs have no default to fill them', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT)');
    await db.query("INSERT INTO items VALUES ('a', NULL)");
    const diff = await plan({
      items: table('items', { v: { type: 'TEXT', notNull: true } }),
    });
    expect(diff.changes.map(classifySchemaChange)).toEqual([
      'column.required-nulls',
    ]);
  });

  it('drops NOT NULL by default, without relaxColumns', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT NOT NULL)');
    await db.query("INSERT INTO items VALUES ('a', 'x')");
    const diff = await migrate({
      items: table('items', { v: { type: 'TEXT' } }),
    });
    expect(diff.changes.map(classifySchemaChange)).toEqual([
      'column.drop-not-null',
    ]);
    await db.query("INSERT INTO items (id, v) VALUES ('b', NULL)");
    expect((await db.query('SELECT COUNT(*) AS n FROM items')).rows).toEqual([
      { n: 2 },
    ]);
  });

  it('adds a foreign key on an existing column and refuses it while orphans exist', async () => {
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT)');
    await db.query("INSERT INTO items VALUES ('a', 'ghost')");
    const schemas = {
      parents: table('parents', {}),
      items: table(
        'items',
        { parent_id: { type: 'TEXT' } },
        {
          foreignKeys: [
            {
              column: 'parent_id',
              referencesTable: 'parents',
              referencesColumn: 'id',
              onDelete: 'RESTRICT',
            },
          ],
          dependencies: ['parents'],
        },
      ),
    };
    const blocked = await plan(schemas);
    expect(blocked.changes.map(classifySchemaChange)).toEqual([
      'foreign-key.orphans',
    ]);
    await db.query('DELETE FROM items');
    await db.query("INSERT INTO parents VALUES ('p')");
    await db.query("INSERT INTO items VALUES ('a', 'p')");
    await migrate(schemas);
    expect(
      (await db.query('PRAGMA foreign_key_list(items)')).rows.map((row) => ({
        from: row.from,
        table: row.table,
        on_delete: row.on_delete,
      })),
    ).toEqual([{ from: 'parent_id', table: 'parents', on_delete: 'RESTRICT' }]);
    await expect(
      db.query("INSERT INTO items VALUES ('b', 'missing')"),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('replaces a key whose action drifted, and drops one the manifest disabled', async () => {
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id) ON DELETE CASCADE)',
    );
    await db.query("INSERT INTO parents VALUES ('p')");
    await db.query("INSERT INTO items VALUES ('a', 'p')");
    const withKey = (engines?: string[]) => ({
      parents: table('parents', {}),
      items: table(
        'items',
        { parent_id: { type: 'TEXT' } },
        {
          foreignKeys: [
            {
              column: 'parent_id',
              referencesTable: 'parents',
              referencesColumn: 'id',
              onDelete: 'NO ACTION',
              ...(engines ? { engines } : {}),
            } as never,
          ],
          dependencies: ['parents'],
        },
      ),
    });
    await migrate(withKey());
    expect(
      (await db.query('PRAGMA foreign_key_list(items)')).rows.map(
        (row) => row.on_delete,
      ),
    ).toEqual(['NO ACTION']);
    const dropped = await migrate(withKey(['postgres']));
    expect(dropped.changes.map(classifySchemaChange)).toEqual([
      'foreign-key.drop',
    ]);
    expect((await db.query('PRAGMA foreign_key_list(items)')).rows).toEqual([]);
    expect((await db.query('SELECT id FROM items')).rows).toEqual([
      { id: 'a' },
    ]);
  });

  it('retypes a column of a table other tables reference, keeping their rows', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, v INTEGER)');
    await db.query(
      'CREATE TABLE lines (id TEXT PRIMARY KEY, item_id TEXT REFERENCES items(id) ON DELETE CASCADE)',
    );
    await db.query("INSERT INTO items VALUES ('a', 1)");
    await db.query("INSERT INTO lines VALUES ('l', 'a')");
    await migrate({
      items: table('items', { v: { type: 'REAL' } }),
      lines: table(
        'lines',
        { item_id: { type: 'TEXT' } },
        {
          foreignKeys: [
            {
              column: 'item_id',
              referencesTable: 'items',
              referencesColumn: 'id',
              onDelete: 'CASCADE',
            },
          ],
          dependencies: ['items'],
        },
      ),
    });
    expect((await db.query('SELECT id FROM lines')).rows).toEqual([
      { id: 'l' },
    ]);
    expect((await db.query('SELECT typeof(v) AS t FROM items')).rows).toEqual([
      { t: 'real' },
    ]);
  });

  it('drops a column that an index covers, with the index', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT, old TEXT)',
    );
    await db.query('CREATE INDEX items_old_idx ON items (old)');
    await db.query("INSERT INTO items VALUES ('a', 'x', 'o')");
    const diff = await migrate(
      { items: table('items', { v: { type: 'TEXT' } }) },
      { includeDroppedColumns: true },
    );
    expect(diff.changes.map(classifySchemaChange)).toContain('column.drop');
    expect((await db.query('SELECT * FROM items')).rows).toEqual([
      { id: 'a', v: 'x' },
    ]);
  });

  it('keeps a table declared AUTOINCREMENT as a stop, with the reason', async () => {
    await db.query(
      'CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)',
    );
    const diff = await plan({
      items: table('items', { v: { type: 'TEXT', defaultValue: 'd' } }, {}),
    });
    const change = diff.changes.find(
      (item) => item.alteration === 'set_default',
    );
    expect(classifySchemaChange(change as never)).toBe(
      'column.rebuild-unavailable',
    );
    expect(change?.sql).toContain('AUTOINCREMENT');
  });

  describe('a failure mid-way leaves everything as it was', () => {
    async function snapshot() {
      return {
        master: (
          await db.query(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_smrt_%' ORDER BY name",
          )
        ).rows,
        rows: (await db.query('SELECT rowid, * FROM items ORDER BY rowid'))
          .rows,
        lines: (await db.query('SELECT * FROM lines')).rows,
        staging: (
          await db.query(
            "SELECT name FROM sqlite_master WHERE name LIKE '_smrt_rebuild_%'",
          )
        ).rows,
        foreignKeys: (await db.query('PRAGMA foreign_keys')).rows,
      };
    }
    beforeEach(async () => {
      await new MigrationTracker({ db }).initialize();
      await db.query(
        "CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT, w TEXT NOT NULL DEFAULT 'w')",
      );
      await db.query(
        'CREATE TABLE lines (id TEXT PRIMARY KEY, item_id TEXT REFERENCES items(id) ON DELETE CASCADE)',
      );
      await db.query('CREATE INDEX items_v_idx ON items (v)');
      await db.query(
        "INSERT INTO items VALUES ('a', NULL, 'w'), ('b', 'x', 'w')",
      );
      await db.query("INSERT INTO lines VALUES ('l', 'a')");
    });
    const schemas = () => ({
      items: table(
        'items',
        {
          v: { type: 'TEXT', notNull: true, defaultValue: 'filled' },
          w: { type: 'TEXT' },
        },
        { indexes: [{ name: 'items_v_idx', columns: ['v'] }] },
      ),
    });

    it('when a later statement of the batch fails', async () => {
      const before = await snapshot();
      const diff = await plan(schemas());
      const results = await apply([
        ...getSQLFromDiff(diff),
        'SELECT this_is_not_valid_sql()',
      ]);
      expect(results[0].success).toBe(false);
      expect(await snapshot()).toEqual(before);
    });

    it('when a row stops fitting after the plan was made', async () => {
      const before = await snapshot();
      const diff = await plan(schemas());
      // A writer slips in a row with a NULL the plan did not see. The copy into
      // the new table then breaks NOT NULL, halfway through the rebuild. The
      // default of the column keeps the planned NULL fill from hiding it.
      await db.query("INSERT INTO items (id, v, w) VALUES ('c', NULL, 'w')");
      await db.query("DELETE FROM items WHERE id = 'c'");
      const statements = getSQLFromDiff(diff).map((sql) =>
        sql.startsWith('INSERT INTO "_smrt_rebuild_items"')
          ? sql.replace('COALESCE("v", \'filled\')', 'NULL')
          : sql,
      );
      expect(statements.some((sql) => sql.includes(', NULL, "w"'))).toBe(true);
      const results = await apply(statements);
      expect(results[0].success).toBe(false);
      expect(await snapshot()).toEqual(before);
    });
  });
});
