import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { createMigrationDefinition } from '../migrations/generator.js';
import { MigrationTracker } from '../migrations/tracker.js';
import type { ColumnDefinition, SchemaDefinition } from './types.js';

function manifest(column: Partial<ColumnDefinition> = {}): SchemaDefinition {
  return {
    tableName: 'records',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      source_id: { type: 'TEXT', ...column },
    },
    foreignKeys: [
      {
        column: 'source_id',
        referencesTable: 'records',
        referencesColumn: 'id',
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
    ],
    indexes: [],
    triggers: [],
    dependencies: ['records'],
    version: '1',
  };
}

describe('new nullable SQLite reference columns (#3795)', () => {
  it('preserves populated and inbound rows, enforces actions, rolls back and repeats cleanly', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await db.query('PRAGMA foreign_keys = ON');
      await db.query('CREATE TABLE records (id TEXT PRIMARY KEY)');
      await db.query(
        'CREATE TABLE attachments (id TEXT PRIMARY KEY, record_id TEXT REFERENCES records(id))',
      );
      await db.query("INSERT INTO records VALUES ('original')");
      await db.query(
        "INSERT INTO attachments VALUES ('attachment', 'original')",
      );
      const diff = await new SchemaComparer(db).compare({
        records: manifest(),
      });
      expect(
        diff.changes.filter((change) => change.type === 'add_foreign_key'),
      ).toEqual([]);
      const change = diff.changes.find((item) => item.type === 'add_column');
      expect(change?.sql).toContain('REFERENCES "records" ("id")');
      await db.query('BEGIN');
      await db.query(change!.sql!);
      await db.query('ROLLBACK');
      expect(
        (await db.getTableSchema?.('records'))?.columns.source_id,
      ).toBeUndefined();
      await db.query(change!.sql!);
      expect((await db.query('SELECT source_id FROM records')).rows).toEqual([
        { source_id: null },
      ]);
      await expect(
        db.query("INSERT INTO records VALUES ('bad', 'missing')"),
      ).rejects.toThrow();
      await db.query("INSERT INTO records VALUES ('refund', 'original')");
      await expect(
        db.query("DELETE FROM records WHERE id = 'original'"),
      ).rejects.toThrow();
      await db.query('DELETE FROM attachments');
      await db.query("UPDATE records SET id = 'renamed' WHERE id = 'original'");
      expect(
        (await db.query("SELECT source_id FROM records WHERE id = 'refund'"))
          .rows,
      ).toEqual([{ source_id: 'renamed' }]);
      const repeated = await new SchemaComparer(db).compare({
        records: manifest(),
      });
      expect(
        repeated.changes.filter(
          (item) =>
            item.type === 'add_column' || item.type === 'add_foreign_key',
        ),
      ).toEqual([]);
    } finally {
      await db.close?.();
    }
  });

  it.each([
    { defaultValue: 'original' },
    { notNull: true },
    { backfill: "'original'" },
  ])('adds the column and its key in one rebuild for column shape %j (#4937)', async (column) => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await db.query('PRAGMA foreign_keys = ON');
      await db.query('CREATE TABLE records (id TEXT PRIMARY KEY)');
      // A required column with no default needs an empty table: there is no
      // value to give the rows that exist.
      if (!('notNull' in column))
        await db.query("INSERT INTO records VALUES ('original')");
      const diff = await new SchemaComparer(db).compare({
        records: manifest(column),
      });
      // SQLite cannot add a key column with a default or NOT NULL in place, so
      // the rebuild carries the column and the key together.
      expect(
        diff.changes.some(
          (item) => item.type === 'add_foreign_key' && item.engineUnsupported,
        ),
      ).toBe(false);
      const tracker = new MigrationTracker({ db });
      await tracker.initialize();
      const results = await tracker.applyAll(
        [
          createMigrationDefinition(
            'add_key',
            getSQLFromDiff(diff).filter((sql) => !sql.startsWith('--')),
          ),
        ],
        { atomic: true },
      );
      expect(results.every((result) => result.success)).toBe(true);
      expect(
        (await db.query('PRAGMA foreign_key_list(records)')).rows.map(
          (row) => row.from,
        ),
      ).toEqual(['source_id']);
      expect((await db.query('SELECT id FROM records')).rows).toEqual(
        'notNull' in column ? [] : [{ id: 'original' }],
      );
      const repeated = await new SchemaComparer(db).compare({
        records: manifest(column),
      });
      expect(repeated.changes).toEqual([]);
    } finally {
      await db.close?.();
    }
  });

  it('rebuilds to add a key on an existing column and honors engine exclusions (#4937)', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await db.query(
        'CREATE TABLE records (id TEXT PRIMARY KEY, source_id TEXT)',
      );
      const diff = await new SchemaComparer(db).compare({
        records: manifest(),
      });
      expect(
        diff.changes.some(
          (item) =>
            item.type === 'add_foreign_key' &&
            !item.engineUnsupported &&
            item.sqlStatements?.some((sql) => sql.includes('_smrt_rebuild_')),
        ),
      ).toBe(true);
      await db.query('DROP TABLE records');
      await db.query('CREATE TABLE records (id TEXT PRIMARY KEY)');
      const schema = manifest();
      schema.foreignKeys[0].engines = ['postgres'];
      const excluded = await new SchemaComparer(db).compare({
        records: schema,
      });
      expect(
        excluded.changes.find((item) => item.type === 'add_column')?.sql,
      ).not.toContain('REFERENCES');
    } finally {
      await db.close?.();
    }
  });
});
