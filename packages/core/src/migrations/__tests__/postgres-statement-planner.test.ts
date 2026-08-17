/**
 * Unit tests for `planPostgresStatements` — the helper that decides
 * which statements run inside the migration transaction and which run
 * outside of it under `--postgres-safe` mode.
 *
 * Issue #1165: shape-drift recreates and orphan-index cleanups emit
 * DROP INDEX statements. Earlier the tracker only rewrote CREATE INDEX
 * to CONCURRENTLY in safe mode and only routed CREATE … CONCURRENTLY
 * outside the transaction. DROP INDEX without CONCURRENTLY then ran
 * in-transaction with stronger locks (contradicting `--postgres-safe`
 * help text), and any DROP INDEX CONCURRENTLY arriving from a generated
 * migration file would error with "DROP INDEX CONCURRENTLY cannot run
 * inside a transaction block."
 */

import { describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import {
  buildConcurrentIndexPlan,
  extractCreatedIndexName,
  parsePostgresTimeoutMs,
  planPostgresStatements,
} from '../tracker.js';

function definition(id: string, up: string[]): MigrationDefinition {
  return { id, description: id, version: '1.0.0', up, down: [] };
}

describe('planPostgresStatements', () => {
  describe('without --postgres-safe (useConcurrentIndexes = false)', () => {
    it('routes pre-existing CONCURRENTLY statements outside the transaction', () => {
      const { concurrent, regular } = planPostgresStatements(
        [
          'CREATE INDEX CONCURRENTLY foo ON t (a)',
          'CREATE UNIQUE INDEX CONCURRENTLY bar ON t (a, b)',
          'DROP INDEX CONCURRENTLY baz',
          'REINDEX INDEX CONCURRENTLY idx_users_email',
          'CREATE INDEX qux ON t (c)',
          'DROP INDEX quux',
          'ALTER TABLE t ADD COLUMN x TEXT',
        ],
        false,
      );

      expect(concurrent).toEqual([
        'CREATE INDEX CONCURRENTLY foo ON t (a)',
        'CREATE UNIQUE INDEX CONCURRENTLY bar ON t (a, b)',
        'DROP INDEX CONCURRENTLY baz',
        'REINDEX INDEX CONCURRENTLY idx_users_email',
      ]);
      expect(regular).toEqual([
        'CREATE INDEX qux ON t (c)',
        'DROP INDEX quux',
        'ALTER TABLE t ADD COLUMN x TEXT',
      ]);
    });
  });

  describe('with --postgres-safe (useConcurrentIndexes = true)', () => {
    it('rewrites plain CREATE INDEX to CREATE INDEX CONCURRENTLY and routes outside transaction', () => {
      const { concurrent, regular } = planPostgresStatements(
        ['CREATE INDEX foo ON t (a)', 'CREATE UNIQUE INDEX bar ON t (b)'],
        true,
      );

      expect(concurrent).toEqual([
        'CREATE INDEX CONCURRENTLY foo ON t (a)',
        'CREATE UNIQUE INDEX CONCURRENTLY bar ON t (b)',
      ]);
      expect(regular).toEqual([]);
    });

    it('rewrites plain DROP INDEX to DROP INDEX CONCURRENTLY (issue #1165)', () => {
      // Without this rewrite, the auto-migrate path would run drops
      // inside the transaction, which contradicts the --postgres-safe
      // help text and risks stronger locks during the repair window.
      const { concurrent, regular } = planPostgresStatements(
        [
          'DROP INDEX IF EXISTS "tenants_slug_context_meta_type_idx"',
          'DROP INDEX my_orphan',
        ],
        true,
      );

      expect(concurrent).toEqual([
        'DROP INDEX CONCURRENTLY IF EXISTS "tenants_slug_context_meta_type_idx"',
        'DROP INDEX CONCURRENTLY my_orphan',
      ]);
      expect(regular).toEqual([]);
    });

    it('keeps already-CONCURRENTLY statements as-is', () => {
      const { concurrent, regular } = planPostgresStatements(
        [
          'DROP INDEX CONCURRENTLY IF EXISTS foo',
          'CREATE INDEX CONCURRENTLY bar ON t (a)',
        ],
        true,
      );

      expect(concurrent).toEqual([
        'DROP INDEX CONCURRENTLY IF EXISTS foo',
        'CREATE INDEX CONCURRENTLY bar ON t (a)',
      ]);
      expect(regular).toEqual([]);
    });

    it('leaves non-index statements in the transaction set', () => {
      const { concurrent, regular } = planPostgresStatements(
        [
          'ALTER TABLE t ADD COLUMN x TEXT',
          'UPDATE t SET x = NULL',
          'DROP INDEX foo',
        ],
        true,
      );

      expect(concurrent).toEqual(['DROP INDEX CONCURRENTLY foo']);
      expect(regular).toEqual([
        'ALTER TABLE t ADD COLUMN x TEXT',
        'UPDATE t SET x = NULL',
      ]);
    });

    it('preserves the per-statement order within each set', () => {
      // Within a set, the original input order must be preserved so
      // dependencies (e.g., a column add followed by a value migration)
      // run in the right sequence.
      const { regular } = planPostgresStatements(
        [
          'ALTER TABLE t ADD COLUMN x TEXT',
          "UPDATE t SET x = COALESCE(legacy, '')",
          'ALTER TABLE t ALTER COLUMN x SET NOT NULL',
        ],
        true,
      );

      expect(regular).toEqual([
        'ALTER TABLE t ADD COLUMN x TEXT',
        "UPDATE t SET x = COALESCE(legacy, '')",
        'ALTER TABLE t ALTER COLUMN x SET NOT NULL',
      ]);
    });

    it('places CONCURRENTLY before IF NOT EXISTS so the rewrite stays valid PostgreSQL (issue #2362)', () => {
      // The differ now emits `IF NOT EXISTS` so a retry after a partial batch
      // repairs rather than errors. PostgreSQL requires CONCURRENTLY to come
      // *before* IF NOT EXISTS, so the rewrite must not simply prepend.
      const { concurrent } = planPostgresStatements(
        [
          'CREATE INDEX IF NOT EXISTS "jobs_status_run_at_idx" ON "jobs" ("status", "run_at")',
          'CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email")',
        ],
        true,
      );

      expect(concurrent).toEqual([
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_status_run_at_idx" ON "jobs" ("status", "run_at")',
        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "users_email_idx" ON "users" ("email")',
      ]);
    });
  });
});

describe('buildConcurrentIndexPlan', () => {
  it('lists only the definitions that have work for the concurrent phase', () => {
    const plan = buildConcurrentIndexPlan(
      [
        definition('add_column_jobs_status', [
          'ALTER TABLE "jobs" ADD COLUMN "status" TEXT',
        ]),
        definition('add_index_jobs_status_idx', [
          'CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
        ]),
      ],
      true,
    );

    expect([...plan.keys()]).toEqual(['add_index_jobs_status_idx']);
    expect(plan.get('add_index_jobs_status_idx')).toEqual({
      regular: [],
      concurrent: [
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
      ],
    });
  });

  it('splits a create-table migration into its table DDL and its index DDL', () => {
    // `create_table_*` migrations carry the CREATE TABLE plus every index for
    // that table. The table must stay in the atomic transaction; the indexes
    // move to the concurrent phase.
    const plan = buildConcurrentIndexPlan(
      [
        definition('create_table_jobs', [
          'CREATE TABLE IF NOT EXISTS "jobs" ("id" TEXT PRIMARY KEY)',
          'CREATE INDEX IF NOT EXISTS "jobs_id_idx" ON "jobs" ("id")',
          'CREATE TRIGGER IF NOT EXISTS "jobs_touch" BEFORE UPDATE ON "jobs" BEGIN SELECT 1; END',
        ]),
      ],
      true,
    );

    expect(plan.get('create_table_jobs')).toEqual({
      regular: [
        'CREATE TABLE IF NOT EXISTS "jobs" ("id" TEXT PRIMARY KEY)',
        'CREATE TRIGGER IF NOT EXISTS "jobs_touch" BEFORE UPDATE ON "jobs" BEGIN SELECT 1; END',
      ],
      concurrent: [
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_id_idx" ON "jobs" ("id")',
      ],
    });
  });

  it('still defers explicit CONCURRENTLY DDL when the rewrite is disabled', () => {
    // `useConcurrentIndexes: false` (migrations.postgres.useConcurrently) must
    // not leave a statement PostgreSQL refuses to run in a transaction inside
    // the batch.
    const plan = buildConcurrentIndexPlan(
      [
        definition('drop_index_legacy', [
          'DROP INDEX CONCURRENTLY IF EXISTS "legacy_idx"',
        ]),
        definition('add_index_plain', [
          'CREATE INDEX IF NOT EXISTS "plain_idx" ON "t" ("a")',
        ]),
      ],
      false,
    );

    expect([...plan.keys()]).toEqual(['drop_index_legacy']);
  });

  it('returns an empty plan when nothing needs to leave the transaction', () => {
    const plan = buildConcurrentIndexPlan(
      [definition('add_column_t_a', ['ALTER TABLE "t" ADD COLUMN "a" TEXT'])],
      true,
    );

    expect(plan.size).toBe(0);
  });
});

describe('extractCreatedIndexName', () => {
  it.each([
    ['CREATE INDEX idx_plain ON t (a)', 'idx_plain'],
    ['CREATE UNIQUE INDEX "idx_quoted" ON "t" ("a")', 'idx_quoted'],
    [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_full" ON "t" ("a")',
      'idx_full',
    ],
    ['  create unique index concurrently idx_lower on t (a)', 'idx_lower'],
  ])('reads the index name from %s', (sql, expected) => {
    expect(extractCreatedIndexName(sql)).toBe(expected);
  });

  it('returns null for statements that do not create an index', () => {
    expect(extractCreatedIndexName('DROP INDEX CONCURRENTLY "idx"')).toBeNull();
    expect(
      extractCreatedIndexName('ALTER TABLE t ADD COLUMN a TEXT'),
    ).toBeNull();
    expect(
      extractCreatedIndexName('REINDEX INDEX CONCURRENTLY idx'),
    ).toBeNull();
  });
});

describe('parsePostgresTimeoutMs', () => {
  it.each([
    ['30s', 30_000],
    ['60s', 60_000],
    ['500ms', 500],
    ['2min', 120_000],
    ['2m', 120_000],
    ['1h', 3_600_000],
    ['750', 750],
    ['  15s  ', 15_000],
    ['1.5s', 1500],
  ])('parses %s', (value, expected) => {
    expect(parsePostgresTimeoutMs(value, 123)).toBe(expected);
  });

  it('accepts a number as milliseconds', () => {
    expect(parsePostgresTimeoutMs(4321, 123)).toBe(4321);
  });

  it('falls back rather than silently disabling the timeout on bad input', () => {
    // A `lock_timeout: 'forever'` typo must not become `SET lock_timeout = 0`.
    expect(parsePostgresTimeoutMs(undefined, 30_000)).toBe(30_000);
    expect(parsePostgresTimeoutMs('', 30_000)).toBe(30_000);
    expect(parsePostgresTimeoutMs('forever', 30_000)).toBe(30_000);
    expect(parsePostgresTimeoutMs('-5s', 30_000)).toBe(30_000);
    expect(parsePostgresTimeoutMs(Number.NaN, 30_000)).toBe(30_000);
  });

  it('preserves an explicit 0 (PostgreSQL: disabled)', () => {
    expect(parsePostgresTimeoutMs('0', 30_000)).toBe(0);
    expect(parsePostgresTimeoutMs(0, 30_000)).toBe(0);
  });
});
