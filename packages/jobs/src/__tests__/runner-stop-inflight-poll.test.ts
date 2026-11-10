/**
 * #3148: `stop()` while a poll is in flight. A poll that resumes after
 * shutdown began must not claim new work, and a surplus release that poll
 * fails must still be flushed by `stop()` before it returns.
 */
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import { createTaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

@smrt()
class InflightPollProbe extends SmrtObject {
  @backgroundEligible()
  async work(): Promise<string> {
    return 'done';
  }
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function setup() {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  const jobs = await SmrtJobCollection.create({ db });
  const objectType =
    ObjectRegistry.getClass('InflightPollProbe')?.qualifiedName ||
    'InflightPollProbe';
  const job = await jobs.create({ objectType, method: 'work', args: {} });
  await job.save();
  const runner = createTaskRunner({
    concurrency: 1,
    pollInterval: 60_000,
    retention: false,
    shutdownTimeout: 5_000,
  });
  await runner.initialize(db);
  const internals = runner as unknown as {
    collection: SmrtJobCollection;
    recoverStaleJobs(): Promise<void>;
  };
  return { db, jobs, job, runner, internals };
}

describe('TaskRunner.stop() with a poll in flight (#3148)', () => {
  it('does not claim once stop() has begun', async () => {
    const { jobs, job, runner, internals } = await setup();
    const recovering = gate();
    const recoveryStarted = gate();
    const realRecover = internals.recoverStaleJobs.bind(runner);
    internals.recoverStaleJobs = async () => {
      recoveryStarted.open();
      await recovering.opened;
      await realRecover();
    };
    const claim = vi.spyOn(internals.collection, 'claimReady');

    await runner.start();
    await recoveryStarted.opened;
    const stopping = runner.stop();
    recovering.open();
    await stopping;

    expect(claim).not.toHaveBeenCalled();
    const row = await jobs.get({ id: job.id ?? '' });
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
  });

  it('flushes a surplus release the in-flight poll failed', async () => {
    const { db, jobs, job, runner, internals } = await setup();
    const claiming = gate();
    const claimStarted = gate();
    const realClaim = internals.collection.claimReady.bind(
      internals.collection,
    );
    internals.collection.claimReady = async (options) => {
      claimStarted.open();
      await claiming.opened;
      return realClaim(options);
    };
    const realQuery = db.query.bind(db);
    let failedOnce = false;
    vi.spyOn(db, 'query').mockImplementation(((
      sql: string,
      ...params: unknown[]
    ) => {
      if (!failedOnce && /SET status = 'pending'/.test(sql)) {
        failedOnce = true;
        return Promise.reject(new Error('injected release failure'));
      }
      return realQuery(sql, ...params);
    }) as typeof db.query);
    runner.on('runner:error', () => {});

    await runner.start();
    await claimStarted.opened;
    const stopping = runner.stop();
    claiming.open();
    await stopping;

    expect(failedOnce).toBe(true);
    const row = await jobs.get({ id: job.id ?? '' });
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.workerId ?? null).toBeNull();
  });
});
