/**
 * Outcome-write isolation (P6 T09): a status write that throws affects only
 * its own row; the rest of the batch runs and `process()` resolves. A
 * handler that succeeded is never recorded `failed` because its `completed`
 * write threw, and every outcome write that throws is logged as
 * `dispatch.settle_error`.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@happyvertical/logger', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@happyvertical/logger')>();
  return {
    ...original,
    createLogger: (...args: Parameters<typeof original.createLogger>) =>
      Object.assign(original.createLogger(...args), { warn }),
  };
});

import {
  type DispatchTestDatabase,
  dispatchStatus,
  insertRawDispatch,
  openDispatchTestDatabase,
  rowsOf,
} from '../__tests__/fixtures/dispatch-test-db';

/** The lease settle write; group 1 is the outcome it records. */
const outcomeWrite = /^UPDATE _smrt_dispatch SET status = '(completed|failed)'/;

/**
 * Make the outcome writes for dispatch `id` throw: every one, or only those
 * writing `status`. Returns the restore.
 */
function failOutcomeWritesFor(
  db: DatabaseInterface,
  id: string,
  status?: 'completed' | 'failed',
): () => void {
  const mutable = db as unknown as { query: DatabaseInterface['query'] };
  const original = mutable.query;
  mutable.query = ((sql: string, ...params: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (
      outcomeWrite.test(text) &&
      params.includes(id) &&
      (status === undefined || text.match(outcomeWrite)?.[1] === status)
    ) {
      return Promise.reject(new Error('injected outcome write failure'));
    }
    return original.call(db, sql, ...params);
  }) as DatabaseInterface['query'];
  return () => {
    mutable.query = original;
  };
}

/** The `dispatch.settle_error` warnings logged so far. */
function settleErrors(): Record<string, unknown>[] {
  return warn.mock.calls
    .filter(([message]) => String(message).startsWith('dispatch.settle_error'))
    .map(([, context]) => context as Record<string, unknown>);
}

async function lastError(
  db: DatabaseInterface,
  id: string,
): Promise<string | null | undefined> {
  const rows = rowsOf(
    await db.query('SELECT last_error FROM _smrt_dispatch WHERE id = $1', id),
  );
  return rows[0]?.last_error as string | null | undefined;
}

describe('dispatch outcome-write isolation on sqlite', () => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    warn.mockClear();
    ctx = await openDispatchTestDatabase('sqlite');
    await ctx.bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    for (const [id, day] of [
      ['first', '01'],
      ['unsettled', '02'],
      ['last', '03'],
    ]) {
      await insertRawDispatch(ctx.db, {
        id,
        type: 'job.run',
        createdAt: `2026-01-${day}T00:00:00.000Z`,
      });
    }
  });

  afterEach(async () => {
    await ctx?.close();
  });

  it('continues the batch when every outcome write of one row throws', async () => {
    const { bus, db } = ctx;
    const seen: string[] = [];
    const restore = failOutcomeWritesFor(db, 'unsettled');
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
    expect(settleErrors()).toEqual([
      expect.objectContaining({ id: 'unsettled', outcome: 'completed' }),
    ]);
  });

  it('a failed completed write leaves the row processing, never failed', async () => {
    const { bus, db } = ctx;
    const restore = failOutcomeWritesFor(db, 'unsettled', 'completed');
    let count: number;
    try {
      count = await bus.process('worker', async () => {});
    } finally {
      restore();
    }

    expect(count).toBe(2);
    expect(await dispatchStatus(db, 'unsettled')).toBe('processing');
    expect(await lastError(db, 'unsettled')).toBeNull();
    expect(await dispatchStatus(db, 'last')).toBe('completed');
    expect(settleErrors()).toEqual([
      expect.objectContaining({
        id: 'unsettled',
        outcome: 'completed',
        error: 'injected outcome write failure',
      }),
    ]);
  });

  it('a failed write of a handler failure leaves the row processing and is logged', async () => {
    const { bus, db } = ctx;
    const restore = failOutcomeWritesFor(db, 'unsettled', 'failed');
    let count: number;
    try {
      count = await bus.process('worker', async (_p, metadata) => {
        if (metadata.id === 'unsettled') throw new Error('handler said no');
      });
    } finally {
      restore();
    }

    expect(count).toBe(2);
    expect(await dispatchStatus(db, 'unsettled')).toBe('processing');
    expect(await dispatchStatus(db, 'last')).toBe('completed');
    expect(settleErrors()).toEqual([
      expect.objectContaining({ id: 'unsettled', outcome: 'failed' }),
    ]);
  });

  it('a handler failure whose write succeeds is recorded failed with its own error', async () => {
    const { bus, db } = ctx;
    const count = await bus.process('worker', async (_p, metadata) => {
      if (metadata.id === 'unsettled') throw new Error('handler said no');
    });

    expect(count).toBe(2);
    expect(await dispatchStatus(db, 'unsettled')).toBe('failed');
    expect(await lastError(db, 'unsettled')).toBe('handler said no');
    expect(settleErrors()).toEqual([]);
  });

  it('a payload the handler made unserializable does not affect the outcome write', async () => {
    const { bus, db } = ctx;
    const count = await bus.process('worker', async (payload, metadata) => {
      if (metadata.id === 'unsettled') {
        // A cycle: the lease settle writes only status columns, never the
        // payload, so it still records the outcome.
        (payload as Record<string, unknown>).self = payload;
      }
    });

    expect(count).toBe(3);
    expect(await dispatchStatus(db, 'first')).toBe('completed');
    expect(await dispatchStatus(db, 'unsettled')).toBe('completed');
    expect(await dispatchStatus(db, 'last')).toBe('completed');
    expect(settleErrors()).toEqual([]);
  });
});
