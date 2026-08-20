import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../object';
import {
  assertPostgresSystemTimestampsCurrent,
  ensureDeferredSystemTableCompatibility,
  ensureDispatchSubscriptionsSystemTableCompatibility,
  ensureJobEventsSystemTableCompatibility,
  ensureJobsSystemTableCompatibility,
  migratePostgresSystemTimestamps,
  planPostgresSystemTimestampMigrations,
} from '../system/compatibility';
import { getSystemTableDDL, SMRT_SCHEMA_VERSION } from '../system/schema';

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

  it('migrates legacy dispatch-subscription identity to tenant-scoped (S5 #1398)', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    // Legacy table: identity is (signal_type, subscriber), no tenant_id column.
    await db.query(`
      CREATE TABLE _smrt_dispatch_subscriptions (
        id TEXT PRIMARY KEY,
        signal_type TEXT NOT NULL,
        subscriber TEXT NOT NULL,
        handler TEXT NOT NULL DEFAULT 'handleDispatch',
        delivery TEXT NOT NULL DEFAULT 'compete',
        enabled INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(signal_type, subscriber)
      )
    `);
    await db.query(
      `INSERT INTO _smrt_dispatch_subscriptions (id, signal_type, subscriber) VALUES ('s1', 'order.placed', 'worker')`,
    );

    await ensureDispatchSubscriptionsSystemTableCompatibility(db);

    // tenant_id column added.
    const columns = await db.query(
      `PRAGMA table_info(_smrt_dispatch_subscriptions)`,
    );
    const columnNames = columns.rows.map((row: { name: string }) => row.name);
    expect(columnNames).toContain('tenant_id');

    // The tenant-scoped unique index exists.
    const idx = await db.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='uq_smrt_dispatch_subs_tenant_signal_subscriber'`,
    );
    expect(idx.rows).toHaveLength(1);

    // The legacy (signal_type, subscriber) auto-index was removed: two tenants
    // can now hold the same (signal_type, subscriber) pair.
    await db.query(
      `INSERT INTO _smrt_dispatch_subscriptions (id, signal_type, subscriber, tenant_id) VALUES ('s2', 'order.placed', 'worker', 'tenant-a')`,
    );
    await db.query(
      `INSERT INTO _smrt_dispatch_subscriptions (id, signal_type, subscriber, tenant_id) VALUES ('s3', 'order.placed', 'worker', 'tenant-b')`,
    );
    const rows = await db.query(
      `SELECT COUNT(*) as c FROM _smrt_dispatch_subscriptions WHERE signal_type='order.placed' AND subscriber='worker'`,
    );
    expect((rows.rows[0] as { c: number }).c).toBe(3);

    // The new index still enforces per-tenant uniqueness.
    await expect(
      db.query(
        `INSERT INTO _smrt_dispatch_subscriptions (id, signal_type, subscriber, tenant_id) VALUES ('s4', 'order.placed', 'worker', 'tenant-a')`,
      ),
    ).rejects.toThrow();
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
    expect(columnNames).toEqual(
      expect.arrayContaining([
        'task_id',
        'task_owner_id',
        'task_result',
        'task_input_requests',
        'task_input_responses',
      ]),
    );

    const indexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_smrt_jobs_tenant_id'
    `);
    const indexNames = indexes.rows.map((row: { name: string }) => row.name);
    expect(indexNames).toContain('idx_smrt_jobs_tenant_id');
    const taskIndexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_smrt_jobs_task_id'
    `);
    expect(taskIndexes.rows.map((row: { name: string }) => row.name)).toContain(
      'idx_smrt_jobs_task_id',
    );
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
    expect(columnNames).toEqual(
      expect.arrayContaining([
        'task_id',
        'task_owner_id',
        'task_result',
        'task_input_requests',
        'task_input_responses',
      ]),
    );

    const indexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_smrt_jobs_tenant_id'
    `);
    const indexNames = indexes.rows.map((row: { name: string }) => row.name);
    expect(indexNames).toContain('idx_smrt_jobs_tenant_id');
    const taskIndexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_smrt_jobs_task_id'
    `);
    expect(taskIndexes.rows.map((row: { name: string }) => row.name)).toContain(
      'idx_smrt_jobs_task_id',
    );
    // The retention predicate of SmrtJobCollection.cleanup() must reach legacy
    // installs the same way (#2375): bootstrap cannot create it, because
    // `_smrt_jobs` comes from a decorated class, not the system DDL.
    const retentionIndexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_smrt_jobs_status_completed_at'
    `);
    expect(
      retentionIndexes.rows.map((row: { name: string }) => row.name),
    ).toContain('idx_smrt_jobs_status_completed_at');
  });

  describe('deferred (manifest-created) tables — issue #2376', () => {
    /** `_smrt_jobs` as `db:migrate` creates it from the jobs manifest. */
    const MANIFEST_JOBS_TABLE = `
      CREATE TABLE _smrt_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        queue TEXT NOT NULL DEFAULT 'default',
        object_type TEXT NOT NULL,
        method TEXT NOT NULL,
        run_at TIMESTAMP NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        task_id TEXT UNIQUE,
        task_owner_id TEXT,
        task_result TEXT,
        task_input_requests TEXT,
        task_input_responses TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`;

    const MANIFEST_JOB_EVENTS_TABLE = `
      CREATE TABLE _smrt_job_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        job_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'log',
        message TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`;

    async function uniqueIndexesOnTaskId(db: DatabaseInterface) {
      const listed = await db.query(`PRAGMA index_list(_smrt_jobs)`);
      const matches: string[] = [];
      for (const index of listed.rows as { name: string; unique: number }[]) {
        if (!index.unique) continue;
        const info = await db.query(`PRAGMA index_info(${index.name})`);
        const columns = (info.rows as { name: string }[]).map(
          (column) => column.name,
        );
        if (columns.length === 1 && columns[0] === 'task_id') {
          matches.push(index.name);
        }
      }
      return matches;
    }

    it('reports unsettled and touches nothing while the jobs tables do not exist', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

      await expect(ensureDeferredSystemTableCompatibility(db)).resolves.toEqual(
        { settled: false },
      );

      const tables = await db.query(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE '\\_smrt\\_%' ESCAPE '\\'`,
      );
      expect(tables.rows).toHaveLength(0);
    });

    it('settles once db:migrate has created the tables, adding the compat indexes a fresh install used to miss', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

      // Fresh-install ordering: framework bootstrap first (no jobs tables yet)…
      expect(await ensureDeferredSystemTableCompatibility(db)).toEqual({
        settled: false,
      });

      // …then `smrt db:migrate` creates them from the manifest.
      await db.query(MANIFEST_JOBS_TABLE);
      await db.query(MANIFEST_JOB_EVENTS_TABLE);

      expect(await ensureDeferredSystemTableCompatibility(db)).toEqual({
        settled: true,
      });

      const indexes = await db.query(
        `SELECT name FROM sqlite_master WHERE type = 'index'`,
      );
      const indexNames = (indexes.rows as { name: string }[]).map(
        (row) => row.name,
      );
      expect(indexNames).toContain('idx_smrt_jobs_tenant_id');
      expect(indexNames).toContain('idx_smrt_job_events_tenant_id');
      expect(indexNames).toContain('idx_smrt_job_events_job_id');
    });

    it('does not add a second unique index on task_id when the manifest already declared one', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      await db.query(MANIFEST_JOBS_TABLE);

      await ensureJobsSystemTableCompatibility(db);

      expect(await uniqueIndexesOnTaskId(db)).toHaveLength(1);
      const compatIndex = await db.query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_smrt_jobs_task_id'`,
      );
      expect(compatIndex.rows).toHaveLength(0);
    });

    it('drops the redundant compat index on a database that has both', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      await db.query(MANIFEST_JOBS_TABLE);
      await db.query(
        `CREATE UNIQUE INDEX idx_smrt_jobs_task_id ON _smrt_jobs(task_id)`,
      );
      expect(await uniqueIndexesOnTaskId(db)).toHaveLength(2);

      await ensureJobsSystemTableCompatibility(db);

      expect(await uniqueIndexesOnTaskId(db)).toEqual([
        expect.not.stringContaining('idx_smrt_jobs_task_id'),
      ]);
    });

    it('still creates the compat index when nothing else enforces task_id uniqueness', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      // Legacy shape: task_id arrived via ALTER TABLE ADD COLUMN, which cannot
      // carry UNIQUE on SQLite — so the compat index is the only enforcement.
      await db.query(`
        CREATE TABLE _smrt_jobs (
          id TEXT PRIMARY KEY,
          queue TEXT NOT NULL DEFAULT 'default',
          object_type TEXT NOT NULL,
          method TEXT NOT NULL,
          run_at TIMESTAMP NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

      await ensureJobsSystemTableCompatibility(db);

      expect(await uniqueIndexesOnTaskId(db)).toEqual([
        'idx_smrt_jobs_task_id',
      ]);
    });
  });

  it('rebuilds legacy dispatch subscriptions using only the columns that exist', async () => {
    // Defence against column drift: the SQLite rebuild used to name all nine
    // columns unconditionally, so any database missing one failed the whole
    // bootstrap with a bare `no such column` (issue #2376).
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(`
      CREATE TABLE _smrt_dispatch_subscriptions (
        id TEXT PRIMARY KEY,
        signal_type TEXT NOT NULL,
        subscriber TEXT NOT NULL,
        handler TEXT NOT NULL DEFAULT 'handleDispatch',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(signal_type, subscriber)
      )
    `);
    await db.query(
      `INSERT INTO _smrt_dispatch_subscriptions (id, signal_type, subscriber) VALUES ('s1', 'order.placed', 'worker')`,
    );

    await expect(
      ensureDispatchSubscriptionsSystemTableCompatibility(db),
    ).resolves.toBeUndefined();

    const columns = await db.query(
      `PRAGMA table_info(_smrt_dispatch_subscriptions)`,
    );
    const columnNames = (columns.rows as { name: string }[]).map(
      (row) => row.name,
    );
    expect(columnNames).toContain('enabled');
    expect(columnNames).toContain('delivery');
    expect(columnNames).toContain('tenant_id');

    const rows = await db.query(
      `SELECT id, enabled FROM _smrt_dispatch_subscriptions`,
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { enabled: number }).enabled).toBe(1);
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
    const existingColumns = new Set([
      'tenant_id',
      'task_id',
      'task_owner_id',
      'task_result',
      'task_input_requests',
      'task_input_responses',
      // Retention predicate of SmrtJobCollection.cleanup() (#2375) — the index
      // below implies the column already exists too.
      'completed_at',
    ]);
    const existingIndexes = new Set([
      'idx_smrt_jobs_tenant_id',
      'idx_smrt_jobs_task_id',
      // Retention predicate of SmrtJobCollection.cleanup() (#2375).
      'idx_smrt_jobs_status_completed_at',
    ]);
    const query = vi
      .fn()
      .mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          expect(params).toEqual(['_smrt_jobs']);
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('information_schema.columns')) {
          expect(sql).toContain('table_schema = current_schema()');
          expect(params[0]).toBe('_smrt_jobs');
          expect(existingColumns.has(params[1] as string)).toBe(true);
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('pg_indexes')) {
          expect(existingIndexes.has(params[0] as string)).toBe(true);
          return { rows: [{ '?column?': 1 }] };
        }

        // Index catalog read by reconcileJobsTaskIdUniqueness (#2376). The
        // legacy table's task_id came from ALTER TABLE ADD COLUMN, so only the
        // compat index enforces uniqueness and it must be left alone.
        if (sql.includes('pg_index')) {
          expect(params).toEqual(['_smrt_jobs']);
          return {
            rows: [
              {
                name: 'idx_smrt_jobs_task_id',
                is_unique: true,
                is_partial: false,
                columns: ['task_id'],
              },
            ],
          };
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
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('DROP INDEX')),
    ).toBe(false);
  });

  it('drops the redundant Postgres compat index when a constraint already enforces task_id', async () => {
    // The manifest declares `taskId` unique, so a table PostgreSQL created from
    // it carries `_smrt_jobs_task_id_key`. The compat index is then redundant
    // and must be dropped rather than kept alongside it (#2376).
    const query = vi
      .fn()
      .mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ '?column?': 1 }] };
        }
        if (sql.includes('information_schema.columns')) {
          return { rows: [{ '?column?': 1 }] };
        }
        if (sql.includes('pg_indexes')) {
          return { rows: [{ '?column?': 1 }] };
        }
        if (sql.includes('pg_index')) {
          expect(params).toEqual(['_smrt_jobs']);
          return {
            rows: [
              {
                name: '_smrt_jobs_task_id_key',
                is_unique: true,
                is_partial: false,
                columns: ['task_id'],
              },
              {
                name: 'idx_smrt_jobs_task_id',
                is_unique: true,
                is_partial: false,
                columns: ['task_id'],
              },
            ],
          };
        }
        if (sql.includes('DROP INDEX')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      });

    await ensureJobsSystemTableCompatibility({
      url: 'postgresql://localhost:5432/test',
      query,
    } as any);

    expect(
      query.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => sql.includes('DROP INDEX')),
    ).toEqual(['DROP INDEX IF EXISTS idx_smrt_jobs_task_id']);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('CREATE UNIQUE INDEX'),
      ),
    ).toBe(false);
  });

  it('keeps the Postgres compat index when only a PARTIAL unique index covers task_id', async () => {
    // A partial unique index does not enforce uniqueness across the table, so
    // it can never stand in for the compat index (#2376).
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (sql.includes('pg_index') && !sql.includes('pg_indexes')) {
        return {
          rows: [
            {
              name: 'partial_task_id_key',
              is_unique: true,
              is_partial: true,
              columns: ['task_id'],
            },
          ],
        };
      }
      if (sql.includes('pg_indexes')) {
        // The compat index does not exist yet.
        return { rows: [] };
      }
      if (sql.includes('CREATE')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await ensureJobsSystemTableCompatibility({
      url: 'postgresql://localhost:5432/test',
      query,
    } as any);

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_smrt_jobs_task_id',
        ),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('DROP INDEX')),
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

  it('materializes system timestamps and integers for each database dialect', () => {
    const postgresDDL = getSystemTableDDL('postgres').join('\n');
    const duckdbDDL = getSystemTableDDL('duckdb').join('\n');
    const sqliteDDL = getSystemTableDDL('sqlite').join('\n');

    expect(postgresDDL).toContain('created_at TIMESTAMPTZ');
    expect(postgresDDL).not.toMatch(/\bTIMESTAMP\b/);
    expect(sqliteDDL).toContain('created_at TIMESTAMP');
    expect(postgresDDL).toContain('prompt_tokens BIGINT');
    expect(duckdbDDL).toContain('prompt_tokens BIGINT');
    expect(sqliteDDL).toContain('prompt_tokens INTEGER');
  });

  it('migrates legacy PostgreSQL system timestamps atomically under the bootstrap lock', async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await migratePostgresSystemTimestamps(
      { url: 'postgresql://localhost/test', query } as any,
      { legacyTimezone: 'UTC' },
      'postgres',
    );

    expect(query).toHaveBeenCalledTimes(1);
    const migration = String(query.mock.calls[0]?.[0]);
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain("current_setting('TimeZone')");
    expect(migration).toContain("table_name LIKE '\\_smrt\\_%'");
    expect(migration).toContain(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ',
    );
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS _smrt_append_change(text,text,text,text,timestamp without time zone)',
    );
    expect(migration).toContain(
      "IF to_regprocedure('_smrt_append_change(text,text,text,text,timestamp without time zone)') IS NOT NULL THEN",
    );
    expect(migration).toContain('p_created_at TIMESTAMPTZ');
  });

  it('plans legacy PostgreSQL system timestamp conversions without mutating', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ timezone: 'UTC', legacy_change_feed_function_exists: true }],
      })
      .mockResolvedValueOnce({
        rows: [
          { table_name: '_smrt_dispatch', column_name: 'created_at' },
          { table_name: '_smrt_jobs', column_name: 'run_at' },
        ],
      });

    const plan = await planPostgresSystemTimestampMigrations(
      { url: 'postgresql://localhost/test', query } as any,
      { legacyTimezone: 'UTC' },
      'postgres',
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(plan).toEqual([
      {
        kind: 'column',
        tableName: '_smrt_dispatch',
        columnName: 'created_at',
        sql: `ALTER TABLE "_smrt_dispatch" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC'`,
      },
      {
        kind: 'column',
        tableName: '_smrt_jobs',
        columnName: 'run_at',
        sql: `ALTER TABLE "_smrt_jobs" ALTER COLUMN "run_at" TYPE TIMESTAMPTZ USING "run_at" AT TIME ZONE 'UTC'`,
      },
      expect.objectContaining({
        kind: 'change-feed-function',
        tableName: '_smrt_changes',
        sql: expect.stringContaining(
          'DROP FUNCTION IF EXISTS _smrt_append_change',
        ),
      }),
    ]);
  });

  it('does not re-plan an already-removed legacy change-feed helper', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ timezone: 'UTC', legacy_change_feed_function_exists: false }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      planPostgresSystemTimestampMigrations(
        { url: 'postgresql://localhost/test', query } as any,
        { legacyTimezone: 'UTC' },
        'postgres',
      ),
    ).resolves.toEqual([]);
    expect(String(query.mock.calls[0]?.[0])).toContain('to_regprocedure');
  });

  it('refuses to preview the system timestamp migration outside a UTC session', async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          timezone: 'America/Edmonton',
          legacy_change_feed_function_exists: false,
        },
      ],
    }));

    await expect(
      planPostgresSystemTimestampMigrations(
        { url: 'postgresql://localhost/test', query } as any,
        { legacyTimezone: 'UTC' },
        'postgres',
      ),
    ).rejects.toThrow('outside a UTC PostgreSQL session');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses to stamp a partial PostgreSQL system schema with legacy timestamps', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { table_name: '_smrt_jobs', column_name: 'run_at' },
        { table_name: '_smrt_dispatch', column_name: 'created_at' },
      ],
    }));

    await expect(
      assertPostgresSystemTimestampsCurrent(
        { url: 'postgresql://localhost/test', query } as any,
        'postgres',
      ),
    ).rejects.toThrow('_smrt_jobs.run_at, _smrt_dispatch.created_at');
  });

  it('requires explicit UTC provenance confirmation before issuing migration SQL', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(
      migratePostgresSystemTimestamps(
        { url: 'postgresql://localhost/test', query } as any,
        { legacyTimezone: 'local' } as any,
        'postgres',
      ),
    ).rejects.toThrow('explicit UTC provenance confirmation');
    expect(query).not.toHaveBeenCalled();
  });
});
