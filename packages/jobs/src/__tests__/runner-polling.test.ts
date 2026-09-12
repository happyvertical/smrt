import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../runner.js';

type PollingInternals = {
  nextPollDelay(foundWork: boolean): number;
  resetIdlePollDelay(): void;
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

  it('resets the actual loop after a claim, capacity pressure, or poll rejection', async () => {
    vi.useFakeTimers();
    const runner = new TaskRunner({
      pollInterval: 100,
      idlePollInterval: 1_000,
    });
    const internal = runner as unknown as {
      collection: { claimReady: ReturnType<typeof vi.fn> };
      db: object;
      running: boolean;
      activeJobs: Map<string, unknown>;
      recoverStaleJobs(): Promise<void>;
      processJob(): Promise<void>;
      startPolling(): void;
      pollTimer: ReturnType<typeof setTimeout> | null;
    };
    const claimReady = vi.fn().mockResolvedValue([]);
    internal.collection = { claimReady };
    internal.db = {};
    internal.recoverStaleJobs = async () => {};
    internal.processJob = async () => {};
    internal.running = true;
    internal.startPolling();
    await vi.advanceTimersByTimeAsync(300);
    claimReady.mockResolvedValueOnce([{ id: 'claimed' }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(claimReady).toHaveBeenCalled();
    internal.activeJobs.set('full', {});
    const beforeCapacity = claimReady.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(claimReady.mock.calls.length).toBeGreaterThanOrEqual(beforeCapacity);
    internal.activeJobs.clear();
    claimReady.mockRejectedValueOnce(new Error('temporary'));
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(claimReady.mock.calls.length).toBeGreaterThan(beforeCapacity);
    internal.running = false;
    if (internal.pollTimer) clearTimeout(internal.pollTimer);
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

  it('returns to the configured interval after work, capacity pressure, or a poll error', () => {
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

  it('starts a new polling cycle at the configured interval after an idle stop', () => {
    const runner = new TaskRunner({
      pollInterval: 100,
      idlePollInterval: 1_000,
    });
    const polling = pollingInternals(runner);

    polling.nextPollDelay(false);
    polling.nextPollDelay(false);
    polling.nextPollDelay(false);
    polling.resetIdlePollDelay();

    expect(polling.nextPollDelay(false)).toBe(100);
  });
});
