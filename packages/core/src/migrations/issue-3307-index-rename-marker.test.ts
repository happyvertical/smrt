/**
 * #3307 — the tenant-led natural-key index rename is executed as
 * `ALTER INDEX ... RENAME TO`, but is reported as an `add_index` change.
 * The change must carry `renamedFrom` so `db:diff` / `db:migrate` can say
 * "rename" instead of "create". The DDL is unchanged.
 */

import { describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../schema/types.js';
import { SchemaComparer } from './differ.js';

const columns = ['tenant_id', 'slug', 'context'];

const manifest: SchemaDefinition = {
  tableName: 'listings',
  columns: {
    id: { type: 'UUID', primaryKey: true },
    tenant_id: { type: 'UUID' },
    slug: { type: 'TEXT' },
    context: { type: 'TEXT' },
  },
  indexes: [{ name: 'listings_tenant_id_slug_idx', columns, unique: true }],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '3307',
};

function postgresFake(liveIndexName: string) {
  return {
    url: 'postgres://fixture/issue3307',
    query: async (sql: string) =>
      sql.includes('information_schema.tables')
        ? { rows: [{ table_name: 'listings' }] }
        : { rows: [] },
    getTableSchema: async () => ({
      columns: {
        id: { name: 'id', type: 'uuid', primaryKey: true },
        tenant_id: { name: 'tenant_id', type: 'uuid' },
        slug: { name: 'slug', type: 'text' },
        context: { name: 'context', type: 'text' },
      },
      indexes: [{ name: liveIndexName, columns, unique: true }],
      foreignKeys: [],
    }),
  };
}

async function indexChanges(liveIndexName: string) {
  const diff = await new SchemaComparer(postgresFake(liveIndexName) as never, {
    engineHint: 'postgres',
  }).compare({ listings: manifest });
  return diff.changes.filter((change) => change.type === 'add_index');
}

describe('index rename reporting (#3307)', () => {
  it('marks the legacy-name rename with renamedFrom and keeps the DDL', async () => {
    const changes = await indexChanges('listings_slug_context_idx');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      name: 'listings_tenant_id_slug_idx',
      renamedFrom: 'listings_slug_context_idx',
      sql: 'ALTER INDEX IF EXISTS "listings_slug_context_idx" RENAME TO "listings_tenant_id_slug_idx"',
    });
  });

  it('emits nothing when the index already has the manifest name', async () => {
    expect(await indexChanges('listings_tenant_id_slug_idx')).toEqual([]);
  });
});
