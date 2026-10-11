import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
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
  ])('does not hide unsupported column shape %j', async (column) => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await db.query('CREATE TABLE records (id TEXT PRIMARY KEY)');
      const diff = await new SchemaComparer(db).compare({
        records: manifest(column),
      });
      expect(
        diff.changes.some(
          (item) => item.type === 'add_foreign_key' && item.engineUnsupported,
        ),
      ).toBe(true);
    } finally {
      await db.close?.();
    }
  });

  it('keeps existing-column FK additions manual and honors engine exclusions', async () => {
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
          (item) => item.type === 'add_foreign_key' && item.engineUnsupported,
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
