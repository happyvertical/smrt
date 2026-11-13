import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { SchemaComparer } from '../differ.js';

const parents: SchemaDefinition = {
  tableName: 'parents',
  columns: { id: { type: 'TEXT', primaryKey: true } },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '4937',
};
const items = (engines?: string[]): SchemaDefinition => ({
  tableName: 'items',
  columns: {
    id: { type: 'TEXT', primaryKey: true },
    parent_id: { type: 'TEXT' },
  },
  indexes: [],
  triggers: [],
  foreignKeys: [
    {
      column: 'parent_id',
      referencesTable: 'parents',
      referencesColumn: 'id',
      ...(engines ? { engines } : {}),
    } as never,
  ],
  dependencies: ['parents'],
  version: '4937',
});

describe('DuckDB foreign keys are read from the catalog (#4937)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id))',
    );
  });
  afterEach(async () => {
    await db.close?.();
  });

  it('sees a live foreign key that the manifest declares', async () => {
    const diff = await new SchemaComparer(db, { engineHint: 'duckdb' }).compare(
      { parents, items: items() },
    );
    expect(diff.changes).toEqual([]);
  });

  it('sees a live foreign key the manifest no longer enables', async () => {
    const diff = await new SchemaComparer(db, { engineHint: 'duckdb' }).compare(
      { parents, items: items(['postgres']) },
    );
    expect(diff.changes.map((change) => change.type)).toEqual([
      'drop_foreign_key',
    ]);
  });
});
