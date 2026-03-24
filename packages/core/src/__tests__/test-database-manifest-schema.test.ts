import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

function getRows(result: any): any[] {
  if (Array.isArray(result)) return result;
  return result?.rows ?? [];
}

describe('getTestDatabase manifest schemas', () => {
  let originalClasses: Map<string, any>;

  beforeEach(() => {
    originalClasses = new Map(ObjectRegistry.getAllClasses());
  });

  afterEach(() => {
    for (const [name] of ObjectRegistry.getAllClasses()) {
      if (!originalClasses.has(name)) {
        // @ts-expect-error test cleanup
        ObjectRegistry.classes.delete(name);
      }
    }

    // @ts-expect-error test cleanup
    for (const [key, entries] of ObjectRegistry.classNameMap) {
      // @ts-expect-error test cleanup
      ObjectRegistry.classNameMap.set(
        key,
        entries.filter((entry: string) => originalClasses.has(entry)),
      );
      // @ts-expect-error test cleanup
      if (ObjectRegistry.classNameMap.get(key)?.length === 0) {
        // @ts-expect-error test cleanup
        ObjectRegistry.classNameMap.delete(key);
      }
    }
  });

  it('preserves manifest-defined unique conflict indexes for test databases', async () => {
    ObjectRegistry.registerFromManifest(
      '@test/pkg:ManifestIndexedJoin',
      {
        className: 'ManifestIndexedJoin',
        fields: {
          factId: { type: 'text', required: true },
          contentId: { type: 'text', required: true },
          relationship: { type: 'text', required: true },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'manifest_indexed_joins',
          conflictColumns: ['fact_id', 'content_id', 'relationship'],
        },
        schema: {
          tableName: 'manifest_indexed_joins',
          ddl: `CREATE TABLE IF NOT EXISTS "manifest_indexed_joins" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "fact_id" TEXT NOT NULL DEFAULT '',
  "content_id" TEXT NOT NULL DEFAULT '',
  "relationship" TEXT NOT NULL DEFAULT 'extracted_from'
)`,
          columns: {
            id: { type: 'TEXT', notNull: true, primaryKey: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, default: '' },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            updated_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            fact_id: { type: 'TEXT', notNull: true, default: '' },
            content_id: { type: 'TEXT', notNull: true, default: '' },
            relationship: {
              type: 'TEXT',
              notNull: true,
              default: 'extracted_from',
            },
          },
          indexes: [
            {
              name: 'manifest_indexed_joins_fact_id_content_id_idx',
              columns: ['fact_id', 'content_id', 'relationship'],
              unique: true,
            },
          ],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ManifestIndexedJoin'],
    });

    const result = await db.query(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'manifest_indexed_joins'
       ORDER BY name`,
    );
    const rows = getRows(result);

    expect(
      rows.some(
        (row) => row.name === 'manifest_indexed_joins_fact_id_content_id_idx',
      ),
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.sql ===
          'CREATE UNIQUE INDEX "manifest_indexed_joins_fact_id_content_id_idx" ON "manifest_indexed_joins" ("fact_id", "content_id", "relationship")',
      ),
    ).toBe(true);
    expect(
      rows.some(
        (row) => row.name === 'manifest_indexed_joins_slug_context_idx',
      ),
    ).toBe(false);
  });
});
