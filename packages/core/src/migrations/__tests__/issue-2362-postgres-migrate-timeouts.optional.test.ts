/**
 * Issue #2362 — live PostgreSQL behaviour of the bounded/concurrent migrate
 * path. Runs only in the PostgreSQL lane (`pnpm --filter
 * @happyvertical/smrt-core test:postgres`, which supplies `DATABASE_URL`);
 * skipped otherwise.
 *
 * The mock-driven coverage in `issue-2362-migrate-timeouts-concurrent.test.ts`
 * proves the tracker emits the right SQL on the right connection. Only a real
 * server can prove the semantics that actually matter in production:
 *
 * - `SET LOCAL lock_timeout` really aborts a migration queued behind a writer
 *   instead of stalling every writer behind the locks the batch already holds;
 * - `CREATE INDEX CONCURRENTLY` really runs (PostgreSQL rejects it inside a
 *   transaction block, so a mis-routed statement fails here and only here);
 * - a failed `CREATE INDEX CONCURRENTLY` really leaves an INVALID index that
 *   `pg_indexes` still reports as present, and the rebuild really repairs it.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import { MigrationTracker } from '../tracker.js';
import type { DatabaseInterface } from '../types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const TABLE = `i2362_jobs_${suffix}`;

function definition(id: string, up: string[]): MigrationDefinition {
  return { id, description: id, version: '1.0.0', up, down: [] };
}

/**
 * Flatten an error and everything it wraps into one searchable string.
 *
 * `@happyvertical/sql` re-throws driver errors as `DatabaseError: Failed to
 * execute raw query` and keeps the PostgreSQL message on `context.originalError`
 * (the message-opacity problem tracked separately as #2366), so asserting on
 * `String(error)` alone would not see the SQLSTATE at all.
 */
function describeError(error: unknown, depth = 0): string {
  if (!error || depth > 5) return '';

  const parts = [String(error)];

  if (typeof error === 'object') {
    const context = (error as { context?: { originalError?: unknown } })
      .context;
    if (context?.originalError) {
      parts.push(describeError(context.originalError, depth + 1));
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause) parts.push(describeError(cause, depth + 1));
    const code = (error as { code?: unknown }).code;
    if (code) parts.push(String(code));
  }

  return parts.join(' | ');
}

describe.skipIf(!pgUrl)(
  'db:migrate PostgreSQL timeouts and concurrent indexes (#2362)',
  () => {
    let adminDb: DatabaseInterface;
    let migrateDb: DatabaseInterface;
    let blockerDb: DatabaseInterface;

    async function connect(role: string, max: number) {
      return (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
        dbid: `smrt-test-2362-${role}-${randomUUID()}`,
        max,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    }

    async function indexIsValid(indexName: string): Promise<boolean> {
      const result = await adminDb.query(
        `SELECT i.indisvalid AS is_valid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = $1`,
        indexName,
      );
      return result.rows.length > 0 && result.rows[0].is_valid === true;
    }

    async function migrationStatus(name: string): Promise<string | null> {
      const result = await adminDb.query(
        `SELECT status FROM _smrt_schema_migrations WHERE name = $1`,
        name,
      );
      return result.rows.length > 0 ? String(result.rows[0].status) : null;
    }

    beforeAll(async () => {
      adminDb = await connect('admin', 2);
      migrateDb = await connect('migrate', 5);
      blockerDb = await connect('blocker', 2);

      await adminDb.query(
        `CREATE TABLE IF NOT EXISTS "${TABLE}" (id TEXT PRIMARY KEY, status TEXT, run_at TEXT)`,
      );
      await adminDb.query(
        `INSERT INTO "${TABLE}" (id, status, run_at) VALUES ('a', 'queued', '2026-01-01'), ('b', 'running', '2026-01-02')`,
      );
    }, 60_000);

    afterAll(async () => {
      try {
        await adminDb?.query(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
        await adminDb?.query(
          `DELETE FROM _smrt_schema_migrations WHERE name LIKE $1`,
          `%${suffix}`,
        );
      } finally {
        await blockerDb?.close?.();
        await migrateDb?.close?.();
        await adminDb?.close?.();
      }
    }, 60_000);

    it('aborts on lock_timeout instead of waiting indefinitely for a blocking writer', async () => {
      // Hold ACCESS EXCLUSIVE on the target table. Without lock_timeout the
      // migration below waits for as long as this session lives — while still
      // holding every lock its batch already took, which is the app-wide write
      // stall this issue is about.
      const held = await blockerDb.acquireSession?.();
      if (!held) throw new Error('PostgreSQL adapter must expose a session');

      await held.query('BEGIN');
      await held.query(`LOCK TABLE "${TABLE}" IN ACCESS EXCLUSIVE MODE`);

      try {
        const tracker = new MigrationTracker({
          db: migrateDb,
          lockTimeout: 750,
          statementTimeout: 30_000,
        });

        const startedAt = Date.now();
        const results = await tracker.applyAll(
          [
            definition(`i2362_locked_${suffix}`, [
              `ALTER TABLE "${TABLE}" ADD COLUMN "locked_probe" TEXT`,
            ]),
          ],
          { atomic: true },
        );
        const elapsed = Date.now() - startedAt;

        expect(results[0].success).toBe(false);
        expect(describeError(results[0].error)).toMatch(
          /lock timeout|canceling statement|55P03/i,
        );
        // Bounded, and bounded by *this* lock_timeout — not "eventually",
        // which is what the unbounded batch did.
        expect(elapsed).toBeGreaterThanOrEqual(700);
        expect(elapsed).toBeLessThan(20_000);

        // The batch rolled back: no half-applied column.
        const columns = await adminDb.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = $1 AND column_name = 'locked_probe'`,
          TABLE,
        );
        expect(columns.rows).toHaveLength(0);
      } finally {
        await held.query('ROLLBACK');
        await held.release();
      }
    }, 120_000);

    it('builds indexes with CREATE INDEX CONCURRENTLY outside the atomic batch', async () => {
      const indexName = `i2362_status_idx_${suffix}`;
      const tracker = new MigrationTracker({ db: migrateDb });

      const results = await tracker.applyAll(
        [
          definition(`i2362_add_column_${suffix}`, [
            `ALTER TABLE "${TABLE}" ADD COLUMN "priority" INTEGER`,
          ]),
          definition(`i2362_add_index_${suffix}`, [
            `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${TABLE}" ("status")`,
          ]),
        ],
        { atomic: true, postgresSafe: true },
      );

      // PostgreSQL only accepts CONCURRENTLY outside a transaction block, so a
      // successful build is itself proof the statement left the batch.
      expect(results.map((result) => result.error).filter(Boolean)).toEqual([]);
      expect(results.every((result) => result.success)).toBe(true);
      expect(await indexIsValid(indexName)).toBe(true);
      expect(await migrationStatus(`i2362_add_index_${suffix}`)).toBe(
        'completed',
      );
      expect(await migrationStatus(`i2362_add_column_${suffix}`)).toBe(
        'completed',
      );
    }, 120_000);

    it('detects an INVALID index and rebuilds it', async () => {
      const invalidIndex = `i2362_invalid_idx_${suffix}`;

      // A UNIQUE build over duplicate values fails and leaves an INVALID index
      // — exactly the stump a lock_timeout or a cancelled deploy leaves behind.
      await adminDb.query(
        `INSERT INTO "${TABLE}" (id, status, run_at) VALUES ('dup1', 'dup', '2026-02-01'), ('dup2', 'dup', '2026-02-02')`,
      );
      await expect(
        adminDb.query(
          `CREATE UNIQUE INDEX CONCURRENTLY "${invalidIndex}" ON "${TABLE}" ("status")`,
        ),
      ).rejects.toThrow();

      // `pg_indexes` — what schema introspection reads — reports it present…
      const listed = await adminDb.query(
        `SELECT indexname FROM pg_indexes WHERE indexname = $1`,
        invalidIndex,
      );
      expect(listed.rows).toHaveLength(1);
      // …but it is INVALID and unusable by the planner.
      expect(await indexIsValid(invalidIndex)).toBe(false);

      // Remove every duplicate so the rebuild can succeed.
      await adminDb.query(
        `DELETE FROM "${TABLE}" WHERE id IN ('dup1', 'dup2', 'b')`,
      );

      const tracker = new MigrationTracker({ db: migrateDb });
      const results = await tracker.applyAll(
        [
          definition(`i2362_rebuild_${suffix}`, [
            `CREATE UNIQUE INDEX IF NOT EXISTS "${invalidIndex}" ON "${TABLE}" ("status")`,
          ]),
        ],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.error).filter(Boolean)).toEqual([]);
      expect(results[0].success).toBe(true);
      expect(await indexIsValid(invalidIndex)).toBe(true);
    }, 120_000);

    it('retries a failed index build without re-running its committed column DDL', async () => {
      // The oscillation this guards against: the batch's ALTER TABLE commits,
      // the index build then fails, and a naive retry re-runs the ALTER —
      // which PostgreSQL rejects with "column already exists", so the retry
      // never reaches the index it existed to build.
      const name = `i2362_resume_${suffix}`;
      const indexName = `i2362_resume_idx_${suffix}`;

      // The previous test leaves a UNIQUE index on `status`; drop it so this
      // test controls the uniqueness it is about to violate on purpose.
      await adminDb.query(`DROP INDEX IF EXISTS "i2362_invalid_idx_${suffix}"`);

      // Force the index build to fail: duplicate values under a UNIQUE index.
      await adminDb.query(
        `INSERT INTO "${TABLE}" (id, status, run_at) VALUES ('r1', 'resume', '2026-03-01'), ('r2', 'resume', '2026-03-02')`,
      );

      const mixed = definition(name, [
        `ALTER TABLE "${TABLE}" ADD COLUMN "resume_probe" TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${TABLE}" ("status")`,
      ]);

      const first = await new MigrationTracker({ db: migrateDb }).applyAll(
        [mixed],
        { atomic: true, postgresSafe: true, reconcile: true },
      );

      expect(first[0].success).toBe(false);
      expect(await migrationStatus(name)).toBe('failed');
      // The column half committed even though the index half failed.
      const columns = await adminDb.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'resume_probe'`,
        TABLE,
      );
      expect(columns.rows).toHaveLength(1);

      // Make the index buildable, then re-run the identical definition.
      await adminDb.query(`DELETE FROM "${TABLE}" WHERE id = 'r2'`);

      const second = await new MigrationTracker({ db: migrateDb }).applyAll(
        [mixed],
        { atomic: true, postgresSafe: true, reconcile: true },
      );

      // Without the resume marker this fails with 42701 "column already exists".
      expect(second.map((result) => result.error).filter(Boolean)).toEqual([]);
      expect(second[0].success).toBe(true);
      expect(await migrationStatus(name)).toBe('completed');
      expect(await indexIsValid(indexName)).toBe(true);
    }, 120_000);
  },
);
