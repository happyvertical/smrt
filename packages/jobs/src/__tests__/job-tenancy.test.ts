import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
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
      await job.save();
      savedJobId = job.id ?? '';
      expect(job.tenantId).toBe('tenant-create');
    });

    const savedJob = await collection.get({ id: savedJobId });
    expect(savedJob?.tenantId).toBe('tenant-create');
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
});
