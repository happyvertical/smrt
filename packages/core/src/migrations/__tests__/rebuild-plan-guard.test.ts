/**
 * A table rebuild stops when the table changed after the migration was planned.
 *
 * A rebuild replaces a table with one built from the definition, the column
 * list and the indexes read at planning time. On SQLite and DuckDB nothing
 * holds the table between planning and applying, so another connection can
 * add a column in that window. It is in none of the planned text: it was not
 * copied, and it went with the old table, together with everything written to
 * it, while the migrate reported success. Every rebuild plan now starts by
 * comparing the live definitions with the planned ones inside its own
 * transaction, and stops by name on a difference.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaDefinition } from '../../schema/types.js';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '../orchestrate.js';
import {
  asTableChangedSincePlan,
  REBUILD_PLAN_STALE_MARKER,
  rebuildPlanStaleMessage,
  TableChangedSincePlanError,
} from '../rebuild-plan-guard.js';
import { sqliteUnchangedTableGuardStatements } from '../sqlite-rebuild.js';

const PACKAGE = '@test/rebuild-plan-guard';
const TABLE = 'guarded_notes';

/**
 * `guarded_notes`, and `guarded_refs` with a foreign key onto it. `title`
 * required, then optional: a table rebuild on SQLite, and on DuckDB (which
 * cannot alter a table another table references) a rebuild of both tables.
 */
function schemas(titleRequired: boolean): Record<string, SchemaDefinition> {
  const table = (
    tableName: string,
    columns: SchemaDefinition['columns'],
    dependencies: string[] = [],
  ): SchemaDefinition => ({
    tableName,
    columns,
    indexes: [],
    foreignKeys: [],
    triggers: [],
    dependencies,
    version: '',
  });
  return {
    guarded_notes: table('guarded_notes', {
      id: { type: 'TEXT', primaryKey: true },
      title: { type: 'TEXT', notNull: titleRequired },
    }),
    guarded_refs: table(
      'guarded_refs',
      {
        id: { type: 'TEXT', primaryKey: true },
        note_id: {
          type: 'TEXT',
          foreignKey: { table: 'guarded_notes', column: 'id' },
        },
      },
      ['guarded_notes'],
    ),
  };
}

/**
 * `db`, running `change` once: after the migrate has planned (it then reads
 * the last migrate record) and before it applies.
 */
function changingAfterThePlan(
  db: DatabaseInterface,
  change: () => Promise<void>,
): { handle: DatabaseInterface; changed: () => boolean } {
  let fired = false;
  const handle = new Proxy(db, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'query')
        return typeof value === 'function' ? value.bind(target) : value;
      return async (sql: string, ...args: unknown[]) => {
        if (!fired && /FROM _smrt_migrate_runs/i.test(String(sql))) {
          fired = true;
          await change();
        }
        return (value as DatabaseInterface['query']).call(target, sql, ...args);
      };
    },
  });
  return { handle, changed: () => fired };
}

describe.each([
  'sqlite',
  'duckdb',
] as const)('a table rebuild checks the table is the one it was planned from (%s)', (engine) => {
  let directory: string;
  let db: DatabaseInterface;
  /** SQLite: a second connection to the file. DuckDB: the same connection. */
  let other: DatabaseInterface;

  const migrate = (handle: DatabaseInterface) =>
    migrateSmrtSchemas({
      db: handle,
      packageName: PACKAGE,
      name: `guarded_${randomUUID()}`,
      engineHint: engine,
    });
  const columns = async () =>
    (
      await db.query(
        `SELECT column_name AS name, is_nullable AS nullable FROM ${
          engine === 'sqlite'
            ? `(SELECT name AS column_name, CASE "notnull" WHEN 1 THEN 'NO' ELSE 'YES' END AS is_nullable FROM pragma_table_info('${TABLE}'))`
            : `information_schema.columns WHERE table_name = '${TABLE}'`
        }`,
      )
    ).rows.map(
      (row) => `${row.name}${row.nullable === 'NO' ? ' NOT NULL' : ''}`,
    );
  const indexNames = async () =>
    (
      await db.query(
        engine === 'sqlite'
          ? `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${TABLE}' AND sql IS NOT NULL`
          : `SELECT index_name AS name FROM duckdb_indexes() WHERE table_name = '${TABLE}'`,
      )
    ).rows.map((row) => String(row.name));

  beforeEach(async () => {
    const declared = vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions');
    declared.mockReturnValue(schemas(true));
    directory = mkdtempSync(join(tmpdir(), 'smrt-rebuild-guard-'));
    if (engine === 'sqlite') {
      const url = `file:${join(directory, 'app.db')}`;
      db = (await getDatabase({ type: 'sqlite', url })) as DatabaseInterface;
      other = (await getDatabase({ type: 'sqlite', url })) as DatabaseInterface;
    } else {
      db = (await getDatabase({
        type: 'duckdb',
        url: ':memory:',
      })) as DatabaseInterface;
      other = db;
    }
    await migrate(db);
    await db.query(`INSERT INTO ${TABLE} (id, title) VALUES ('n1', 'hello')`);
    await db.query(
      "INSERT INTO guarded_refs (id, note_id) VALUES ('r1', 'n1')",
    );
    declared.mockReturnValue(schemas(false));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (other !== db) await other.close?.();
    await db.close?.();
    rmSync(directory, { recursive: true, force: true });
  });

  it('plans a rebuild that starts with the check', async () => {
    const { statements } = await getPendingSchemaStatements(db, {
      engineHint: engine,
    });
    const check = statements.findIndex((sql) =>
      sql.includes(REBUILD_PLAN_STALE_MARKER),
    );
    const firstWrite = statements.findIndex((sql) =>
      /^\s*(CREATE TABLE "_smrt_rebuild_|DROP TABLE "guarded_)/.test(sql),
    );
    expect(check).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(check);
  });

  it('applies the rebuild when nothing changed since the plan', async () => {
    const result = await migrate(db);
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(await columns()).toContain('title');
    expect(await columns()).not.toContain('title NOT NULL');
    expect((await db.query(`SELECT title FROM ${TABLE}`)).rows).toEqual([
      { title: 'hello' },
    ]);
    expect((await db.query('SELECT note_id FROM guarded_refs')).rows).toEqual([
      { note_id: 'n1' },
    ]);
  });

  it('stops by name when a column was added after the plan, and keeps the column and its data', async () => {
    const { handle, changed } = changingAfterThePlan(db, async () => {
      await other.query(`ALTER TABLE ${TABLE} ADD COLUMN precious TEXT`);
      await other.query(`UPDATE ${TABLE} SET precious = 'keep me'`);
    });

    const failure = await migrate(handle).then(
      () => null,
      (error: unknown) => error,
    );

    expect(changed()).toBe(true);
    expect(failure).toBeInstanceOf(TableChangedSincePlanError);
    expect(failure).toMatchObject({ table: TABLE });
    expect((failure as Error).message).toContain(
      `"${TABLE}" changed after this migration was planned`,
    );
    // Nothing of the batch happened: the table is as the other connection
    // left it, not rebuilt, with the added column and what it holds.
    expect(await columns()).toContain('title NOT NULL');
    expect(
      (await db.query(`SELECT title, precious FROM ${TABLE}`)).rows,
    ).toEqual([{ title: 'hello', precious: 'keep me' }]);

    // Planned again from the table as it is now, the rebuild keeps the column.
    const rerun = await migrate(db);
    expect(rerun).toMatchObject({ applied: true, refused: false });
    expect(await columns()).not.toContain('title NOT NULL');
    expect(
      (await db.query(`SELECT title, precious FROM ${TABLE}`)).rows,
    ).toEqual([{ title: 'hello', precious: 'keep me' }]);
  });

  it('stops by name when an index was added after the plan, and keeps the index', async () => {
    const { handle } = changingAfterThePlan(db, async () => {
      await other.query(
        `CREATE INDEX guarded_notes_by_title ON ${TABLE} (title)`,
      );
    });

    await expect(migrate(handle)).rejects.toBeInstanceOf(
      TableChangedSincePlanError,
    );
    expect(await indexNames()).toContain('guarded_notes_by_title');
    expect(await columns()).toContain('title NOT NULL');
  });

  it('holds for a caller that runs the planned statements itself', async () => {
    const { statements } = await getPendingSchemaStatements(db, {
      engineHint: engine,
    });
    await other.query(`ALTER TABLE ${TABLE} ADD COLUMN precious TEXT`);
    await other.query(`UPDATE ${TABLE} SET precious = 'keep me'`);

    const failure = await db
      .transaction?.(async (tx) => {
        for (const sql of statements) {
          await tx.query(sql);
        }
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(asTableChangedSincePlan(failure)).toMatchObject({ table: TABLE });
    expect(
      (await db.query(`SELECT title, precious FROM ${TABLE}`)).rows,
    ).toEqual([{ title: 'hello', precious: 'keep me' }]);
  });
});

describe('a SQLite rebuild stops when a table started referencing it after the plan', () => {
  const PARENT = 'lonely_parent';
  let directory: string;
  let db: DatabaseInterface;
  let other: DatabaseInterface;

  const parentSchema = (
    titleRequired: boolean,
  ): Record<string, SchemaDefinition> => ({
    [PARENT]: {
      tableName: PARENT,
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        title: { type: 'TEXT', notNull: titleRequired },
      },
      indexes: [],
      foreignKeys: [],
      triggers: [],
      dependencies: [],
      version: '',
    },
  });
  const migrate = (handle: DatabaseInterface) =>
    migrateSmrtSchemas({
      db: handle,
      packageName: PACKAGE,
      name: `lonely_${randomUUID()}`,
      engineHint: 'sqlite',
    });
  /** On the other connection: a child with a cascading key, and a row in it. */
  const addCascadingChild = async () => {
    await other.query(
      `CREATE TABLE late_child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES ${PARENT} (id) ON DELETE CASCADE)`,
    );
    await other.query(
      "INSERT INTO late_child (id, parent_id) VALUES ('c1', 'p1')",
    );
  };
  const childRows = async () =>
    (await db.query('SELECT id, parent_id FROM late_child')).rows;

  beforeEach(async () => {
    const declared = vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions');
    declared.mockReturnValue(parentSchema(true));
    directory = mkdtempSync(join(tmpdir(), 'smrt-rebuild-guard-fk-'));
    const url = `file:${join(directory, 'app.db')}`;
    db = (await getDatabase({ type: 'sqlite', url })) as DatabaseInterface;
    other = (await getDatabase({ type: 'sqlite', url })) as DatabaseInterface;
    await migrate(db);
    await db.query(`INSERT INTO ${PARENT} (id, title) VALUES ('p1', 'hello')`);
    declared.mockReturnValue(parentSchema(false));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await other.close?.();
    await db.close?.();
    rmSync(directory, { recursive: true, force: true });
  });

  it('runs with foreign keys on in these tests, as the adapter opens them', async () => {
    expect(
      Number((await db.query('PRAGMA foreign_keys')).rows[0]?.foreign_keys),
    ).toBe(1);
  });

  it('carries an index whose name only resembles the internal prefix through the rebuild', async () => {
    await db.query(`CREATE UNIQUE INDEX sqliteX_title ON ${PARENT} (title)`);

    expect(await migrate(db)).toMatchObject({ applied: true, refused: false });

    expect(
      (
        await db.query(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${PARENT}' AND sql IS NOT NULL`,
        )
      ).rows,
    ).toEqual([{ name: 'sqliteX_title' }]);
    await expect(
      db.query(`INSERT INTO ${PARENT} (id, title) VALUES ('p2', 'hello')`),
    ).rejects.toThrow();
  });

  it('stops by name when an index whose name only resembles the internal prefix was added after the plan', async () => {
    const { handle } = changingAfterThePlan(db, async () => {
      await other.query(
        `CREATE UNIQUE INDEX sqliteX_late ON ${PARENT} (title)`,
      );
    });

    await expect(migrate(handle)).rejects.toBeInstanceOf(
      TableChangedSincePlanError,
    );
    expect(
      (
        await db.query(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sqliteX_late'`,
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('refuses a caller that runs the planned statements itself, and keeps the child rows', async () => {
    const { statements } = await getPendingSchemaStatements(db, {
      engineHint: 'sqlite',
    });
    await addCascadingChild();

    const failure = await db
      .transaction?.(async (tx) => {
        for (const sql of statements) await tx.query(sql);
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(asTableChangedSincePlan(failure)).toMatchObject({ table: PARENT });
    expect(await childRows()).toEqual([{ id: 'c1', parent_id: 'p1' }]);
    expect((await db.query(`SELECT id FROM ${PARENT}`)).rows).toEqual([
      { id: 'p1' },
    ]);
  });

  it('stops the migrate by name, keeps the child rows, and the rerun rebuilds with the child in place', async () => {
    const { handle, changed } = changingAfterThePlan(db, addCascadingChild);

    await expect(migrate(handle)).rejects.toBeInstanceOf(
      TableChangedSincePlanError,
    );
    expect(changed()).toBe(true);
    expect(await childRows()).toEqual([{ id: 'c1', parent_id: 'p1' }]);

    const rerun = await migrate(db);
    expect(rerun).toMatchObject({ applied: true, refused: false });
    expect(await childRows()).toEqual([{ id: 'c1', parent_id: 'p1' }]);
  });
});

describe('the SQLite check compares the table and every index and trigger', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = (await getDatabase({
      type: 'sqlite',
      url: ':memory:',
    })) as DatabaseInterface;
    await db.query(
      "CREATE TABLE checked (id TEXT PRIMARY KEY, label TEXT DEFAULT 'it''s -- text')",
    );
    await db.query('CREATE INDEX checked_by_label ON checked (label)');
    await db.query(
      'CREATE TRIGGER checked_touch AFTER UPDATE ON checked BEGIN SELECT 1; END',
    );
  });
  afterEach(async () => {
    await db.close?.();
  });

  async function planned() {
    const table = await db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'checked'",
    );
    const objects = await db.query(
      "SELECT name, sql FROM sqlite_master WHERE tbl_name = 'checked' AND sql IS NOT NULL AND type IN ('index', 'trigger')",
    );
    return {
      createTableSql: String(table.rows[0].sql),
      objects: objects.rows.map((row) => ({
        name: String(row.name),
        sql: String(row.sql),
      })),
      inboundReferences: [],
    };
  }
  async function run(statements: string[]) {
    await db.transaction?.(async (tx) => {
      for (const sql of statements) await tx.query(sql);
    });
  }

  it('passes while the table, its index and its trigger are as planned', async () => {
    await expect(
      run(sqliteUnchangedTableGuardStatements('checked', await planned())),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a column was added', 'ALTER TABLE checked ADD COLUMN extra TEXT'],
    ['an index was added', 'CREATE INDEX checked_by_id ON checked (id)'],
    ['an index was dropped', 'DROP INDEX checked_by_label'],
    ['a trigger was dropped', 'DROP TRIGGER checked_touch'],
    [
      'a trigger was replaced under the same name',
      'DROP TRIGGER checked_touch | CREATE TRIGGER checked_touch AFTER UPDATE ON checked BEGIN SELECT 2; END',
    ],
    ['the table was dropped', 'DROP TABLE checked'],
    [
      'an index whose name only resembles the internal prefix was added',
      'CREATE UNIQUE INDEX sqliteX_unique ON checked (label)',
    ],
    [
      'a table that references it was created',
      'CREATE TABLE late_ref (id TEXT, checked_id TEXT REFERENCES checked (id) ON DELETE CASCADE)',
    ],
  ])('fails when %s', async (_name, change) => {
    const statements = sqliteUnchangedTableGuardStatements(
      'checked',
      await planned(),
    );
    for (const sql of change.split(' | ')) await db.query(sql);

    const failure = await run(statements).then(
      () => null,
      (error: unknown) => error,
    );
    expect(asTableChangedSincePlan(failure)).toMatchObject({
      table: 'checked',
    });
  });
});

describe('asTableChangedSincePlan', () => {
  it('reads the failure through the errors that wrap it, and nothing else', () => {
    const database = new Error(
      `SQLITE_CONSTRAINT: CHECK constraint failed: ${rebuildPlanStaleMessage('a "quoted" table')}`,
    );
    const wrapped = new Error('Failed to execute raw query', {
      cause: database,
    });
    expect(asTableChangedSincePlan(wrapped)).toMatchObject({
      name: 'TableChangedSincePlanError',
      table: 'a "quoted" table',
      cause: wrapped,
    });
    expect(
      asTableChangedSincePlan(new Error(REBUILD_PLAN_STALE_MARKER)),
    ).toMatchObject({ table: null });
    expect(asTableChangedSincePlan(new Error('disk full'))).toBeNull();
    expect(asTableChangedSincePlan(undefined)).toBeNull();
  });
});
