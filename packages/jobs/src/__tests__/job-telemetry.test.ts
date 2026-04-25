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
