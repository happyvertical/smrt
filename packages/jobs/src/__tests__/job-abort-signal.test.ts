/**
 * Cooperative cancellation: `JobExecutionContext.signal` (#4518).
 */
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import type { JobExecutionContext } from '../logger-extension.js';
import { McpTaskStore } from '../mcp-task.js';
import {
  createTaskRunner,
  JobCancelledError,
  JobTimeoutError,
  TaskRunner,
} from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

const seen: Record<string, { signal?: AbortSignal; aborted?: boolean }> = {};

function waitAbort(
  signal: AbortSignal,
  ms: number,
): Promise<'aborted' | 'done'> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('aborted');
    const t = setTimeout(() => resolve('done'), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve('aborted');
      },
      { once: true },
    );
  });
}

@smrt()
class AbortProbe extends SmrtObject {
  @backgroundEligible()
  async quick(_a: unknown, ctx?: JobExecutionContext) {
    seen.quick = { signal: ctx?.signal, aborted: ctx?.signal.aborted };
    return 'ok';
  }

  @backgroundEligible()
  async cooperative(args: { key: string }, ctx?: JobExecutionContext) {
    const signal = ctx?.signal as AbortSignal;
    seen[args.key] = { signal };
    const outcome = await waitAbort(signal, 5000);
    seen[args.key].aborted = outcome === 'aborted';
    if (outcome === 'aborted') throw signal.reason;
    return 'finished';
  }

  @backgroundEligible()
  async slow(args: { key: string; ms: number }, ctx?: JobExecutionContext) {
    seen[args.key] = { signal: ctx?.signal };
    const outcome = await waitAbort(ctx?.signal as AbortSignal, args.ms);
    seen[args.key].aborted = outcome === 'aborted';
    return outcome;
  }
}

async function setup() {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  const collection = await SmrtJobCollection.create({ db });
  const objectType =
    ObjectRegistry.getClass('AbortProbe')?.qualifiedName || 'AbortProbe';
  return { db, collection, objectType };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

describe('JobExecutionContext.signal', () => {
  it('is present and not aborted for a normal job, and its poll timer is cleared', async () => {
    const { db, collection, objectType } = await setup();
    const job = await collection.create({
      objectType,
      method: 'quick',
      args: {},
    });
    await job.save();
    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    const done = new Promise((r) => runner.once('job:completed', r));
    await runner.start();
    await done;
    await runner.stop();
    expect(seen.quick.signal).toBeInstanceOf(AbortSignal);
    expect(seen.quick.aborted).toBe(false);
    expect(
      (runner as unknown as { jobAborts: Map<string, unknown> }).jobAborts.size,
    ).toBe(0);
  });

  it('aborts after cancel() of a running job; the row stays cancelled', async () => {
    const { db, collection, objectType } = await setup();
    const job = await collection.create({
      objectType,
      method: 'cooperative',
      args: { key: 'cancel' },
      maxAttempts: 3,
    });
    await job.save();
    const runner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      cancelPollInterval: 20,
    });
    await runner.initialize(db);
    const failures: unknown[] = [];
    runner.on('job:failed', (_j, e) => failures.push(e));
    runner.on('job:retrying', (_j, e) => failures.push(e));
    await runner.start();
    try {
      await until(() => seen.cancel?.signal !== undefined);
      const running = await collection.get({ id: job.id ?? '' });
      expect(running?.status).toBe('running');
      await running?.cancel();
      await until(() => seen.cancel.aborted === true);
      expect(seen.cancel.signal?.reason).toBeInstanceOf(JobCancelledError);
      await until(() => runner.activeJobCount() === 0);
      const after = await collection.get({ id: job.id ?? '' });
      expect(after?.status).toBe('cancelled');
      expect(failures).toHaveLength(0);
    } finally {
      await runner.stop();
    }
  });

  it("aborts with JobTimeoutError on a 'fail' timeout", async () => {
    const { db, collection, objectType } = await setup();
    const job = await collection.create({
      objectType,
      method: 'slow',
      args: { key: 'fail', ms: 3000 },
      timeout: 50,
      timeoutBehavior: 'fail',
      maxAttempts: 1,
    });
    await job.save();
    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    const failed = new Promise((r) => runner.once('job:failed', r));
    await runner.start();
    try {
      await failed;
      await until(() => seen.fail.aborted === true);
      expect(seen.fail.signal?.reason).toBeInstanceOf(JobTimeoutError);
      expect((await collection.get({ id: job.id ?? '' }))?.status).toBe(
        'failed',
      );
    } finally {
      await runner.stop();
    }
  });

  it("does not abort on a 'warn' timeout", async () => {
    const { db, collection, objectType } = await setup();
    const job = await collection.create({
      objectType,
      method: 'slow',
      args: { key: 'warn', ms: 200 },
      timeout: 50,
      timeoutBehavior: 'warn',
    });
    await job.save();
    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    const done = new Promise((r) => runner.once('job:completed', r));
    await runner.start();
    try {
      await done;
      expect(seen.warn.aborted).toBe(false);
      expect(seen.warn.signal?.aborted).toBe(false);
    } finally {
      await runner.stop();
    }
  });

  it('is passed to handlers invoked with the MCP task marker', async () => {
    ObjectRegistry.registerCollection('AbortProbe', AbortProbeCollection);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AbortProbe', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
    });
    const probes = await AbortProbeCollection.create({ db });
    const probe = await probes.create({});
    const store = await McpTaskStore.create(db, { ownerId: 'principal-a' });
    const created = await store.createTask({
      objectType: 'AbortProbe',
      objectId: probe.id ?? '',
      method: 'quick',
      invocationArgs: [{}],
    });
    delete seen.quick;
    const runner = new TaskRunner({
      queues: ['mcp-tasks'],
      pollInterval: 5,
      concurrency: 1,
    });
    await runner.initialize(db);
    await runner.start();
    try {
      await until(
        async () =>
          (await store.getTask(created.taskId)).status === 'completed',
      );
      expect(seen.quick.signal).toBeInstanceOf(AbortSignal);
      expect(seen.quick.aborted).toBe(false);
    } finally {
      await runner.stop();
    }
  });
});

class AbortProbeCollection extends SmrtCollection<AbortProbe> {
  static readonly _itemClass = AbortProbe;
}
