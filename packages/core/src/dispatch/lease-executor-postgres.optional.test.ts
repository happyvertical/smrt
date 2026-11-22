/**
 * Dispatch lease executor on PostgreSQL (P6 T08, optional lane): a pool of
 * one client or a transaction handle is refused before anything is claimed;
 * with two clients, a renewal commits while the handler holds the other
 * client in an open transaction, visible from a second connection.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { interceptRenewals } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  type DispatchTestDatabase,
  dispatchLeaseRow,
  insertRawDispatch,
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';
import { createDispatchBus } from './bus.js';
import { DISPATCH_LEASE_EXECUTOR_UNSAFE } from './lease-heartbeat.js';

describe.skipIf(!postgresDispatchUrl)('dispatch lease executor on pg', () => {
  const opened: DispatchTestDatabase[] = [];
  const pools: DatabaseInterface[] = [];

  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.close?.();
    for (const ctx of opened.splice(0)) await ctx.close();
  });

  const openPool = async (url: string, max: number) => {
    const pool = (await getDatabase({
      type: 'postgres',
      url,
      max,
      dbid: `smrt-test-dispatch-lease-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    pools.push(pool);
    return pool;
  };

  it('lease writes commit independently or lease mode is rejected', async () => {
    const ctx = await openPostgresDispatchDatabase('lease_exec');
    opened.push(ctx);
    await ctx.bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(ctx.db, { id: 'work', type: 'job.run' });

    // One client: refused before any claim.
    const single = await openPool(String(ctx.url), 1);
    const singleBus = await createDispatchBus({ db: single });
    await expect(singleBus.process('worker', async () => {})).rejects.toThrow(
      DISPATCH_LEASE_EXECUTOR_UNSAFE,
    );
    expect((await dispatchLeaseRow(ctx.db, 'work')).status).toBe('pending');

    // A transaction handle: refused too.
    await ctx.db.transaction(async (tx) => {
      const txBus = await createDispatchBus({ db: tx });
      await expect(txBus.process('worker', async () => {})).rejects.toThrow(
        DISPATCH_LEASE_EXECUTOR_UNSAFE,
      );
    });

    // Two clients: the renewal commits while the handler holds the other
    // client inside an open transaction.
    const pair = await openPool(String(ctx.url), 2);
    const pairBus = await createDispatchBus({ db: pair, leaseMs: 1_000 });
    const renewals = interceptRenewals(pair);
    try {
      let before: string | null = null;
      let observed: string | null = null;
      const count = await pairBus.process('worker', async () => {
        before = (await dispatchLeaseRow(ctx.db, 'work')).claimedUntil;
        await pair.transaction(async (tx) => {
          await tx.query('SELECT 1');
          const start = Date.now();
          while (renewals.count < 2 && Date.now() - start < 5_000) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          observed = (await dispatchLeaseRow(ctx.db, 'work')).claimedUntil;
        });
      });
      expect(count).toBe(1);
      expect(String(observed) > String(before)).toBe(true);
    } finally {
      renewals.restore();
    }
  });
});
