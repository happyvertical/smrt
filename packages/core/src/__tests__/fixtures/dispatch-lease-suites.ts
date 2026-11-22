/**
 * Dispatch lease behaviour suites shared by the default/PGlite lane files and
 * the `*-postgres.optional.test.ts` files: each suite takes an opener, so the
 * same cases run on SQLite, DuckDB, PGlite and PostgreSQL.
 */

import { afterEach, expect, it, vi } from 'vitest';
import type { DispatchMetadata } from '../../dispatch/types';
import {
  type DispatchTestDatabase,
  type DispatchTestOpenOptions,
  dispatchLeaseRow,
  insertRawDispatch,
} from './dispatch-test-db';

export type DispatchOpener = (
  options?: DispatchTestOpenOptions,
) => Promise<DispatchTestDatabase>;

const PAST = '2026-01-01T00:00:00.000Z';

/** Track opened databases and close them after each test. */
function useOpener(open: DispatchOpener): DispatchOpener {
  const opened: DispatchTestDatabase[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const ctx of opened.splice(0)) await ctx.close();
  });
  return async (options) => {
    const ctx = await open(options);
    opened.push(ctx);
    return ctx;
  };
}

/** T01, T04, T35: claim exclusivity, RETURNING wins, stale pending token. */
export function defineLeaseClaimCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);

  it('claims a compete row exactly once under 8 concurrent process() calls', async () => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'only', type: 'job.run' });

    const calls: string[] = [];
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        bus.process('worker', async (_payload, metadata) => {
          calls.push(metadata.id);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }),
      ),
    );

    expect(calls).toEqual(['only']);
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    const row = await dispatchLeaseRow(db, 'only');
    expect(row.status).toBe('completed');
    expect(row.attempts).toBe(1);
  });

  it('reports a successful settle as a win via RETURNING on every adapter', async () => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'win', type: 'job.run' });

    let seen: DispatchMetadata | undefined;
    const count = await bus.process('worker', async (_payload, metadata) => {
      seen = metadata;
      const live = await dispatchLeaseRow(db, 'win');
      // While the handler runs the row holds a lease.
      expect(live.status).toBe('processing');
      expect(live.leaseToken).toEqual(expect.any(String));
      expect(live.claimedUntil).not.toBeNull();
    });

    expect(count).toBe(1);
    expect(seen?.attempts).toBe(1);
    const row = await dispatchLeaseRow(db, 'win');
    expect(row.status).toBe('completed');
    expect(row.claimedUntil).toBeNull();
  });

  it('pending row with a stale token is claimable', async () => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, {
      id: 'stale',
      type: 'job.run',
      leaseToken: 'left-by-an-old-retry',
    });

    let during: string | null = null;
    const count = await bus.process('worker', async () => {
      during = (await dispatchLeaseRow(db, 'stale')).leaseToken;
    });

    expect(count).toBe(1);
    expect(during).not.toBeNull();
    expect(during).not.toBe('left-by-an-old-retry');
    expect((await dispatchLeaseRow(db, 'stale')).status).toBe('completed');
  });
}

/** T03 and the claim half of T15: reclaim after expiry, cap on every branch. */
export function defineLeaseReclaimCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);

  it('reclaims an expired lease and increments attempts in SQL', async () => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, {
      id: 'expired',
      type: 'job.run',
      status: 'processing',
      attempts: 1,
      leaseToken: 'crashed-worker',
      claimedUntil: PAST,
    });
    await insertRawDispatch(db, {
      id: 'live',
      type: 'job.run',
      status: 'processing',
      attempts: 1,
      leaseToken: 'running-worker',
      claimedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const seen: [string, number][] = [];
    const count = await bus.process('worker', async (_payload, metadata) => {
      seen.push([metadata.id, metadata.attempts]);
    });

    expect(seen).toEqual([['expired', 2]]);
    expect(count).toBe(1);
    const reclaimed = await dispatchLeaseRow(db, 'expired');
    expect(reclaimed.status).toBe('completed');
    expect(reclaimed.attempts).toBe(2);
    expect(reclaimed.leaseToken).not.toBe('crashed-worker');
    const live = await dispatchLeaseRow(db, 'live');
    expect(live.status).toBe('processing');
    expect(live.leaseToken).toBe('running-worker');
  });

  it('does not reclaim a lease that expires exactly at the call start', async () => {
    const callStart = new Date('2026-06-01T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'], now: callStart });
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, {
      id: 'boundary',
      type: 'job.run',
      status: 'processing',
      attempts: 1,
      leaseToken: 'holder',
      claimedUntil: callStart.toISOString(),
    });
    await insertRawDispatch(db, {
      id: 'just-before',
      type: 'job.run',
      status: 'processing',
      attempts: 1,
      leaseToken: 'holder',
      claimedUntil: new Date(callStart.getTime() - 1).toISOString(),
    });

    const seen: string[] = [];
    await bus.process('worker', async (_payload, metadata) => {
      seen.push(metadata.id);
    });

    expect(seen).toEqual(['just-before']);
    expect((await dispatchLeaseRow(db, 'boundary')).leaseToken).toBe('holder');
  });

  it('claim cap applies to pending and expired branches', async () => {
    const { bus, db } = await open({ bus: { maxAttempts: 2 } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, {
      id: 'pending-at-cap',
      type: 'job.run',
      attempts: 2,
    });
    await insertRawDispatch(db, {
      id: 'expired-at-cap',
      type: 'job.run',
      status: 'processing',
      attempts: 2,
      leaseToken: 'gone',
      claimedUntil: PAST,
    });
    await insertRawDispatch(db, {
      id: 'pending-under-cap',
      type: 'job.run',
      attempts: 1,
    });
    await insertRawDispatch(db, {
      id: 'legacy-null-attempts',
      type: 'job.run',
      attempts: null,
    });

    const seen: [string, number][] = [];
    await bus.process('worker', async (_payload, metadata) => {
      seen.push([metadata.id, metadata.attempts]);
    });

    expect(seen.sort()).toEqual([
      ['legacy-null-attempts', 1],
      ['pending-under-cap', 2],
    ]);
    expect((await dispatchLeaseRow(db, 'pending-at-cap')).attempts).toBe(2);
    expect((await dispatchLeaseRow(db, 'expired-at-cap')).leaseToken).toBe(
      'gone',
    );
  });
}
