import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  dispatchLeaseRow,
  dispatchTestEngines,
  insertRawDispatch,
  openDispatchTestDatabase,
} from '../../__tests__/fixtures/dispatch-test-db';
import { DispatchCollection } from './Dispatches.js';

describe('DispatchCollection countByStatus', () => {
  it.each([
    ['PostgreSQL', '2'],
    ['DuckDB', 2n],
  ])('hydrates %s COUNT(*) results', async (_driver, count) => {
    const db = {
      single: async () => ({ count }),
    } as unknown as DatabaseInterface;

    await expect(DispatchCollection.countByStatus(db, 'pending')).resolves.toBe(
      2,
    );
  });
});

// P6 T14: a full-row write from a stale read never overwrites a live lease.
describe.each(
  dispatchTestEngines,
)('DispatchCollection.update fencing on %s', (engine) => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    ctx = await openDispatchTestDatabase(engine as 'sqlite');
  });

  afterEach(async () => {
    await ctx?.close();
  });

  it('DispatchCollection.update refuses a leased processing row', async () => {
    const { db } = ctx;
    await insertRawDispatch(db, { id: 'leased', type: 'job.run' });
    await insertRawDispatch(db, { id: 'free', type: 'job.run' });
    const stale = await DispatchCollection.get(db, 'leased');
    const free = await DispatchCollection.get(db, 'free');
    if (!stale || !free) throw new Error('fixture rows missing');
    await db.query(
      `UPDATE _smrt_dispatch SET status = 'processing', lease_token = 'live'
        WHERE id = 'leased'`,
    );

    stale.status = 'pending';
    await expect(DispatchCollection.update(db, stale)).rejects.toMatchObject({
      code: 'DISPATCH_ROW_LEASED',
    });
    const row = await dispatchLeaseRow(db, 'leased');
    expect(row.status).toBe('processing');
    expect(row.leaseToken).toBe('live');

    free.status = 'failed';
    await DispatchCollection.update(db, free);
    expect((await dispatchLeaseRow(db, 'free')).status).toBe('failed');

    // A missing row stays a no-op.
    free.id = 'missing';
    await expect(DispatchCollection.update(db, free)).resolves.toBeUndefined();
  });
});
