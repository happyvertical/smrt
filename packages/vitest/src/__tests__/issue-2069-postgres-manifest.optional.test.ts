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
});
