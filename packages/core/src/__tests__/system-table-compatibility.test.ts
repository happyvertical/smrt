import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../object';
import {
  ensureJobEventsSystemTableCompatibility,
  ensureJobsSystemTableCompatibility,
} from '../system/compatibility';
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

  it('upgrades legacy job event tables without replaying system DDL', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    await db.query(`
      CREATE TABLE _smrt_job_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'log',
        level TEXT NOT NULL DEFAULT 'info',
        stage TEXT,
        progress INTEGER,
        message TEXT NOT NULL DEFAULT '',
        data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await ensureJobEventsSystemTableCompatibility(db);

    const columns = await db.query(`PRAGMA table_info(_smrt_job_events)`);
    const columnNames = columns.rows.map((row: { name: string }) => row.name);
    expect(columnNames).toContain('tenant_id');

    const indexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_smrt_job_events_tenant_id',
          'idx_smrt_job_events_job_id',
          'idx_smrt_job_events_type',
          'idx_smrt_job_events_created_at'
        )
    `);
    const indexNames = indexes.rows.map((row: { name: string }) => row.name);
    expect(indexNames).toContain('idx_smrt_job_events_tenant_id');
    expect(indexNames).toContain('idx_smrt_job_events_job_id');
    expect(indexNames).toContain('idx_smrt_job_events_type');
    expect(indexNames).toContain('idx_smrt_job_events_created_at');
  });

  it('skips Postgres jobs DDL when the compatibility column and index already exist', async () => {
    const query = vi
      .fn()
      .mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          expect(params).toEqual(['_smrt_jobs']);
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

  it('skips Postgres job event DDL when compatibility columns and indexes already exist', async () => {
    const existingIndexes = new Set([
      'idx_smrt_job_events_tenant_id',
      'idx_smrt_job_events_job_id',
      'idx_smrt_job_events_type',
      'idx_smrt_job_events_created_at',
    ]);
    const query = vi
      .fn()
      .mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          expect(params).toEqual(['_smrt_job_events']);
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('information_schema.columns')) {
          expect(sql).toContain('table_schema = current_schema()');
          expect(params).toEqual(['_smrt_job_events', 'tenant_id']);
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('pg_indexes')) {
          const [indexName] = params;
          expect(existingIndexes.has(String(indexName))).toBe(true);
          return { rows: [{ '?column?': 1 }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      });

    await ensureJobEventsSystemTableCompatibility({
      url: 'postgresql://localhost:5432/test',
      query,
    } as any);

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('ALTER TABLE _smrt_job_events ADD COLUMN'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('CREATE INDEX IF NOT EXISTS'),
      ),
    ).toBe(false);
  });

  it('tolerates a verified Postgres concurrent index creation race', async () => {
    let createdAtIndexLookups = 0;
    const query = vi
      .fn()
      .mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          expect(params).toEqual(['_smrt_job_events']);
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('information_schema.columns')) {
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('pg_indexes')) {
          const [indexName] = params;
          if (indexName === 'idx_smrt_job_events_created_at') {
            createdAtIndexLookups += 1;
            return {
              rows: createdAtIndexLookups === 1 ? [] : [{ '?column?': 1 }],
            };
          }

          return { rows: [{ '?column?': 1 }] };
        }

        if (
          sql.includes(
            'CREATE INDEX IF NOT EXISTS idx_smrt_job_events_created_at',
          )
        ) {
          const error = new Error('Failed query') as Error & {
            originalError?: {
              code: string;
              message: string;
              detail: string;
            };
          };
          error.originalError = {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "pg_class_relname_nsp_index"',
            detail:
              'Key (relname, relnamespace)=(idx_smrt_job_events_created_at, 2200) already exists.',
          };
          throw error;
        }

        throw new Error(`Unexpected query: ${sql}`);
      });

    await expect(
      ensureJobEventsSystemTableCompatibility({
        url: 'postgresql://localhost:5432/test',
        query,
      } as any),
    ).resolves.toBeUndefined();

    expect(createdAtIndexLookups).toBe(2);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes(
          'CREATE INDEX IF NOT EXISTS idx_smrt_job_events_created_at',
        ),
      ),
    ).toHaveLength(1);
  });

  it('tolerates a verified Postgres index race wrapped by sql context text', async () => {
    let createdAtIndexLookups = 0;
    const query = vi
      .fn()
      .mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          expect(params).toEqual(['_smrt_job_events']);
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('information_schema.columns')) {
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('pg_indexes')) {
          const [indexName] = params;
          if (indexName === 'idx_smrt_job_events_created_at') {
            createdAtIndexLookups += 1;
            return {
              rows: createdAtIndexLookups === 1 ? [] : [{ '?column?': 1 }],
            };
          }

          return { rows: [{ '?column?': 1 }] };
        }

        if (
          sql.includes(
            'CREATE INDEX IF NOT EXISTS idx_smrt_job_events_created_at',
          )
        ) {
          const error = new Error('Failed to execute raw query') as Error & {
            context?: {
              originalError: string;
            };
          };
          error.context = {
            originalError:
              'duplicate key value violates unique constraint "pg_class_relname_nsp_index", code=23505, detail=Key (relname, relnamespace)=(idx_smrt_job_events_created_at, 2200) already exists., severity=ERROR',
          };
          throw error;
        }

        throw new Error(`Unexpected query: ${sql}`);
      });

    await expect(
      ensureJobEventsSystemTableCompatibility({
        url: 'postgresql://localhost:5432/test',
        query,
      } as any),
    ).resolves.toBeUndefined();

    expect(createdAtIndexLookups).toBe(2);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes(
          'CREATE INDEX IF NOT EXISTS idx_smrt_job_events_created_at',
        ),
      ),
    ).toHaveLength(1);
  });

  it('still fails Postgres index creation when the index race cannot be verified', async () => {
    const query = vi
      .fn()
      .mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          expect(params).toEqual(['_smrt_job_events']);
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('information_schema.columns')) {
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('pg_indexes')) {
          const [indexName] = params;
          if (indexName === 'idx_smrt_job_events_created_at') {
            return { rows: [] };
          }

          return { rows: [{ '?column?': 1 }] };
        }

        if (
          sql.includes(
            'CREATE INDEX IF NOT EXISTS idx_smrt_job_events_created_at',
          )
        ) {
          const error = new Error(
            'permission denied for schema public',
          ) as Error & {
            code?: string;
          };
          error.code = '42501';
          throw error;
        }

        throw new Error(`Unexpected query: ${sql}`);
      });

    await expect(
      ensureJobEventsSystemTableCompatibility({
        url: 'postgresql://localhost:5432/test',
        query,
      } as any),
    ).rejects.toThrow('permission denied for schema public');
  });
});
