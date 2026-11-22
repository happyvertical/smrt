/**
 * Conditional retry on PostgreSQL (P6 T12, T13 filter half). Runs only in
 * the disposable PostgreSQL lane (`SMRT_TEST_POSTGRES_URL`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beforeStatement } from '../__tests__/fixtures/ai-run-test-db';
import {
  type DispatchTestDatabase,
  dispatchStatus,
  insertRawDispatch,
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

const postgresDescribe = postgresDispatchUrl
  ? describe.sequential
  : describe.skip;

postgresDescribe('conditional dispatch retry on PostgreSQL (optional)', () => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    ctx = await openPostgresDispatchDatabase('retry');
  });

  afterEach(async () => {
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
    const restore = beforeStatement(
      db,
      (sql) => sql.startsWith('UPDATE _smrt_dispatch '),
      async (exec) => {
        await exec(
          "UPDATE _smrt_dispatch SET status = 'completed' WHERE id = 'done-meanwhile'",
        );
      },
    );
    let count: number;
    try {
      count = await bus.retry();
    } finally {
      restore();
    }
    expect(count).toBe(0);
    expect(await dispatchStatus(db, 'done-meanwhile')).toBe('completed');
  });

  it('retry enforces filters in the UPDATE', async () => {
    const { bus, db } = ctx;
    await insertRawDispatch(db, {
      id: 'below-cap',
      type: 'job.run',
      status: 'failed',
      attempts: 2,
    });
    await insertRawDispatch(db, {
      id: 'at-cap',
      type: 'job.run',
      status: 'failed',
      attempts: 3,
    });
    await insertRawDispatch(db, {
      id: 'legacy-null-attempts',
      type: 'job.run',
      status: 'failed',
      attempts: null,
    });
    await insertRawDispatch(db, {
      id: 'other-type',
      type: 'mail.send',
      status: 'failed',
      attempts: 1,
    });
    const count = await bus.retry({ maxAttempts: 3, signalTypes: ['job.run'] });
    expect(count).toBe(1);
    expect(await dispatchStatus(db, 'below-cap')).toBe('pending');
    expect(await dispatchStatus(db, 'legacy-null-attempts')).toBe('failed');
    expect(await dispatchStatus(db, 'at-cap')).toBe('failed');
    expect(await dispatchStatus(db, 'other-type')).toBe('failed');
  });
});
