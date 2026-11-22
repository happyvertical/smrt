/**
 * Conditional retry (P6 T12, T13 filter half; the `resetAttempts` half is a
 * new option and ships separately): `retry()` moves only rows
 * that are still `failed` when its write runs, applies its filters in that
 * write, and counts the rows it changed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beforeStatement } from '../__tests__/fixtures/ai-run-test-db';
import {
  type DispatchTestDatabase,
  dispatchStatus,
  dispatchTestEngines,
  insertRawDispatch,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';
import { setDispatchTenantResolver } from './tenant-resolver.js';

const firstDispatchUpdate = (sql: string) =>
  sql.startsWith('UPDATE _smrt_dispatch ');

describe.each(
  dispatchTestEngines,
)('conditional dispatch retry on %s', (engine) => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    ctx = await openDispatchTestDatabase(engine as 'sqlite');
  });

  afterEach(async () => {
    setDispatchTenantResolver(undefined);
    await ctx?.close();
  });

  it('a delayed second retry cannot revert a claimed or completed row; count via RETURNING', async () => {
    const { bus, db } = ctx;
    await insertRawDispatch(db, {
      id: 'done-meanwhile',
      type: 'job.run',
      status: 'failed',
      attempts: 1,
    });
    await insertRawDispatch(db, {
      id: 'claimed-meanwhile',
      type: 'job.run',
      status: 'failed',
      attempts: 1,
    });

    // Another worker retries, claims and settles the rows after this retry
    // decided what to reset but before its write lands.
    const restore = beforeStatement(db, firstDispatchUpdate, async (exec) => {
      await exec(
        "UPDATE _smrt_dispatch SET status = 'completed' WHERE id = 'done-meanwhile'",
      );
      await exec(
        "UPDATE _smrt_dispatch SET status = 'processing', attempts = 2 WHERE id = 'claimed-meanwhile'",
      );
    });
    let count: number;
    try {
      count = await bus.retry();
    } finally {
      restore();
    }

    expect(count).toBe(0);
    expect(await dispatchStatus(db, 'done-meanwhile')).toBe('completed');
    expect(await dispatchStatus(db, 'claimed-meanwhile')).toBe('processing');

    // The count is what this call changed, unaffected by a claim right after.
    await insertRawDispatch(db, {
      id: 'revive-me',
      type: 'job.run',
      status: 'failed',
      attempts: 1,
    });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    expect(await bus.retry()).toBe(1);
    expect(await bus.process('worker', async () => {})).toBe(1);
    expect(await bus.retry()).toBe(0);
    expect(await dispatchStatus(db, 'revive-me')).toBe('completed');
  });

  it('retry enforces filters in the UPDATE', async () => {
    const { bus, db } = ctx;
    let activeTenant: string | null | undefined;
    setDispatchTenantResolver(() => activeTenant);

    await insertRawDispatch(db, {
      id: 'below-cap',
      type: 'job.run',
      status: 'failed',
      attempts: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'at-cap',
      type: 'job.run',
      status: 'failed',
      attempts: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'legacy-null-attempts',
      type: 'job.run',
      status: 'failed',
      attempts: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'too-new',
      type: 'job.run',
      status: 'failed',
      attempts: 1,
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'other-type',
      type: 'mail.send',
      status: 'failed',
      attempts: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'tenant-b-row',
      type: 'job.run',
      status: 'failed',
      attempts: 1,
      tenantId: 'tenant-b',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'tenant-a-row',
      type: 'job.run',
      status: 'failed',
      attempts: 1,
      tenantId: 'tenant-a',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    activeTenant = 'tenant-a';
    const count = await bus.retry({
      maxAttempts: 3,
      olderThan: new Date('2026-03-01T00:00:00.000Z'),
      signalTypes: ['job.run'],
    });

    expect(count).toBe(2);
    expect(await dispatchStatus(db, 'below-cap')).toBe('pending');
    expect(await dispatchStatus(db, 'tenant-a-row')).toBe('pending');
    // `attempts < maxAttempts` is not true for NULL attempts: such a row is
    // left failed, as before.
    expect(await dispatchStatus(db, 'legacy-null-attempts')).toBe('failed');
    expect(await dispatchStatus(db, 'at-cap')).toBe('failed');
    expect(await dispatchStatus(db, 'too-new')).toBe('failed');
    expect(await dispatchStatus(db, 'other-type')).toBe('failed');
    expect(await dispatchStatus(db, 'tenant-b-row')).toBe('failed');
  });

  it('without maxAttempts a failed row with NULL attempts is retried', async () => {
    const { bus, db } = ctx;
    await insertRawDispatch(db, {
      id: 'legacy-null-attempts',
      type: 'job.run',
      status: 'failed',
      attempts: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(await bus.retry({ signalTypes: ['job.run'] })).toBe(1);
    expect(await dispatchStatus(db, 'legacy-null-attempts')).toBe('pending');
  });
});
