import { getTestDatabase } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtWorkerCollection } from '../smrt-worker.js';

type PollingInternals = {
  nextPollDelay(foundWork: boolean): number;
};

function pollingInternals(runner: TaskRunner): PollingInternals {
  return runner as unknown as PollingInternals;
}

describe('TaskRunner idle polling (#2820)', () => {
  afterEach(() => vi.useRealTimers());

  async function runIdleSqlWindow(idlePollInterval?: number) {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const runner = new TaskRunner({ idlePollInterval, retention: false });
    await runner.initialize(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
    // Observe the actual adapter boundary, including claim UPDATE and recovery
    // SELECT. Neither poll(), recoverStaleJobs(), nor claimReady() is mocked.
    const query = vi.spyOn(db, 'query');
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(120_000);
      query.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      const sql = query.mock.calls
        .map(([statement]) => statement)
        .filter((statement) => /\b_smrt_jobs\b/i.test(statement));
      return {
        total: sql.length,
        claims: sql.filter((statement) => /UPDATE _smrt_jobs/i.test(statement))
          .length,
        recovery: sql.filter(
          (statement) =>
            /FROM _smrt_jobs/i.test(statement) &&
            !/UPDATE _smrt_jobs/i.test(statement),
        ).length,
      };
    } finally {
      await runner.stop();
      query.mockRestore();
      vi.useRealTimers();
      await db.close();
    }
  }

  it('reduces all adapter jobs SQL at least tenfold over equal idle minutes', async () => {
    // A cap equal to the base reproduces pre-backoff fixed polling. Production
    // defaults are used for the after window, including lease/recovery timers.
    const before = await runIdleSqlWindow(1_000);
    const after = await runIdleSqlWindow();
    expect(before).toEqual({ total: 66, claims: 60, recovery: 6 });
    expect(after).toEqual({ total: 6, claims: 3, recovery: 3 });
    expect(before.total / after.total).toBeGreaterThanOrEqual(10);
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    0,
    2_147_483_648,
  ])('rejects unsafe polling intervals (%s)', (value) => {
    expect(() => new TaskRunner({ idlePollInterval: value })).toThrow(
      RangeError,
    );
    expect(() => new TaskRunner({ pollInterval: value })).toThrow(RangeError);
  });

  it('keeps a skipped sweep inside the remaining recovery deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_999);
    const runner = new TaskRunner({ pollInterval: 60_000 });
    const internal = runner as unknown as {
      workersTableVerified: boolean;
      lastRecoverySweepAt: number;
    };
    internal.workersTableVerified = true;
    internal.lastRecoverySweepAt = 0;
    // A poll just before the 10s sweep throttle opens must not schedule an
    // additional full 30s TTL and push recovery out to 39,999ms.
    expect(pollingInternals(runner).nextPollDelay(false)).toBe(20_001);
    expect(pollingInternals(runner).nextPollDelay(true)).toBe(20_001);
  });

  it('bounds orphan recovery by the lease TTL with a one-minute base interval', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const runner = new TaskRunner({ pollInterval: 60_000, retention: false });
    await runner.initialize(db);
    const jobs = await SmrtJobCollection.create({ db });
    const workers = await SmrtWorkerCollection.create({ db });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
    try {
      await workers.registerWorker({
        workerKey: 'expired-peer',
        leaseTtlMs: 20_000,
      });
      const job = await jobs.create({
        objectType: 'OrphanProbe',
        method: 'run',
      });
      job.status = 'running';
      job.workerId = 'expired-peer';
      await job.save();
      await runner.start();
      await vi.advanceTimersByTimeAsync(29_999);
      expect((await jobs.get({ id: job.id ?? '' }))?.status).toBe('running');
      // At most one TTL between recovery sweeps, even though the requested
      // base is 60s and its uncapped idle delay would grow to twenty minutes.
      await vi.advanceTimersByTimeAsync(1);
      expect((await jobs.get({ id: job.id ?? '' }))?.status).toBe('failed');
    } finally {
      await runner.stop();
      vi.useRealTimers();
      await db.close();
    }
  });

  function lifecycleRunner() {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runner = new TaskRunner({
      concurrency: 1,
      pollInterval: 100,
      idlePollInterval: 1_000,
      retention: false,
    });
    const internal = runner as unknown as {
      collection: object;
      workerCollection: object;
      db: object;
      activeJobs: Map<string, unknown>;
      recoverStaleJobs(): Promise<void>;
      processJob(job: { id: string }): Promise<void>;
    };
    const times: number[] = [];
    const claimReady = vi.fn().mockImplementation(async () => {
      times.push(Date.now());
      return [];
    });
    internal.collection = { claimReady };
    internal.workerCollection = {
      assertReady: vi.fn().mockResolvedValue(undefined),
      registerWorker: vi.fn().mockResolvedValue(undefined),
      expireWorker: vi.fn().mockResolvedValue(undefined),
    };
    internal.db = { config: { type: 'duckdb' } };
    internal.recoverStaleJobs = vi.fn().mockResolvedValue(undefined);
    const processJob = vi.fn().mockResolvedValue(undefined);
    internal.processJob = processJob;
    return { runner, internal, claimReady, processJob, times };
  }

  it('resets the loop after claimed work at a backed-off poll', async () => {
    const { runner, claimReady, processJob, times } = lifecycleRunner();
    await runner.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(times).toEqual([0, 100, 300]);
    const job = { id: 'claimed' };
    claimReady.mockImplementationOnce(async () => {
      times.push(Date.now());
      return [job];
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(processJob).toHaveBeenCalledExactlyOnceWith(job);
    expect(times).toEqual([0, 100, 300, 700]);
    await vi.advanceTimersByTimeAsync(99);
    expect(times).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([0, 100, 300, 700, 800]);
    await runner.stop();
  });

  it('skips claiming at full capacity and resumes at the base interval', async () => {
    const { runner, internal, times } = lifecycleRunner();
    await runner.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(times).toEqual([0, 100, 300]);
    internal.activeJobs.set('full', {}); // concurrency is explicitly one
    await vi.advanceTimersByTimeAsync(400);
    expect(internal.recoverStaleJobs).toHaveBeenCalledTimes(4);
    expect(times).toEqual([0, 100, 300]); // 700ms poll did not claim
    internal.activeJobs.clear();
    await vi.advanceTimersByTimeAsync(99);
    expect(times).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([0, 100, 300, 800]);
    await runner.stop();
  });

  it('emits a rejected claim and retries at the base interval', async () => {
    const { runner, claimReady, times } = lifecycleRunner();
    const error = new Error('temporary');
    const onError = vi.fn();
    runner.on('runner:error', onError);
    await runner.start();
    await vi.advanceTimersByTimeAsync(300);
    claimReady.mockImplementationOnce(async () => {
      times.push(Date.now());
      throw error;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(times).toEqual([0, 100, 300, 700]);
    await vi.advanceTimersByTimeAsync(99);
    expect(times).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([0, 100, 300, 700, 800]);
    await runner.stop();
  });

  it('backs empty queue checks off to the default twentyfold cap', () => {
    const runner = new TaskRunner({ pollInterval: 1_000 });
    const polling = pollingInternals(runner);

    expect([
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
    ]).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 20_000]);
  });

  it('resets the delay progression when the poll reports activity', () => {
    const runner = new TaskRunner({
      pollInterval: 100,
      idlePollInterval: 1_000,
    });
    const polling = pollingInternals(runner);

    polling.nextPollDelay(false);
    polling.nextPollDelay(false);
    expect(polling.nextPollDelay(true)).toBe(100);
    expect(polling.nextPollDelay(false)).toBe(100);
  });

  it('lets latency-sensitive runners choose a smaller idle cap', () => {
    const runner = new TaskRunner({ pollInterval: 25, idlePollInterval: 50 });
    const polling = pollingInternals(runner);

    expect(polling.nextPollDelay(false)).toBe(25);
    expect(polling.nextPollDelay(false)).toBe(50);
    expect(polling.nextPollDelay(false)).toBe(50);
  });

  it('resets backed-off polling through public stop and start', async () => {
    const { runner, times } = lifecycleRunner();
    await runner.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(times).toEqual([0, 100, 300, 700]);
    await runner.stop();
    expect(runner.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(times).toHaveLength(4);
    await runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.isRunning()).toBe(true);
    expect(times).toEqual([0, 100, 300, 700, 2_700]);
    await vi.advanceTimersByTimeAsync(99);
    expect(times).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([0, 100, 300, 700, 2_700, 2_800]);
    await runner.stop();
  });
});
