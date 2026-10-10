import { describe, expect, it, vi } from 'vitest';
import { runImport } from '../runner.js';
import type { ValidRecord } from '../types.js';

const records = (n: number): ValidRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    index: i,
    line: i + 2,
    values: { n: i },
  }));

describe('runImport', () => {
  it('creates every record and reports progress', async () => {
    const create = vi.fn(async () => ({}));
    const progress: Array<[number, number]> = [];
    const r = await runImport({
      records: records(5),
      createRecord: create,
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(r).toEqual({ attempted: 5, created: 5, failed: [], aborted: false });
    expect(create).toHaveBeenCalledTimes(5);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it('continues past row failures and reports them by line, sorted', async () => {
    const r = await runImport({
      records: records(4),
      concurrency: 1,
      createRecord: async (v) => {
        if (v.n === 1 || v.n === 3) throw new Error(`bad ${v.n}`);
      },
    });
    expect(r.created).toBe(2);
    expect(r.failed).toEqual([
      { code: 'import-failed', line: 3, detail: 'bad 1' },
      { code: 'import-failed', line: 5, detail: 'bad 3' },
    ]);
  });

  it('bounds parallelism', async () => {
    let active = 0;
    let peak = 0;
    await runImport({
      records: records(12),
      concurrency: 3,
      createRecord: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
      },
    });
    expect(peak).toBe(3);
  });

  it('stops starting rows once aborted but counts in-flight ones', async () => {
    const controller = new AbortController();
    const r = await runImport({
      records: records(10),
      concurrency: 1,
      signal: controller.signal,
      createRecord: async (v) => {
        if (v.n === 2) controller.abort();
      },
    });
    expect(r.aborted).toBe(true);
    expect(r.attempted).toBe(3);
    expect(r.created).toBe(3);
  });

  it('handles an empty list', async () => {
    expect(
      await runImport({ records: [], createRecord: async () => ({}) }),
    ).toEqual({
      attempted: 0,
      created: 0,
      failed: [],
      aborted: false,
    });
  });
});
