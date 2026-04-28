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
import { planPostgresStatements } from '../tracker.js';

describe('planPostgresStatements', () => {
  describe('without --postgres-safe (useConcurrentIndexes = false)', () => {
    it('routes pre-existing CONCURRENTLY statements outside the transaction', () => {
      const { concurrent, regular } = planPostgresStatements(
        [
          'CREATE INDEX CONCURRENTLY foo ON t (a)',
          'CREATE UNIQUE INDEX CONCURRENTLY bar ON t (a, b)',
          'DROP INDEX CONCURRENTLY baz',
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
  });
});
