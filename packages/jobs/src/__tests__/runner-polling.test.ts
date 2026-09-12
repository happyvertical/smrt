import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../runner.js';

type PollingInternals = {
  nextPollDelay(foundWork: boolean): number;
};

function pollingInternals(runner: TaskRunner): PollingInternals {
  return runner as unknown as PollingInternals;
}

describe('TaskRunner idle polling (#2820)', () => {
  afterEach(() => vi.useRealTimers());

  async function runIdleWindow(idlePollInterval: number): Promise<number> {
    vi.useFakeTimers();
    const runner = new TaskRunner({ pollInterval: 1_000, idlePollInterval });
    const internal = runner as unknown as {
      collection: { claimReady: ReturnType<typeof vi.fn> };
      db: object;
      running: boolean;
      recoverStaleJobs(): Promise<void>;
      startPolling(): void;
      pollTimer: ReturnType<typeof setTimeout> | null;
    };
    const claimReady = vi.fn().mockResolvedValue([]);
    internal.collection = { claimReady };
    internal.db = {};
    internal.recoverStaleJobs = async () => {};
    internal.running = true;
    internal.startPolling();
    await vi.advanceTimersByTimeAsync(30_000);
    claimReady.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    internal.running = false;
    if (internal.pollTimer) clearTimeout(internal.pollTimer);
    return claimReady.mock.calls.length;
  }

  it('measures a tenfold lower steady idle query count through the poll loop', async () => {
    const before = await runIdleWindow(1_000);
    const after = await runIdleWindow(10_000);

    expect(before).toBe(60);
    expect(after).toBe(6);
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

  it('backs empty queue checks off to one tenth of the configured polling rate', () => {
    const runner = new TaskRunner({ pollInterval: 1_000 });
    const polling = pollingInternals(runner);

    expect([
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
      polling.nextPollDelay(false),
    ]).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
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
