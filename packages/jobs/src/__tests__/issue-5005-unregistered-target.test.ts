/**
 * A queued job whose target class is no longer registered (#5005).
 *
 * The design-run model `@happyvertical/smrt-inference:DesignRunRecord` is
 * removed (its table retired); jobs still queued for its `execute` method need
 * no stored-value rewrite, because the runner already ends such a job as
 * terminal `failed` with its terminal event. This proves exactly that for a
 * job shaped like the ones the design-run hosts admitted (object-bound,
 * `maxAttempts: 1`, a dedupe key, `timeoutBehavior: 'warn'`), on a fenced
 * runner as those hosts ran: it is claimed once, fails with a terminal
 * `execution` event, is never retried, and the runner keeps serving work.
 */
import { randomUUID } from 'node:crypto';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunner, type TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';

const RETIRED_TARGET = '@happyvertical/smrt-inference:DesignRunRecord';

@smrt({ api: false, cli: false, mcp: false })
class Issue5005LiveProbe extends SmrtObject {
  static readonly backgroundEligibleMethods = ['ping'];
  static calls = 0;

  async ping(): Promise<string> {
    Issue5005LiveProbe.calls++;
    return 'pong';
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition did not settle');
    await delay(10);
  }
}

describe('a queued job for a class that is no longer registered (#5005)', () => {
  let db: DatabaseInterface | undefined;
  let runner: TaskRunner | undefined;

  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
    await (db as { close?: () => Promise<void> } | undefined)?.close?.();
    db = undefined;
    Issue5005LiveProbe.calls = 0;
  });

  it('ends a DesignRunRecord.execute job failed once, with its event, and the runner carries on', async () => {
    expect(ObjectRegistry.getClass(RETIRED_TARGET)).toBeUndefined();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });
    const runId = randomUUID();
    const queued = await jobs.enqueueJob({
      objectType: RETIRED_TARGET,
      objectId: runId,
      method: 'execute',
      args: { kind: 'example-design' },
      tenantId: null,
      dedupeKey: runId,
      queue: 'default',
      maxAttempts: 1,
      timeout: 200_000,
      timeoutBehavior: 'warn',
    });

    runner = createTaskRunner({
      claimFencing: true,
      concurrency: 1,
      pollInterval: 10,
      cancelPollInterval: 10,
      retention: false,
    });
    const failures: string[] = [];
    const runnerErrors: unknown[] = [];
    runner.on('job:failed', (_job, error) =>
      failures.push(error instanceof Error ? error.message : String(error)),
    );
    runner.on('runner:error', (error) => runnerErrors.push(error));
    await runner.initialize(db);
    await runner.start();

    await until(
      async () =>
        (await jobs.get({ id: queued.id as string }))?.status === 'failed',
    );
    const failed = await jobs.get({ id: queued.id as string });
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed?.lastError).toContain(
      `Unknown object type: ${RETIRED_TARGET}`,
    );
    expect(failures).toEqual([`Unknown object type: ${RETIRED_TARGET}`]);

    const events = await SmrtJobEventCollection.create({ db });
    expect(
      await events.getTerminalOutcome(queued.id as string, {
        tenantId: null,
        attempts: 1,
        completedAt: failed?.completedAt?.toISOString(),
      }),
    ).toMatchObject({
      jobId: queued.id,
      status: 'failed',
      failureKind: 'execution',
      objectType: RETIRED_TARGET,
      method: 'execute',
      attempts: 1,
    });

    // The runner is still serving: a live job after the failed one completes.
    const live = await jobs.enqueueJob({
      objectType:
        ObjectRegistry.getClass('Issue5005LiveProbe')?.qualifiedName ??
        'Issue5005LiveProbe',
      method: 'ping',
      maxAttempts: 1,
    });
    await until(
      async () =>
        (await jobs.get({ id: live.id as string }))?.status === 'completed',
    );
    expect(Issue5005LiveProbe.calls).toBe(1);

    // No retry loop: the failed job is never claimed again.
    await delay(100);
    expect(await jobs.get({ id: queued.id as string })).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect(
      await jobs.list({ where: { objectType: RETIRED_TARGET } }),
    ).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(runnerErrors).toEqual([]);
  });
});
