/**
 * #4937 (review rv4): a table rebuild must not undo another change made in the
 * same migration.
 *
 * DuckDB rebuilds a table together with every table that references it. When
 * one of those referencing tables also changes in the same migration, the plan
 * must build each table once, in its final shape, whatever order the changes
 * come in. SQLite rebuilds only the changed table, so the same scenarios must
 * hold there too. Each case plans with the differ, applies the plan the way
 * `db:migrate` does (one atomic migration through the tracker), and checks the
 * rows, the new columns and their backfilled values, the indexes, and that a
 * second diff has nothing left to do.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { classifySchemaChange, decideSchemaChange } from '../change-kinds.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { createMigrationDefinition } from '../generator.js';
import { collectStatementsFromDiff } from '../orchestrate.js';
import { MigrationTracker } from '../tracker.js';

type Engine = 'duckdb' | 'sqlite';

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
const refersTo = (column: string, to: string) => ({
  foreignKeys: [{ column, referencesTable: to, referencesColumn: 'id' }],
  dependencies: [to],
});
/** The same schemas, in the given key order (the order the diff walks). */
const ordered = (
  schemas: Record<string, SchemaDefinition>,
  order: string[],
): Record<string, SchemaDefinition> =>
  Object.fromEntries(order.map((name) => [name, schemas[name]]));

describe.each<Engine>([
  'duckdb',
  'sqlite',
])('%s: overlapping rebuilds in one migration', (engine) => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: engine, url: ':memory:' });
    if (engine === 'sqlite') await db.query('PRAGMA foreign_keys = ON');
  });
  afterEach(async () => {
    await db.close?.();
  });

  const comparer = (options = {}) =>
    new SchemaComparer(db, { engineHint: engine, ...options });
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
          `overlap_${++applied}`,
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
    // Converges: a second diff has nothing left to do.
    expect((await plan(schemas, options)).changes).toEqual([]);
    return diff;
  }
  const rows = async (name: string) =>
    (await db.query(`SELECT * FROM ${name} ORDER BY id`)).rows;
  const indexNames = async (name: string): Promise<string[]> =>
    engine === 'duckdb'
      ? (
          await db.query(
            "SELECT index_name FROM duckdb_indexes() WHERE table_name = ? AND index_name NOT LIKE 'idx_smrt_%' ORDER BY index_name",
            name,
          )
        ).rows.map((row) => String(row.index_name))
      : (
          await db.query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
            name,
          )
        ).rows.map((row) => String(row.name));

  describe('a parent rebuild and a changed child', () => {
    beforeEach(async () => {
      await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY, v INTEGER)');
      await db.query(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id), note TEXT)',
      );
      await db.query('CREATE INDEX children_note_idx ON children (note)');
      await db.query("INSERT INTO parents VALUES ('p1', 1), ('p2', 2)");
      await db.query(
        "INSERT INTO children VALUES ('c1', 'p1', 'a'), ('c2', 'p2', 'b'), ('c3', NULL, NULL)",
      );
    });
    const schemas = {
      // A type change on a referenced table: DuckDB must rebuild it and its
      // referencing tables; SQLite rebuilds it alone.
      parents: table('parents', { v: { type: 'REAL' } }),
      // A required column filled by a backfill, and a new index on it.
      children: table(
        'children',
        {
          parent_id: { type: 'TEXT' },
          note: { type: 'TEXT' },
          claim: { type: 'TEXT', notNull: true, backfill: "'claim:' || id" },
        },
        {
          ...refersTo('parent_id', 'parents'),
          indexes: [
            { name: 'children_note_idx', columns: ['note'] },
            { name: 'children_claim_idx', columns: ['claim'] },
          ],
        },
      ),
    };

    it.each([
      ['child first', ['children', 'parents']],
      ['parent first', ['parents', 'children']],
    ])('keeps the child change and every row (%s)', async (_label, order) => {
      await migrate(ordered(schemas, order));
      expect(await rows('parents')).toEqual([
        { id: 'p1', v: 1 },
        { id: 'p2', v: 2 },
      ]);
      expect(await rows('children')).toEqual([
        { id: 'c1', parent_id: 'p1', note: 'a', claim: 'claim:c1' },
        { id: 'c2', parent_id: 'p2', note: 'b', claim: 'claim:c2' },
        { id: 'c3', parent_id: null, note: null, claim: 'claim:c3' },
      ]);
      expect(await indexNames('children')).toEqual([
        'children_claim_idx',
        'children_note_idx',
      ]);
      // The key and the new NOT NULL hold.
      await expect(
        db.query("INSERT INTO children VALUES ('x', 'missing', 'n', 'c')"),
      ).rejects.toThrow();
      await expect(
        db.query("INSERT INTO children VALUES ('y', 'p1', 'n', NULL)"),
      ).rejects.toThrow();
    });

    it.each([
      ['child first', ['children', 'parents']],
      ['parent first', ['parents', 'children']],
    ])('keeps an index added to the child alone (%s)', async (_label, order) => {
      await migrate(
        ordered(
          {
            ...schemas,
            children: table(
              'children',
              { parent_id: { type: 'TEXT' }, note: { type: 'TEXT' } },
              {
                ...refersTo('parent_id', 'parents'),
                indexes: [
                  { name: 'children_note_idx', columns: ['note'] },
                  { name: 'children_parent_idx', columns: ['parent_id'] },
                ],
              },
            ),
          },
          order,
        ),
      );
      expect(await indexNames('children')).toEqual([
        'children_note_idx',
        'children_parent_idx',
      ]);
      expect((await rows('children')).length).toBe(3);
    });

    it.each([
      ['child first', ['children', 'parents']],
      ['parent first', ['parents', 'children']],
    ])('keeps a nullable column added to the child (%s)', async (_label, order) => {
      await migrate(
        ordered(
          {
            ...schemas,
            children: table(
              'children',
              {
                parent_id: { type: 'TEXT' },
                note: { type: 'TEXT' },
                extra: { type: 'TEXT' },
              },
              {
                ...refersTo('parent_id', 'parents'),
                indexes: [{ name: 'children_note_idx', columns: ['note'] }],
              },
            ),
          },
          order,
        ),
      );
      expect((await rows('children')).map((row) => row.extra)).toEqual([
        null,
        null,
        null,
      ]);
    });
  });

  describe('a three-level chain', () => {
    beforeEach(async () => {
      await db.query('CREATE TABLE grands (id TEXT PRIMARY KEY, v INTEGER)');
      await db.query(
        'CREATE TABLE parents (id TEXT PRIMARY KEY, grand_id TEXT REFERENCES grands(id), w TEXT)',
      );
      await db.query(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id), note TEXT)',
      );
      await db.query('CREATE INDEX parents_w_idx ON parents (w)');
      await db.query("INSERT INTO grands VALUES ('g1', 1)");
      await db.query(
        "INSERT INTO parents VALUES ('p1', 'g1', NULL), ('p2', NULL, 'keep')",
      );
      await db.query(
        "INSERT INTO children VALUES ('c1', 'p1', 'a'), ('c2', 'p2', NULL)",
      );
    });
    const schemas = {
      grands: table('grands', { v: { type: 'REAL' } }),
      parents: table(
        'parents',
        {
          grand_id: { type: 'TEXT' },
          w: { type: 'TEXT', notNull: true, backfill: "'w:' || id" },
          added: { type: 'TEXT', notNull: true, backfill: "'a:' || id" },
        },
        {
          ...refersTo('grand_id', 'grands'),
          indexes: [{ name: 'parents_w_idx', columns: ['w'] }],
        },
      ),
      children: table(
        'children',
        {
          parent_id: { type: 'TEXT' },
          note: { type: 'TEXT', notNull: true, defaultValue: 'none' },
        },
        {
          ...refersTo('parent_id', 'parents'),
          indexes: [{ name: 'children_note_idx', columns: ['note'] }],
        },
      ),
    };

    it.each([
      ['leaves first', ['children', 'parents', 'grands']],
      ['root first', ['grands', 'parents', 'children']],
      ['middle first', ['parents', 'grands', 'children']],
    ])('builds each table once in its final shape (%s)', async (_label, order) => {
      await migrate(ordered(schemas, order));
      expect(await rows('grands')).toEqual([{ id: 'g1', v: 1 }]);
      expect(await rows('parents')).toEqual([
        { id: 'p1', grand_id: 'g1', w: 'w:p1', added: 'a:p1' },
        { id: 'p2', grand_id: null, w: 'keep', added: 'a:p2' },
      ]);
      expect(await rows('children')).toEqual([
        { id: 'c1', parent_id: 'p1', note: 'a' },
        { id: 'c2', parent_id: 'p2', note: 'none' },
      ]);
      expect(await indexNames('parents')).toEqual(['parents_w_idx']);
      expect(await indexNames('children')).toEqual(['children_note_idx']);
      await expect(
        db.query("INSERT INTO children VALUES ('x', 'missing', 'n')"),
      ).rejects.toThrow();
      await expect(
        db.query("INSERT INTO parents VALUES ('x', 'missing', 'w', 'a')"),
      ).rejects.toThrow();
    });
  });

  describe('one table with a rebuild and a plain ALTER', () => {
    beforeEach(async () => {
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY, v INTEGER, w TEXT)',
      );
      await db.query('CREATE INDEX items_w_idx ON items (w)');
      await db.query("INSERT INTO items VALUES ('a', 1, 'x'), ('b', 2, NULL)");
    });

    it('keeps the added column, its index and the retyped values', async () => {
      // The new column is declared before the retyped one, so its ALTER comes
      // first in the table's changes.
      await migrate({
        items: table(
          'items',
          {
            extra: { type: 'TEXT' },
            v: { type: 'REAL' },
            w: { type: 'TEXT' },
          },
          {
            indexes: [
              { name: 'items_w_idx', columns: ['w'] },
              { name: 'items_extra_idx', columns: ['extra'] },
            ],
          },
        ),
      });
      expect(
        (await db.query('SELECT id, v, w, extra FROM items ORDER BY id')).rows,
      ).toEqual([
        { id: 'a', v: 1, w: 'x', extra: null },
        { id: 'b', v: 2, w: null, extra: null },
      ]);
      expect(await indexNames('items')).toEqual([
        'items_extra_idx',
        'items_w_idx',
      ]);
    });
  });

  describe('a new key onto a table that is altered', () => {
    beforeEach(async () => {
      await db.query(
        "CREATE TABLE parents (id TEXT PRIMARY KEY, w TEXT DEFAULT 'old')",
      );
      await db.query(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT)',
      );
      await db.query("INSERT INTO parents (id) VALUES ('p1')");
      await db.query("INSERT INTO children VALUES ('c1', 'p1'), ('c2', NULL)");
    });
    // The child's rebuild adds a key onto the parent, whose default changes.
    const schemas = {
      parents: table('parents', { w: { type: 'TEXT', defaultValue: 'new' } }),
      children: table(
        'children',
        { parent_id: { type: 'TEXT' } },
        refersTo('parent_id', 'parents'),
      ),
    };

    it.each([
      ['child first', ['children', 'parents']],
      ['parent first', ['parents', 'children']],
    ])('alters the parent and adds the key (%s)', async (_label, order) => {
      await migrate(ordered(schemas, order), { relaxColumns: true });
      await db.query("INSERT INTO parents (id) VALUES ('p2')");
      expect(await rows('parents')).toEqual([
        { id: 'p1', w: 'old' },
        { id: 'p2', w: 'new' },
      ]);
      expect((await rows('children')).length).toBe(2);
      await expect(
        db.query("INSERT INTO children VALUES ('x', 'missing')"),
      ).rejects.toThrow();
    });
  });

  describe('one table rebuilt twice', () => {
    beforeEach(async () => {
      await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY, v INTEGER)');
      await db.query(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id), n INTEGER, other_id TEXT)',
      );
      await db.query('CREATE TABLE others (id TEXT PRIMARY KEY)');
      await db.query("INSERT INTO parents VALUES ('p1', 1)");
      await db.query("INSERT INTO others VALUES ('o1')");
      await db.query(
        "INSERT INTO children VALUES ('c1', 'p1', 1, 'o1'), ('c2', NULL, NULL, NULL)",
      );
    });
    // The child is rebuilt for its own changes (a type change, a new key) and
    // again as a member of its parent's group.
    const schemas = {
      parents: table('parents', { v: { type: 'REAL' } }),
      others: table('others', {}),
      children: table(
        'children',
        {
          parent_id: { type: 'TEXT' },
          n: { type: 'REAL' },
          other_id: { type: 'TEXT' },
        },
        {
          foreignKeys: [
            {
              column: 'parent_id',
              referencesTable: 'parents',
              referencesColumn: 'id',
            },
            {
              column: 'other_id',
              referencesTable: 'others',
              referencesColumn: 'id',
            },
          ],
          dependencies: ['parents', 'others'],
        },
      ),
    };

    it.each([
      ['child first', ['children', 'others', 'parents']],
      ['parent first', ['parents', 'others', 'children']],
    ])('keeps both rebuilds (%s)', async (_label, order) => {
      await migrate(ordered(schemas, order));
      expect(await rows('children')).toEqual([
        { id: 'c1', parent_id: 'p1', n: 1, other_id: 'o1' },
        { id: 'c2', parent_id: null, n: null, other_id: null },
      ]);
      await expect(
        db.query("INSERT INTO children VALUES ('x', NULL, 1, 'missing')"),
      ).rejects.toThrow();
    });
  });
});

describe('duckdb: overlapping rebuilds that cannot run', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
  });
  afterEach(async () => {
    await db.close?.();
  });
  const plan = (schemas: Record<string, SchemaDefinition>) =>
    new SchemaComparer(db, { engineHint: 'duckdb' }).compare(schemas);
  async function apply(statements: string[]) {
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    return tracker.applyAll(
      [
        createMigrationDefinition(
          `refused_${Math.random().toString(36).slice(2)}`,
          statements.filter((sql) => !sql.startsWith('--')),
        ),
      ],
      { atomic: true },
    );
  }
  const snapshot = async () => ({
    tables: (
      await db.query(
        "SELECT table_name, sql FROM duckdb_tables() WHERE table_name NOT LIKE '_smrt_%' ORDER BY table_name",
      )
    ).rows,
    indexes: (
      await db.query(
        "SELECT index_name FROM duckdb_indexes() WHERE index_name NOT LIKE 'idx_smrt_%' ORDER BY index_name",
      )
    ).rows,
  });

  it('stops when two rebuilds would make two tables reference each other', async () => {
    await db.query('CREATE TABLE a (id TEXT PRIMARY KEY, b_id TEXT)');
    await db.query('CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT)');
    const diff = await plan({
      a: table('a', { b_id: { type: 'TEXT' } }, refersTo('b_id', 'b')),
      b: table('b', { a_id: { type: 'TEXT' } }, refersTo('a_id', 'a')),
    });
    const verdicts = diff.changes.map((change) =>
      decideSchemaChange(change, 'duckdb'),
    );
    expect(verdicts.map((verdict) => verdict.kind)).toEqual([
      'foreign-key.add-unsupported',
      'foreign-key.add-unsupported',
    ]);
    expect(verdicts.every((verdict) => verdict.decision === 'stop')).toBe(true);
    expect(verdicts[0].message).toContain('overlap and cannot be combined');
    expect(verdicts[0].message).toContain('reference each other');
    expect(getSQLFromDiff(diff).filter((sql) => !sql.startsWith('--'))).toEqual(
      [],
    );
  });

  it('stops when a new table references a table the migration rebuilds or alters', async () => {
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY, v INTEGER)');
    await db.query(
      'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id), w TEXT)',
    );
    await db.query("INSERT INTO parents VALUES ('p', 1)");
    const fresh = table(
      'fresh',
      { child_id: { type: 'TEXT' } },
      refersTo('child_id', 'children'),
    );
    const before = await snapshot();
    // The parent's rebuild drops and creates "children" too, which the new
    // table references.
    const diff = await plan({
      parents: table('parents', { v: { type: 'REAL' } }),
      children: table(
        'children',
        { parent_id: { type: 'TEXT' }, w: { type: 'TEXT' } },
        refersTo('parent_id', 'parents'),
      ),
      fresh,
    });
    const rebuilt = diff.changes.find(
      (change) => change.table === 'parents',
    ) as never;
    const verdict = decideSchemaChange(rebuilt, 'duckdb');
    expect(verdict.kind).toBe('type.rebuild-unavailable');
    expect(verdict.decision).toBe('stop');
    expect((rebuilt as { sql: string }).sql).toContain('new table "fresh"');
    // A plain ALTER COLUMN on a table a new table references is refused too.
    const altered = await plan({
      parents: table('parents', { v: { type: 'INTEGER' } }),
      children: table(
        'children',
        {
          parent_id: { type: 'TEXT' },
          w: { type: 'TEXT', defaultValue: 'd' },
        },
        refersTo('parent_id', 'parents'),
      ),
      fresh,
    });
    const alteredChange = altered.changes.find(
      (change) => change.table === 'children',
    ) as never;
    expect(decideSchemaChange(alteredChange, 'duckdb').decision).toBe('stop');
    expect((alteredChange as { sql: string }).sql).toContain(
      'new table "fresh"',
    );
    expect(await snapshot()).toEqual(before);
  });

  it('a plain column added to a table a new table references still applies', async () => {
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    const diff = await plan({
      parents: table('parents', { extra: { type: 'TEXT' } }),
      fresh: table(
        'fresh',
        { parent_id: { type: 'TEXT' } },
        refersTo('parent_id', 'parents'),
      ),
    });
    const results = await apply(collectStatementsFromDiff(diff, db, 'duckdb'));
    expect(results.map((result) => result.success)).toEqual([true]);
  });
});

describe('duckdb: the rebuild checks what it built', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY, v INTEGER)');
    await db.query(
      'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id), note TEXT)',
    );
    await db.query('CREATE INDEX children_note_idx ON children (note)');
    await db.query("INSERT INTO parents VALUES ('p1', 1)");
    await db.query(
      "INSERT INTO children VALUES ('c1', 'p1', 'a'), ('c2', NULL, 'b')",
    );
  });
  afterEach(async () => {
    await db.close?.();
  });
  const schemas = {
    parents: table('parents', { v: { type: 'REAL' } }),
    children: table(
      'children',
      { parent_id: { type: 'TEXT' }, note: { type: 'TEXT' } },
      {
        ...refersTo('parent_id', 'parents'),
        indexes: [{ name: 'children_note_idx', columns: ['note'] }],
      },
    ),
  };
  async function applyWith(sabotage: (statements: string[]) => void) {
    const diff = await new SchemaComparer(db, {
      engineHint: 'duckdb',
    }).compare(schemas);
    const statements = getSQLFromDiff(diff);
    sabotage(statements);
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    const [result] = await tracker.applyAll(
      [createMigrationDefinition('checked', statements)],
      { atomic: true },
    );
    return result;
  }
  const beforeCheck = (statements: string[]) =>
    statements.findIndex((sql) => sql.includes('_smrt_check_rebuild'));
  const state = async () => ({
    tables: (
      await db.query(
        "SELECT table_name, sql FROM duckdb_tables() WHERE table_name NOT LIKE '_smrt_%' ORDER BY table_name",
      )
    ).rows,
    children: (await db.query('SELECT * FROM children ORDER BY id')).rows,
    parents: (await db.query('SELECT * FROM parents ORDER BY id')).rows,
  });

  it.each([
    ['a lost row', "DELETE FROM children WHERE id = 'c2'", 'a row count of'],
    ['a lost index', 'DROP INDEX children_note_idx', 'indexes'],
    [
      'a different column',
      'ALTER TABLE children ADD COLUMN stray TEXT',
      'columns',
    ],
  ])('rolls back on %s, naming the difference', async (_label, sql, what) => {
    const before = await state();
    const result = await applyWith((statements) =>
      statements.splice(beforeCheck(statements), 0, sql),
    );
    expect(result.success).toBe(false);
    const message = String(
      typeof result.error === 'string' ? result.error : result.error?.message,
    );
    expect(message).toContain('table rebuild check failed');
    expect(message).toContain(`"children" has ${what}`);
    expect(await state()).toEqual(before);
  });

  it('rolls back on a lost foreign key', async () => {
    const before = await state();
    const result = await applyWith((statements) => {
      const at = statements.findIndex((sql) =>
        /^CREATE TABLE "?children"?\s*\(/.test(sql),
      );
      statements[at] = statements[at].replace(
        /,\s*FOREIGN KEY \(parent_id\) REFERENCES parents\(id\)/,
        '',
      );
    });
    expect(result.success).toBe(false);
    expect(
      String(
        typeof result.error === 'string' ? result.error : result.error?.message,
      ),
    ).toContain('"children" has foreign keys');
    expect(await state()).toEqual(before);
  });
});
