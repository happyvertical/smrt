/**
 * Schema path parity for `createIsolatedTestDbFromManifest` (#2358).
 *
 * A manifest-derived isolated test database must carry the same tables and
 * the same indexes as the migration path (`db:migrate` /
 * `MigrationGenerator`) for the same manifest schema — including partial
 * `WHERE` predicates, JSON-path targets, and the SQLite primary-key NOT NULL.
 * Before #2358 the test-db path executed the cached `schema.ddl` string and a
 * private index renderer that dropped `where`/`jsonPath`, so tests ran against
 * a schema no deployment received.
 *
 * TODO(#2359): fold these assertions into
 * `packages/core/src/schema/schema-path-parity.test.ts` once it lands. They
 * live here because smrt-core cannot depend on smrt-vitest.
 *
 * SQLite-only: the assertions read `sqlite_master`. The PostgreSQL manifest
 * lane (`issue-2069-postgres-manifest.optional.test.ts`) covers PG typing.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationGenerator } from '@happyvertical/smrt-core/migrations';
import { manifestSchemaToDefinition } from '@happyvertical/smrt-core/schema/utils';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIsolatedTestDbFromManifest,
  getTestAdapter,
} from '../test-db.js';

const testDir = join(tmpdir(), `smrt-vitest-parity-${Date.now()}`);

type Row = Record<string, unknown>;

async function rows(
  db: { query: (sql: string, ...params: unknown[]) => Promise<unknown> },
  sql: string,
): Promise<Row[]> {
  const result = await db.query(sql);
  return Array.isArray(result)
    ? (result as Row[])
    : ((result as { rows?: Row[] }).rows ?? []);
}

/**
 * Named (non-autoindex) indexes of a table: name → normalized SQL.
 *
 * Whitespace and identifier quotes are normalized: the isolated test-db path
 * applies its DDL through the SDK's `syncSchema`, which stores the statement
 * with bare identifiers, while a directly executed migration keeps the
 * quotes. Both are the same index.
 */
async function indexMap(
  db: { query: (sql: string, ...params: unknown[]) => Promise<unknown> },
  tableName: string,
): Promise<Map<string, string>> {
  const result = await rows(
    db,
    `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${tableName}' AND sql IS NOT NULL ORDER BY name`,
  );
  return new Map(
    result.map((row) => [
      String(row.name),
      String(row.sql).replace(/"/g, '').replace(/\s+/g, ' ').trim(),
    ]),
  );
}

async function columnMap(
  db: { query: (sql: string, ...params: unknown[]) => Promise<unknown> },
  tableName: string,
): Promise<Map<string, { type: string; notnull: number; pk: number }>> {
  const result = await rows(db, `PRAGMA table_info('${tableName}')`);
  return new Map(
    result.map((row) => [
      String(row.name),
      {
        type: String(row.type),
        notnull: Number(row.notnull),
        pk: Number(row.pk),
      },
    ]),
  );
}

const sqliteDescribe = getTestAdapter() === 'sqlite' ? describe : describe.skip;

sqliteDescribe('manifest test-db ↔ migration path parity (#2358)', () => {
  const manifestPath = join(testDir, 'parity-manifest.json');

  // A structured manifest as `smrt build` / `smrtVitestPlugin()` writes it:
  // engine-neutral cached `ddl` (CREATE TABLE only, abstract types) plus the
  // authoritative `columns` / `indexes`. Two STI classes share `events`.
  const manifest = {
    packageName: '@test/parity',
    objects: {
      '@test/parity:Event': {
        className: 'Event',
        schema: {
          tableName: 'events',
          ddl: 'CREATE TABLE IF NOT EXISTS "events" ("id" TEXT PRIMARY KEY NOT NULL, "slug" TEXT NOT NULL, "context" TEXT NOT NULL DEFAULT \'\', "_meta_type" TEXT NOT NULL DEFAULT \'\', "_meta_data" JSON, "tenant_id" UUID, "deleted_at" TIMESTAMP);',
          columns: {
            id: { type: 'UUID', primaryKey: true, notNull: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, default: '' },
            _meta_type: { type: 'TEXT', notNull: true, default: '' },
            _meta_data: { type: 'JSON' },
            tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
            deleted_at: { type: 'TIMESTAMP' },
          },
          indexes: [
            {
              name: 'events_slug_context_meta_type_idx',
              columns: ['slug', 'context', '_meta_type'],
              unique: true,
            },
            { name: 'events_meta_type_idx', columns: ['_meta_type'] },
            { name: 'events_tenant_id_idx', columns: ['tenant_id'] },
            {
              name: 'events_tenant_live_idx',
              columns: ['tenant_id'],
              where: '"deleted_at" IS NULL',
            },
            {
              name: 'events_meta_kind_idx',
              columns: [],
              jsonPath: { column: '_meta_data', path: 'kind' },
            },
          ],
          version: 'a',
        },
      },
      '@test/parity:ScheduledEvent': {
        className: 'ScheduledEvent',
        extends: 'Event',
        schema: {
          tableName: 'events',
          ddl: 'CREATE TABLE IF NOT EXISTS "events" ("id" TEXT PRIMARY KEY NOT NULL, "starts_at" TIMESTAMP);',
          columns: {
            id: { type: 'UUID', primaryKey: true, notNull: true },
            starts_at: { type: 'TIMESTAMP' },
          },
          indexes: [
            { name: 'events_meta_type_idx', columns: ['_meta_type'] },
            { name: 'events_starts_at_idx', columns: ['starts_at'] },
          ],
          version: 'b',
        },
      },
    },
  };

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));
  });

  afterAll(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('creates the same columns and indexes as a generated migration for the same schema', async () => {
    // Path A: the isolated test database.
    const isolated = await createIsolatedTestDbFromManifest({ manifestPath });

    // Path B: the migration path — the merged STI definition rendered by
    // MigrationGenerator (which, like the orchestrator, delegates to the
    // engine DDL strategy) and applied to a fresh database.
    const migrated = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const base = manifestSchemaToDefinition(
        manifest.objects['@test/parity:Event'].schema,
      );
      const child = manifestSchemaToDefinition(
        manifest.objects['@test/parity:ScheduledEvent'].schema,
      );
      for (const [name, column] of Object.entries(child.columns)) {
        if (!(name in base.columns)) base.columns[name] = column;
      }
      for (const index of child.indexes) {
        if (!base.indexes.some((existing) => existing.name === index.name)) {
          base.indexes.push(index);
        }
      }

      const migration = new MigrationGenerator({
        engine: 'sqlite',
      }).generateFromDiff(
        {
          has_changes: true,
          added_tables: [base],
          dropped_tables: [],
          changes: [],
        },
        { name: '0001_events' },
      );
      for (const statement of migration.up) {
        await migrated.query(statement);
      }

      const isolatedIndexes = await indexMap(isolated.baseDb, 'events');
      const migratedIndexes = await indexMap(migrated, 'events');
      expect([...isolatedIndexes.keys()]).toEqual([...migratedIndexes.keys()]);
      expect(isolatedIndexes).toEqual(migratedIndexes);

      // The specific indexes the retired string renderers lost.
      expect(isolatedIndexes.get('events_tenant_live_idx')).toContain(
        'WHERE deleted_at IS NULL',
      );
      expect(isolatedIndexes.get('events_meta_kind_idx')).toContain(
        "json_extract(_meta_data, '$.kind')",
      );
      expect(isolatedIndexes.get('events_slug_context_meta_type_idx')).toMatch(
        /^CREATE UNIQUE INDEX/,
      );
      // STI union: the child's index is present exactly once.
      expect(isolatedIndexes.has('events_starts_at_idx')).toBe(true);
      expect(isolatedIndexes.size).toBe(6);

      const isolatedColumns = await columnMap(isolated.baseDb, 'events');
      const migratedColumns = await columnMap(migrated, 'events');
      expect(isolatedColumns).toEqual(migratedColumns);
      expect([...isolatedColumns.keys()]).toEqual([
        'id',
        'slug',
        'context',
        '_meta_type',
        '_meta_data',
        'tenant_id',
        'deleted_at',
        'starts_at',
      ]);
      // Engine types come from the SQLite strategy, not the cached string.
      expect(isolatedColumns.get('deleted_at')?.type).toBe('DATETIME');
      expect(isolatedColumns.get('_meta_data')?.type).toBe('TEXT');
      // Primary key is NOT NULL on SQLite (#2358).
      expect(isolatedColumns.get('id')).toEqual({
        type: 'TEXT',
        notnull: 1,
        pk: 1,
      });
    } finally {
      await isolated.cleanup();
      if (typeof migrated.close === 'function') await migrated.close();
    }
  });

  it('rejects a NULL primary key in the isolated test database', async () => {
    const isolated = await createIsolatedTestDbFromManifest({ manifestPath });
    try {
      await expect(
        isolated.db.query(
          `INSERT INTO "events" ("id", "slug", "_meta_type") VALUES (NULL, 'x', 'Event')`,
        ),
      ).rejects.toThrow();
    } finally {
      await isolated.cleanup();
    }
  });
});
