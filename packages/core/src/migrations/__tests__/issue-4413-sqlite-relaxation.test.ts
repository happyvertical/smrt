import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { createMigrationDefinition } from '../generator.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { rewriteSqliteCreateTable } from '../sqlite-rebuild.js';
import { MigrationTracker } from '../tracker.js';

const schema: Record<string, SchemaDefinition> = {
  activities: {
    tableName: 'activities',
    ddl: '',
    version: '1',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      workbook_id: { type: 'TEXT' },
      label: { type: 'TEXT', notNull: true, defaultValue: 'NOT NULL' },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
  },
};

describe('#4413 explicit SQLite nullable relaxation', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query('PRAGMA foreign_keys = ON');
    await db.query('CREATE TABLE workbooks (id TEXT PRIMARY KEY)');
    await db.query(
      `CREATE TABLE activities (id TEXT PRIMARY KEY, workbook_id TEXT NOT NULL REFERENCES workbooks(id), label TEXT NOT NULL DEFAULT 'NOT NULL' CHECK(length(label) > 0))`,
    );
    await db.query(
      'CREATE TABLE attempts (id TEXT PRIMARY KEY, activity_id TEXT REFERENCES activities(id) ON DELETE CASCADE)',
    );
    await db.query(
      'CREATE TABLE assessments (id TEXT PRIMARY KEY, activity_id TEXT REFERENCES activities(id) ON DELETE CASCADE)',
    );
    await db.query(
      'CREATE TABLE grades (id TEXT PRIMARY KEY, attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE)',
    );
    await db.query(
      'CREATE INDEX activity_partial ON activities(workbook_id) WHERE workbook_id IS NOT NULL',
    );
    await db.query(
      'CREATE TRIGGER activity_guard BEFORE DELETE ON activities BEGIN SELECT 1; END',
    );
    await db.query("INSERT INTO workbooks VALUES ('w')");
    await db.query(
      "INSERT INTO activities(rowid,id,workbook_id,label) VALUES (42,'a','w','legacy')",
    );
    await db.query("INSERT INTO attempts VALUES ('t','a')");
    await db.query("INSERT INTO assessments VALUES ('s','a')");
    await db.query("INSERT INTO grades VALUES ('g','t')");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  async function planned() {
    const diff = await new SchemaComparer(db, { relaxColumns: true }).compare(
      schema,
    );
    return getSQLFromDiff(diff).filter((sql) => !sql.trim().startsWith('--'));
  }
  async function apply(extra: string[] = []) {
    const sql = await planned();
    expect(
      sql.some((s) => s.includes('CREATE TABLE "_smrt_rebuild_activities"')),
    ).toBe(true);
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    return tracker.applyAll(
      [createMigrationDefinition('relax_activity', [...sql, ...extra])],
      { atomic: true },
    );
  }
  it('remains advisory without explicit opt-in', async () => {
    const diff = await new SchemaComparer(db).compare(schema);
    expect(
      diff.changes.find((c) => c.alteration === 'drop_not_null')?.advisory,
    ).toBeDefined();
    expect(getSQLFromDiff(diff).some((s) => s.includes('_smrt_rebuild_'))).toBe(
      false,
    );
  });
  it('preserves populated referenced rows and native DDL, converges, then permits NULL', async () => {
    const before = await db.query(
      "SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='activities' ORDER BY name",
    );
    expect((await apply()).every((r) => r.success)).toBe(true);
    for (const [table, row] of [
      ['activities', { id: 'a', workbook_id: 'w', label: 'legacy' }],
      ['attempts', { id: 't', activity_id: 'a' }],
      ['assessments', { id: 's', activity_id: 'a' }],
      ['grades', { id: 'g', attempt_id: 't' }],
    ] as const) {
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([row]);
    }
    expect(
      (
        await db.query(
          "SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='activities' ORDER BY name",
        )
      ).rows,
    ).toEqual(before.rows);
    expect(await planned()).toEqual([]);
    expect((await db.query('SELECT rowid FROM activities')).rows).toEqual([
      { rowid: 42 },
    ]);
    await db.query(
      "INSERT INTO activities(id,workbook_id) VALUES ('unfiled',NULL)",
    );
    await expect(
      db.query("INSERT INTO activities VALUES ('bad','missing','x')"),
    ).rejects.toThrow();
    await expect(
      db.query("INSERT INTO activities VALUES ('bad',NULL,'')"),
    ).rejects.toThrow();
    expect((await db.query('PRAGMA foreign_key_check')).rows).toEqual([]);
    expect((await db.query('PRAGMA foreign_keys')).rows[0]).toEqual({
      foreign_keys: 1,
    });
    expect((await db.query('PRAGMA legacy_alter_table')).rows[0]).toEqual({
      legacy_alter_table: 0,
    });
  });
  it('forwards the explicit option through orchestration and repeats as a no-op', async () => {
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue(
      schema,
    );
    const first = await migrateSmrtSchemas({
      db,
      packageName: 'test',
      relaxColumns: true,
    });
    expect(first.applied).toBe(true);
    expect(first.hasManualDrift).toBe(false);
    const second = await migrateSmrtSchemas({
      db,
      packageName: 'test',
      relaxColumns: true,
    });
    expect(second.applied).toBe(false);
    expect(second.statements).toEqual([]);
    expect((await db.query('SELECT id FROM grades')).rows).toEqual([
      { id: 'g' },
    ]);
  });
  it('fails closed when the adapter cannot suspend foreign keys', async () => {
    const sql = await planned();
    const originalQuery = db.query.bind(db);
    const query = vi
      .spyOn(db, 'query')
      .mockImplementation(async (sql, ...params) => {
        if (sql === 'PRAGMA foreign_keys = OFF')
          return { rows: [], rowCount: 0 };
        return originalQuery(sql, ...params);
      });
    const tracker = new MigrationTracker({ db });
    await expect(
      tracker.applyAll([createMigrationDefinition('refused', sql)], {
        atomic: true,
      }),
    ).rejects.toThrow(/suspension failed/);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.startsWith('CREATE TABLE "_smrt_rebuild_'),
      ),
    ).toBe(false);
    expect((await db.query('PRAGMA foreign_keys')).rows[0]).toEqual({
      foreign_keys: 1,
    });
  });
  it('refuses adapters without transactions before changing FK enforcement', async () => {
    const sql = await planned();
    const tracker = new MigrationTracker({
      db: { ...db, transaction: undefined },
    });
    await expect(
      tracker.applyAll([createMigrationDefinition('refused', sql)], {
        atomic: true,
      }),
    ).rejects.toThrow(/transaction support/);
    expect((await db.query('PRAGMA foreign_keys')).rows[0]).toEqual({
      foreign_keys: 1,
    });
  });
  it('refuses transaction connections that did not inherit FK suspension', async () => {
    const sql = await planned();
    const transaction = db.transaction?.bind(db);
    if (!transaction) throw new Error('SQLite transactions required');
    const tracker = new MigrationTracker({
      db: {
        ...db,
        transaction: async (callback) =>
          transaction(async (tx) =>
            callback({
              ...tx,
              query: async (sql, ...params) =>
                sql === 'PRAGMA foreign_keys'
                  ? { rows: [{ foreign_keys: 1 }], rowCount: 1 }
                  : tx.query(sql, ...params),
            }),
          ),
      },
    });
    await expect(
      tracker.applyAll([createMigrationDefinition('refused', sql)], {
        atomic: true,
      }),
    ).rejects.toThrow(/suspension failed/);
    expect((await db.query('PRAGMA foreign_keys')).rows[0]).toEqual({
      foreign_keys: 1,
    });
  });
  it('leaves AUTOINCREMENT sequence tables manual', async () => {
    await db.query(
      'CREATE TABLE sequence_items (id INTEGER PRIMARY KEY AUTOINCREMENT, workbook_id TEXT NOT NULL)',
    );
    const diff = await new SchemaComparer(db, { relaxColumns: true }).compare({
      sequence_items: {
        ...schema.activities,
        tableName: 'sequence_items',
        columns: {
          id: { type: 'INTEGER', primaryKey: true },
          workbook_id: { type: 'TEXT' },
        },
      },
    });
    expect(
      diff.changes.find((change) => change.alteration === 'drop_not_null')?.sql,
    ).toMatch(/blocked: AUTOINCREMENT/);
  });
  it('preserves an explicitly disabled FK setting and enabled legacy setting', async () => {
    await db.query('PRAGMA foreign_keys = OFF');
    await db.query('PRAGMA legacy_alter_table = ON');
    expect((await apply()).every((result) => result.success)).toBe(true);
    expect((await db.query('PRAGMA foreign_keys')).rows[0]).toEqual({
      foreign_keys: 0,
    });
    expect((await db.query('PRAGMA legacy_alter_table')).rows[0]).toEqual({
      legacy_alter_table: 1,
    });
  });
  it('refuses a borrowed active transaction before changing schema', async () => {
    const sql = await planned();
    if (!db.transaction) throw new Error('SQLite transaction support required');
    await db.transaction(async (tx) => {
      const tracker = new MigrationTracker({ db: tx as DatabaseInterface });
      await tracker.initialize();
      await expect(
        tracker.applyAll([createMigrationDefinition('borrowed', sql)], {
          atomic: true,
        }),
      ).rejects.toThrow(/outside an active transaction/);
      expect((await tx.query('PRAGMA foreign_keys')).rows[0]).toEqual({
        foreign_keys: 1,
      });
    });
    expect(
      (await db.query('PRAGMA table_info(activities)')).rows.find(
        (c) => c.name === 'workbook_id',
      )?.notnull,
    ).toBe(1);
  });
  it('rolls back DDL and data and restores connection settings on failure', async () => {
    const before = (
      await db.query("SELECT sql FROM sqlite_master WHERE name='activities'")
    ).rows;
    expect(
      (await apply(['SELECT * FROM nonexistent_failure'])).some(
        (r) => !r.success,
      ),
    ).toBe(true);
    expect(
      (await db.query("SELECT sql FROM sqlite_master WHERE name='activities'"))
        .rows,
    ).toEqual(before);
    expect((await db.query('SELECT * FROM grades')).rows).toEqual([
      { id: 'g', attempt_id: 't' },
    ]);
    expect((await db.query('PRAGMA foreign_keys')).rows[0]).toEqual({
      foreign_keys: 1,
    });
    expect((await db.query('PRAGMA legacy_alter_table')).rows[0]).toEqual({
      legacy_alter_table: 0,
    });
  });
  it('rejects orphan rows before committing the rebuilt schema', async () => {
    const results = await apply([
      "INSERT INTO activities VALUES ('bad','missing','x')",
    ]);
    expect(results[0].success).toBe(false);
    expect(String(results[0].error)).toMatch(/foreign key/i);
    expect((await db.query('SELECT id FROM activities')).rows).toEqual([
      { id: 'a' },
    ]);
    expect((await db.query('PRAGMA foreign_keys')).rows[0]).toEqual({
      foreign_keys: 1,
    });
  });
});

it('rewrites only a top-level NOT NULL clause, refusing ambiguous constraints', () => {
  const rewrite = (sql: string) =>
    rewriteSqliteCreateTable(sql, {
      tableName: 'new_t',
      columnTypes: new Map(),
      nullableColumns: new Set(['a']),
    });
  expect(
    rewrite(
      `CREATE TABLE t (a TEXT NOT NULL DEFAULT 'NOT NULL' CHECK(a != 'NOT NULL'))`,
    ),
  ).toContain(`a TEXT  DEFAULT 'NOT NULL' CHECK(a != 'NOT NULL')`);
  expect(
    rewrite('CREATE TABLE t (a TEXT CONSTRAINT required NOT NULL)'),
  ).toBeNull();
  expect(rewrite('CREATE TABLE t (a TEXT PRIMARY KEY NOT NULL)')).toBeNull();
  expect(
    rewrite('CREATE TABLE t (a TEXT NOT NULL ON CONFLICT REPLACE)'),
  ).toBeNull();
});
