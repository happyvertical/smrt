import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

describe('getTestDatabase manifest schemas', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
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

    const indexListResult = await db.query(
      `PRAGMA index_list('manifest_indexed_joins')`,
    );
    const indexList = Array.isArray(indexListResult)
      ? indexListResult
      : indexListResult.rows;
    const conflictIndex = indexList.find(
      (row: { name: string }) =>
        row.name === 'manifest_indexed_joins_fact_id_content_id_idx',
    );

    expect(conflictIndex).toBeDefined();
    expect(Boolean(conflictIndex?.unique)).toBe(true);
    expect(
      indexList.some(
        (row) => row.name === 'manifest_indexed_joins_slug_context_idx',
      ),
    ).toBe(false);

    const indexInfoResult = await db.query(
      `PRAGMA index_info('manifest_indexed_joins_fact_id_content_id_idx')`,
    );
    const indexInfo = Array.isArray(indexInfoResult)
      ? indexInfoResult
      : indexInfoResult.rows;

    expect(indexInfo.map((row: { name: string }) => row.name)).toEqual([
      'fact_id',
      'content_id',
      'relationship',
    ]);
  });
});
