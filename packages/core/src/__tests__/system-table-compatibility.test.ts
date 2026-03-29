import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../object';
import { ensureJobsSystemTableCompatibility } from '../system/compatibility';
import { SMRT_SCHEMA_VERSION } from '../system/schema';

class LegacySystemTableProbe extends SmrtObject {
  value: string = '';
}

describe('system table compatibility', () => {
  it('upgrades legacy dispatch tables before replaying system DDL', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    await db.query(`
      CREATE TABLE _smrt_dispatch (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        processed_at TIMESTAMP,
        processed_by TEXT,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const probe = new LegacySystemTableProbe({ db, value: 'probe' });
    await probe.initialize();

    const columns = await db.query(`PRAGMA table_info(_smrt_dispatch)`);
    const columnNames = columns.rows.map((row: { name: string }) => row.name);
    expect(columnNames).toContain('target_subscriber');
    expect(columnNames).toContain('correlation_id');

    const indexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name IN ('idx_smrt_dispatch_target', 'idx_smrt_dispatch_correlation')
    `);
    const indexNames = indexes.rows.map((row: { name: string }) => row.name);
    expect(indexNames).toContain('idx_smrt_dispatch_target');
    expect(indexNames).toContain('idx_smrt_dispatch_correlation');
  });

  it('upgrades legacy jobs tables before replaying system DDL', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    await db.query(`
      CREATE TABLE _smrt_jobs (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL DEFAULT 'default',
        object_type TEXT NOT NULL,
        object_id TEXT,
        method TEXT NOT NULL,
        args TEXT,
        run_at TIMESTAMP NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        timeout INTEGER NOT NULL DEFAULT 300000,
        timeout_behavior TEXT NOT NULL DEFAULT 'fail',
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        last_error TEXT,
        result_pointer TEXT,
        retry_strategy TEXT,
        worker_id TEXT,
        worker_heartbeat TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const probe = new LegacySystemTableProbe({ db, value: 'probe' });
    await probe.initialize();

    const columns = await db.query(`PRAGMA table_info(_smrt_jobs)`);
    const columnNames = columns.rows.map((row: { name: string }) => row.name);
    expect(columnNames).toContain('tenant_id');

    const indexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_smrt_jobs_tenant_id'
    `);
    const indexNames = indexes.rows.map((row: { name: string }) => row.name);
    expect(indexNames).toContain('idx_smrt_jobs_tenant_id');
  });

  it('upgrades legacy jobs tables without replaying system DDL', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    await db.query(`
      CREATE TABLE _smrt_jobs (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL DEFAULT 'default',
        object_type TEXT NOT NULL,
        object_id TEXT,
        method TEXT NOT NULL,
        args TEXT,
        run_at TIMESTAMP NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        timeout INTEGER NOT NULL DEFAULT 300000,
        timeout_behavior TEXT NOT NULL DEFAULT 'fail',
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        last_error TEXT,
        result_pointer TEXT,
        retry_strategy TEXT,
        worker_id TEXT,
        worker_heartbeat TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE _smrt_migrations (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        description TEXT,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query(
      `INSERT INTO _smrt_migrations (id, version, description) VALUES (?, ?, ?)`,
      'migration-1',
      SMRT_SCHEMA_VERSION,
      'current system schema',
    );

    await ensureJobsSystemTableCompatibility(db);

    const columns = await db.query(`PRAGMA table_info(_smrt_jobs)`);
    const columnNames = columns.rows.map((row: { name: string }) => row.name);
    expect(columnNames).toContain('tenant_id');

    const indexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_smrt_jobs_tenant_id'
    `);
    const indexNames = indexes.rows.map((row: { name: string }) => row.name);
    expect(indexNames).toContain('idx_smrt_jobs_tenant_id');
  });

  it('skips Postgres jobs DDL when the compatibility column and index already exist', async () => {
    const query = vi
      .fn()
      .mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql === 'SELECT 1 FROM _smrt_jobs LIMIT 1') {
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('information_schema.columns')) {
          expect(sql).toContain('table_schema = current_schema()');
          expect(params).toEqual(['_smrt_jobs', 'tenant_id']);
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('pg_indexes')) {
          expect(params).toEqual(['idx_smrt_jobs_tenant_id']);
          return { rows: [{ '?column?': 1 }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      });

    await ensureJobsSystemTableCompatibility({
      url: 'postgresql://localhost:5432/test',
      query,
    } as any);

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('ALTER TABLE _smrt_jobs ADD COLUMN'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes(
          'CREATE INDEX IF NOT EXISTS idx_smrt_jobs_tenant_id',
        ),
      ),
    ).toBe(false);
  });
});
