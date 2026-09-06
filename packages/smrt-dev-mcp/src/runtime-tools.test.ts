/**
 * Runtime diagnostics tool tests (#1824).
 *
 * Real SQLite database (file-backed so the connection resolver can open it by
 * URL like a dev database), no mocks. System tables are provisioned via
 * `ensureSystemTables`; jobs/agents-owned tables are created with the column
 * shapes their owning packages define, and rows are seeded directly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSystemTables } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactConnectionString } from './tools/runtime/connection.js';
import {
  RUNTIME_PROVENANCE,
  runtimeDispatchHealth,
  runtimeJobHealth,
  runtimeMigrationStatus,
  runtimeRecentChanges,
  runtimeRegistryDrift,
  runtimeScheduleHealth,
  STATIC_PROVENANCE,
} from './tools/runtime/tools.js';

let dbDir: string;
let dbUrl: string;
let admin: DatabaseInterface;

const ENV_KEYS = ['SMRT_DEV_DB_URL'] as const;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'smrt-dev-mcp-runtime-'));
  // `file:` URL — the repo's documented sqlite connection format
  // (packages/config/src/types.ts); `@happyvertical/sql` passes `file:` through
  // to libsql verbatim.
  dbUrl = `file:${join(dbDir, 'dev.db')}`;
  for (const key of ENV_KEYS) delete process.env[key];
  admin = await getDatabase({ type: 'sqlite', url: dbUrl });
  await ensureSystemTables(admin);
  await createJobsTables(admin);
  await seed(admin);
});

afterEach(async () => {
  await admin.close?.();
  rmSync(dbDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) delete process.env[key];
});

async function createJobsTables(database: DatabaseInterface): Promise<void> {
  // Column shapes mirror the @smrt() definitions in packages/jobs
  // (SmrtJob / SmrtJobEvent / SmrtWorker) and packages/agents (AgentSchedule).
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

async function seed(database: DatabaseInterface): Promise<void> {
  await database.query(
    `INSERT INTO _smrt_schema_migrations
       (id, name, version, checksum, status, applied_at, error_message, package_name)
     VALUES
       ('m1', '0001_init', '0.1.0', 'c8e1', 'completed', '2026-08-29T10:00:00.000Z', NULL, 'app'),
       ('m2', '0002_failed', '0.2.0', 'c8e2', 'failed', '2026-08-29T11:00:00.000Z', 'boom: password=hunter2', 'app')`,
  );
  await database.query(
    `INSERT INTO _smrt_jobs
       (id, queue, object_type, method, run_at, status, attempts, last_error, worker_heartbeat)
     VALUES
       ('j1', 'default', 'Article', 'refresh', '2026-08-29T10:05:00.000Z', 'failed', 3, 'task exploded: postgres://u:hunter2@db/app', NULL),
       ('j2', 'default', 'Article', 'refresh', '2026-08-29T10:06:00.000Z', 'running', 1, NULL, '2026-08-29T10:06:30.000Z')`,
  );
  await database.query(
    `INSERT INTO _smrt_workers (id, worker_id, pid, hostname, heartbeat_at, status)
     VALUES ('w1', 'worker-a', 4242, 'dev.local', '2026-08-29T10:06:30.000Z', 'running')`,
  );
  await database.query(
    `INSERT INTO _smrt_agent_schedules
       (id, agent_type, agent_config, cron, enabled, status, last_run, next_run, last_status, last_error, method_args)
     VALUES
       ('s1', 'DigestAgent', '{"apiKey":"secret-value"}', '0 9 * * *', 1, 'error',
        '2026-08-28T09:00:00.000Z', '2026-08-29T09:00:00.000Z', 'failed', 'agent failed', '{"mode":"fast"}')`,
  );
  await database.query(
    `INSERT INTO _smrt_dispatch (id, type, source, status, payload, created_at)
     VALUES ('d1', 'article.published', 'article-service', 'pending', '{"secret":"payload"}', '2026-08-29T10:07:00.000Z')`,
  );
  await database.query(
    `INSERT INTO _smrt_dispatch_subscriptions
       (id, signal_type, subscriber, handler, delivery, enabled, created_at, updated_at)
     VALUES ('sub1', 'article.published', 'cache-warmer', 'onPublish', 'sync', 1,
       '2026-08-29T10:07:00.000Z', '2026-08-29T10:07:00.000Z')`,
  );
}

function collectSensitiveKeys(
  value: unknown,
  path: string,
  found: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveKeys(item, path, found);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (
        key === 'agentConfig' ||
        key === 'agent_config' ||
        key === 'methodArgs' ||
        key === 'method_args' ||
        key === 'payload' ||
        key === 'result' ||
        key === 'taskResult' ||
        key === 'task_result' ||
        key === 'args' ||
        key === 'metadata'
      ) {
        found.push(childPath);
      }
      collectSensitiveKeys(child, childPath, found);
    }
  }
}

function assertNoSensitiveKeys(envelope: unknown): void {
  const found: string[] = [];
  collectSensitiveKeys(envelope, '$', found);
  expect(found, `sensitive keys leaked: ${found.join(', ')}`).toEqual([]);
}

async function tableCounts(
  database: DatabaseInterface,
): Promise<Record<string, number>> {
  const tables = [
    '_smrt_schema_migrations',
    '_smrt_dispatch',
    '_smrt_dispatch_subscriptions',
    '_smrt_changes',
    '_smrt_jobs',
    '_smrt_job_events',
    '_smrt_workers',
    '_smrt_agent_schedules',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await database.query(
      `SELECT COUNT(*) AS total FROM ${table}`,
    );
    const rows = Array.isArray(result) ? result : (result.rows as unknown[]);
    counts[table] = Number((rows[0] as { total?: unknown }).total ?? 0);
  }
  return counts;
}

describe('runtime diagnostics tools (#1824)', () => {
  it('returns live state for every tool against the seeded dev database', async () => {
    const results = await Promise.all([
      runtimeMigrationStatus({ dbUrl }),
      runtimeJobHealth({ dbUrl }),
      runtimeScheduleHealth({ dbUrl }),
      runtimeDispatchHealth({ dbUrl }),
      runtimeRecentChanges({ dbUrl }),
      runtimeRegistryDrift({ dbUrl }),
    ]);
    const [migrations, jobs, schedules, dispatch, changes, registry] = results;

    expect(migrations.ok).toBe(true);
    expect(migrations.data.provenance).toBe(RUNTIME_PROVENANCE);
    expect(migrations.data.connected).toBe(true);
    expect((migrations.data.summary as { failed: number }).failed).toBe(1);

    expect(jobs.data.provenance).toBe(RUNTIME_PROVENANCE);
    expect((jobs.data.summary as { failed: number }).failed).toBe(1);

    expect(schedules.data.provenance).toBe(RUNTIME_PROVENANCE);
    expect((schedules.data.summary as { errored: number }).errored).toBe(1);

    expect(dispatch.data.provenance).toBe(RUNTIME_PROVENANCE);
    expect((dispatch.data.summary as { total: number }).total).toBe(1);

    expect(changes.data.provenance).toBe(RUNTIME_PROVENANCE);
    expect((changes.data.count as number) >= 0).toBe(true);

    expect(registry.data.provenance).toBe(RUNTIME_PROVENANCE);
    expect(registry.data.reason).toBe('retired');
    expect(registry.data.stillPresent).toBe(false);
  });

  it('never leaks sensitive columns in any live result', async () => {
    const envelopes = await Promise.all([
      runtimeMigrationStatus({ dbUrl }),
      runtimeJobHealth({ dbUrl }),
      runtimeScheduleHealth({ dbUrl }),
      runtimeDispatchHealth({ dbUrl }),
      runtimeRecentChanges({ dbUrl }),
      runtimeRegistryDrift({ dbUrl }),
    ]);
    for (const envelope of envelopes) {
      assertNoSensitiveKeys(envelope);
      // Seeded error columns quote a credential; values must be redacted too.
      expect(JSON.stringify(envelope)).not.toContain('hunter2');
    }
    const migrations = envelopes[0];
    expect(JSON.stringify(migrations.data)).toContain('password=***');
  });

  it('degrades to a successful static-only envelope with no connection', async () => {
    const envelope = await runtimeMigrationStatus({});
    expect(envelope.ok).toBe(true);
    expect(envelope.data.provenance).toBe(STATIC_PROVENANCE);
    expect(envelope.data.connected).toBe(false);
    expect(envelope.diagnostics[0]?.code).toBe(
      'runtime_connection_unavailable',
    );
  });

  it('returns a safe diagnostic envelope for an unreachable database', async () => {
    const envelope = await runtimeMigrationStatus({
      dbUrl: `sqlite:${join(dbDir, 'nonexistent')}/missing.db`,
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.diagnostics[0]?.code).toBe('runtime_connection_error');
  });

  it('performs no writes across all tool reads', async () => {
    const before = await tableCounts(admin);
    await Promise.all([
      runtimeMigrationStatus({ dbUrl }),
      runtimeJobHealth({ dbUrl }),
      runtimeScheduleHealth({ dbUrl }),
      runtimeDispatchHealth({ dbUrl }),
      runtimeRecentChanges({ dbUrl }),
      runtimeRegistryDrift({ dbUrl }),
    ]);
    const after = await tableCounts(admin);
    expect(after).toEqual(before);
  });

  it('resolves the connection from SMRT_DEV_DB_URL', async () => {
    process.env.SMRT_DEV_DB_URL = dbUrl;
    const envelope = await runtimeJobHealth({});
    expect(envelope.data.provenance).toBe(RUNTIME_PROVENANCE);
    expect(envelope.data.connectionSource).toBe('environment');
  });

  it('masks camelCase sensitive query params like authToken', () => {
    expect(
      redactConnectionString(
        'libsql://my-db.turso.io?authToken=eyJhbGciOiJIUzI1NiJ9.secret',
      ),
    ).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(
      redactConnectionString(
        'postgres://user:p%40ss@localhost:5432/app?accessToken=abc123&ssl=true',
      ),
    ).not.toContain('abc123');
    expect(redactConnectionString('postgres://u@h/db?ssl=true')).not.toContain(
      '***',
    );
  });

  it('masks sensitive pairs embedded in free-text error messages', () => {
    expect(
      redactConnectionString(
        'connect failed for postgres://user@host/db?password=hunter2 timeout',
      ),
    ).not.toContain('hunter2');
    expect(
      redactConnectionString('boom: password=hunter2 at connector'),
    ).not.toContain('hunter2');
  });

  it('masks a sensitive pair at the very start of a message', () => {
    expect(redactConnectionString('password=hunter2 rejected')).not.toContain(
      'hunter2',
    );
    expect(redactConnectionString('authToken=abc123')).toBe('authToken=***');
  });

  it('masks sensitive pairs preceded by comma or parenthesis', () => {
    expect(
      redactConnectionString('failed (password=hunter2) after 3 tries'),
    ).not.toContain('hunter2');
    expect(
      redactConnectionString('hosts: a=db,b=db2 password=hunter2; retrying'),
    ).not.toContain('hunter2');
  });

  it('masks connectionString-style params', () => {
    expect(
      redactConnectionString(
        'config connectionString=postgres://user:secretpw@host/db rejected',
      ),
    ).not.toContain('secretpw');
  });

  it('masks an unencoded @ inside a quoted URL password', () => {
    expect(
      redactConnectionString(
        'connect "postgres://user:p@ss!@host:5432/db" failed',
      ),
    ).not.toContain('p@ss!');
  });
});
