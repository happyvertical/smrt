import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackfillTracker } from './backfill-tracker.js';

describe('BackfillTracker', () => {
  let db: DatabaseInterface;
  let tracker: BackfillTracker;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    tracker = new BackfillTracker({ db });
  });

  afterEach(async () => {
    const maybeClose = (db as { close?: () => Promise<void> } | undefined)
      ?.close;
    if (typeof maybeClose === 'function') {
      try {
        await maybeClose.call(db);
      } catch {
        // Ignore close errors — mirrors the pattern in differ.test.ts.
      }
    }
  });

  it('returns false for a never-applied backfill', async () => {
    expect(await tracker.isApplied('never')).toBe(false);
  });

  it('records and reads back applied backfills', async () => {
    await tracker.recordApplied('first');
    await tracker.recordApplied('second', {
      description: 'second backfill',
      packageName: '@example/app',
    });
    expect(await tracker.isApplied('first')).toBe(true);
    expect(await tracker.isApplied('second')).toBe(true);
    expect(await tracker.isApplied('third')).toBe(false);

    const list = await tracker.listApplied();
    expect(list.map((r) => r.name)).toEqual(['first', 'second']);
    expect(list[1]).toMatchObject({
      description: 'second backfill',
      packageName: '@example/app',
    });
  });

  it('recordApplied is idempotent', async () => {
    await tracker.recordApplied('only-once');
    await tracker.recordApplied('only-once', {
      description: 'attempted again',
    });
    const list = await tracker.listApplied();
    expect(list).toHaveLength(1);
  });

  it('listApplied uses a stable secondary sort when timestamps tie', async () => {
    await tracker.recordApplied('zeta');
    await tracker.recordApplied('alpha');
    await tracker.recordApplied('mu');

    // Force a same-timestamp tie so secondary ORDER BY behavior is deterministic.
    await db.query(
      `UPDATE _smrt_backfills SET applied_at = '2026-01-01 00:00:00'`,
    );

    const list = await tracker.listApplied();
    expect(list.map((row) => row.name)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('runIfPending runs only the first time and reports ran:false on subsequent calls', async () => {
    let runCount = 0;
    const result1 = await tracker.runIfPending('first', async () => {
      runCount += 1;
      return 'ok';
    });
    expect(result1).toEqual({ ran: true, result: 'ok' });
    expect(runCount).toBe(1);

    const result2 = await tracker.runIfPending('first', async () => {
      runCount += 1;
      return 'again';
    });
    expect(result2).toEqual({ ran: false, result: null });
    expect(runCount).toBe(1);
  });

  it('runIfPending discriminates "ran and returned null" from "already applied"', async () => {
    // Documented footgun from the previous `T | null` shape — fn returning
    // null is now unambiguous via the `ran` discriminator.
    const first = await tracker.runIfPending('null-returner', async () => null);
    expect(first).toEqual({ ran: true, result: null });

    const second = await tracker.runIfPending(
      'null-returner',
      async () => null,
    );
    expect(second).toEqual({ ran: false, result: null });
    // Different `ran` flag distinguishes the two cases even though both
    // have `result: null`.
    expect(first.ran).not.toBe(second.ran);
  });

  it('initialize is safe to call repeatedly', async () => {
    await tracker.initialize();
    await tracker.initialize();
    await tracker.recordApplied('still-works');
    expect(await tracker.isApplied('still-works')).toBe(true);
  });

  it('initialize is safe under concurrent calls — DDL runs once', async () => {
    // Wrap the underlying query so we can count how many times the
    // CREATE TABLE actually fires. Pre-memoization, two concurrent
    // initialize() calls both observed `initialized === false` and both
    // ran the DDL; now they should share the same in-flight promise.
    let createCalls = 0;
    const originalQuery = db.query.bind(db);
    db.query = ((sql: string, ...args: unknown[]) => {
      if (sql.includes('CREATE TABLE') && sql.includes('_smrt_backfills')) {
        createCalls += 1;
      }
      return originalQuery(sql as unknown as string, ...(args as []));
    }) as unknown as typeof db.query;

    const freshTracker = new BackfillTracker({ db });
    await Promise.all([
      freshTracker.initialize(),
      freshTracker.initialize(),
      freshTracker.initialize(),
      freshTracker.initialize(),
    ]);

    expect(createCalls).toBe(1);

    // Restore for the afterEach close.
    db.query = originalQuery as typeof db.query;
  });

  it('initialize allows retry after a failed CREATE TABLE', async () => {
    let attempts = 0;
    const originalQuery = db.query.bind(db);
    db.query = ((sql: string, ...args: unknown[]) => {
      if (sql.includes('CREATE TABLE') && sql.includes('_smrt_backfills')) {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error('transient failure'));
        }
      }
      return originalQuery(sql as unknown as string, ...(args as []));
    }) as unknown as typeof db.query;

    const freshTracker = new BackfillTracker({ db });
    await expect(freshTracker.initialize()).rejects.toThrow(
      'transient failure',
    );
    // The promise slot was cleared on error — a second call must retry,
    // not return a permanently-rejected memoized promise.
    await expect(freshTracker.initialize()).resolves.toBeUndefined();
    expect(attempts).toBe(2);

    db.query = originalQuery as typeof db.query;
  });
});
