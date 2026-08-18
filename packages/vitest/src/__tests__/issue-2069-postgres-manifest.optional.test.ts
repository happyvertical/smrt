/**
 * PostgreSQL manifest materialization contract for issue #2069.
 *
 * Runs only in the dedicated disposable PostgreSQL shard.
 */

import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIsolatedTestDbFromManifest } from '../test-db.js';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe.sequential
  : describe.skip;

postgresDescribe('PostgreSQL manifest Date materialization (#2069)', () => {
  it('creates bare manifest TIMESTAMP columns as TIMESTAMPTZ', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tableName = `issue_2069_manifest_${suffix}`;
    const manifestPath = join(
      tmpdir(),
      `smrt-vitest-issue-2069-${suffix}.json`,
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        objects: {
          ManifestDateRecord: {
            className: 'ManifestDateRecord',
            schema: {
              tableName,
              ddl: `CREATE TABLE IF NOT EXISTS "${tableName}" ("id" UUID PRIMARY KEY, "occurred_at" TIMESTAMP NOT NULL)`,
            },
          },
        },
      }),
    );

    const result = await createIsolatedTestDbFromManifest({ manifestPath });
    try {
      const queryResult = await result.db.query(
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1
           AND column_name = 'occurred_at'`,
        tableName,
      );
      const rows = Array.isArray(queryResult)
        ? queryResult
        : ((queryResult as { rows?: unknown[] }).rows ?? []);
      expect(rows).toEqual([
        expect.objectContaining({ data_type: 'timestamp with time zone' }),
      ]);

      await result.db.rollback();
      await result.baseDb.query(`DROP TABLE IF EXISTS "${tableName}"`);
    } finally {
      await result.cleanup();
      rmSync(manifestPath, { force: true });
    }
  });

  it('renders structured manifest columns and indexes through the PostgreSQL strategy (#2358)', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tableName = `issue_2358_manifest_${suffix}`;
    const manifestPath = join(
      tmpdir(),
      `smrt-vitest-issue-2358-${suffix}.json`,
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        objects: {
          StructuredRecord: {
            className: 'StructuredRecord',
            schema: {
              tableName,
              // Cached preview: CREATE TABLE only, abstract types. Must NOT
              // be what the database receives.
              ddl: `CREATE TABLE IF NOT EXISTS "${tableName}" ("id" TEXT PRIMARY KEY NOT NULL, "payload" JSON, "ratio" REAL, "occurred_at" TIMESTAMP, "deleted_at" TIMESTAMP)`,
              columns: {
                id: { type: 'UUID', primaryKey: true, notNull: true },
                payload: { type: 'JSON' },
                ratio: { type: 'REAL' },
                occurred_at: { type: 'TIMESTAMP', notNull: true },
                deleted_at: { type: 'TIMESTAMP' },
              },
              indexes: [
                { name: `${tableName}_occurred_idx`, columns: ['occurred_at'] },
                {
                  name: `${tableName}_live_idx`,
                  columns: ['occurred_at'],
                  where: '"deleted_at" IS NULL',
                },
                {
                  name: `${tableName}_kind_idx`,
                  columns: [],
                  jsonPath: { column: 'payload', path: 'kind' },
                },
              ],
            },
          },
        },
      }),
    );

    const result = await createIsolatedTestDbFromManifest({ manifestPath });
    try {
      const columnsResult = await result.db.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1
         ORDER BY ordinal_position`,
        tableName,
      );
      const columns = (
        Array.isArray(columnsResult)
          ? columnsResult
          : ((columnsResult as { rows?: unknown[] }).rows ?? [])
      ) as Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>;
      const byName = new Map(columns.map((c) => [c.column_name, c]));
      expect(byName.get('id')).toMatchObject({
        data_type: 'uuid',
        is_nullable: 'NO',
      });
      expect(byName.get('payload')?.data_type).toBe('jsonb');
      expect(byName.get('ratio')?.data_type).toBe('double precision');
      expect(byName.get('occurred_at')?.data_type).toBe(
        'timestamp with time zone',
      );

      const indexResult = await result.db.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = current_schema() AND tablename = $1
         ORDER BY indexname`,
        tableName,
      );
      const indexes = (
        Array.isArray(indexResult)
          ? indexResult
          : ((indexResult as { rows?: unknown[] }).rows ?? [])
      ) as Array<{ indexname: string; indexdef: string }>;
      const defs = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
      expect(defs.has(`${tableName}_occurred_idx`)).toBe(true);
      expect(defs.get(`${tableName}_live_idx`)).toMatch(
        /WHERE \(deleted_at IS NULL\)/,
      );
      expect(defs.get(`${tableName}_kind_idx`)).toContain("->> 'kind'");

      await result.db.rollback();
      await result.baseDb.query(`DROP TABLE IF EXISTS "${tableName}"`);
    } finally {
      await result.cleanup();
      rmSync(manifestPath, { force: true });
    }
  });
});
