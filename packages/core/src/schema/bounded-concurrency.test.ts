import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './bounded-concurrency.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1, 10];
    const results = await mapWithConcurrency(delays, 3, async (ms, index) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${index}:${ms}`;
    });
    expect(results).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10']);
  });

  it('never exceeds the limit and does use it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
      },
    );
    expect(maxInFlight).toBe(4);
  });

  it('with limit 1 runs sequentially and stops at the first failure', async () => {
    const seen: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4], 1, async (n) => {
        seen.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1, 2]);
  });

  it('stops scheduling after a failure, awaits in-flight work, and rethrows the first error', async () => {
    const gate = deferred();
    const started: number[] = [];
    let settledAfterFailure = false;
    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 0) throw new Error('first');
      if (n === 1) {
        await gate.promise;
        settledAfterFailure = true;
        throw new Error('second');
      }
      return n;
    });
    // Let worker 0 fail, then release the in-flight item.
    await new Promise((r) => setTimeout(r, 5));
    gate.resolve();
    await expect(run).rejects.toThrow('first');
    expect(settledAfterFailure).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it('handles empty input and non-finite limits', async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
    expect(
      await mapWithConcurrency([1, 2], Number.NaN, async (n) => n * 2),
    ).toEqual([2, 4]);
  });
});
