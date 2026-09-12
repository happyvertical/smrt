import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { createTaskRunner } from '@happyvertical/smrt-jobs';
import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DataSurfaceBackgroundActionEnvelope,
  DataSurfaceBackgroundActionJob,
} from './data-surface-actions.js';
import {
  createJobsDataSurfaceBackgroundQueue,
  registerDataSurfaceBackgroundActionHandler,
  SmrtDataSurfaceActionTask,
} from './jobs-data-surface-action-queue.js';

describe('jobs-backed data-surface action queue', () => {
  let db: DatabaseInterface | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
    ObjectRegistry.clearCollectionCache?.();
  });

  it('persists a versioned principal-bound envelope and executes it after handler restart', async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const firstHandler = vi.fn(async () => actionResult());
    const queue = createJobsDataSurfaceBackgroundQueue({
      db,
      handlerId: 'orders-actions-v1',
      execute: firstHandler,
    });
    const envelope = actionEnvelope();
    const queued = await queue.enqueue(actionJob(envelope));
    const stored = await db.query(
      'SELECT tenant_id, args FROM _smrt_jobs WHERE id = ?',
      queued.jobId,
    );
    const args = JSON.parse(String(stored.rows[0]?.args));
    expect(stored.rows[0]?.tenant_id).toBe('tenant-a');
    expect(args).toEqual({ version: 1, envelope });
    expect(JSON.stringify(args)).not.toContain('permissions');
    expect(firstHandler).not.toHaveBeenCalled();

    queue.unregister();
    const restartedHandler = vi.fn(async () => actionResult());
    const unregister = registerDataSurfaceBackgroundActionHandler(
      'orders-actions-v1',
      restartedHandler,
    );
    const runner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['data-surface-actions'],
    });
    await runner.initialize(db);
    const completion = new Promise<{ result?: unknown }>((resolve, reject) => {
      runner.once('job:completed', (_job, result) =>
        resolve(result as { result?: unknown }),
      );
      runner.once('job:failed', (_job, error) => reject(error));
      runner.once('runner:error', reject);
    });
    try {
      await runner.start();
      await expect(completion).resolves.toEqual({ result: actionResult() });
      expect(restartedHandler).toHaveBeenCalledWith(envelope);
    } finally {
      await runner.stop();
      unregister();
    }
  });

  it('rejects a persisted tenant mismatch before dispatching the handler', async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const execute = vi.fn(async () => actionResult());
    const unregister = registerDataSurfaceBackgroundActionHandler(
      'orders-actions-v1',
      execute,
    );
    try {
      const task = new SmrtDataSurfaceActionTask({ db });
      task.tenantId = 'tenant-b';
      await expect(
        task.run({ version: 1, envelope: actionEnvelope() }),
      ).rejects.toThrow('Invalid durable data-surface action envelope');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});

function actionEnvelope(): DataSurfaceBackgroundActionEnvelope {
  return {
    binding: { version: 1, keyId: 'test', signature: 'test-binding' },
    version: 1,
    handlerId: 'orders-actions-v1',
    principal: {
      runAsUserId: 'user-a',
      tenantId: 'tenant-a',
      actsAsProfileId: null,
      onBehalfOfUserId: 'requester-a',
    },
    request: {
      version: 1,
      requestId: 'request-a',
      identity: {
        kind: 'table',
        surfaceId: 'orders',
        subject: { type: 'tenant', id: 'tenant-a' },
      },
      actionId: 'archive',
      phase: 'apply',
      selection: { scope: 'explicit-ids', rowIds: ['order-a'] },
      expectedRevision: 7,
      idempotencyKey: 'apply-a',
    },
  };
}

function actionJob(
  envelope: DataSurfaceBackgroundActionEnvelope,
): DataSurfaceBackgroundActionJob {
  return {
    idempotencyKey: 'apply-a',
    identity: envelope.request.identity,
    actionId: envelope.request.actionId,
    rowIds: ['order-a'],
    envelope,
    run: async () => actionResult(),
  };
}

function actionResult(): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: 'request-a',
    identity: actionEnvelope().request.identity,
    actionId: 'archive',
    phase: 'apply',
    ok: true,
  };
}
