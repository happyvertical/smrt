import {
  getTestDatabase,
  ObjectRegistry,
  SMRT_SCHEMA_VERSION,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunner } from '../runner.js';
import { createScheduleRunner } from '../schedule-runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

@smrt()
class JobTenantProbe extends SmrtObject {
  async captureTenantId(): Promise<string | null> {
    return getTenantId() ?? null;
  }
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
});

describe('job tenancy propagation', () => {
  it('captures tenantId when jobs are created inside a tenant context', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    let savedJobId = '';

    await withTenant({ tenantId: 'tenant-create' }, async () => {
      const job = await collection.create({
        objectType: 'JobTenantProbe',
        method: 'captureTenantId',
        args: {},
      });
      savedJobId = job.id ?? '';
      expect(job.tenantId).toBe('tenant-create');
    });

    const savedJob = await collection.get({ id: savedJobId });
    expect(savedJob?.tenantId).toBe('tenant-create');
  });

  it('preserves explicit null tenantId for global jobs inside a tenant context', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    const job = await withTenant({ tenantId: 'tenant-create' }, async () =>
      collection.create({
        tenantId: null,
        objectType: 'JobTenantProbe',
        method: 'captureTenantId',
        args: {},
      }),
    );

    expect(job.tenantId).toBeNull();

    const savedJob = await collection.get({ id: job.id ?? '' });
    expect(savedJob?.tenantId).toBeNull();
  });

  it('restores tenant context while TaskRunner executes a job', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });
    const job = await collection.create({
      tenantId: 'tenant-runner',
      objectType: 'JobTenantProbe',
      method: 'captureTenantId',
      args: {},
    });
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const completion = new Promise<{ result?: unknown }>((resolve, reject) => {
      runner.once('job:completed', (_completedJob, result) =>
        resolve(result as { result?: unknown }),
      );
      runner.once('job:failed', (_failedJob, error) => reject(error));
      runner.once('runner:error', reject);
    });

    await runner.start();

    try {
      const { result } = await completion;
      expect(result).toBe('tenant-runner');
    } finally {
      await runner.stop();
    }
  });

  it('copies tenantId from schedules onto created jobs', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });

    await db.query(`
      CREATE TABLE _smrt_agent_schedules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        agent_type TEXT NOT NULL,
        agent_id TEXT,
        agent_config TEXT,
        cron TEXT NOT NULL,
        method TEXT,
        method_args TEXT,
        timeout INTEGER,
        enabled BOOLEAN NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        next_run TIMESTAMP,
        running_count INTEGER NOT NULL DEFAULT 0,
        max_concurrent INTEGER NOT NULL DEFAULT 1
      )
    `);

    await db.query(
      `INSERT INTO _smrt_agent_schedules (
        id, tenant_id, agent_type, agent_id, agent_config, cron, method,
        method_args, timeout, enabled, status, next_run, running_count, max_concurrent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'schedule-1',
      'tenant-schedule',
      'JobTenantProbe',
      null,
      '{}',
      '* * * * *',
      'captureTenantId',
      '{}',
      60000,
      1,
      'active',
      new Date(Date.now() - 60_000).toISOString(),
      0,
      1,
    );

    const runner = createScheduleRunner({ pollInterval: 60_000 });
    await runner.initialize(db);
    await (runner as unknown as { poll(): Promise<void> }).poll();

    const collection = await SmrtJobCollection.create({ db });
    const jobs = await collection.list({});

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.tenantId).toBe('tenant-schedule');
  });

  it('upgrades legacy jobs tables even when system tables are already current', async () => {
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

    await db.query(`
      INSERT INTO _smrt_migrations (id, version, description)
      VALUES ('migration-1', '${SMRT_SCHEMA_VERSION}', 'current system schema')
    `);

    await SmrtJobCollection.create({ db });

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
});
