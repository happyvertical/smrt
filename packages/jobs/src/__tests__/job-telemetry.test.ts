import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobExecutionContext } from '../logger-extension.js';
import { createTaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';

@smrt()
class JobTelemetryProbe extends SmrtObject {
  async legacyEcho(args: { value: string }): Promise<string> {
    return args.value;
  }

  async reportProgress(
    _args: Record<string, unknown>,
    context?: JobExecutionContext,
  ): Promise<string> {
    await context?.progress({
      stage: 'processing',
      progress: 42,
      message: 'Processing fixture',
      detail: 'halfway-ish',
      source: 'vitest',
    });
    await context?.event({
      type: 'status',
      level: 'info',
      stage: 'checkpoint',
      message: 'Checkpoint recorded',
      data: { ok: true },
    });
    return 'done';
  }
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
});

describe('job telemetry', () => {
  it('appends and lists durable tenant-scoped job events', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    const first = await events.append({
      tenantId: 'tenant-a',
      jobId: 'job-1',
      type: 'progress',
      level: 'info',
      stage: 'download',
      progress: 12,
      message: 'Downloading',
    });
    await events.append({
      tenantId: 'tenant-b',
      jobId: 'job-1',
      type: 'progress',
      level: 'info',
      stage: 'process',
      progress: 80,
      message: 'Processing',
    });
    const second = await events.append({
      tenantId: 'tenant-a',
      jobId: 'job-1',
      type: 'progress',
      level: 'info',
      stage: 'upload',
      progress: 120,
      message: 'Uploading',
    });

    const tenantEvents = await events.listByJob('job-1', {
      tenantId: 'tenant-a',
    });
    expect(tenantEvents.map((event) => event.message)).toEqual([
      'Downloading',
      'Uploading',
    ]);

    const afterFirst = await events.listByJob('job-1', {
      tenantId: 'tenant-a',
      cursor: first.toCursor(),
    });
    expect(afterFirst.map((event) => event.id)).toEqual([second.id]);

    const latest = await events.latestProgressByJobIds(['job-1'], {
      tenantId: 'tenant-a',
    });
    expect(latest.get('job-1')?.stage).toBe('upload');
    expect(latest.get('job-1')?.progress).toBe(100);
  });

  it('uses ambient tenant context for event list helpers', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    await events.append({
      tenantId: 'tenant-a',
      jobId: 'job-1',
      type: 'progress',
      level: 'info',
      stage: 'download',
      progress: 12,
      message: 'Downloading',
    });
    await events.append({
      tenantId: 'tenant-b',
      jobId: 'job-1',
      type: 'progress',
      level: 'info',
      stage: 'process',
      progress: 80,
      message: 'Processing',
    });

    const tenantEvents = await withTenant({ tenantId: 'tenant-a' }, async () =>
      events.listByJob('job-1'),
    );
    expect(tenantEvents.map((event) => event.message)).toEqual(['Downloading']);

    const latest = await withTenant({ tenantId: 'tenant-b' }, async () =>
      events.latestProgressByJobIds(['job-1']),
    );
    expect(latest.get('job-1')?.stage).toBe('process');
  });

  it('treats tenantId undefined as ambient tenant context', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    await events.append({
      tenantId: 'tenant-a',
      jobId: 'job-undefined-tenant',
      type: 'progress',
      level: 'info',
      stage: 'download',
      progress: 10,
      message: 'Tenant A',
    });
    await events.append({
      tenantId: 'tenant-b',
      jobId: 'job-undefined-tenant',
      type: 'progress',
      level: 'info',
      stage: 'process',
      progress: 90,
      message: 'Tenant B',
    });

    const tenantEvents = await withTenant({ tenantId: 'tenant-a' }, async () =>
      events.listByJob('job-undefined-tenant', { tenantId: undefined }),
    );
    expect(tenantEvents.map((event) => event.message)).toEqual(['Tenant A']);

    const latest = await withTenant({ tenantId: 'tenant-b' }, async () =>
      events.latestProgressByJobIds(['job-undefined-tenant'], {
        tenantId: undefined,
      }),
    );
    expect(latest.get('job-undefined-tenant')?.message).toBe('Tenant B');
  });

  it('requires explicit tenant scope for raw event list helpers', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    await events.append({
      tenantId: 'tenant-a',
      jobId: 'job-scope-required',
      type: 'progress',
      level: 'info',
      stage: 'download',
      progress: 10,
      message: 'Tenant A',
    });

    await expect(events.listByJob('job-scope-required')).rejects.toThrow(
      /require tenantId/,
    );
    await expect(
      events.latestProgressByJobIds(['job-scope-required']),
    ).rejects.toThrow(/require tenantId/);
  });

  it('supports explicit global tenant scope', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    await events.append({
      tenantId: null,
      jobId: 'job-global',
      type: 'progress',
      level: 'info',
      stage: 'global',
      progress: 30,
      message: 'Global event',
    });
    await events.append({
      tenantId: 'tenant-a',
      jobId: 'job-global',
      type: 'progress',
      level: 'info',
      stage: 'tenant',
      progress: 90,
      message: 'Tenant event',
    });

    const globalEvents = await events.listByJob('job-global', {
      tenantId: null,
    });
    expect(globalEvents.map((event) => event.message)).toEqual([
      'Global event',
    ]);

    const latest = await events.latestProgressByJobIds(['job-global'], {
      tenantId: null,
    });
    expect(latest.get('job-global')?.stage).toBe('global');
  });

  it('paginates across legacy SQLite timestamp formats', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    await db.query(
      `INSERT INTO _smrt_job_events (
         id, slug, context, created_at, updated_at, tenant_id, job_id, type,
         level, stage, progress, message, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'legacy-event',
      'legacy-event',
      '',
      '2026-04-25 12:00:00',
      '2026-04-25 12:00:00',
      'tenant-a',
      'job-legacy-cursor',
      'progress',
      'info',
      'legacy',
      10,
      'Legacy timestamp',
      '{}',
    );
    await db.query(
      `INSERT INTO _smrt_job_events (
         id, slug, context, created_at, updated_at, tenant_id, job_id, type,
         level, stage, progress, message, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'iso-event',
      'iso-event',
      '',
      '2026-04-25T12:00:01.000Z',
      '2026-04-25T12:00:01.000Z',
      'tenant-a',
      'job-legacy-cursor',
      'progress',
      'info',
      'iso',
      20,
      'ISO timestamp',
      '{}',
    );

    const allEvents = await events.listByJob('job-legacy-cursor', {
      tenantId: 'tenant-a',
    });
    expect(allEvents.map((event) => event.message)).toEqual([
      'Legacy timestamp',
      'ISO timestamp',
    ]);

    const afterLegacy = await events.listByJob('job-legacy-cursor', {
      tenantId: 'tenant-a',
      cursor: allEvents[0]?.toCursor(),
    });
    expect(afterLegacy.map((event) => event.message)).toEqual([
      'ISO timestamp',
    ]);
  });

  it('passes an optional execution context without breaking one-arg methods', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });
    const events = await SmrtJobEventCollection.create({ db });

    const legacyJob = await jobs.create({
      tenantId: 'tenant-runner',
      objectType: 'JobTelemetryProbe',
      method: 'legacyEcho',
      args: { value: 'legacy-ok' },
    });
    const progressJob = await jobs.create({
      tenantId: 'tenant-runner',
      objectType: 'JobTelemetryProbe',
      method: 'reportProgress',
      args: {},
    });

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const completed = new Promise<unknown[]>((resolve, reject) => {
      const results: unknown[] = [];
      runner.on('job:completed', (_job, result) => {
        results.push((result as { result?: unknown }).result);
        if (results.length === 2) {
          resolve(results);
        }
      });
      runner.once('job:failed', (_job, error) => reject(error));
      runner.once('runner:error', reject);
    });

    await runner.start();

    try {
      const results = await completed;
      expect(results).toContain('legacy-ok');
      expect(results).toContain('done');
    } finally {
      await runner.stop();
    }

    const legacyEvents = await events.listByJob(legacyJob.id ?? '', {
      tenantId: 'tenant-runner',
    });
    expect(legacyEvents.some((event) => event.stage === 'completed')).toBe(
      true,
    );

    const progressEvents = await events.listByJob(progressJob.id ?? '', {
      tenantId: 'tenant-runner',
    });
    expect(
      progressEvents.some(
        (event) =>
          event.type === 'progress' &&
          event.stage === 'processing' &&
          event.progress === 42,
      ),
    ).toBe(true);
    expect(
      progressEvents.some((event) => event.message === 'Checkpoint recorded'),
    ).toBe(true);
  });

  it('keeps running jobs when telemetry persistence is unavailable', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    await jobs.create({
      tenantId: 'tenant-runner',
      objectType: 'JobTelemetryProbe',
      method: 'legacyEcho',
      args: { value: 'telemetry-best-effort' },
    });

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    await db.query('DROP TABLE _smrt_job_events');

    const telemetryErrors: Error[] = [];
    runner.on('runner:error', (error) => {
      telemetryErrors.push(error);
    });

    const completed = new Promise<unknown>((resolve, reject) => {
      runner.once('job:completed', (_job, result) =>
        resolve((result as { result?: unknown }).result),
      );
      runner.once('job:failed', (_job, error) => reject(error));
    });

    await runner.start();

    try {
      await expect(completed).resolves.toBe('telemetry-best-effort');
      expect(telemetryErrors.length).toBeGreaterThan(0);
    } finally {
      await runner.stop();
    }
  });
});
