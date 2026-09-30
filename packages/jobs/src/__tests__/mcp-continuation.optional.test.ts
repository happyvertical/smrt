import { randomUUID } from 'node:crypto';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobExecutionContext } from '../logger-extension.js';
import { McpTaskStore } from '../mcp-task.js';
import { TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

const binding = {
  recordId: 'review-1',
  revision: 'immutable-1',
  inputKey: 'answer',
};
let applications = 0;
let unknownOutcome = false;
let beforeApply: (() => Promise<void>) | undefined;

@smrt()
class DurableContinuationProbe extends SmrtObject {
  name = '';
  async review(_options: unknown, context?: JobExecutionContext) {
    const answer = await context?.task?.requestContinuation(binding, {
      type: 'string',
    });
    await beforeApply?.();
    await context?.task?.assertAuthorized();
    applications++;
    if (unknownOutcome)
      throw new Error('External outcome unknown; reconcile manually');
    return { answer };
  }
}
class DurableContinuationProbeCollection extends SmrtCollection<DurableContinuationProbe> {
  static readonly _itemClass = DurableContinuationProbe;
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
  beforeApply = undefined;
  applications = 0;
  unknownOutcome = false;
});

async function fixture(tenantId: string | null = null) {
  ObjectRegistry.registerCollection(
    'DurableContinuationProbe',
    DurableContinuationProbeCollection,
  );
  const db = await getTestDatabase({
    type: process.env.SMRT_TEST_POSTGRES_URL ? 'postgres' : 'sqlite',
    url: process.env.SMRT_TEST_POSTGRES_URL ?? ':memory:',
    classes: [
      'DurableContinuationProbe',
      'SmrtJob',
      'SmrtJobEvent',
      'SmrtWorker',
    ],
  });
  const objects = await DurableContinuationProbeCollection.create({ db });
  const probe = await objects.create({ name: randomUUID() });
  const ownerId = randomUUID();
  const store = await McpTaskStore.create(db, { ownerId, tenantId });
  const task = await store.createTask({
    objectType: 'DurableContinuationProbe',
    objectId: probe.id ?? '',
    method: 'review',
    invocationArgs: [{}],
    continuation: binding,
    tenantId,
  });
  const runners: TaskRunner[] = [];
  const start = async (authorize = async () => true) => {
    const runner = new TaskRunner({
      queues: ['mcp-tasks'],
      pollInterval: 5,
      concurrency: 1,
      authorizeMcpTask: authorize,
      retention: false,
    });
    await runner.initialize(db);
    await runner.start();
    runners.push(runner);
    return runner;
  };
  return {
    db,
    store,
    task,
    start,
    ownerId,
    stop: async () => {
      for (const runner of runners) await runner.stop();
    },
  };
}

async function waitForStatus(store: McpTaskStore, id: string, status: string) {
  for (let count = 0; count < 300; count++) {
    const task = await store.getTask(id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task did not reach ${status}`);
}

describe('durable MCP continuation persistence', () => {
  it('releases the worker, survives restart, and accepts only the first complete answer', async () => {
    const f = await fixture();
    try {
      const first = await f.start();
      await waitForStatus(f.store, f.task.taskId, 'input_required');
      await first.stop();
      const jobs = await SmrtJobCollection.create({ db: f.db });
      expect(
        await jobs.claimReady({ workerId: 'uninvited', queues: ['mcp-tasks'] }),
      ).toHaveLength(0);
      expect(await f.store.getContinuation(f.task.taskId)).toMatchObject({
        binding,
        inputRequests: { answer: { type: 'string' } },
      });
      const restored = await McpTaskStore.create(f.db, { ownerId: f.ownerId });
      await restored.updateTask(f.task.taskId, { unknown: 'ignored' });
      for (const answer of [undefined, Number.NaN, 'x'.repeat(65_537)]) {
        await expect(
          restored.updateTask(f.task.taskId, { answer }),
        ).rejects.toThrow('must be JSON');
      }
      await Promise.all([
        restored.updateTask(f.task.taskId, { answer: 'first' }),
        restored.updateTask(f.task.taskId, { answer: 'second' }),
      ]);
      await f.start();
      const result = await waitForStatus(restored, f.task.taskId, 'completed');
      if (!result.result) throw new Error('Missing task result');
      expect(['first', 'second']).toContain(
        (result.result.structuredContent as { data: { answer: string } }).data
          .answer,
      );
      await restored.updateTask(f.task.taskId, { answer: 'third' });
      expect(applications).toBe(1);
    } finally {
      await f.stop();
    }
  });

  it('fails closed when permission is revoked before resume', async () => {
    const f = await fixture();
    try {
      const first = await f.start();
      await waitForStatus(f.store, f.task.taskId, 'input_required');
      await first.stop();
      await f.store.updateTask(f.task.taskId, { answer: 'yes' });
      await f.start(async () => false);
      await waitForStatus(f.store, f.task.taskId, 'failed');
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
  });

  it('denies a guessed task to another actor or active tenant', async () => {
    const tenantId = randomUUID();
    const f = await fixture(tenantId);
    try {
      for (const options of [
        { ownerId: 'other', tenantId },
        { ownerId: f.ownerId },
        { ownerId: f.ownerId, tenantId: randomUUID() },
      ]) {
        const other = await McpTaskStore.create(f.db, options);
        await expect(other.getContinuation(f.task.taskId)).rejects.toThrow(
          'not found',
        );
        await expect(other.getTask(f.task.taskId)).rejects.toThrow('not found');
        await expect(
          other.updateTask(f.task.taskId, { answer: 'yes' }),
        ).rejects.toThrow('not found');
        await expect(other.cancelTask(f.task.taskId)).rejects.toThrow(
          'not found',
        );
      }
    } finally {
      await f.stop();
    }
  });

  it('does not apply after cancellation races with an accepted answer', async () => {
    const f = await fixture();
    try {
      await f.start();
      await waitForStatus(f.store, f.task.taskId, 'input_required');
      beforeApply = () => f.store.cancelTask(f.task.taskId);
      await f.store.updateTask(f.task.taskId, { answer: 'yes' });
      await waitForStatus(f.store, f.task.taskId, 'cancelled');
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
  });

  it('rolls back an answer and leaves the same task waiting', async () => {
    const f = await fixture();
    try {
      const runner = await f.start();
      await waitForStatus(f.store, f.task.taskId, 'input_required');
      await runner.stop();
      if (!f.db.transaction) throw new Error('Transaction support required');
      await expect(
        f.db.transaction(async (tx) => {
          const store = await McpTaskStore.create(tx, { ownerId: f.ownerId });
          await store.updateTask(f.task.taskId, { answer: 'rollback' });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      const rows = await f.db.query(
        'SELECT task_input_responses FROM _smrt_jobs WHERE task_id = ?',
        f.task.taskId,
      );
      expect(rows.rows[0].task_input_responses).toBeNull();
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
  });
  it('never automatically resubmits an unknown external outcome', async () => {
    const f = await fixture();
    try {
      await f.start();
      await waitForStatus(f.store, f.task.taskId, 'input_required');
      unknownOutcome = true;
      await f.store.updateTask(f.task.taskId, { answer: 'yes' });
      await waitForStatus(f.store, f.task.taskId, 'failed');
      await f.store.updateTask(f.task.taskId, { answer: 'retry' });
      expect(applications).toBe(1);
      expect(await f.store.getContinuation(f.task.taskId)).toBeNull();
    } finally {
      await f.stop();
    }
  });

  it('fails closed without a configured authorizer or when it is unavailable', async () => {
    for (const authorize of [
      undefined,
      async () => {
        throw new Error('authority unavailable');
      },
    ]) {
      const f = await fixture();
      const runner = new TaskRunner({
        queues: ['mcp-tasks'],
        pollInterval: 5,
        retention: false,
        ...(authorize ? { authorizeMcpTask: authorize } : {}),
      });
      try {
        await runner.initialize(f.db);
        await runner.start();
        await waitForStatus(f.store, f.task.taskId, 'failed');
        expect(applications).toBe(0);
      } finally {
        await runner.stop();
        await f.stop();
      }
    }
  });

  it('rejects stale immutable continuation bindings before asking for input', async () => {
    const f = await fixture();
    try {
      const rows = await f.db.query(
        'SELECT args FROM _smrt_jobs WHERE task_id = ?',
        f.task.taskId,
      );
      const args =
        typeof rows.rows[0].args === 'string'
          ? JSON.parse(rows.rows[0].args)
          : rows.rows[0].args;
      args._mcpTask.continuation.revision = 'stale';
      await f.db.query(
        'UPDATE _smrt_jobs SET args = ? WHERE task_id = ?',
        JSON.stringify(args),
        f.task.taskId,
      );
      await f.start();
      await waitForStatus(f.store, f.task.taskId, 'failed');
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
  });
  it('observes cancellation while the live authorizer is in flight', async () => {
    const f = await fixture();
    let checks = 0;
    try {
      await f.start(async () => {
        if (++checks === 3) await f.store.cancelTask(f.task.taskId);
        return true;
      });
      await waitForStatus(f.store, f.task.taskId, 'input_required');
      await f.store.updateTask(f.task.taskId, { answer: 'yes' });
      await waitForStatus(f.store, f.task.taskId, 'cancelled');
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
  });
});
