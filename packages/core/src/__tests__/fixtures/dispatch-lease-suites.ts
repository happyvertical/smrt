/**
 * Dispatch lease behaviour suites shared by the default/PGlite lane files and
 * the `*-postgres.optional.test.ts` files: each suite takes an opener, so the
 * same cases run on SQLite, DuckDB, PGlite and PostgreSQL.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, expect, it, vi } from 'vitest';
import { DispatchBus } from '../../dispatch/bus';
import type {
  DispatchMetadata,
  DispatchProcessStats,
} from '../../dispatch/types';
import {
  type DispatchTestDatabase,
  type DispatchTestOpenOptions,
  dispatchLeaseRow,
  insertRawDispatch,
  rowsOf,
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

const RENEWAL = /^UPDATE _smrt_dispatch SET claimed_until = /;

/**
 * Intercept lease renewal statements on `db`: count them, optionally hold
 * each until `release()` is called, or make them throw.
 */
export function interceptRenewals(db: DatabaseInterface): {
  readonly count: number;
  hold(): void;
  release(): void;
  failNext(times: number): void;
  restore(): void;
} {
  const mutable = db as unknown as { query: DatabaseInterface['query'] };
  const original = mutable.query;
  let count = 0;
  let failures = 0;
  let gate: { promise: Promise<void>; open: () => void } | null = null;
  mutable.query = (async (sql: string, ...params: unknown[]) => {
    if (RENEWAL.test(sql.replace(/\s+/g, ' ').trim())) {
      count++;
      if (failures > 0) {
        failures--;
        throw new Error('injected renewal failure');
      }
      if (gate) await gate.promise;
    }
    return original.call(db, sql, ...params);
  }) as DatabaseInterface['query'];
  return {
    get count() {
      return count;
    },
    hold() {
      let open = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      gate = { promise, open };
    },
    release() {
      gate?.open();
      gate = null;
    },
    failNext(times: number) {
      failures = times;
    },
    restore() {
      gate?.open();
      mutable.query = original;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve once `predicate()` holds (polling), or reject after `ms`. */
async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await sleep(10);
  }
}

/** T07: heartbeat serialized, gated on the live attempt, fenced by token. */
export function defineLeaseHeartbeatCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);
  const leaseMs = 1_000;

  it('renews the lease while the handler runs and stops once it settles', async () => {
    const { bus, db } = await open({ bus: { leaseMs } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'long', type: 'job.run' });
    const renewals = interceptRenewals(db);
    try {
      let first: string | null = null;
      let later: string | null = null;
      const count = await bus.process('worker', async () => {
        first = (await dispatchLeaseRow(db, 'long')).claimedUntil;
        await until(() => renewals.count >= 2);
        await sleep(50);
        later = (await dispatchLeaseRow(db, 'long')).claimedUntil;
      });
      expect(count).toBe(1);
      expect(String(later) > String(first)).toBe(true);
      const settledAt = renewals.count;
      await sleep(leaseMs);
      expect(renewals.count).toBe(settledAt);
    } finally {
      renewals.restore();
    }
  });

  it('sends at most one renewal at a time', async () => {
    const { bus, db } = await open({ bus: { leaseMs } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'slow-renewal', type: 'job.run' });
    const renewals = interceptRenewals(db);
    renewals.hold();
    try {
      const count = await bus.process('worker', async () => {
        await until(() => renewals.count === 1);
        // Several ticks pass while the first renewal is held.
        await sleep(leaseMs);
        expect(renewals.count).toBe(1);
        renewals.release();
      });
      expect(count).toBe(1);
    } finally {
      renewals.restore();
    }
  });

  it('a renewal released after the token changed never extends the lease and aborts the signal', async () => {
    const { bus, db } = await open({ bus: { leaseMs } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'taken', type: 'job.run' });
    const renewals = interceptRenewals(db);
    renewals.hold();
    try {
      let aborted = false;
      const count = await bus.process('worker', async (_payload, metadata) => {
        await until(() => renewals.count === 1);
        // Another writer replaces the token (a reclaim or a sweep) while
        // the renewal is still queued.
        await db.query(
          'UPDATE _smrt_dispatch SET lease_token = $1, claimed_until = $2 WHERE id = $3',
          'other-holder',
          PAST,
          'taken',
        );
        renewals.release();
        await until(() => metadata.signal?.aborted === true);
        aborted = true;
      });
      expect(aborted).toBe(true);
      expect(count).toBe(0);
      const row = await dispatchLeaseRow(db, 'taken');
      expect(row.status).toBe('processing');
      expect(row.leaseToken).toBe('other-holder');
      expect(row.claimedUntil?.startsWith('2026-01-01')).toBe(true);
    } finally {
      renewals.restore();
    }
  });

  it('a renewal error does not abort the handler', async () => {
    const { bus, db } = await open({ bus: { leaseMs } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'flaky', type: 'job.run' });
    const renewals = interceptRenewals(db);
    renewals.failNext(2);
    try {
      let aborted: boolean | undefined;
      const count = await bus.process('worker', async (_payload, metadata) => {
        await until(() => renewals.count >= 3);
        aborted = metadata.signal?.aborted;
      });
      expect(aborted).toBe(false);
      expect(count).toBe(1);
      expect((await dispatchLeaseRow(db, 'flaky')).status).toBe('completed');
    } finally {
      renewals.restore();
    }
  });
}

/**
 * T08 (embedded half): an attempt running in this process is never started
 * a second time by this process, even when its database lease looks expired.
 */
export function defineLocalLeaseRegistryCases(
  openDatabase: DispatchOpener,
): void {
  const open = useOpener(openDatabase);

  it('lease writes commit independently or lease mode is rejected: no local double execution', async () => {
    const { bus, db } = await open({ bus: { leaseMs: 1_000 } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'held', type: 'job.run' });
    const renewals = interceptRenewals(db);
    // Renewals never land (as if rolled back with a handler transaction).
    renewals.hold();
    try {
      const calls: string[] = [];
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const first = bus.process('worker', async (_payload, metadata) => {
        calls.push(metadata.id);
        await finished;
      });
      await until(() => calls.length === 1);
      // The database lease looks expired to everyone. (Not shaped like a
      // renewal, so the interceptor lets it through.)
      await db.query(
        'UPDATE _smrt_dispatch SET status = status, claimed_until = $1 WHERE id = $2',
        PAST,
        'held',
      );
      const second = await bus.process('worker', async (_payload, metadata) => {
        calls.push(metadata.id);
      });
      expect(second).toBe(0);
      expect(calls).toEqual(['held']);
      renewals.release();
      finish();
      expect(await first).toBe(1);
      expect((await dispatchLeaseRow(db, 'held')).status).toBe('completed');
    } finally {
      renewals.restore();
    }
  });
}

/** T15, T16, T23: per-row claim budget and the cap sweep. */
export function defineLeaseCapCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it('claim cap applies to pending and expired branches; pre-handler crashes exhaust', async () => {
    const { bus, db } = await open({ bus: { maxAttempts: 2 } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    // Claimed twice by processes that stopped before their handler ran.
    await insertRawDispatch(db, {
      id: 'crashed-twice',
      type: 'job.run',
      status: 'processing',
      attempts: 2,
      leaseToken: 'gone',
      claimedUntil: PAST,
      updatedAt: PAST,
    });
    await insertRawDispatch(db, {
      id: 'revived-at-cap',
      type: 'job.run',
      attempts: 2,
      updatedAt: PAST,
    });
    await insertRawDispatch(db, {
      id: 'live-at-cap',
      type: 'job.run',
      status: 'processing',
      attempts: 2,
      leaseToken: 'running',
      claimedUntil: future(),
    });

    const calls: string[] = [];
    let stats: DispatchProcessStats | undefined;
    await bus.process(
      'worker',
      async (_payload, metadata) => {
        calls.push(metadata.id);
      },
      { onStats: (value) => (stats = value) },
    );

    expect(calls).toEqual([]);
    expect(stats?.exhausted).toBe(2);
    for (const id of ['crashed-twice', 'revived-at-cap']) {
      const row = await dispatchLeaseRow(db, id);
      expect(row.status).toBe('failed');
      expect(row.leaseToken).toBeNull();
      expect(row.lastError).toBe(
        '[smrt:DISPATCH_ATTEMPTS_EXHAUSTED] claim budget spent after 2 claims',
      );
      const updated = rowsOf(
        await db.query(
          'SELECT CAST(updated_at AS TEXT) AS u FROM _smrt_dispatch WHERE id = $1',
          id,
        ),
      )[0]?.u;
      // Failure time, so retention ages the row from when it failed.
      expect(String(updated).startsWith('2026-01-01')).toBe(false);
    }
    const live = await dispatchLeaseRow(db, 'live-at-cap');
    expect(live.status).toBe('processing');
    expect(live.leaseToken).toBe('running');
  });

  it('stamps the claim budget at the first claim; a cap-1 bus never fails another subscriber row', async () => {
    const { bus, db } = await open({ bus: { maxAttempts: 5 } });
    const strict = new DispatchBus(db, { maxAttempts: 1 });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'patient' });
    await strict.subscribe({ signalType: 'job.run', subscriber: 'strict' });
    await insertRawDispatch(db, { id: 'shared', type: 'job.run' });

    // First claim by the budget-5 bus stamps 5 on the row.
    await bus.process('patient', async () => {
      throw new Error('transient');
    });
    expect((await dispatchLeaseRow(db, 'shared')).maxAttempts).toBe(5);
    expect(await bus.retry()).toBe(1);

    // The cap-1 bus applies the row's budget, not its own.
    const seen: number[] = [];
    let stats: DispatchProcessStats | undefined;
    await strict.process(
      'strict',
      async (_payload, metadata) => {
        seen.push(metadata.attempts);
      },
      { onStats: (value) => (stats = value) },
    );
    expect(stats?.exhausted).toBe(0);
    expect(seen).toEqual([2]);
    expect((await dispatchLeaseRow(db, 'shared')).status).toBe('completed');
  });

  it('cap sweep uses the compiled pattern', async () => {
    const { bus, db } = await open({ bus: { maxAttempts: 1 } });
    await bus.subscribe({ signalType: 'invoice.v*', subscriber: 'billing' });
    await bus.subscribe({ signalType: 'campaign.*', subscriber: 'billing' });
    await insertRawDispatch(db, {
      id: 'routed',
      type: 'invoice.v2',
      attempts: 1,
    });
    await insertRawDispatch(db, {
      id: 'other-case',
      type: 'Campaign.X',
      attempts: 1,
    });

    await bus.process('billing', async () => {});

    expect((await dispatchLeaseRow(db, 'routed')).status).toBe('failed');
    // Case-sensitive on every engine (GLOB on SQLite).
    expect((await dispatchLeaseRow(db, 'other-case')).status).toBe('pending');
  });
}

/** T05, T06: settle is fenced by the token alone. */
export function defineLeaseSettleFenceCases(
  openDatabase: DispatchOpener,
): void {
  const open = useOpener(openDatabase);

  it.each([
    [
      'reclaim',
      "UPDATE _smrt_dispatch SET lease_token = 'next-holder' WHERE id = $1",
      { status: 'processing', leaseToken: 'next-holder' },
    ],
    [
      'cap sweep',
      "UPDATE _smrt_dispatch SET status = 'failed', lease_token = NULL, last_error = '[smrt:DISPATCH_ATTEMPTS_EXHAUSTED] swept' WHERE id = $1",
      { status: 'failed', leaseToken: null },
    ],
    [
      'retry',
      "UPDATE _smrt_dispatch SET status = 'pending', lease_token = NULL WHERE id = $1",
      { status: 'pending', leaseToken: null },
    ],
  ] as const)('stale settle after %s reports lease-lost and leaves row', async (_writer, takeover, expected) => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'contested', type: 'job.run' });

    const before = await dispatchLeaseRow(db, 'contested');
    let stats: DispatchProcessStats | undefined;
    const count = await bus.process(
      'worker',
      async () => {
        // Another writer acts between this handler and its settle.
        await db.query(takeover, 'contested');
      },
      { onStats: (value) => (stats = value) },
    );

    expect(count).toBe(0);
    expect(stats?.leaseLost).toBe(1);
    expect(stats?.completed).toBe(0);
    const row = await dispatchLeaseRow(db, 'contested');
    expect({ status: row.status, leaseToken: row.leaseToken }).toEqual(
      expected,
    );
    expect(row.lastError).toBe(
      expected.status === 'failed'
        ? '[smrt:DISPATCH_ATTEMPTS_EXHAUSTED] swept'
        : before.lastError,
    );
  });

  it('settles as a win after the event loop was blocked past leaseMs', async () => {
    const { bus, db } = await open({ bus: { leaseMs: 1_000 } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'blocked', type: 'job.run' });

    const count = await bus.process('worker', async () => {
      const until = Date.now() + 1_300;
      while (Date.now() < until) {
        // Busy: no timer (and so no renewal) runs.
      }
    });

    expect(count).toBe(1);
    expect((await dispatchLeaseRow(db, 'blocked')).status).toBe('completed');
  });
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
    // Not claimed; the claim budget sweep fails them instead.
    const pendingAtCap = await dispatchLeaseRow(db, 'pending-at-cap');
    expect(pendingAtCap.attempts).toBe(2);
    expect(pendingAtCap.status).toBe('failed');
    const expiredAtCap = await dispatchLeaseRow(db, 'expired-at-cap');
    expect(expiredAtCap.attempts).toBe(2);
    expect(expiredAtCap.status).toBe('failed');
    expect(expiredAtCap.leaseToken).toBeNull();
  });
}
