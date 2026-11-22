/**
 * A DuckDB table rebuild copies stored columns only and keeps generated ones
 * (P5a, E6).
 *
 * DuckDB refuses to insert into a generated column, and a stored column left
 * out of the copy would silently take its default. So every column of every
 * table in the rebuild group is classified twice at planning (the live
 * `CREATE TABLE` text and DuckDB's binder) and the plan is refused when the
 * two disagree. After the copy, a content check compares every stored
 * column's values with the source rows and rolls the transaction back on any
 * difference.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaChange, SchemaDefinition } from '../../schema/types.js';
import { isCommentOnlySql } from '../change-kinds.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import {
  duckDbRebuildTestHooks,
  planDuckDbTableChanges,
} from '../duckdb-rebuild.js';
import { createMigrationDefinition } from '../generator.js';
import { MigrationTracker } from '../tracker.js';

const widen = (table: string, column = 'amount'): SchemaChange => ({
  type: 'type_upgrade',
  table,
  name: column,
  column: { type: 'REAL' },
  sql: `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE DOUBLE USING "${column}"::DOUBLE`,
});

const schemaOf = (
  table: string,
  columns: SchemaDefinition['columns'],
): SchemaDefinition => ({
  tableName: table,
  columns,
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '1',
});

describe('DuckDB rebuild with generated columns', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
  });

  afterEach(async () => {
    delete duckDbRebuildTestHooks.textScanGenerated;
    delete duckDbRebuildTestHooks.storedColumns;
    await db.close?.();
  });

  const typeOf = async (table: string, column = 'amount') =>
    String(
      (
        await db.query(
          'SELECT data_type FROM duckdb_columns() WHERE table_name = ? AND column_name = ?',
          table,
          column,
        )
      ).rows[0]?.data_type,
    );

  async function planAndApply(table: string) {
    const planned = await planDuckDbTableChanges({
      db,
      tableName: table,
      changes: [widen(table)],
      mapType: () => 'DOUBLE',
    });
    const statements = planned.changes.flatMap((change) =>
      (change.sqlStatements ?? (change.sql ? [change.sql] : [])).filter(
        (sql) => !isCommentOnlySql(sql),
      ),
    );
    const blocked = planned.changes
      .map((change) => change.sql ?? '')
      .find((sql) => sql.trim().startsWith('--'));
    if (blocked) return { blocked, result: undefined };
    const tracker = new MigrationTracker({ db, engineHint: 'duckdb' });
    await tracker.initialize();
    const result = await tracker.apply(
      createMigrationDefinition(`generated_${Math.random()}`, statements),
    );
    return { blocked: undefined, result };
  }

  it.each([
    [
      'a stored column beside a generated one (A11)',
      async (db: DatabaseInterface) => {
        await db.query(
          'CREATE TABLE gen_prices (id TEXT PRIMARY KEY, note VARCHAR, amount REAL, loud AS (upper(note)))',
        );
        await db.query(
          "INSERT INTO gen_prices (id, note, amount) VALUES ('a', 'x', 1.5)",
        );
      },
      'SELECT id, note, amount, loud FROM gen_prices ORDER BY id',
      [['a', 'x', 1.5, 'X']],
    ],
    [
      'a generated column that reads the widened column (A12)',
      async (db: DatabaseInterface) => {
        await db.query(
          'CREATE TABLE gen_prices (id TEXT PRIMARY KEY, amount REAL, doubled AS (amount * 2))',
        );
        await db.query("INSERT INTO gen_prices (id, amount) VALUES ('a', 1.5)");
      },
      'SELECT id, amount, doubled FROM gen_prices ORDER BY id',
      [['a', 1.5, 3]],
    ],
    [
      'a stored column whose default reads like a generated clause (A13)',
      async (db: DatabaseInterface) => {
        await db.query(
          "CREATE TABLE gen_prices (id TEXT PRIMARY KEY, note VARCHAR DEFAULT 'GENERATED ALWAYS AS (x)', amount REAL)",
        );
        await db.query(
          "INSERT INTO gen_prices (id, note, amount) VALUES ('a', 'kept', 1.5)",
        );
      },
      'SELECT id, note, amount FROM gen_prices ORDER BY id',
      [['a', 'kept', 1.5]],
    ],
    [
      'an empty table (A48)',
      async (db: DatabaseInterface) => {
        await db.query(
          'CREATE TABLE gen_prices (id TEXT PRIMARY KEY, note VARCHAR, amount REAL, loud AS (upper(note)))',
        );
      },
      'SELECT id FROM gen_prices',
      [],
    ],
  ])('classifies generated columns strictly and copies stored columns only (%s)', async (_label, setup, select, rows) => {
    await setup(db);
    const { blocked, result } = await planAndApply('gen_prices');
    expect(blocked).toBeUndefined();
    expect(result?.error).toBeUndefined();
    expect(await typeOf('gen_prices')).toBe('DOUBLE');
    const read = (await db.query(select)).rows.map((row) =>
      Object.values(row).map((value) =>
        typeof value === 'number' || typeof value === 'bigint'
          ? Number(value)
          : value,
      ),
    );
    expect(read).toEqual(rows);
  });

  it('classifies generated columns strictly and copies stored columns only (populated FK child, A47)', async () => {
    await db.query(
      'CREATE TABLE gen_parents (id TEXT PRIMARY KEY, amount REAL)',
    );
    await db.query(
      'CREATE TABLE gen_children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES gen_parents(id), note VARCHAR, loud AS (upper(note)))',
    );
    await db.query("INSERT INTO gen_parents VALUES ('p', 1.5)");
    await db.query(
      "INSERT INTO gen_children (id, parent_id, note) VALUES ('c', 'p', 'quiet')",
    );
    const diff = await new SchemaComparer(db, { engineHint: 'duckdb' }).compare(
      {
        gen_parents: schemaOf('gen_parents', {
          id: { type: 'TEXT', primaryKey: true },
          amount: { type: 'REAL' },
        }),
      },
    );
    const statements = getSQLFromDiff(diff).filter(
      (sql) => !isCommentOnlySql(sql),
    );
    const tracker = new MigrationTracker({ db, engineHint: 'duckdb' });
    await tracker.initialize();
    const [result] = await tracker.applyAll(
      [createMigrationDefinition(`generated_fk_${Date.now()}`, statements)],
      { atomic: true },
    );
    expect(result.error).toBeUndefined();
    expect(await typeOf('gen_parents')).toBe('DOUBLE');
    const children = await db.query(
      'SELECT id, parent_id, note, loud FROM gen_children',
    );
    expect(children.rows).toEqual([
      { id: 'c', parent_id: 'p', note: 'quiet', loud: 'QUIET' },
    ]);
  });

  it('classifies generated columns strictly and copies stored columns only (classifiers disagree, A49)', async () => {
    await db.query(
      "CREATE TABLE gen_prices (id TEXT PRIMARY KEY, note VARCHAR DEFAULT 'd', amount REAL)",
    );
    await db.query(
      "INSERT INTO gen_prices (id, note, amount) VALUES ('a', 'not default', 1.5)",
    );
    duckDbRebuildTestHooks.textScanGenerated = (_table, column, scanned) =>
      column === 'note' ? true : scanned;
    const disagree = await planAndApply('gen_prices');
    expect(disagree.blocked).toContain('note');
    delete duckDbRebuildTestHooks.textScanGenerated;

    // A wrong stored-column list leaves `note` out of the copy: the content
    // check sees its values change and rolls the rebuild back.
    duckDbRebuildTestHooks.storedColumns = (_table, stored) =>
      stored.filter((column) => column !== 'note');
    const wrong = await planAndApply('gen_prices');
    expect(wrong.blocked).toBeUndefined();
    expect(wrong.result?.success).toBe(false);
    expect(String((wrong.result?.error as Error)?.message)).toContain(
      'table rebuild check failed',
    );
    expect(await typeOf('gen_prices')).toBe('FLOAT');
    const kept = await db.query('SELECT note FROM gen_prices');
    expect(kept.rows).toEqual([{ note: 'not default' }]);
  });

  it('classifies generated columns strictly and copies stored columns only (target is generated, A50)', async () => {
    await db.query(
      'CREATE TABLE gen_prices (id TEXT PRIMARY KEY, base REAL, amount FLOAT GENERATED ALWAYS AS (base * 2))',
    );
    const { blocked } = await planAndApply('gen_prices');
    expect(blocked).toContain('generated');
    expect(await typeOf('gen_prices')).toBe('FLOAT');
  });
});
