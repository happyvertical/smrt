/**
 * MigrationTracker Tests
 *
 * Tests for migration state management, tracking, and execution.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import {
  computeChecksum,
  computeQuotedTextChecksum,
  verifyChecksum,
} from '../checksum.js';
import { createMigrationDefinition, MigrationGenerator } from '../generator.js';
import { MigrationTracker } from '../tracker.js';

describe('MigrationTracker', () => {
  let db: DatabaseInterface;
  let tracker: MigrationTracker;

  beforeEach(async () => {
    // Create fresh in-memory database for each test
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    tracker = new MigrationTracker({ db });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
      const result = await db.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='_smrt_schema_migrations'`,
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('_smrt_schema_migrations');
    });

    it('should be idempotent', async () => {
      await tracker.initialize();
      await tracker.initialize();

      // Should not throw
      const result = await db.query(
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
      const tables = await db.query(
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

    it('should force only migration IDs explicitly selected by the caller', async () => {
      const selectedV1: MigrationDefinition = {
        id: '0001_selected',
        description: 'Selected migration',
        version: '1.0.0',
        up: ['CREATE TABLE selected (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE selected;'],
      };
      const guardedV1: MigrationDefinition = {
        id: '0002_guarded',
        description: 'Guarded migration',
        version: '1.0.0',
        up: ['CREATE TABLE guarded (id TEXT PRIMARY KEY);'],
        down: ['DROP TABLE guarded;'],
      };

      await tracker.apply(selectedV1);
      await tracker.apply(guardedV1);

      const selectedResult = await tracker.apply(
        {
          ...selectedV1,
          up: ['CREATE TABLE IF NOT EXISTS selected (id TEXT);'],
        },
        { forceMigrations: ['0001_selected'] },
      );
      const guardedResult = await tracker.apply(
        { ...guardedV1, up: ['CREATE TABLE IF NOT EXISTS guarded (id TEXT);'] },
        { forceMigrations: ['0001_selected'] },
      );

      expect(selectedResult.success).toBe(true);
      expect(selectedResult.applied).toBe(true);
      expect(guardedResult.success).toBe(false);
      expect(guardedResult.error).toContain('checksum mismatch');
    });

    it('should not reconcile an unrelated failed migration during scoped force', async () => {
      const failed: MigrationDefinition = {
        id: '0001_failed_guarded',
        description: 'Guarded failed migration',
        version: '1.0.0',
        up: ['INVALID SQL'],
        down: [],
      };

      const first = await tracker.apply(failed);
      expect(first.success).toBe(false);

      const retry = await tracker.apply(
        { ...failed, up: ['CREATE TABLE guarded_retry (id TEXT);'] },
        {
          reconcile: true,
          forceMigrations: ['0002_selected'],
        },
      );

      expect(retry.success).toBe(false);
      expect(retry.error).toContain('previously failed');
    });

    it('refuses a reused id whose statement differs only inside a quoted string', async () => {
      await db.query('CREATE TABLE notes (id TEXT PRIMARY KEY, label TEXT)');
      const recorded: MigrationDefinition = {
        id: '0001_label_default',
        description: 'Fill the label',
        version: '1.0.0',
        up: ["UPDATE notes SET label = 'n/a--legacy' WHERE label IS NULL"],
        down: [],
      };
      expect((await tracker.apply(recorded)).success).toBe(true);

      const edited = {
        ...recorded,
        up: ["UPDATE notes SET label = 'n/a--v2' WHERE label IS NULL"],
      };
      const result = await tracker.apply(edited);

      expect(result.success).toBe(false);
      expect(result.error).toContain('checksum mismatch');
      expect(await tracker.detectDrift([edited])).toEqual([
        expect.objectContaining({
          migration_name: '0001_label_default',
          drift_type: 'file_modified',
        }),
      ]);
    });

    it('still recognises a migration an earlier release recorded, whatever its quoted text', async () => {
      await db.query('CREATE TABLE notes (id TEXT PRIMARY KEY, label TEXT)');
      const definition: MigrationDefinition = {
        id: '0001_label_spacing',
        description: 'Fill the label',
        version: '1.0.0',
        up: [
          "UPDATE notes SET label = 'two  spaces -- kept' WHERE label IS NULL",
        ],
        down: [],
      };
      // The row as an earlier release wrote it: its checksum came from
      // normalizing the quoted text as well.
      const earlier = computeChecksum(definition.up);
      expect(earlier).not.toBe(computeQuotedTextChecksum(definition.up));
      await tracker.initialize();
      await db.query(
        `INSERT INTO _smrt_schema_migrations
           (id, name, version, checksum, applied_checksum, status, attempts, is_reversible, batch)
         VALUES ('earlier-row', ?, '1.0.0', ?, ?, 'completed', 1, 0, 1)`,
        definition.id,
        earlier,
        earlier,
      );

      const result = await tracker.apply(definition);

      expect(result).toMatchObject({ success: true, skipped: true });
      expect(await tracker.detectDrift([definition])).toEqual([]);

      // The batch pre-check that selects what `apply` would run reads the
      // same record the same way, so it also leaves the definition out.
      const toRun = await (
        tracker as unknown as {
          definitionsToRun(
            definitions: MigrationDefinition[],
            options: Record<string, never>,
          ): Promise<MigrationDefinition[]>;
        }
      ).definitionsToRun([definition], {});
      expect(toRun).toEqual([]);
    });

    it.each([
      ['spaces gained', "SELECT 'two spaces'", "SELECT 'two  spaces'"],
      ['spaces lost', "SELECT 'two  spaces'", "SELECT 'two spaces'"],
      ['a backtick alias', 'SELECT 1 AS `a  b`', 'SELECT 1 AS `a b`'],
      ['a line ending', "SELECT 'a\r\nb'", "SELECT 'a\nb'"],
      [
        'a literal after a comment that never closes under nesting (SQLite ends it at the first close marker)',
        "UPDATE notes /* example /* marker */ SET label = 'old'",
        "UPDATE notes /* example /* marker */ SET label = 'new'",
      ],
      [
        'a literal after a comment holding a marker',
        "UPDATE notes /* -- why */ SET label = 'old'",
        "UPDATE notes /* -- why */ SET label = 'new'",
      ],
    ])('detects a reused id whose literal changed (%s) through the batch path, drift and the pre-check', async (_name, original, changed) => {
      await db.query('CREATE TABLE notes (id TEXT PRIMARY KEY, label TEXT)');
      const make = (literal: string): MigrationDefinition => ({
        id: '0001_literal',
        description: 'Literal',
        version: '1.0.0',
        up: [literal],
        down: [],
      });
      const first = await tracker.applyAll([make(original)]);
      expect(first[0]).toMatchObject({ success: true, applied: true });
      expect(first[0].checksum).toMatch(/^v2:/);

      const edited = make(changed);
      const again = await tracker.applyAll([edited]);
      expect(again[0].success).toBe(false);
      expect(again[0].error).toContain('checksum mismatch');
      expect(await tracker.detectDrift([edited])).toEqual([
        expect.objectContaining({ drift_type: 'file_modified' }),
      ]);
      const toRun = await (
        tracker as unknown as {
          definitionsToRun(
            definitions: MigrationDefinition[],
            options: Record<string, never>,
          ): Promise<MigrationDefinition[]>;
        }
      ).definitionsToRun([edited], {});
      expect(toRun).toEqual([edited]);
      // The unchanged definition is still skipped.
      expect((await tracker.applyAll([make(original)]))[0]).toMatchObject({
        success: true,
        skipped: true,
      });
    });

    it.each([
      [
        'a comment holding a stray open marker, closed by a marker in a later literal',
        "/* strip /* markers */ UPDATE notes SET kind = 'old', body = replace(body, '*/', '')",
        "/* strip /* markers */ UPDATE notes SET kind = 'new', body = replace(body, '*/', '')",
      ],
      [
        'a comment ending in a glob, with a later literal holding a close marker',
        "UPDATE notes /* old glob: /img/* */ SET kind = 'old*/logo.svg'",
        "UPDATE notes /* old glob: /img/* */ SET kind = 'new*/logo.svg'",
      ],
    ])('refuses a reused id whose literal changed after a comment that ends at its first close marker (%s), in both edit directions', async (_name, left, right) => {
      await db.query(
        'CREATE TABLE notes (id TEXT PRIMARY KEY, kind TEXT, body TEXT)',
      );
      for (const [recorded, edited] of [
        [left, right],
        [right, left],
      ]) {
        await db.query('DELETE FROM _smrt_schema_migrations');
        const make = (sql: string): MigrationDefinition => ({
          id: '0001_comment_end',
          description: 'Comment end',
          version: '1.0.0',
          up: [sql],
          down: [],
        });
        expect((await tracker.apply(make(recorded))).success).toBe(true);
        const result = await tracker.apply(make(edited));
        expect(result.success).toBe(false);
        expect(result.error).toContain('checksum mismatch');
        expect(await tracker.detectDrift([make(edited)])).toEqual([
          expect.objectContaining({ drift_type: 'file_modified' }),
        ]);
      }
    });

    it('refuses a reused id whose bracket identifier holding an open marker changed, in both edit directions', async () => {
      const make = (sql: string): MigrationDefinition => ({
        id: '0001_bracket_marker',
        description: 'Bracket marker',
        version: '1.0.0',
        up: [sql],
        down: [],
      });
      const left = 'ALTER TABLE t RENAME COLUMN [a/*b] TO c';
      const right = 'ALTER TABLE t RENAME COLUMN [a/*b] TO d';
      for (const [recorded, edited] of [
        [left, right],
        [right, left],
      ]) {
        await db.query('DROP TABLE IF EXISTS t');
        await db.query('DELETE FROM _smrt_schema_migrations');
        await db.query('CREATE TABLE t ("a/*b" TEXT)');
        expect((await tracker.apply(make(recorded))).success).toBe(true);
        const result = await tracker.apply(make(edited));
        expect(result.success).toBe(false);
        expect(result.error).toContain('checksum mismatch');
        expect(await tracker.detectDrift([make(edited)])).toEqual([
          expect.objectContaining({ drift_type: 'file_modified' }),
        ]);
      }
    });

    it('keeps the checksum of an earlier record when reconcile or force runs it again', async () => {
      const definition: MigrationDefinition = {
        id: '0001_label_spacing_again',
        description: 'Select',
        version: '1.0.0',
        up: ["SELECT 'two  spaces'"],
        down: [],
      };
      const earlier = computeChecksum(definition.up);
      await tracker.initialize();
      await db.query(
        `INSERT INTO _smrt_schema_migrations
           (id, name, version, checksum, applied_checksum, status, attempts, is_reversible, batch)
         VALUES ('earlier-row-2', ?, '1.0.0', ?, ?, 'completed', 1, 0, 1)`,
        definition.id,
        earlier,
        earlier,
      );
      for (const options of [{ reconcile: true }, { force: true }]) {
        const result = await tracker.apply(definition, options);
        expect(result.success).toBe(true);
        expect(result.checksum).toBe(earlier);
        const row = await tracker.getMigration(definition.id);
        expect(row?.checksum).toBe(earlier);
        expect(row?.applied_checksum).toBe(earlier);
      }
      expect(await tracker.detectDrift([definition])).toEqual([]);
    });

    it('keeps an earlier record in its own form when a forced edit changes its statements', async () => {
      const original: MigrationDefinition = {
        id: '0001_forced_edit',
        description: 'Select',
        version: '1.0.0',
        up: ["SELECT 'two  spaces'"],
        down: [],
      };
      const edited = { ...original, up: ["SELECT 'three   spaces'"] };
      const earlier = computeChecksum(original.up);
      await tracker.initialize();
      await db.query(
        `INSERT INTO _smrt_schema_migrations
           (id, name, version, checksum, applied_checksum, status, attempts, is_reversible, batch)
         VALUES ('earlier-row-3', ?, '1.0.0', ?, ?, 'completed', 1, 0, 1)`,
        original.id,
        earlier,
        earlier,
      );
      // Without force the edit is refused and the record is untouched.
      expect((await tracker.apply(edited)).success).toBe(false);
      expect((await tracker.getMigration(original.id))?.checksum).toBe(earlier);

      const forced = await tracker.apply(edited, { force: true });
      expect(forced.success).toBe(true);
      const row = await tracker.getMigration(original.id);
      // Still an earlier-form digest, now of the edited statements, so a build
      // that predates the prefix reads the same definition as unmodified.
      expect(row?.checksum).toBe(computeChecksum(edited.up));
      expect(row?.checksum).not.toMatch(/^v2:/);
      expect(row?.applied_checksum).toBe(row?.checksum);
      expect(
        verifyChecksum(
          computeChecksum(edited.up),
          row?.checksum as string,
          row?.applied_checksum,
        ),
      ).toEqual({ valid: true });
      expect(await tracker.detectDrift([edited])).toEqual([]);
    });

    it('records a new migration in the current form and a generated migration advertises the same value', async () => {
      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: false,
      });
      const generated = generator.generateFromSQL(
        ["UPDATE notes SET label = 'two  spaces' WHERE label IS NULL"],
        [],
        { name: '0002_generated', description: 'Generated' },
      );
      await db.query('CREATE TABLE notes (id TEXT PRIMARY KEY, label TEXT)');
      const result = await tracker.apply(
        createMigrationDefinition(generated.id, generated.up, generated.down, {
          version: '1.0.0',
        }),
      );
      expect(result.success).toBe(true);
      expect(result.checksum).toBe(generated.checksum);
      expect((await tracker.getMigration('0002_generated'))?.checksum).toBe(
        generated.checksum,
      );
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
      const tables = await db.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'profiles')`,
      );
      expect(tables.rows).toHaveLength(2);

      const indexes = await db.query(
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

      const tables = await db.query(
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

      const tables = await db.query(
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
      const tables = await db.query(
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

    it('should block an unrelated running migration during scoped force', async () => {
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, attempts, is_reversible, batch)
         VALUES ('scoped-stuck-id', '0001_scoped_stuck', '1.0.0', 'abc123', 'running', 1, 0, 1)`,
      );

      const result = await tracker.apply(
        {
          id: '0001_scoped_stuck',
          description: 'Scoped stuck migration',
          version: '1.0.0',
          up: ['SELECT 1;'],
          down: [],
        },
        {
          reconcile: true,
          forceMigrations: ['0002_selected'],
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('currently running or was interrupted');
      expect(result.error).toContain('--force-migration 0001_scoped_stuck');
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
      expect(results[0].rolled_back).toBe(true);
      expect(results[0].error).toBeInstanceOf(Error);
      expect(String(results[0].error)).toContain(
        'Rolled back because migration 0002_atomic_bad_sql failed',
      );
      expect(results[1].success).toBe(false);

      const tables = await db.query(
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
          // Without concurrent-index mode (issue #2362) there is nowhere for a
          // CONCURRENTLY statement to run, so the batch must refuse up front.
          { atomic: true, postgresSafe: false },
        ),
      ).rejects.toThrow(/cannot include CONCURRENTLY index DDL/);
    });

    it('rejects explicit Postgres REINDEX CONCURRENTLY DDL before starting an atomic batch', async () => {
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
              id: '0001_concurrent_reindex',
              description: 'Concurrent reindex',
              version: '1.0.0',
              up: ['REINDEX INDEX CONCURRENTLY idx_atomic_name;'],
              down: [],
            },
          ],
          { atomic: true },
        ),
      ).rejects.toThrow(/cannot include CONCURRENTLY index DDL/);
    });

    it('reports failed-status persistence errors without hiding the migration failure', async () => {
      const originalQuery = db.query.bind(db);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (db as any).query = async (sql: string, ...params: unknown[]) => {
        if (sql.includes("SET status = 'failed'")) {
          throw new Error('failed-status write failed');
        }

        return originalQuery(sql, ...params);
      };

      const result = await tracker.apply({
        id: '0001_bad_sql',
        description: 'Bad SQL',
        version: '1.0.0',
        up: ['THIS IS NOT VALID SQL;'],
        down: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(String(result.error)).toContain('Failed to execute raw query');
      expect(errorSpy.mock.calls.flat().join('\n')).toContain(
        'Failed to persist failed status for migration 0001_bad_sql: failed-status write failed',
      );
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
      const tables = await db.query(
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

describe('MigrationTracker engine detection', () => {
  // A PGlite handle opened at a data directory has a path for a URL. With no
  // hint, the tracker must read it as PostgreSQL, as the system-table checks
  // do (`getDatabaseEngine`); reading it as SQLite created SQLite-typed
  // timestamps that the PostgreSQL timestamp check then refused.
  it('reads a handle that speaks PostgreSQL as PostgreSQL when no hint is given', () => {
    const db = {
      url: '/tmp/app/pg-data',
      client: { query: async () => ({ rows: [] }), exec: async () => [] },
      query: async () => ({ rows: [] }),
    } as unknown as DatabaseInterface;
    expect(new MigrationTracker({ db }).getEngine()).toBe('postgres');
    expect(new MigrationTracker({ db, engineHint: 'sqlite' }).getEngine()).toBe(
      'sqlite',
    );
  });

  it('still reads a plain SQLite file as SQLite', () => {
    const db = {
      url: '/tmp/app/live.db',
      query: async () => ({ rows: [] }),
    } as unknown as DatabaseInterface;
    expect(new MigrationTracker({ db }).getEngine()).toBe('sqlite');
  });
});
