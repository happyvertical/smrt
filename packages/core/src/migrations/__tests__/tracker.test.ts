/**
 * MigrationTracker Tests
 *
 * Tests for migration state management, tracking, and execution.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import { MigrationTracker } from '../tracker.js';

describe('MigrationTracker', () => {
  let db: DatabaseProvider;
  let tracker: MigrationTracker;

  beforeEach(async () => {
    // Create fresh in-memory database for each test
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    tracker = new MigrationTracker({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  describe('initialize', () => {
    it('should create migrations table on first run', async () => {
      await tracker.initialize();

      // Verify table exists
      const result = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='_smrt_schema_migrations'`,
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('_smrt_schema_migrations');
    });

    it('should be idempotent', async () => {
      await tracker.initialize();
      await tracker.initialize();

      // Should not throw
      const result = await db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='_smrt_schema_migrations'`,
      );

      expect(result.rows[0].count).toBe(1);
    });
  });

  describe('getAppliedMigrations', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('should return empty array when no migrations applied', async () => {
      const applied = await tracker.getAppliedMigrations();

      expect(applied).toEqual([]);
    });

    it('should return applied migrations', async () => {
      // Insert a migration directly
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, applied_at, batch)
         VALUES ('uuid-1', '0001_initial', '1.0.0', 'abc123', 'completed', datetime('now'), 1)`,
      );

      const applied = await tracker.getAppliedMigrations();

      expect(applied).toHaveLength(1);
      expect(applied[0].name).toBe('0001_initial');
    });
  });

  describe('apply', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('should apply a simple migration', async () => {
      const migration: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);'],
        down: ['DROP TABLE users;'],
      };

      const result = await tracker.apply(migration);

      expect(result.success).toBe(true);
      expect(result.applied).toBe(true);

      // Verify table was created
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
      );
      expect(tables.rows).toHaveLength(1);

      // Verify migration was recorded
      const applied = await tracker.getAppliedMigrations();
      expect(applied).toHaveLength(1);
      expect(applied[0].name).toBe('0001_create_users');
    });

    it('should skip already applied migration by checksum', async () => {
      const migration: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE users;'],
      };

      // Apply first time
      const result1 = await tracker.apply(migration);
      expect(result1.success).toBe(true);
      expect(result1.applied).toBe(true);

      // Apply second time - should skip
      const result2 = await tracker.apply(migration);
      expect(result2.success).toBe(true);
      expect(result2.applied).toBe(false);
      expect(result2.skipped).toBe(true);
    });

    it('should detect checksum mismatch', async () => {
      const migration1: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE users;'],
      };

      await tracker.apply(migration1);

      // Try to apply with different content
      const migration2: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);'], // Different!
        down: ['DROP TABLE users;'],
      };

      const result = await tracker.apply(migration2);

      expect(result.success).toBe(false);
      expect(result.error).toContain('checksum mismatch');
    });

    it('should still block checksum mismatches during reconcile', async () => {
      const migration1: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE users;'],
      };

      await tracker.apply(migration1);

      const migration2: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);'],
        down: ['DROP TABLE users;'],
      };

      const result = await tracker.apply(migration2, { reconcile: true });

      expect(result.success).toBe(false);
      expect(result.error).toContain('checksum mismatch');
    });

    it('should allow reconcile to re-run a completed checksum-matching migration', async () => {
      const migration: MigrationDefinition = {
        id: '0001_reconcile',
        description: 'Reconcile test',
        version: '1.0.0',
        up: [
          'CREATE TABLE IF NOT EXISTS reconcile_test (id TEXT PRIMARY KEY);',
        ],
        down: ['DROP TABLE reconcile_test;'],
      };

      const first = await tracker.apply(migration);
      expect(first.success).toBe(true);
      expect(first.applied).toBe(true);

      const second = await tracker.apply(migration, { reconcile: true });

      expect(second.success).toBe(true);
      expect(second.applied).toBe(true);
      expect(second.skipped).toBe(false);

      const history = await tracker.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].attempts).toBe(2);
      expect(history[0].status).toBe('completed');
    });

    it('should record migration with correct metadata', async () => {
      const migration: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE users;'],
      };

      await tracker.apply(migration);

      const history = await tracker.getHistory();

      expect(history).toHaveLength(1);
      expect(history[0].name).toBe('0001_create_users');
      expect(history[0].version).toBe('1.0.0');
      expect(history[0].status).toBe('completed');
      expect(history[0].checksum).toBeDefined();
      expect(history[0].is_reversible).toBe(true);
    });

    it('should handle migration with multiple statements', async () => {
      const migration: MigrationDefinition = {
        id: '0001_initial',
        description: 'Initial schema',
        version: '1.0.0',
        up: [
          'CREATE TABLE users (id TEXT PRIMARY KEY);',
          'CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT);',
          'CREATE INDEX idx_profiles_user ON profiles(user_id);',
        ],
        down: [
          'DROP INDEX idx_profiles_user;',
          'DROP TABLE profiles;',
          'DROP TABLE users;',
        ],
      };

      const result = await tracker.apply(migration);

      expect(result.success).toBe(true);

      // Verify all statements executed
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'profiles')`,
      );
      expect(tables.rows).toHaveLength(2);

      const indexes = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_profiles_user'`,
      );
      expect(indexes.rows).toHaveLength(1);
    });

    it('should record failed migration', async () => {
      const migration: MigrationDefinition = {
        id: '0001_bad_sql',
        description: 'Bad SQL',
        version: '1.0.0',
        up: ['THIS IS NOT VALID SQL;'],
        down: [],
      };

      const result = await tracker.apply(migration);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Migration should be recorded as failed
      const history = await tracker.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('failed');
      expect(history[0].error_message).toBeDefined();
    });

    it('should block retry of failed migration without --force', async () => {
      const migration: MigrationDefinition = {
        id: '0001_bad_sql',
        description: 'Bad SQL',
        version: '1.0.0',
        up: ['THIS IS NOT VALID SQL;'],
        down: [],
      };

      // First attempt fails
      await tracker.apply(migration);

      // Second attempt without --force should fail with clear error
      const result = await tracker.apply(migration);

      expect(result.success).toBe(false);
      expect(result.error).toContain('previously failed');
      expect(result.error).toContain('--force');
    });

    it('should retry failed migrations during reconcile', async () => {
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, attempts, is_reversible, batch, error_message)
         VALUES ('failed-id', '0001_failed_reconcile', '1.0.0', 'old-checksum', 'failed', 1, 0, 1, 'previous failure')`,
      );

      const migration: MigrationDefinition = {
        id: '0001_failed_reconcile',
        description: 'Failed reconcile',
        version: '1.0.0',
        up: ['CREATE TABLE failed_reconcile_test (id TEXT PRIMARY KEY);'],
        down: [],
      };

      const result = await tracker.apply(migration, { reconcile: true });

      expect(result.success).toBe(true);
      expect(result.applied).toBe(true);

      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='failed_reconcile_test'`,
      );
      expect(tables.rows).toHaveLength(1);

      const history = await tracker.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('completed');
      expect(history[0].attempts).toBe(2);
    });

    it('should not mutate migration history during dry-run', async () => {
      const migration: MigrationDefinition = {
        id: '0001_dry_run_existing',
        description: 'Dry-run existing migration',
        version: '1.0.0',
        up: ['CREATE TABLE dry_run_existing (id TEXT PRIMARY KEY);'],
        down: [],
      };

      const applied = await tracker.apply(migration);
      expect(applied.success).toBe(true);

      const [before] = await tracker.getHistory();
      const dryRun = await tracker.apply(migration, {
        dryRun: true,
        reconcile: true,
      });
      const [after] = await tracker.getHistory();

      expect(dryRun.success).toBe(true);
      expect(dryRun.applied).toBe(false);
      expect(after.status).toBe(before.status);
      expect(after.checksum).toBe(before.checksum);
      expect(after.attempts).toBe(before.attempts);
      expect(after.batch).toBe(before.batch);
      expect(after.applied_by).toBe(before.applied_by);
      expect(after.applied_at.toISOString()).toBe(
        before.applied_at.toISOString(),
      );
    });

    it('should not create migration records during dry-run', async () => {
      const migration: MigrationDefinition = {
        id: '0001_dry_run_new',
        description: 'Dry-run new migration',
        version: '1.0.0',
        up: ['CREATE TABLE dry_run_new (id TEXT PRIMARY KEY);'],
        down: [],
      };

      const dryRun = await tracker.apply(migration, { dryRun: true });

      expect(dryRun.success).toBe(true);
      expect(dryRun.applied).toBe(false);
      expect(await tracker.getHistory()).toHaveLength(0);

      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='dry_run_new'`,
      );
      expect(tables.rows).toHaveLength(0);
    });

    it('should allow retry of failed migration with --force', async () => {
      // First, create a migration that will fail
      const badMigration: MigrationDefinition = {
        id: '0001_retry_test',
        description: 'Retry test',
        version: '1.0.0',
        up: ['THIS IS NOT VALID SQL;'],
        down: [],
      };

      // First attempt fails
      const result1 = await tracker.apply(badMigration);
      expect(result1.success).toBe(false);

      // Now fix the migration and retry with --force
      const goodMigration: MigrationDefinition = {
        id: '0001_retry_test',
        description: 'Retry test',
        version: '1.0.0',
        up: ['CREATE TABLE retry_test (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE retry_test;'],
      };

      const result2 = await tracker.apply(goodMigration, { force: true });

      expect(result2.success).toBe(true);
      expect(result2.applied).toBe(true);

      // Verify table was created
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='retry_test'`,
      );
      expect(tables.rows).toHaveLength(1);

      // Verify migration status is now completed
      const history = await tracker.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('completed');
      expect(history[0].attempts).toBe(2);
    });

    it('should block apply when migration is in running state without --force', async () => {
      // Manually insert a 'running' migration to simulate a crashed run
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, attempts, is_reversible, batch)
         VALUES ('stuck-id', '0001_stuck', '1.0.0', 'abc123', 'running', 1, 0, 1)`,
      );

      const migration: MigrationDefinition = {
        id: '0001_stuck',
        description: 'Stuck migration',
        version: '1.0.0',
        up: ['SELECT 1;'],
        down: [],
      };

      const result = await tracker.apply(migration);

      expect(result.success).toBe(false);
      expect(result.error).toContain('currently running or was interrupted');
      expect(result.error).toContain('--force');
    });

    it('should block running migrations during reconcile without --force', async () => {
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, attempts, is_reversible, batch)
         VALUES ('stuck-id', '0001_stuck', '1.0.0', 'abc123', 'running', 1, 0, 1)`,
      );

      const migration: MigrationDefinition = {
        id: '0001_stuck',
        description: 'Stuck migration',
        version: '1.0.0',
        up: ['SELECT 1;'],
        down: [],
      };

      const result = await tracker.apply(migration, { reconcile: true });

      expect(result.success).toBe(false);
      expect(result.error).toContain('currently running or was interrupted');
      expect(result.error).toContain('--force');
    });

    it('should allow re-applying rolled back migration without --force', async () => {
      const migration: MigrationDefinition = {
        id: '0001_reapply',
        description: 'Reapply test',
        version: '1.0.0',
        up: ['CREATE TABLE reapply_test (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE reapply_test;'],
      };

      // Apply
      await tracker.apply(migration);

      // Rollback
      await tracker.rollback('0001_reapply', migration);

      // Re-apply without --force should work
      const result = await tracker.apply(migration);

      expect(result.success).toBe(true);
      expect(result.applied).toBe(true);

      // Verify migration is completed
      const history = await tracker.getHistory({ status: 'completed' });
      expect(history).toHaveLength(1);
    });
  });

  describe('applyAll', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('should roll back prior migrations in an atomic batch when a later migration fails', async () => {
      const migrations: MigrationDefinition[] = [
        {
          id: '0001_atomic_first',
          description: 'First migration',
          version: '1.0.0',
          up: ['CREATE TABLE atomic_first (id TEXT PRIMARY KEY);'],
          down: [],
        },
        {
          id: '0002_atomic_bad_sql',
          description: 'Bad SQL',
          version: '1.0.0',
          up: ['THIS IS NOT VALID SQL;'],
          down: [],
        },
      ];

      const results = await tracker.applyAll(migrations, { atomic: true });

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBeInstanceOf(Error);
      expect(String(results[0].error)).toContain(
        'Rolled back because migration 0002_atomic_bad_sql failed',
      );
      expect(results[1].success).toBe(false);

      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='atomic_first'`,
      );
      expect(tables.rows).toHaveLength(0);

      const history = await tracker.getHistory();
      expect(history).toHaveLength(0);
    });

    it('rejects explicit Postgres CONCURRENTLY index DDL before starting an atomic batch', async () => {
      const postgresTracker = new MigrationTracker({
        db: {
          url: 'postgresql://test:test@localhost:5432/test',
          query: async () => ({ rows: [] }),
          transaction: async () => {
            throw new Error('transaction should not start');
          },
        } as any,
      });

      await expect(
        postgresTracker.applyAll(
          [
            {
              id: '0001_concurrent_index',
              description: 'Concurrent index',
              version: '1.0.0',
              up: [
                'CREATE INDEX CONCURRENTLY idx_atomic_name ON atomic_first (name);',
              ],
              down: [],
            },
          ],
          { atomic: true, postgresSafe: true },
        ),
      ).rejects.toThrow(/cannot include CONCURRENTLY index DDL/);
    });
  });

  describe('rollback', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('should rollback a migration', async () => {
      const migration: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE users;'],
      };

      // Apply first
      await tracker.apply(migration);

      // Rollback
      const result = await tracker.rollback('0001_create_users', migration);

      expect(result.success).toBe(true);

      // Verify table was dropped
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
      );
      expect(tables.rows).toHaveLength(0);

      // Verify migration status updated
      const history = await tracker.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('rolled_back');
    });

    it('should fail rollback for migration without down script', async () => {
      const migration: MigrationDefinition = {
        id: '0001_create_users',
        description: 'Create users table',
        version: '1.0.0',
        up: ['CREATE TABLE users (id TEXT PRIMARY KEY);'],
        down: [], // No down script
      };

      await tracker.apply(migration);

      const result = await tracker.rollback('0001_create_users', migration);

      // Should fail since there's no down script
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('getHistory', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('should return migrations in reverse chronological order', async () => {
      const migration1: MigrationDefinition = {
        id: '0001_first',
        description: 'First',
        version: '1.0.0',
        up: ['SELECT 1;'],
        down: [],
      };

      const migration2: MigrationDefinition = {
        id: '0002_second',
        description: 'Second',
        version: '1.0.0',
        up: ['SELECT 2;'],
        down: [],
      };

      await tracker.apply(migration1);
      await tracker.apply(migration2);

      const history = await tracker.getHistory();

      expect(history).toHaveLength(2);
      expect(history[0].name).toBe('0002_second'); // Most recent first
      expect(history[1].name).toBe('0001_first');
    });

    it('should respect limit option', async () => {
      for (let i = 1; i <= 5; i++) {
        await tracker.apply({
          id: `000${i}_migration`,
          description: `Migration ${i}`,
          version: '1.0.0',
          up: [`SELECT ${i};`],
          down: [],
        });
      }

      const history = await tracker.getHistory({ limit: 3 });

      expect(history).toHaveLength(3);
    });

    it('should filter by status', async () => {
      const migration: MigrationDefinition = {
        id: '0001_test',
        description: 'Test',
        version: '1.0.0',
        up: ['CREATE TABLE test (id TEXT);'],
        down: ['DROP TABLE test;'],
      };

      await tracker.apply(migration);
      await tracker.rollback('0001_test', migration);

      const completedOnly = await tracker.getHistory({ status: 'completed' });
      const rolledBackOnly = await tracker.getHistory({
        status: 'rolled_back',
      });

      expect(completedOnly).toHaveLength(0);
      expect(rolledBackOnly).toHaveLength(1);
    });
  });

  describe('isApplied', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('should return true for applied migration', async () => {
      const migration: MigrationDefinition = {
        id: '0001_test',
        description: 'Test',
        version: '1.0.0',
        up: ['SELECT 1;'],
        down: [],
      };

      await tracker.apply(migration);

      const isApplied = await tracker.isApplied('0001_test');

      expect(isApplied).toBe(true);
    });

    it('should return false for unapplied migration', async () => {
      const isApplied = await tracker.isApplied('0001_test');

      expect(isApplied).toBe(false);
    });

    it('should return false for rolled back migration', async () => {
      const migration: MigrationDefinition = {
        id: '0001_test',
        description: 'Test',
        version: '1.0.0',
        up: ['CREATE TABLE test (id TEXT);'],
        down: ['DROP TABLE test;'],
      };

      await tracker.apply(migration);
      await tracker.rollback('0001_test', migration);

      const isApplied = await tracker.isApplied('0001_test');

      expect(isApplied).toBe(false);
    });
  });
});
