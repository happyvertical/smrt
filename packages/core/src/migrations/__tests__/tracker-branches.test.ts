/**
 * MigrationTracker branch coverage.
 *
 * tracker.test.ts covers initialize/apply/applyAll(atomic)/rollback/getHistory
 * happy paths. This file targets the gaps:
 * - getEngine / detectDbEngine via config.url + engineHint
 * - getPendingMigrations filtering
 * - detectDrift: unknown_in_db, file_modified, and db_modified reports
 * - getNextBatch incrementing from existing rows
 * - rollback: not-found, not-completed, and dry-run early returns
 * - executeStatements fallbacks: no-transaction sequential, postgres safe mode
 *   (regular-in-transaction + CONCURRENTLY outside), and postgres no-transaction.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import { computeChecksum } from '../checksum.js';
import { MigrationTracker } from '../tracker.js';

describe('MigrationTracker engine detection', () => {
  it('reads the URL from db.config when db.url is empty', () => {
    const tracker = new MigrationTracker({
      db: {
        url: '',
        config: { url: 'postgres://localhost/test' },
        query: async () => ({ rows: [] }),
      } as any,
    });
    expect(tracker.getEngine()).toBe('postgres');
  });

  it('honors an explicit engineHint over URL parsing', () => {
    const tracker = new MigrationTracker({
      db: { url: '', query: async () => ({ rows: [] }) } as any,
      engineHint: 'postgres',
    });
    expect(tracker.getEngine()).toBe('postgres');
  });
});

describe('MigrationTracker on real SQLite', () => {
  let db: DatabaseProvider;
  let tracker: MigrationTracker;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    tracker = new MigrationTracker({ db });
    await tracker.initialize();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // ignore
      }
    }
  });

  it('getPendingMigrations returns only unapplied definitions', async () => {
    const applied: MigrationDefinition = {
      id: '0001_applied',
      description: 'a',
      version: '1.0.0',
      up: ['CREATE TABLE applied_t (id TEXT);'],
      down: [],
    };
    const pending: MigrationDefinition = {
      id: '0002_pending',
      description: 'b',
      version: '1.0.0',
      up: ['CREATE TABLE pending_t (id TEXT);'],
      down: [],
    };

    await tracker.apply(applied);
    const result = await tracker.getPendingMigrations([applied, pending]);

    expect(result.map((d) => d.id)).toEqual(['0002_pending']);
  });

  it('getNextBatch increments from the highest existing batch', async () => {
    await db.query(
      `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, batch)
       VALUES ('x', '0001_x', '1.0.0', 'c', 'completed', 7)`,
    );
    expect(await tracker.getNextBatch()).toBe(8);
  });

  it('getMigration returns null for an unknown migration', async () => {
    expect(await tracker.getMigration('nope')).toBeNull();
  });

  describe('detectDrift', () => {
    it('reports unknown_in_db when an applied migration has no definition', async () => {
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, applied_at, batch)
         VALUES ('id-1', '0001_orphan', '1.0.0', 'abc', 'completed', datetime('now'), 1)`,
      );

      const reports = await tracker.detectDrift([]);
      expect(reports).toHaveLength(1);
      expect(reports[0].drift_type).toBe('unknown_in_db');
      expect(reports[0].migration_name).toBe('0001_orphan');
    });

    it('reports file_modified when the definition checksum no longer matches', async () => {
      const original = ['CREATE TABLE drift_t (id TEXT);'];
      const recordedChecksum = computeChecksum(original);
      // applied_checksum equal to recorded -> DB untouched, so a definition
      // change classifies as file_modified.
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, applied_checksum, status, applied_at, batch)
         VALUES ('id-1', '0001_drift', '1.0.0', ?, ?, 'completed', datetime('now'), 1)`,
        recordedChecksum,
        recordedChecksum,
      );

      const reports = await tracker.detectDrift([
        {
          id: '0001_drift',
          description: 'changed',
          version: '1.0.0',
          up: ['CREATE TABLE drift_t (id TEXT, extra TEXT);'], // changed!
          down: [],
        },
      ]);

      expect(reports).toHaveLength(1);
      expect(reports[0].drift_type).toBe('file_modified');
      expect(reports[0].recommendation).toContain('Create a new migration');
    });

    it('reports db_modified when the applied checksum diverges from the recorded one', async () => {
      const def: MigrationDefinition = {
        id: '0001_dbdrift',
        description: 'x',
        version: '1.0.0',
        up: ['CREATE TABLE dbdrift_t (id TEXT);'],
        down: [],
      };
      const defChecksum = computeChecksum(def.up);

      // checksum matches the definition, but applied_checksum differs ->
      // the database was modified outside migrations.
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, applied_checksum, status, applied_at, batch)
         VALUES ('id-1', '0001_dbdrift', '1.0.0', ?, 'different-applied', 'completed', datetime('now'), 1)`,
        defChecksum,
      );

      const reports = await tracker.detectDrift([def]);
      expect(reports).toHaveLength(1);
      expect(reports[0].drift_type).toBe('db_modified');
      expect(reports[0].recommendation).toContain('reconcile manually');
    });

    it('returns no reports when checksums all match', async () => {
      const def: MigrationDefinition = {
        id: '0001_clean',
        description: 'x',
        version: '1.0.0',
        up: ['CREATE TABLE clean_t (id TEXT);'],
        down: [],
      };
      await tracker.apply(def);
      expect(await tracker.detectDrift([def])).toHaveLength(0);
    });
  });

  describe('rollback early returns', () => {
    it('fails when the migration is not in the database', async () => {
      const result = await tracker.rollback('0001_ghost', {
        id: '0001_ghost',
        description: 'x',
        version: '1.0.0',
        up: ['SELECT 1;'],
        down: ['SELECT 1;'],
      });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('not found in database');
    });

    it('fails when the migration is not in completed state', async () => {
      await db.query(
        `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, batch)
         VALUES ('id-1', '0001_failed', '1.0.0', 'c', 'failed', 1)`,
      );
      const result = await tracker.rollback('0001_failed', {
        id: '0001_failed',
        description: 'x',
        version: '1.0.0',
        up: ['SELECT 1;'],
        down: ['SELECT 1;'],
      });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('not in completed state');
    });

    it('returns success without executing during a dry-run rollback', async () => {
      const def: MigrationDefinition = {
        id: '0001_dryroll',
        description: 'x',
        version: '1.0.0',
        up: ['CREATE TABLE dryroll_t (id TEXT);'],
        down: ['DROP TABLE dryroll_t;'],
      };
      await tracker.apply(def);

      const result = await tracker.rollback('0001_dryroll', def, {
        dryRun: true,
      });
      expect(result.success).toBe(true);
      expect(result.rolled_back).toBe(true);

      // Table still exists; status unchanged.
      expect(await db.tableExists('dryroll_t')).toBe(true);
      const [record] = await tracker.getHistory();
      expect(record.status).toBe('completed');
    });

    it('reports a failed rollback when a DOWN statement errors', async () => {
      const def: MigrationDefinition = {
        id: '0001_badroll',
        description: 'x',
        version: '1.0.0',
        up: ['CREATE TABLE badroll_t (id TEXT);'],
        down: ['DROP TABLE does_not_exist_xyz;'],
      };
      await tracker.apply(def);

      const result = await tracker.rollback('0001_badroll', def);
      expect(result.success).toBe(false);
      expect(result.rolled_back).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    });
  });
});

describe('MigrationTracker statement execution fallbacks', () => {
  it('executes sequentially when the adapter has no transaction support', async () => {
    const executed: string[] = [];
    const db = {
      url: 'sqlite::memory:',
      // No `transaction` method -> sequential fallback.
      query: async (sql: string) => {
        executed.push(sql);
        return { rows: [] };
      },
    } as any;

    const tracker = new MigrationTracker({ db });
    const result = await tracker.apply({
      id: '0001_seq',
      description: 'x',
      version: '1.0.0',
      up: [
        'CREATE TABLE seq_t (id TEXT);',
        'CREATE INDEX idx_seq ON seq_t(id);',
      ],
      down: [],
    });

    expect(result.success).toBe(true);
    // Both migration statements ran via direct query (no transaction wrapper).
    expect(executed).toContain('CREATE TABLE seq_t (id TEXT);');
    expect(executed).toContain('CREATE INDEX idx_seq ON seq_t(id);');
  });

  it('routes CONCURRENTLY index DDL outside the transaction in postgres safe mode', async () => {
    const insideTx: string[] = [];
    const outsideTx: string[] = [];
    let txCalls = 0;

    // Records which statements run inside db.transaction() vs direct db.query().
    const db: any = {
      url: 'postgres://localhost/test',
      query: async (sql: string) => {
        outsideTx.push(sql);
        return { rows: [] };
      },
      transaction: async (cb: (tx: any) => Promise<unknown>) => {
        txCalls++;
        const tx = {
          query: async (sql: string) => {
            insideTx.push(sql);
            return { rows: [] };
          },
        };
        return cb(tx);
      },
    };
    // getMigration / status writes go through db.query too; filter them out
    // by tagging migration DDL distinctly below.

    const tracker = new MigrationTracker({ db, useConcurrentIndexes: true });

    const result = await tracker.apply(
      {
        id: '0001_pg_safe',
        description: 'x',
        version: '1.0.0',
        up: ['ALTER TABLE t ADD COLUMN c TEXT', 'CREATE INDEX idx_pg ON t (c)'],
        down: [],
      },
      { postgresSafe: true },
    );

    expect(result.success).toBe(true);
    // Transaction was used for the regular ALTER plus SET LOCAL timeouts.
    expect(txCalls).toBeGreaterThan(0);
    expect(insideTx.some((s) => s.includes('ALTER TABLE t ADD COLUMN c'))).toBe(
      true,
    );
    expect(insideTx.some((s) => s.startsWith('SET LOCAL lock_timeout'))).toBe(
      true,
    );
    // The plain CREATE INDEX was rewritten to CONCURRENTLY and run outside tx.
    expect(
      outsideTx.some((s) => s.includes('CREATE INDEX CONCURRENTLY idx_pg')),
    ).toBe(true);
  });

  it('runs regular postgres statements directly when no transaction is available', async () => {
    const ran: string[] = [];
    const db: any = {
      url: 'postgres://localhost/test',
      // No `transaction` method -> regular statements run via db.query loop.
      query: async (sql: string) => {
        ran.push(sql);
        return { rows: [] };
      },
    };

    const tracker = new MigrationTracker({ db, useConcurrentIndexes: false });
    const result = await tracker.apply(
      {
        id: '0001_pg_notx',
        description: 'x',
        version: '1.0.0',
        up: ['ALTER TABLE t ADD COLUMN d TEXT'],
        down: [],
      },
      { postgresSafe: true },
    );

    expect(result.success).toBe(true);
    expect(ran.some((s) => s.includes('ALTER TABLE t ADD COLUMN d'))).toBe(
      true,
    );
  });
});
