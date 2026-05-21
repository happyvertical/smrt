import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

describe('getTestDatabase manifest schemas', () => {
  let restoreRegistry: () => void;

  function registerCollectionStubWithSTIItem(): void {
    ObjectRegistry.registerFromManifest(
      '@test/pkg:Meetings',
      {
        className: 'Meetings',
        extends: 'SmrtCollection',
        extendsTypeArg: 'Event',
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: 'events',
        },
        schema: {
          tableName: 'events',
          ddl: `CREATE TABLE IF NOT EXISTS "events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp
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
          },
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );

    ObjectRegistry.registerFromManifest(
      '@test/pkg:Event',
      {
        className: 'Event',
        fields: {
          name: { type: 'text', required: false, default: '' },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'events',
          tableStrategy: 'sti',
        },
        schema: {
          tableName: 'events',
          ddl: `CREATE TABLE IF NOT EXISTS "events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "_meta_type" TEXT NOT NULL,
  "_meta_data" JSON,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "name" TEXT DEFAULT ''
)`,
          columns: {
            id: { type: 'TEXT', notNull: true, primaryKey: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, default: '' },
            _meta_type: { type: 'TEXT', notNull: true },
            _meta_data: { type: 'JSON', notNull: false },
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
            name: { type: 'TEXT', notNull: false, default: '' },
          },
          indexes: [
            {
              name: 'events_meta_type_idx',
              columns: ['_meta_type'],
              unique: false,
            },
          ],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );
  }

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('normalizes manifest column defaults into runtime schema definitions', () => {
    ObjectRegistry.registerFromManifest(
      '@test/pkg:ManifestDefaultedFeedSource',
      {
        className: 'ManifestDefaultedFeedSource',
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: 'manifest_defaulted_feed_sources',
        },
        schema: {
          tableName: 'manifest_defaulted_feed_sources',
          ddl: `CREATE TABLE IF NOT EXISTS "manifest_defaulted_feed_sources" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "poll_interval_minutes" INTEGER NOT NULL DEFAULT 15
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
            poll_interval_minutes: {
              type: 'INTEGER',
              notNull: true,
              default: 15,
            },
          },
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );

    const schema =
      ObjectRegistry.getAllSchemasAsDefinitions()
        .manifest_defaulted_feed_sources;

    expect(schema.columns.context.defaultValue).toBe('');
    expect(schema.columns.created_at.defaultValue).toBe('current_timestamp');
    expect(schema.columns.updated_at.defaultValue).toBe('current_timestamp');
    expect(schema.columns.poll_interval_minutes.defaultValue).toBe(15);
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

  it('prefers the STI item schema over collection manifest stubs that share the same table', async () => {
    registerCollectionStubWithSTIItem();

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Meetings', 'Event'],
    });

    const columnsResult = await db.query(`PRAGMA table_info('events')`);
    const columns = Array.isArray(columnsResult)
      ? columnsResult
      : columnsResult.rows;
    const columnNames = columns.map((row: { name: string }) => row.name);

    expect(columnNames).toContain('_meta_type');
    expect(columnNames).toContain('_meta_data');
    expect(columnNames).toContain('name');
  });

  it('maps requested collection classes to their STI item schema', async () => {
    registerCollectionStubWithSTIItem();

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Meetings'],
    });

    const columnsResult = await db.query(`PRAGMA table_info('events')`);
    const columns = Array.isArray(columnsResult)
      ? columnsResult
      : columnsResult.rows;
    const columnNames = columns.map((row: { name: string }) => row.name);

    expect(columnNames).toContain('_meta_type');
    expect(columnNames).toContain('_meta_data');
    expect(columnNames).toContain('name');
  });
});
