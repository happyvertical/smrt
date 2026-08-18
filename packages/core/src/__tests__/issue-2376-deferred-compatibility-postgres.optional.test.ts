/**
 * Deferred system-table compatibility against a real PostgreSQL database
 * (#2376).
 *
 * `reconcileJobsTaskIdUniqueness()` decides whether to create or drop the
 * unique index backing the `_smrt_jobs.task_id` upsert conflict target, from a
 * `pg_index` catalog read. Two things only PostgreSQL can prove:
 *
 * - a `UNIQUE` *column constraint* materializes as an implicit `<table>_key`
 *   index that must be recognized as already enforcing the uniqueness;
 * - a *partial* unique index must not be, because it enforces nothing outside
 *   its predicate.
 *
 * SQLite reports both through a different catalog and cannot exercise the
 * PostgreSQL query at all, so this is the only place the production path is
 * verified (`packages/core/agents/schema-paths.md` rule 3).
 *
 * Runs only in the dedicated PostgreSQL shard. The database must be
 * disposable: this suite creates and drops its own `_smrt_jobs` table.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureDeferredSystemTableCompatibility,
  ensureJobsSystemTableCompatibility,
} from '../system/compatibility.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

let db: DatabaseInterface | undefined;

/** `_smrt_jobs` as `db:migrate` creates it, with `taskId` declared unique. */
async function createManifestJobsTable(): Promise<void> {
  await db?.query(`
    CREATE TABLE _smrt_jobs (
      id uuid PRIMARY KEY,
      tenant_id uuid,
      queue text NOT NULL DEFAULT 'default',
      object_type text NOT NULL,
      method text NOT NULL,
      run_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      task_id text UNIQUE,
      task_owner_id text,
      task_result text,
      task_input_requests text,
      task_input_responses text,
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz DEFAULT CURRENT_TIMESTAMP
    )`);
}

/** A pre-task_id install: the column arrives later via ALTER TABLE. */
async function createLegacyJobsTable(): Promise<void> {
  await db?.query(`
    CREATE TABLE _smrt_jobs (
      id uuid PRIMARY KEY,
      queue text NOT NULL DEFAULT 'default',
      object_type text NOT NULL,
      method text NOT NULL,
      run_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz DEFAULT CURRENT_TIMESTAMP
    )`);
}

async function createJobEventsTable(): Promise<void> {
  await db?.query(`
    CREATE TABLE _smrt_job_events (
      id uuid PRIMARY KEY,
      tenant_id uuid,
      job_id text NOT NULL,
      type text NOT NULL DEFAULT 'log',
      message text NOT NULL DEFAULT '',
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz DEFAULT CURRENT_TIMESTAMP
    )`);
}

/** Every non-partial unique index over exactly `(task_id)`. */
async function uniqueIndexesOnTaskId(): Promise<string[]> {
  const result = await db?.query(`
    SELECT i.relname AS name
    FROM pg_class t
    JOIN pg_index ix ON ix.indrelid = t.oid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = '_smrt_jobs'
      AND ix.indisunique
      AND ix.indpred IS NULL
      AND ix.indnatts = 1
      AND (
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum = ix.indkey[0]
      ) = 'task_id'
    ORDER BY i.relname`);
  return ((result?.rows ?? []) as { name: string }[]).map((row) => row.name);
}

describe.skipIf(!pgUrl)(
  'deferred system-table compatibility (PostgreSQL)',
  () => {
    beforeAll(async () => {
      db = await getDatabase({ type: 'postgres', url: pgUrl as string });
    });

    afterEach(async () => {
      await db?.query('DROP TABLE IF EXISTS _smrt_jobs CASCADE');
      await db?.query('DROP TABLE IF EXISTS _smrt_job_events CASCADE');
    });

    afterAll(async () => {
      await db?.close?.();
      db = undefined;
    });

    it('recognizes the implicit constraint index and adds no second unique index', async () => {
      await createManifestJobsTable();

      await ensureJobsSystemTableCompatibility(db as DatabaseInterface);

      expect(await uniqueIndexesOnTaskId()).toEqual(['_smrt_jobs_task_id_key']);
    });

    it('drops the redundant compat index when the constraint index also exists', async () => {
      await createManifestJobsTable();
      await db?.query(
        'CREATE UNIQUE INDEX idx_smrt_jobs_task_id ON _smrt_jobs (task_id)',
      );
      expect(await uniqueIndexesOnTaskId()).toEqual([
        '_smrt_jobs_task_id_key',
        'idx_smrt_jobs_task_id',
      ]);

      await ensureJobsSystemTableCompatibility(db as DatabaseInterface);

      expect(await uniqueIndexesOnTaskId()).toEqual(['_smrt_jobs_task_id_key']);
    });

    it('creates the compat index on a legacy table whose task_id came from ALTER TABLE', async () => {
      await createLegacyJobsTable();

      await ensureJobsSystemTableCompatibility(db as DatabaseInterface);

      expect(await uniqueIndexesOnTaskId()).toEqual(['idx_smrt_jobs_task_id']);
    });

    it('never lets a partial unique index stand in for the compat index', async () => {
      await createLegacyJobsTable();
      await db?.query('ALTER TABLE _smrt_jobs ADD COLUMN task_id text');
      await db?.query(`
      CREATE UNIQUE INDEX partial_task_id_key
        ON _smrt_jobs (task_id) WHERE status = 'pending'`);

      await ensureJobsSystemTableCompatibility(db as DatabaseInterface);

      // The partial index enforces nothing outside its predicate, so the compat
      // index is still required.
      expect(await uniqueIndexesOnTaskId()).toEqual(['idx_smrt_jobs_task_id']);
    });

    it('settles only once both deferred tables exist', async () => {
      await expect(
        ensureDeferredSystemTableCompatibility(db as DatabaseInterface),
      ).resolves.toEqual({ settled: false });

      await createManifestJobsTable();
      await expect(
        ensureDeferredSystemTableCompatibility(db as DatabaseInterface),
      ).resolves.toEqual({ settled: false });

      await createJobEventsTable();
      await expect(
        ensureDeferredSystemTableCompatibility(db as DatabaseInterface),
      ).resolves.toEqual({ settled: true });

      const indexes = await db?.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename IN ('_smrt_jobs', '_smrt_job_events')`);
      const names = ((indexes?.rows ?? []) as { indexname: string }[]).map(
        (row) => row.indexname,
      );
      expect(names).toContain('idx_smrt_jobs_tenant_id');
      expect(names).toContain('idx_smrt_job_events_tenant_id');
      expect(names).toContain('idx_smrt_job_events_job_id');
    });
  },
);
