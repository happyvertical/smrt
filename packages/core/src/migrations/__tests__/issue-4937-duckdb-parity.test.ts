/**
 * #4937: every change kind that applies on PostgreSQL applies on DuckDB.
 *
 * Real in-memory DuckDB. DuckDB refuses an ALTER when the table has an index,
 * when another table references it, and after an UPDATE in the same
 * transaction, and it cannot add or drop a foreign key. Each scenario plans
 * with the differ and applies the plan the way `db:migrate` does (one atomic
 * transaction through the tracker), then checks that the rows survive, the
 * indexes and keys come back and the schema converges.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { classifySchemaChange } from '../change-kinds.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { createMigrationDefinition } from '../generator.js';
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
const key = (extra: Record<string, unknown> = {}) => ({
  column: 'parent_id',
  referencesTable: 'parents',
  referencesColumn: 'id',
  ...extra,
});

describe('#4937 DuckDB change kinds apply when ALTER cannot', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
  });
  afterEach(async () => {
    await db.close?.();
  });

  const comparer = (options = {}) =>
    new SchemaComparer(db, { engineHint: 'duckdb', ...options });
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
  const indexNames = async () =>
    (
      await db.query(
        "SELECT index_name FROM duckdb_indexes() WHERE index_name NOT LIKE 'idx_smrt_%' ORDER BY index_name",
      )
    ).rows.map((row) => row.index_name);

  it('moves the indexes aside for default and NOT NULL drift on an indexed table', async () => {
    await db.query(
      "CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT NOT NULL, w TEXT DEFAULT 'old')",
    );
    await db.query('CREATE INDEX items_v_idx ON items (v)');
    await db.query("INSERT INTO items VALUES ('a', 'x', 'y')");
    const diff = await migrate(
      {
        items: table(
          'items',
          { v: { type: 'TEXT' }, w: { type: 'TEXT', defaultValue: 'new' } },
          { indexes: [{ name: 'items_v_idx', columns: ['v'] }] },
        ),
      },
      { relaxColumns: true },
    );
    expect(diff.changes.map(classifySchemaChange).sort()).toEqual([
      'column.drop-not-null',
      'column.set-default',
    ]);
    expect(await indexNames()).toEqual(['items_v_idx']);
    expect((await db.query('SELECT * FROM items')).rows).toEqual([
      { id: 'a', v: 'x', w: 'y' },
    ]);
  });

  it('drops NOT NULL by default, without relaxColumns', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT NOT NULL)');
    await db.query("INSERT INTO items VALUES ('a', 'x')");
    await migrate({ items: table('items', { v: { type: 'TEXT' } }) });
    await db.query("INSERT INTO items (id, v) VALUES ('b', NULL)");
  });

  it('enforces NOT NULL after filling NULLs, which ALTER cannot do in one transaction', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT, w TEXT)');
    await db.query('CREATE INDEX items_w_idx ON items (w)');
    await db.query(
      "INSERT INTO items VALUES ('a', NULL, NULL), ('b', 'keep', 'keep')",
    );
    await migrate({
      items: table(
        'items',
        {
          v: { type: 'TEXT', notNull: true, defaultValue: 'filled' },
          w: { type: 'TEXT', notNull: true, backfill: "'row:' || id" },
        },
        { indexes: [{ name: 'items_w_idx', columns: ['w'] }] },
      ),
    });
    expect(
      (await db.query('SELECT id, v, w FROM items ORDER BY id')).rows,
    ).toEqual([
      { id: 'a', v: 'filled', w: 'row:a' },
      { id: 'b', v: 'keep', w: 'keep' },
    ]);
    expect(await indexNames()).toEqual(['items_w_idx']);
    await expect(
      db.query("INSERT INTO items (id, v, w) VALUES ('c', NULL, 'x')"),
    ).rejects.toThrow();
  });

  it('adds a required column filled from its backfill', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY)');
    await db.query("INSERT INTO items VALUES ('a'), ('b')");
    await migrate({
      items: table('items', {
        claim: { type: 'TEXT', notNull: true, backfill: "'closed:' || id" },
      }),
    });
    expect(
      (await db.query('SELECT id, claim FROM items ORDER BY id')).rows,
    ).toEqual([
      { id: 'a', claim: 'closed:a' },
      { id: 'b', claim: 'closed:b' },
    ]);
  });

  it('retypes a column that an index covers', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, v INTEGER)');
    await db.query('CREATE INDEX items_v_idx ON items (v)');
    await db.query("INSERT INTO items VALUES ('a', 3)");
    await migrate({
      items: table(
        'items',
        { v: { type: 'REAL' } },
        { indexes: [{ name: 'items_v_idx', columns: ['v'] }] },
      ),
    });
    expect((await db.query('SELECT v FROM items')).rows).toEqual([{ v: 3 }]);
    expect(await indexNames()).toEqual(['items_v_idx']);
  });

  it('drops a column that an index covers, and keeps the other indexes', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT, old TEXT)',
    );
    await db.query('CREATE INDEX items_old_idx ON items (old)');
    await db.query('CREATE INDEX items_v_idx ON items (v)');
    await db.query("INSERT INTO items VALUES ('a', 'x', 'o')");
    await migrate(
      {
        items: table(
          'items',
          { v: { type: 'TEXT' } },
          { indexes: [{ name: 'items_v_idx', columns: ['v'] }] },
        ),
      },
      { includeDroppedColumns: true },
    );
    expect((await db.query('SELECT * FROM items')).rows).toEqual([
      { id: 'a', v: 'x' },
    ]);
    expect(await indexNames()).toEqual(['items_v_idx']);
  });

  it('adds a foreign key on an existing column and refuses it while orphans exist', async () => {
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT)');
    await db.query('CREATE INDEX items_parent_idx ON items (parent_id)');
    await db.query("INSERT INTO items VALUES ('a', 'ghost')");
    const schemas = {
      parents: table('parents', {}),
      items: table(
        'items',
        { parent_id: { type: 'TEXT' } },
        {
          foreignKeys: [key()],
          dependencies: ['parents'],
          indexes: [{ name: 'items_parent_idx', columns: ['parent_id'] }],
        },
      ),
    };
    expect((await plan(schemas)).changes.map(classifySchemaChange)).toEqual([
      'foreign-key.orphans',
    ]);
    await db.query('DELETE FROM items');
    await db.query("INSERT INTO parents VALUES ('p')");
    await db.query("INSERT INTO items VALUES ('a', 'p')");
    await migrate(schemas);
    await expect(
      db.query("INSERT INTO items VALUES ('b', 'missing')"),
    ).rejects.toThrow();
    expect(await indexNames()).toEqual(['items_parent_idx']);
  });

  it('drops a foreign key the manifest disabled', async () => {
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id))',
    );
    await db.query("INSERT INTO parents VALUES ('p')");
    await db.query("INSERT INTO items VALUES ('a', 'p')");
    const diff = await migrate({
      parents: table('parents', {}),
      items: table(
        'items',
        { parent_id: { type: 'TEXT' } },
        {
          foreignKeys: [key({ engines: ['postgres'] }) as never],
          dependencies: ['parents'],
        },
      ),
    });
    expect(diff.changes.map(classifySchemaChange)).toEqual([
      'foreign-key.drop',
    ]);
    await db.query("INSERT INTO items VALUES ('b', 'missing')");
  });

  describe('a table that other tables reference', () => {
    beforeEach(async () => {
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY, v INTEGER, w TEXT)',
      );
      await db.query('CREATE INDEX items_w_idx ON items (w)');
      await db.query(
        'CREATE TABLE lines (id TEXT PRIMARY KEY, item_id TEXT REFERENCES items(id), note TEXT)',
      );
      await db.query('CREATE INDEX lines_note_idx ON lines (note)');
      await db.query(
        'CREATE TABLE notes (id TEXT PRIMARY KEY, line_id TEXT REFERENCES lines(id))',
      );
      await db.query("INSERT INTO items VALUES ('a', 1, 'w')");
      await db.query("INSERT INTO lines VALUES ('l', 'a', 'n')");
      await db.query("INSERT INTO notes VALUES ('n', 'l')");
    });
    const fk = (name: string, column: string, to: string) =>
      table(
        name,
        { [column]: { type: 'TEXT' } },
        {
          foreignKeys: [
            {
              column,
              referencesTable: to,
              referencesColumn: 'id',
            },
          ],
          dependencies: [to],
        },
      );
    const schemas = (v: 'INTEGER' | 'REAL') => ({
      items: table(
        'items',
        { v: { type: v }, w: { type: 'TEXT', defaultValue: 'd' } },
        { indexes: [{ name: 'items_w_idx', columns: ['w'] }] },
      ),
      lines: {
        ...fk('lines', 'item_id', 'items'),
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          item_id: { type: 'TEXT' },
          note: { type: 'TEXT' },
        },
        indexes: [{ name: 'lines_note_idx', columns: ['note'] }],
      } as SchemaDefinition,
      notes: fk('notes', 'line_id', 'lines'),
    });

    it('rebuilds the whole group in one transaction, keeping rows, indexes and keys', async () => {
      await migrate(schemas('REAL'));
      expect((await db.query('SELECT * FROM items')).rows).toEqual([
        { id: 'a', v: 1, w: 'w' },
      ]);
      expect((await db.query('SELECT * FROM lines')).rows).toEqual([
        { id: 'l', item_id: 'a', note: 'n' },
      ]);
      expect((await db.query('SELECT * FROM notes')).rows).toEqual([
        { id: 'n', line_id: 'l' },
      ]);
      expect(await indexNames()).toEqual(['items_w_idx', 'lines_note_idx']);
      await expect(
        db.query("INSERT INTO lines VALUES ('x', 'missing', 'n')"),
      ).rejects.toThrow();
      await expect(
        db.query("INSERT INTO notes VALUES ('x', 'missing')"),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '_smrt_rebuild_%'",
          )
        ).rows,
      ).toEqual([]);
    });

    it('leaves every table as it was when the rebuild fails part-way', async () => {
      const snapshot = async () => ({
        tables: (
          await db.query(
            "SELECT table_name, sql FROM duckdb_tables() WHERE table_name NOT LIKE '_smrt_schema%' ORDER BY table_name",
          )
        ).rows,
        indexes: await indexNames(),
        items: (await db.query('SELECT * FROM items')).rows,
        lines: (await db.query('SELECT * FROM lines')).rows,
        notes: (await db.query('SELECT * FROM notes')).rows,
      });
      const before = await snapshot();
      const diff = await plan(schemas('REAL'));
      const statements = getSQLFromDiff(diff);
      // Fail after the old tables are dropped and the new ones filled.
      const last = statements.findIndex((sql) =>
        sql.startsWith('DROP TABLE "_smrt_rebuild_'),
      );
      expect(last).toBeGreaterThan(0);
      statements.splice(last, 0, 'SELECT this_is_not_valid_sql()');
      const results = await apply(statements);
      expect(results[0].success).toBe(false);
      expect(await snapshot()).toEqual(before);
    });

    it('applies a plain default change to the referenced table too', async () => {
      await db.query('DROP TABLE notes');
      await db.query('DROP TABLE lines');
      await db.query(
        'CREATE TABLE lines (id TEXT PRIMARY KEY, item_id TEXT REFERENCES items(id))',
      );
      await db.query("INSERT INTO lines VALUES ('l', 'a')");
      await migrate({
        items: table(
          'items',
          { v: { type: 'INTEGER' }, w: { type: 'TEXT', defaultValue: 'next' } },
          { indexes: [{ name: 'items_w_idx', columns: ['w'] }] },
        ),
        lines: fk('lines', 'item_id', 'items'),
      });
      await db.query("INSERT INTO items (id) VALUES ('b')");
      expect(
        (await db.query("SELECT w FROM items WHERE id = 'b'")).rows,
      ).toEqual([{ w: 'next' }]);
      expect((await db.query('SELECT * FROM lines')).rows).toEqual([
        { id: 'l', item_id: 'a' },
      ]);
    });
  });

  it('alters a table that references itself in place, and stops when it would need a rebuild', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES items(id), v TEXT)',
    );
    await db.query("INSERT INTO items VALUES ('a', NULL, NULL)");
    const selfKey = {
      foreignKeys: [
        {
          column: 'parent_id',
          referencesTable: 'items',
          referencesColumn: 'id',
        },
      ],
      dependencies: ['items'],
    };
    // A plain ALTER is fine on such a table.
    await migrate({
      items: table(
        'items',
        { parent_id: { type: 'TEXT' }, v: { type: 'TEXT', defaultValue: 'd' } },
        selfKey,
      ),
    });
    // Filling NULLs needs an UPDATE, and DuckDB then refuses the ALTER, so the
    // table must be rebuilt. DuckDB cannot copy rows into a table whose key
    // points at itself in one statement, so this stays a stop.
    const diff = await plan({
      items: table(
        'items',
        {
          parent_id: { type: 'TEXT' },
          v: { type: 'TEXT', notNull: true, defaultValue: 'd' },
        },
        selfKey,
      ),
    });
    const change = diff.changes.find(
      (item) => item.alteration === 'set_not_null',
    );
    expect(classifySchemaChange(change as never)).toBe(
      'column.rebuild-unavailable',
    );
    expect(change?.sql).toContain('references itself');
  });
});
