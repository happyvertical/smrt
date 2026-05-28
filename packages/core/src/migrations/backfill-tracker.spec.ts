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

  it('runIfPending runs only the first time and returns null on subsequent calls', async () => {
    let runCount = 0;
    const result1 = await tracker.runIfPending('first', async () => {
      runCount += 1;
      return 'ok';
    });
    expect(result1).toBe('ok');
    expect(runCount).toBe(1);

    const result2 = await tracker.runIfPending('first', async () => {
      runCount += 1;
      return 'again';
    });
    expect(result2).toBeNull();
    expect(runCount).toBe(1);
  });

  it('initialize is safe to call repeatedly', async () => {
    await tracker.initialize();
    await tracker.initialize();
    await tracker.recordApplied('still-works');
    expect(await tracker.isApplied('still-works')).toBe(true);
  });
});
