import { describe, expect, it } from 'vitest';
import { TaskRunner } from '../runner.js';

type PollingInternals = {
  nextPollDelay(foundWork: boolean): number;
  resetIdlePollDelay(): void;
};

function pollingInternals(runner: TaskRunner): PollingInternals {
  return runner as unknown as PollingInternals;
}

describe('TaskRunner idle polling (#2820)', () => {
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
