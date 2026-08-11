import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  redactSystemDiagnosticText,
  SystemDiagnosticsReader,
} from './system-diagnostics.js';

const NOW = new Date('2026-08-11T18:00:00.000Z');

describe('SystemDiagnosticsReader', () => {
  let db: DatabaseInterface;
  let sql: string[];
  let auditedDb: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      dbid: `system-diagnostics-${crypto.randomUUID()}`,
    });
    await seedSystemTables(db);
    sql = [];
    auditedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'query')
          return Reflect.get(target, property, receiver);
        return async (statement: string, ...params: unknown[]) => {
          sql.push(statement);
          return target.query(statement, ...params);
        };
      },
    });
  });

  afterEach(async () => {
    await closeTestDatabase(db);
  });

  it('reads all six categories with provenance and never issues a write', async () => {
    const reader = new SystemDiagnosticsReader(auditedDb, {
      engine: 'sqlite',
      connectionSource: 'injected',
      scope: { mode: 'tenant', tenantId: 'tenant-a' },
      now: () => NOW,
    });

    const migrations = await reader.migrationStatus();
    const jobs = await reader.jobHealth();
    const schedules = await reader.scheduleHealth();
    const dispatch = await reader.dispatchHealth();
    const changes = await reader.recentChanges({ since: 0 });
    const registry = await reader.registrySnapshot();

    for (const result of [
      migrations,
      jobs,
      schedules,
      dispatch,
      changes,
      registry,
    ]) {
      expect(result.status).toBe('available');
      expect(result.provenance).toMatchObject({
        source: 'runtime',
        observation: 'live-db',
        engine: 'sqlite',
        connectionSource: 'injected',
        scope: { mode: 'tenant', tenantId: 'tenant-a' },
      });
    }

    expect(migrations.data?.counts.failed).toBe(1);
    expect(migrations.data?.migrations[0].errorMessage).not.toContain('secret');
    expect(jobs.data?.countsByStatus).toMatchObject({ failed: 2, running: 1 });
    expect(jobs.data?.stuckJobs.map((job) => job.id)).toEqual(['job-stuck']);
    expect(jobs.data?.recentFailures[0]).not.toHaveProperty('args');
    expect(schedules.data).toMatchObject({ due: 1, overdue: 1, errored: 1 });
    expect(schedules.data?.schedules[0]).not.toHaveProperty('agentConfig');
    expect(schedules.data?.schedules[0]).not.toHaveProperty('methodArgs');
    expect(dispatch.data).toMatchObject({ pending: 1, stuck: 1 });
    expect(dispatch.data?.dispatches[0]).not.toHaveProperty('payload');
    expect(dispatch.data?.dispatches[0]).not.toHaveProperty('metadata');
    expect(dispatch.data?.subscriptions).toHaveLength(1);
    expect(changes.data?.changes.map((change) => change.rowId)).toEqual([
      'global-row',
      'tenant-a-row',
    ]);
    expect(registry.data?.registrations).toEqual([
      {
        className: 'Article',
        schemaVersion: '3',
        lastUpdated: '2026-08-11T17:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(registry.data)).not.toContain('registry-secret');

    expect(sql.length).toBeGreaterThan(0);
    for (const statement of sql) {
      expect(statement.trim()).toMatch(/^SELECT\b/i);
      expect(statement).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|TRUNCATE|PRAGMA)\b/i,
      );
    }
  });

  it('fails closed to global rows and never exposes other tenants', async () => {
    const reader = new SystemDiagnosticsReader(auditedDb, {
      engine: 'sqlite',
      scope: { mode: 'global' },
      now: () => NOW,
    });

    const jobs = await reader.jobHealth();
    const schedules = await reader.scheduleHealth();
    const dispatch = await reader.dispatchHealth();
    const changes = await reader.recentChanges({ since: 0 });

    expect(jobs.data?.recentFailures.map((job) => job.id)).toEqual([
      'job-global-failed',
    ]);
    expect(schedules.data?.schedules.map((schedule) => schedule.id)).toEqual([
      'schedule-global',
    ]);
    expect(dispatch.data?.dispatches.map((item) => item.id)).toEqual([
      'dispatch-global',
    ]);
    expect(dispatch.data?.subscriptions.map((item) => item.subscriber)).toEqual(
      ['global-worker'],
    );
    expect(changes.data?.changes.map((change) => change.rowId)).toEqual([
      'global-row',
    ]);
    expect(
      JSON.stringify({ jobs, schedules, dispatch, changes }),
    ).not.toContain('tenant-b');
  });

  it('keeps aggregate counts independent from bounded detail lists', async () => {
    for (let index = 0; index < 60; index += 1) {
      await db.query(
        `INSERT INTO _smrt_schema_migrations VALUES (?, ?, '1', 'demo', 'pending', NULL, NULL, 0, NULL)`,
        `migration-${index}`,
        `pending-${index}`,
      );
      await db.query(
        `INSERT INTO _smrt_agent_schedules VALUES
         (?, NULL, 'BulkAgent', NULL, '{}', '* * * * *', 'UTC', 1, 'active',
          NULL, ?, NULL, NULL, 0, 0, 0, 0, '{}')`,
        `bulk-schedule-${index}`,
        '2026-08-11T17:00:00.000Z',
      );
      await db.query(
        `INSERT INTO _smrt_dispatch VALUES
         (?, NULL, 'bulk.ready', 'system', '{}', '{}', 'pending', 0, NULL,
          NULL, NULL, ?, ?)`,
        `bulk-dispatch-${index}`,
        '2026-08-11T17:00:00.000Z',
        '2026-08-11T17:00:00.000Z',
      );
    }
    const reader = new SystemDiagnosticsReader(auditedDb, {
      engine: 'sqlite',
      scope: { mode: 'global' },
      now: () => NOW,
    });

    const migrations = await reader.migrationStatus({ limit: 1 });
    const schedules = await reader.scheduleHealth({ limit: 1 });
    const dispatch = await reader.dispatchHealth({ limit: 1 });

    expect(migrations.data?.counts.pending).toBe(60);
    expect(migrations.data?.migrations).toHaveLength(1);
    expect(schedules.data?.countsByStatus.active).toBe(61);
    expect(schedules.data?.due).toBe(60);
    expect(schedules.data?.schedules).toHaveLength(1);
    expect(dispatch.data?.pending).toBe(61);
    expect(dispatch.data?.dispatches).toHaveLength(1);
  });

  it('reports an unavailable category without creating a missing table', async () => {
    const emptyDb = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      dbid: `system-diagnostics-empty-${crypto.randomUUID()}`,
    });
    const statements: string[] = [];
    const proxy = new Proxy(emptyDb, {
      get(target, property, receiver) {
        if (property !== 'query')
          return Reflect.get(target, property, receiver);
        return async (statement: string, ...params: unknown[]) => {
          statements.push(statement);
          return target.query(statement, ...params);
        };
      },
    });
    const reader = new SystemDiagnosticsReader(proxy, {
      engine: 'sqlite',
      scope: { mode: 'global' },
    });

    await expect(reader.migrationStatus()).resolves.toMatchObject({
      status: 'unavailable',
      data: null,
      diagnostics: [{ code: 'table-unavailable' }],
    });
    expect(statements).toHaveLength(1);
    expect(statements[0].trim()).toMatch(/^SELECT\b/i);
    const table = await emptyDb.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smrt_schema_migrations'",
    );
    expect(table.rows).toHaveLength(0);
    await closeTestDatabase(emptyDb);
  });

  it('keeps PostgreSQL placeholder numbering aligned with scoped aggregate parameters', async () => {
    const calls: Array<{ statement: string; params: unknown[] }> = [];
    const postgresDb = {
      query: async (statement: string, ...params: unknown[]) => {
        calls.push({ statement, params });
        return { rows: [] };
      },
    } as unknown as DatabaseInterface;
    const reader = new SystemDiagnosticsReader(postgresDb, {
      engine: 'postgres',
      scope: { mode: 'tenant', tenantId: 'tenant-a' },
      now: () => NOW,
    });

    await reader.scheduleHealth();
    await reader.dispatchHealth();

    const scheduleAggregate = calls.find((call) =>
      call.statement.includes('AS due_count'),
    );
    expect(scheduleAggregate?.statement).toMatch(/next_run <= \$2/);
    expect(scheduleAggregate?.statement).toMatch(/next_run < \$3/);
    expect(scheduleAggregate?.statement).toMatch(/tenant_id = \$1/);
    expect(scheduleAggregate?.params).toEqual([
      'tenant-a',
      NOW.toISOString(),
      '2026-08-11T17:55:00.000Z',
    ]);

    const dispatchAggregate = calls.find((call) =>
      call.statement.includes('AS stuck_count'),
    );
    expect(dispatchAggregate?.statement).toMatch(/updated_at < \$2/);
    expect(dispatchAggregate?.statement).toMatch(/tenant_id = \$1/);
    expect(dispatchAggregate?.params).toEqual([
      'tenant-a',
      '2026-08-11T17:55:00.000Z',
    ]);
  });

  it('redacts credential URLs, tokens, and secret key/value pairs', () => {
    const value = redactSystemDiagnosticText(
      'postgres://user:password@db/app apiKey=sk-ABCDEFGHIJKLMNOP password=hunter2',
    );
    expect(value).not.toContain('user:password');
    expect(value).not.toContain('ABCDEFGHIJKLMNOP');
    expect(value).not.toContain('hunter2');
  });
});

async function closeTestDatabase(db: DatabaseInterface): Promise<void> {
  const client = db.client as { close?: () => void | Promise<void> };
  await client.close?.();
}

async function seedSystemTables(db: DatabaseInterface): Promise<void> {
  const statements = [
    `CREATE TABLE _smrt_schema_migrations (
      id TEXT PRIMARY KEY, name TEXT, version TEXT, package_name TEXT,
      status TEXT, applied_at TEXT, execution_time_ms INTEGER,
      attempts INTEGER, error_message TEXT
    )`,
    `CREATE TABLE _smrt_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT, queue TEXT, object_type TEXT,
      method TEXT, args TEXT, run_at TEXT, status TEXT, attempts INTEGER,
      max_attempts INTEGER, started_at TEXT, completed_at TEXT,
      last_error TEXT, worker_id TEXT, worker_heartbeat TEXT
    )`,
    `CREATE TABLE _smrt_workers (
      worker_id TEXT PRIMARY KEY, status TEXT, lease_expires_at TEXT
    )`,
    `CREATE TABLE _smrt_agent_schedules (
      id TEXT PRIMARY KEY, tenant_id TEXT, agent_type TEXT, agent_id TEXT,
      agent_config TEXT, cron TEXT, timezone TEXT, enabled INTEGER,
      status TEXT, last_run TEXT, next_run TEXT, last_status TEXT,
      last_error TEXT, run_count INTEGER, success_count INTEGER,
      failure_count INTEGER, running_count INTEGER, method_args TEXT
    )`,
    `CREATE TABLE _smrt_dispatch (
      id TEXT PRIMARY KEY, tenant_id TEXT, type TEXT, source TEXT, payload TEXT,
      metadata TEXT, status TEXT, attempts INTEGER, last_error TEXT,
      processed_at TEXT, target_subscriber TEXT, created_at TEXT, updated_at TEXT
    )`,
    `CREATE TABLE _smrt_dispatch_subscriptions (
      id TEXT PRIMARY KEY, signal_type TEXT, subscriber TEXT, delivery TEXT,
      enabled INTEGER, tenant_id TEXT, updated_at TEXT
    )`,
    `CREATE TABLE _smrt_changes (
      seq INTEGER PRIMARY KEY, table_name TEXT, row_id TEXT, operation TEXT,
      tenant_id TEXT, created_at TEXT
    )`,
    `CREATE TABLE _smrt_registry (
      class_name TEXT PRIMARY KEY, schema_version TEXT, fields TEXT,
      relationships TEXT, config TEXT, manifest TEXT, last_updated TEXT
    )`,
  ];
  for (const statement of statements) await db.query(statement);

  await db.query(
    `INSERT INTO _smrt_schema_migrations
      VALUES ('m1', 'failed migration', '1', '@happyvertical/smrt-core', 'failed',
              ?, 12, 2, 'postgres://user:secret@db/app password=hunter2')`,
    '2026-08-11T17:00:00.000Z',
  );
  await db.query(
    `INSERT INTO _smrt_workers VALUES ('worker-live', 'running', ?)`,
    '2026-08-11T19:00:00.000Z',
  );
  await db.query(
    `INSERT INTO _smrt_workers VALUES ('worker-dead', 'running', ?)`,
    '2026-08-11T17:00:00.000Z',
  );
  await db.query(
    `INSERT INTO _smrt_jobs VALUES
      ('job-stuck', 'tenant-a', 'default', 'Report', 'run', '{"password":"job-secret"}', ?, 'running', 1, 3, ?, NULL, 'apiKey=job-secret', 'worker-dead', ?),
      ('job-tenant-failed', 'tenant-a', 'critical', 'Report', 'run', '{}', ?, 'failed', 3, 3, ?, ?, 'token=tenant-secret', NULL, NULL),
      ('job-global-failed', NULL, 'default', 'Cleanup', 'run', '{}', ?, 'failed', 1, 3, ?, ?, 'password=global-secret', NULL, NULL),
      ('job-tenant-b', 'tenant-b', 'private', 'Billing', 'run', '{}', ?, 'failed', 1, 3, ?, ?, 'tenant-b', NULL, NULL)`,
    '2026-08-11T17:00:00.000Z',
    '2026-08-11T17:00:00.000Z',
    '2026-08-11T17:30:00.000Z',
    '2026-08-11T17:30:00.000Z',
    '2026-08-11T17:31:00.000Z',
    '2026-08-11T17:40:00.000Z',
    '2026-08-11T17:40:00.000Z',
    '2026-08-11T17:41:00.000Z',
    '2026-08-11T17:50:00.000Z',
    '2026-08-11T17:50:00.000Z',
    '2026-08-11T17:51:00.000Z',
  );
  await db.query(
    `INSERT INTO _smrt_agent_schedules VALUES
      ('schedule-overdue', 'tenant-a', 'DigestAgent', NULL, '{"apiKey":"schedule-secret"}', '0 * * * *', 'UTC', 1, 'active', NULL, ?, 'failed', 'password=schedule-secret', 3, 2, 1, 0, '{"token":"args-secret"}'),
      ('schedule-global', NULL, 'CleanupAgent', NULL, '{}', '0 0 * * *', 'UTC', 1, 'active', NULL, ?, 'success', NULL, 1, 1, 0, 0, '{}'),
      ('schedule-tenant-b', 'tenant-b', 'BillingAgent', NULL, '{}', '* * * * *', 'UTC', 1, 'active', NULL, ?, 'success', 'tenant-b', 1, 1, 0, 0, '{}')`,
    '2026-08-11T17:00:00.000Z',
    '2026-08-11T19:00:00.000Z',
    '2026-08-11T19:00:00.000Z',
  );
  await db.query(
    `INSERT INTO _smrt_dispatch VALUES
      ('dispatch-stuck', 'tenant-a', 'report.ready', 'agent', '{"password":"dispatch-secret"}', '{"token":"metadata-secret"}', 'processing', 1, 'apiKey=dispatch-secret', NULL, 'worker', ?, ?),
      ('dispatch-global', NULL, 'cleanup.ready', 'system', '{}', '{}', 'pending', 0, NULL, NULL, NULL, ?, ?),
      ('dispatch-tenant-b', 'tenant-b', 'billing.ready', 'agent', '{}', '{}', 'pending', 0, 'tenant-b', NULL, NULL, ?, ?)`,
    '2026-08-11T16:00:00.000Z',
    '2026-08-11T17:00:00.000Z',
    '2026-08-11T17:00:00.000Z',
    '2026-08-11T17:55:00.000Z',
    '2026-08-11T17:00:00.000Z',
    '2026-08-11T17:55:00.000Z',
  );
  await db.query(
    `INSERT INTO _smrt_dispatch_subscriptions VALUES
      ('sub-a', 'report.*', 'tenant-a-worker', 'compete', 1, 'tenant-a', ?),
      ('sub-global', 'cleanup.*', 'global-worker', 'compete', 1, NULL, ?),
      ('sub-b', 'billing.*', 'tenant-b-worker', 'compete', 1, 'tenant-b', ?)`,
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
  );
  await db.query(
    `INSERT INTO _smrt_changes VALUES
      (1, 'articles', 'global-row', 'update', NULL, ?),
      (2, 'articles', 'tenant-a-row', 'update', 'tenant-a', ?),
      (3, 'articles', 'tenant-b-row', 'update', 'tenant-b', ?)`,
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
  );
  await db.query(
    `INSERT INTO _smrt_registry VALUES
      ('Article', '3', '{"password":"registry-secret"}', '{}',
       '{"apiKey":"registry-secret"}', '{"tableName":"articles","token":"registry-secret"}', ?)`,
    '2026-08-11T17:00:00.000Z',
  );
}
