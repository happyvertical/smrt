/**
 * Tests for the shared system-diagnostics reader
 * (`src/system/diagnostics.ts`, #1824).
 *
 * Real in-memory SQLite databases, no mocks: core system tables are provisioned
 * via `ensureSystemTables`, the jobs/agents-owned tables are created with the
 * column shapes their owning packages define, and rows are seeded directly.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../system/bootstrap.js';
import {
  readDispatchHealth,
  readJobHealth,
  readMigrationStatus,
  readRecentChanges,
  readRegistryDrift,
  readScheduleHealth,
  readSystemDiagnostics,
  SYSTEM_DIAGNOSTICS_TABLES,
} from '../system/diagnostics.js';

let db: DatabaseInterface;

beforeEach(async () => {
  db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  await ensureSystemTables(db);
  await createJobsTables(db);
  await createSchedulesTable(db);
});

afterEach(async () => {
  await db.close?.();
});

async function createJobsTables(database: DatabaseInterface): Promise<void> {
  // Column shapes mirror the @smrt() definitions in packages/jobs
  // (SmrtJob / SmrtJobEvent / SmrtWorker).
  await database.query(`
    CREATE TABLE IF NOT EXISTS _smrt_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      queue TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT,
      method TEXT NOT NULL,
      args TEXT,
      run_at TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      timeout INTEGER NOT NULL DEFAULT 300000,
      timeout_behavior TEXT NOT NULL DEFAULT 'fail',
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      result_pointer TEXT,
      task_id TEXT,
      task_owner_id TEXT,
      task_result TEXT,
      task_input_requests TEXT,
      task_input_responses TEXT,
      retry_strategy TEXT,
      worker_id TEXT,
      worker_heartbeat TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS _smrt_job_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'log',
      level TEXT NOT NULL DEFAULT 'info',
      stage TEXT,
      progress INTEGER,
      message TEXT NOT NULL DEFAULT '',
      data TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS _smrt_workers (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      pid INTEGER,
      hostname TEXT,
      started_at TEXT,
      heartbeat_at TEXT,
      lease_expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'running'
    )
  `);
}

async function createSchedulesTable(
  database: DatabaseInterface,
): Promise<void> {
  // Column shape mirrors @smrt() AgentSchedule in packages/agents/src/schedule.ts.
  await database.query(`
    CREATE TABLE IF NOT EXISTS _smrt_agent_schedules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      agent_type TEXT NOT NULL,
      agent_id TEXT,
      agent_config TEXT,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled BOOLEAN NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      last_run TEXT,
      next_run TEXT,
      last_status TEXT,
      last_error TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      max_concurrent INTEGER NOT NULL DEFAULT 1,
      running_count INTEGER NOT NULL DEFAULT 0,
      timeout INTEGER NOT NULL DEFAULT 3600000,
      method TEXT NOT NULL DEFAULT 'run',
      method_args TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
}

async function countRows(table: string): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS total FROM ${table}`);
  const rows = Array.isArray(result) ? result : (result.rows as unknown[]);
  return Number((rows[0] as { total?: unknown }).total ?? 0);
}

const TS = '2026-08-30T10:00:00.000Z';

describe('system diagnostics reader (#1824)', () => {
  describe('migration-status', () => {
    it('reflects seeded applied and failed migrations with safe projections', async () => {
      await db.query(
        `INSERT INTO _smrt_schema_migrations
           (id, name, version, checksum, status, applied_at, execution_time_ms,
            attempts, error_message, package_name, source_file, is_reversible,
            batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'm1',
        'create_users',
        '1.0.0',
        'abc123',
        'applied',
        '2026-08-01T00:00:00.000Z',
        42,
        1,
        null,
        '@happyvertical/smrt-core',
        'migrations/001.sql',
        1,
        1,
      );
      await db.query(
        `INSERT INTO _smrt_schema_migrations
           (id, name, version, checksum, status, applied_at, attempts, error_message, batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'm2',
        'create_broken_table',
        '1.0.1',
        'def456',
        'failed',
        '2026-08-02T00:00:00.000Z',
        2,
        'syntax error at line 3',
        1,
      );

      const result = await readMigrationStatus(db);
      expect(result.available).toBe(true);
      if (!result.available) return;

      expect(result.summary).toMatchObject({ total: 2, applied: 1, failed: 1 });
      expect(result.summary.byStatus).toEqual({ applied: 1, failed: 1 });
      expect(result.latest).toHaveLength(1);
      expect(result.latest[0]).toMatchObject({
        name: 'create_users',
        version: '1.0.0',
        status: 'applied',
        executionTimeMs: 42,
        packageName: '@happyvertical/smrt-core',
        isReversible: true,
      });
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].errorMessage).toBe('syntax error at line 3');
    });

    it('degrades to category-unavailable when the table is missing', async () => {
      await db.query('DROP TABLE _smrt_schema_migrations');
      const result = await readMigrationStatus(db);
      expect(result).toMatchObject({
        available: false,
        reason: 'table-missing',
        tableName: '_smrt_schema_migrations',
      });
    });

    it('binds $n placeholders when the connection URL is postgres (#1824 L1)', async () => {
      // The engine must come from the connection URL (getDatabaseEngine
      // convention), not a `type` field: a postgres URL without a matching
      // explicit type would otherwise fall back to `?` and fail to bind.
      const queries: string[] = [];
      // Postgres-flavored wrapper: the URL drives placeholder style for every
      // statement the reader issues — including the tableExists probe, which
      // shares the same URL-driven engine detection and queries
      // information_schema with $n bindings. The stub records each statement
      // and answers the postgres-shaped probes with shaped rows; nothing is
      // executed against a real postgres.
      const shaped: DatabaseInterface = {
        ...db,
        url: 'postgres://user:***@localhost:5432/app',
        query: async (sql: string): Promise<any> => {
          queries.push(sql);
          if (/information_schema\.tables/.test(sql)) {
            return [{ '1': 1 }];
          }
          if (/GROUP BY status/.test(sql)) {
            return [{ status: 'applied', total: 1 }];
          }
          if (/LIMIT \$1/.test(sql)) {
            return [];
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
      const result = await readMigrationStatus(shaped);
      expect(result.available).toBe(true);
      if (!result.available) return;
      expect(result.summary.total).toBe(1);
      expect(
        queries.some((sql) => /LIMIT \$1/.test(sql)),
        'postgres URL must produce $n placeholders',
      ).toBe(true);
      expect(
        queries.some((sql) => /LIMIT \?/.test(sql)),
        'postgres URL must not produce ? placeholders',
      ).toBe(false);
    });
  });

  describe('job-health', () => {
    it('reflects seeded jobs and workers and detects stuck running jobs', async () => {
      await db.query(
        `INSERT INTO _smrt_jobs
           (id, tenant_id, queue, object_type, object_id, method, args, run_at,
            status, attempts, max_attempts, last_error, worker_id, worker_heartbeat,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'job-1',
        null,
        'default',
        'OrderProcessor',
        'ord-1',
        'process',
        '{"secret":1}',
        '2026-08-30T09:00:00.000Z',
        'running',
        1,
        3,
        null,
        'worker-a',
        '2026-08-30T09:55:00.000Z',
        TS,
      );
      await db.query(
        `INSERT INTO _smrt_jobs
           (id, queue, object_type, method, run_at, status, attempts, max_attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'job-2',
        'default',
        'InvoiceMailer',
        'send',
        '2026-08-30T08:00:00.000Z',
        'failed',
        3,
        3,
        TS,
      );
      await db.query(
        `INSERT INTO _smrt_workers
           (id, worker_id, pid, hostname, started_at, heartbeat_at, lease_expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        'w-1',
        'worker-a',
        1234,
        'host-a',
        TS,
        '2026-08-30T09:55:00.000Z',
        '2026-08-30T10:05:00.000Z',
        'running',
      );

      const result = await readJobHealth(db, {
        now: new Date('2026-08-30T10:00:00.000Z'),
        staleAfterMs: 60_000,
      });
      expect(result.available).toBe(true);
      if (!result.available) return;

      expect(result.summary).toMatchObject({
        total: 2,
        failed: 1,
        stuck: 1,
      });
      expect(result.summary.byStatus).toEqual({ running: 1, failed: 1 });
      expect(result.jobs).toHaveLength(2);
      expect(result.workers).toHaveLength(1);
      expect(result.workers[0]).toMatchObject({
        workerId: 'worker-a',
        pid: 1234,
        hostname: 'host-a',
        status: 'running',
      });
    });

    it('never projects job payload/result columns', async () => {
      await db.query(
        `INSERT INTO _smrt_jobs
           (id, queue, object_type, method, args, run_at, status, task_id, task_result,
            task_input_requests, task_input_responses, retry_strategy, result_pointer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'job-3',
        'default',
        'Type',
        'run',
        '{"secret":1}',
        TS,
        'running',
        'task-1',
        '{"secret":2}',
        '{"secret":3}',
        '{"secret":4}',
        '{"type":"exponential"}',
        's3://bucket/result.json',
        TS,
      );
      const result = await readJobHealth(db);
      expect(result.available).toBe(true);
      if (!result.available) return;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('args');
      expect(serialized).not.toContain('task_result');
      expect(serialized).not.toContain('taskResult');
      expect(serialized).not.toContain('task_input');
      expect(serialized).not.toContain('result_pointer');
      expect(serialized).not.toContain('retry_strategy');
      expect(serialized).not.toContain('resultPointer');
    });

    it('degrades to category-unavailable when _smrt_jobs is missing', async () => {
      await db.query('DROP TABLE _smrt_jobs');
      const result = await readJobHealth(db);
      expect(result).toMatchObject({
        available: false,
        reason: 'table-missing',
        tableName: '_smrt_jobs',
      });
    });
  });

  describe('schedule-health', () => {
    it('reflects seeded schedules and counts overdue active schedules', async () => {
      await db.query(
        `INSERT INTO _smrt_agent_schedules
           (id, tenant_id, agent_type, agent_config, cron, timezone, enabled, status,
            next_run, last_status, last_error, run_count, failure_count, method, method_args)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'sched-1',
        null,
        'SupportAgent',
        '{"apiKey":"top-secret"}',
        '0 2 * * *',
        'UTC',
        1,
        'active',
        '2026-08-30T09:00:00.000Z',
        'failed',
        'timeout after 3600000ms',
        5,
        2,
        'run',
        '{"secret":true}',
      );
      await db.query(
        `INSERT INTO _smrt_agent_schedules
           (id, agent_type, cron, timezone, enabled, status, next_run, method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        'sched-2',
        'HealthAgent',
        '0 3 * * *',
        'UTC',
        1,
        'active',
        '2026-08-31T03:00:00.000Z',
        'run',
      );

      const result = await readScheduleHealth(db, {
        now: new Date('2026-08-30T10:00:00.000Z'),
      });
      expect(result.available).toBe(true);
      if (!result.available) return;

      expect(result.summary).toMatchObject({
        total: 2,
        enabled: 2,
        active: 2,
        failed: 1,
        overdue: 1,
      });
      expect(result.schedules).toHaveLength(2);
      expect(result.schedules[0]).toMatchObject({
        id: 'sched-1',
        agentType: 'SupportAgent',
        cron: '0 2 * * *',
        lastStatus: 'failed',
        failureCount: 2,
      });
    });

    it('never projects agentConfig or methodArgs', async () => {
      await db.query(
        `INSERT INTO _smrt_agent_schedules
           (id, agent_type, agent_config, cron, timezone, enabled, status, method, method_args)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'sched-3',
        'SupportAgent',
        '{"apiKey":"top-secret"}',
        '0 2 * * *',
        'UTC',
        1,
        'active',
        'run',
        '{"password":"hunter2"}',
      );
      const result = await readScheduleHealth(db);
      expect(result.available).toBe(true);
      if (!result.available) return;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('top-secret');
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('agent_config');
      expect(serialized).not.toContain('agentConfig');
      expect(serialized).not.toContain('method_args');
      expect(serialized).not.toContain('methodArgs');
    });
  });

  describe('dispatch-health', () => {
    it('reflects seeded dispatches and subscriptions with safe projections', async () => {
      await db.query(
        `INSERT INTO _smrt_dispatch
           (id, type, source, source_id, payload, status, attempts, last_error,
            target_subscriber, correlation_id, tenant_id, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'd-1',
        'order.created',
        'orders',
        'ord-1',
        '{"secret":1}',
        'pending',
        0,
        null,
        'order-handler',
        'corr-1',
        null,
        '{"secret":2}',
        TS,
        TS,
      );
      await db.query(
        `INSERT INTO _smrt_dispatch
           (id, type, source, status, attempts, last_error, processed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'd-2',
        'order.created',
        'orders',
        'failed',
        3,
        'handler crashed',
        '2026-08-29T10:00:00.000Z',
        TS,
        TS,
      );
      await db.query(
        `INSERT INTO _smrt_dispatch_subscriptions
           (id, signal_type, subscriber, handler, delivery, enabled, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        's-1',
        'order.created',
        'order-handler',
        'handleDispatch',
        'compete',
        1,
        null,
        TS,
        TS,
      );

      const result = await readDispatchHealth(db);
      expect(result.available).toBe(true);
      if (!result.available) return;

      expect(result.summary).toMatchObject({
        total: 2,
        pending: 1,
        failed: 1,
        completed: 0,
        subscriptions: 1,
      });
      expect(result.dispatches).toHaveLength(2);
      expect(result.dispatches[0]).toMatchObject({
        id: 'd-1',
        type: 'order.created',
        targetSubscriber: 'order-handler',
        correlationId: 'corr-1',
      });
      expect(result.subscriptions[0]).toMatchObject({
        signalType: 'order.created',
        subscriber: 'order-handler',
        enabled: true,
      });
    });

    it('never projects dispatch payload or metadata', async () => {
      await db.query(
        `INSERT INTO _smrt_dispatch
           (id, type, source, payload, status, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        'd-3',
        'evt',
        'src',
        '{"secret":1}',
        'pending',
        '{"secret":2}',
        TS,
        TS,
      );
      const result = await readDispatchHealth(db);
      expect(result.available).toBe(true);
      if (!result.available) return;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('payload');
      expect(serialized).not.toContain('metadata');
    });

    it('reports subscriptions as absent when only _smrt_dispatch exists', async () => {
      await db.query('DROP TABLE _smrt_dispatch_subscriptions');
      await db.query(
        `INSERT INTO _smrt_dispatch (id, type, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'd-4',
        'evt',
        'src',
        'pending',
        TS,
        TS,
      );
      const result = await readDispatchHealth(db);
      expect(result.available).toBe(true);
      if (!result.available) return;
      expect(result.summary.subscriptions).toBe(0);
      expect(result.subscriptions).toEqual([]);
    });
  });

  describe('recent-changes', () => {
    it('returns seeded changes after a cursor with table filtering', async () => {
      await db.query(
        `INSERT INTO _smrt_changes (seq, table_name, row_id, operation, tenant_id, created_at)
         VALUES (1, 'orders', 'ord-1', 'create', NULL, ?),
                (2, 'orders', 'ord-2', 'update', NULL, ?),
                (3, 'invoices', 'inv-1', 'create', 'tenant-a', ?)`,
        TS,
        TS,
        TS,
      );

      const all = await readRecentChanges(db);
      expect(all.available).toBe(true);
      if (!all.available) return;
      expect(all.changes).toHaveLength(3);
      expect(all.cursor).toBe(3);

      const filtered = await readRecentChanges(db, {
        since: 1,
        tables: ['orders'],
      });
      expect(filtered.available).toBe(true);
      if (!filtered.available) return;
      expect(filtered.changes.map((c) => c.seq)).toEqual([2]);
      expect(filtered.cursor).toBe(3);

      const tenanted = await readRecentChanges(db, { tenantId: 'tenant-a' });
      expect(tenanted.available).toBe(true);
      if (!tenanted.available) return;
      // Documented change-feed semantics: a tenant sees its own rows plus
      // global rows (tenant_id = T OR tenant_id IS NULL).
      expect(tenanted.changes.map((c) => c.rowId)).toEqual([
        'ord-1',
        'ord-2',
        'inv-1',
      ]);

      const globalOnly = await readRecentChanges(db, { tenantId: null });
      expect(globalOnly.available).toBe(true);
      if (!globalOnly.available) return;
      expect(globalOnly.changes.map((c) => c.rowId)).toEqual([
        'ord-1',
        'ord-2',
      ]);
    });

    it('degrades to category-unavailable when _smrt_changes is missing', async () => {
      await db.query('DROP TABLE _smrt_changes');
      const result = await readRecentChanges(db);
      expect(result).toMatchObject({
        available: false,
        reason: 'table-missing',
        tableName: '_smrt_changes',
      });
    });
  });

  describe('registry-drift', () => {
    it('reports the retirement without fabricating drift (fresh DB)', async () => {
      const result = await readRegistryDrift(db);
      expect(result).toMatchObject({
        available: false,
        reason: 'retired',
        tableName: '_smrt_registry',
        stillPresent: false,
      });
      expect(result.message).toContain('retired');
      expect(result.message).not.toContain('drift:');
    });

    it('notes when a legacy registry table still exists', async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS _smrt_registry (id TEXT PRIMARY KEY, data TEXT)
      `);
      const result = await readRegistryDrift(db);
      expect(result.stillPresent).toBe(true);
      expect(result.message).toContain('legacy empty table remains');
    });
  });

  describe('readSystemDiagnostics facade + read-only boundary', () => {
    it('returns every category with a mix of live and unavailable results', async () => {
      await db.query(
        `INSERT INTO _smrt_schema_migrations
           (id, name, version, checksum, status, applied_at, batch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'm1',
        'init',
        '1.0.0',
        'x',
        'applied',
        '2026-08-01T00:00:00.000Z',
        1,
      );
      await db.query('DROP TABLE _smrt_changes');

      const result = await readSystemDiagnostics(db);
      expect(result.migrations.available).toBe(true);
      expect(result.jobs.available).toBe(true);
      expect(result.schedules.available).toBe(true);
      expect(result.dispatch.available).toBe(true);
      expect(result.changes).toMatchObject({
        available: false,
        reason: 'table-missing',
        tableName: '_smrt_changes',
      });
      expect(result.registry).toMatchObject({
        available: false,
        reason: 'retired',
      });
    });

    it('performs no writes: every table count is unchanged after a full read', async () => {
      await db.query(
        `INSERT INTO _smrt_schema_migrations
           (id, name, version, checksum, status, applied_at, batch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'm1',
        'init',
        '1.0.0',
        'x',
        'applied',
        '2026-08-01T00:00:00.000Z',
        1,
      );
      await db.query(
        `INSERT INTO _smrt_jobs (id, queue, object_type, method, run_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'job-1',
        'default',
        'Type',
        'run',
        TS,
        'running',
        TS,
      );
      await db.query(
        `INSERT INTO _smrt_dispatch (id, type, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'd-1',
        'evt',
        'src',
        'pending',
        TS,
        TS,
      );
      await db.query(
        `INSERT INTO _smrt_agent_schedules
           (id, agent_type, cron, timezone, enabled, status, method)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'sched-1',
        'Agent',
        '0 2 * * *',
        'UTC',
        1,
        'active',
        'run',
      );

      const tables = [
        SYSTEM_DIAGNOSTICS_TABLES.migrations,
        SYSTEM_DIAGNOSTICS_TABLES.dispatch,
        SYSTEM_DIAGNOSTICS_TABLES.dispatchSubscriptions,
        SYSTEM_DIAGNOSTICS_TABLES.changes,
        SYSTEM_DIAGNOSTICS_TABLES.jobs,
        SYSTEM_DIAGNOSTICS_TABLES.jobEvents,
        SYSTEM_DIAGNOSTICS_TABLES.workers,
        SYSTEM_DIAGNOSTICS_TABLES.schedules,
      ];
      const before = new Map<string, number>();
      for (const table of tables) {
        before.set(table, await countRows(table));
      }

      await readSystemDiagnostics(db);

      for (const table of tables) {
        expect(await countRows(table)).toBe(before.get(table));
      }
    });
  });
});
