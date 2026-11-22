/**
 * Settle-error isolation (P6 T09): a status write that throws affects only
 * its own row; the rest of the batch runs and `process()` resolves.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  dispatchStatus,
  insertRawDispatch,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

/** Make every outcome write for dispatch `id` throw; returns the restore. */
function failSettleWritesFor(db: DatabaseInterface, id: string): () => void {
  const mutable = db as unknown as { query: DatabaseInterface['query'] };
  const original = mutable.query;
  mutable.query = ((sql: string, ...params: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (
      /^UPDATE _smrt_dispatch SET status = '(completed|failed)'/.test(text) &&
      params.includes(id)
    ) {
      return Promise.reject(new Error('injected settle failure'));
    }
    return original.call(db, sql, ...params);
  }) as DatabaseInterface['query'];
  return () => {
    mutable.query = original;
  };
}

describe('dispatch settle-error isolation on sqlite', () => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    ctx = await openDispatchTestDatabase('sqlite');
  });

  afterEach(async () => {
    await ctx?.close();
  });

  it('continues the batch when one settle throws', async () => {
    const { bus, db } = ctx;
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, {
      id: 'first',
      type: 'job.run',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'unsettled',
      type: 'job.run',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'last',
      type: 'job.run',
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    const seen: string[] = [];
    const restore = failSettleWritesFor(db, 'unsettled');
    let count: number;
    try {
      count = await bus.process('worker', async (_p, metadata) => {
        seen.push(metadata.id);
      });
    } finally {
      restore();
    }

    expect(seen).toEqual(['first', 'unsettled', 'last']);
    expect(count).toBe(2);
    expect(await dispatchStatus(db, 'first')).toBe('completed');
    expect(await dispatchStatus(db, 'last')).toBe('completed');
    // Its outcome was never recorded: still claimed, not reported done.
    expect(await dispatchStatus(db, 'unsettled')).toBe('processing');
  });
});
