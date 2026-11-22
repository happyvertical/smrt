/**
 * Dispatch maintenance suites (P6 T18-T20, T23 orphan half, T27, T34),
 * shared by the default/PGlite lane files and the
 * `*-postgres.optional.test.ts` files: each suite takes an opener, so the
 * same cases run on SQLite, DuckDB, PGlite and PostgreSQL.
 */

import { afterEach, expect, it } from 'vitest';
import { DispatchBus } from '../../dispatch/bus';
import { setDispatchTenantResolver } from '../../dispatch/tenant-resolver';
import type { DispatchProcessStats } from '../../dispatch/types';
import type { DispatchOpener } from './dispatch-lease-suites';
import {
  type DispatchTestDatabase,
  dispatchLeaseRow,
  insertRawDispatch,
} from './dispatch-test-db';

const DAY_MS = 86_400_000;
const ORPHANED = '[smrt:DISPATCH_LEASE_ORPHANED]';

/** Track opened databases and close them after each test. */
function useOpener(open: DispatchOpener): DispatchOpener {
  const opened: DispatchTestDatabase[] = [];
  afterEach(async () => {
    setDispatchTenantResolver(undefined);
    for (const ctx of opened.splice(0)) await ctx.close();
  });
  return async (options) => {
    const ctx = await open(options);
    opened.push(ctx);
    return ctx;
  };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A `processing` row whose lease holder stopped `ageMs` ago. */
function abandoned(
  id: string,
  type: string,
  extra: {
    targetSubscriber?: string | null;
    tenantId?: string | null;
    ageMs?: number;
  } = {},
) {
  const at = ago(extra.ageMs ?? 2 * DAY_MS);
  return {
    id,
    type,
    status: 'processing',
    attempts: 1,
    leaseToken: `gone-${id}`,
    claimedUntil: at,
    updatedAt: at,
    targetSubscriber: extra.targetSubscriber ?? null,
    tenantId: extra.tenantId ?? null,
  };
}

/** T18, T23 (orphan route check): unrouted rows only. */
export function defineLeaseOrphanCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);

  it('maintenance fails only unrouted orphaned leases; routed rows wait for their subscriber', async () => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.*', subscriber: 'worker' });
    await bus.subscribe({
      signalType: 'mail.send',
      subscriber: 'fan',
      delivery: 'fanout',
    });
    await bus.subscribe({
      signalType: 'report.run',
      subscriber: 'paused',
      enabled: false,
    });
    await bus.subscribe({ signalType: 'invoice.v*', subscriber: 'billing' });
    await bus.subscribe({ signalType: 'campaign.*', subscriber: 'billing' });
    await bus.subscribe({ signalType: 'idle.*', subscriber: 'idle' });

    const rows = [
      abandoned('routed-compete', 'job.run'),
      abandoned('unrouted-type', 'nobody.listens'),
      abandoned('routed-by-disabled', 'report.run'),
      abandoned('targeted-unknown', 'mail.send', { targetSubscriber: 'ghost' }),
      abandoned('targeted-known', 'mail.send', { targetSubscriber: 'fan' }),
      abandoned('compete-without-compete-sub', 'mail.send'),
      abandoned('recent-unrouted', 'nobody.listens', { ageMs: 60_000 }),
      abandoned('pattern-routed', 'invoice.v2'),
      abandoned('other-case', 'Campaign.X'),
    ];
    for (const row of rows) await insertRawDispatch(db, row);

    // process() never sweeps orphans, whatever it polls.
    await bus.process('idle', async () => {});
    expect((await dispatchLeaseRow(db, 'unrouted-type')).status).toBe(
      'processing',
    );

    const result = await bus.maintain();
    expect(result.orphaned).toBe(4);

    for (const id of [
      'unrouted-type',
      'targeted-unknown',
      'compete-without-compete-sub',
      'other-case',
    ]) {
      const row = await dispatchLeaseRow(db, id);
      expect(row.status).toBe('failed');
      expect(row.leaseToken).toBeNull();
      expect(row.claimedUntil).toBeNull();
      expect(row.lastError?.startsWith(ORPHANED)).toBe(true);
    }
    for (const id of [
      'routed-compete',
      'routed-by-disabled',
      'targeted-known',
      'recent-unrouted',
      'pattern-routed',
    ]) {
      const row = await dispatchLeaseRow(db, id);
      expect(row.status).toBe('processing');
      expect(row.leaseToken).toBe(`gone-${id}`);
    }
  });

  it('a short threshold never fails a routed row; its subscriber reclaims it', async () => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, abandoned('down-long', 'job.run'));

    // Retention first, after a downtime longer than any threshold.
    const swept = await bus.maintain({ orphanedLeaseAfterMs: 1 });
    expect(swept.orphaned).toBe(0);
    expect((await dispatchLeaseRow(db, 'down-long')).status).toBe('processing');

    // The subscriber comes back and reclaims it under the claim budget.
    const seen: number[] = [];
    await bus.process('worker', async (_payload, metadata) => {
      seen.push(metadata.attempts);
    });
    expect(seen).toEqual([2]);
    expect((await dispatchLeaseRow(db, 'down-long')).status).toBe('completed');
  });

  it('a dry run counts the unrouted orphaned leases and writes nothing', async () => {
    const { bus, db } = await open();
    await insertRawDispatch(db, abandoned('lonely', 'nobody.listens'));

    const preview = await bus.maintain({ dryRun: true });
    expect(preview).toMatchObject({ orphaned: 1, dryRun: true });
    const row = await dispatchLeaseRow(db, 'lonely');
    expect(row.status).toBe('processing');
    expect(row.leaseToken).toBe('gone-lonely');
  });

  it('rejects an invalid orphan threshold, naming it', async () => {
    const { bus } = await open();
    for (const value of [0, -1, 1.5, Number.NaN]) {
      await expect(
        bus.maintain({ orphanedLeaseAfterMs: value }),
      ).rejects.toThrow(/orphanedLeaseAfterMs/);
    }
  });
}

/** Tenant ids (UUIDs: PostgreSQL engines type tenant columns as uuid). */
export const TENANT_A = '0f1e2d3c-0000-4000-8000-00000000000a';
export const TENANT_B = '0f1e2d3c-0000-4000-8000-00000000000b';

/** T19: tenant-exact maintenance; global rows use the all-tenant route check. */
export function defineMaintenanceTenantCases(
  openDatabase: DispatchOpener,
): void {
  const open = useOpener(openDatabase);

  async function seed() {
    const ctx = await open();
    const { bus, db } = ctx;
    let active: string | null | undefined;
    setDispatchTenantResolver(() => active);
    active = TENANT_A;
    await bus.subscribe({ signalType: 'job.*', subscriber: 'worker-a' });
    active = null;
    await bus.subscribe({ signalType: 'mail.*', subscriber: 'mailer' });
    for (const row of [
      abandoned('a-routed', 'job.run', { tenantId: TENANT_A }),
      // Only a global subscription matches: a tenant row is not routed by it.
      abandoned('a-global-sub-only', 'mail.send', { tenantId: TENANT_A }),
      // Routed by tenant A's subscription through the all-tenant check.
      abandoned('global-routed', 'job.run'),
      abandoned('global-unrouted', 'nobody.listens'),
      abandoned('b-unrouted', 'job.run', { tenantId: TENANT_B }),
    ]) {
      await insertRawDispatch(db, row);
    }
    return {
      ...ctx,
      as(tenant: string | null | undefined) {
        active = tenant;
        if (tenant === undefined) setDispatchTenantResolver(undefined);
        else setDispatchTenantResolver(() => active);
      },
    };
  }

  const statuses = async (db: DispatchTestDatabase['db']) => {
    const out: Record<string, string> = {};
    for (const id of [
      'a-routed',
      'a-global-sub-only',
      'global-routed',
      'global-unrouted',
      'b-unrouted',
    ]) {
      out[id] = (await dispatchLeaseRow(db, id)).status;
    }
    return out;
  };

  it('tenant maintenance is owner-exact and never touches global rows', async () => {
    const { bus, db, as } = await seed();
    as(TENANT_A);
    expect((await bus.maintain()).orphaned).toBe(1);
    expect(await statuses(db)).toEqual({
      'a-routed': 'processing',
      'a-global-sub-only': 'failed',
      'global-routed': 'processing',
      'global-unrouted': 'processing',
      'b-unrouted': 'processing',
    });
  });

  it('no-tenant maintenance sweeps global rows only, routed by any tenant subscription', async () => {
    const { bus, db, as } = await seed();
    as(null);
    expect((await bus.maintain()).orphaned).toBe(1);
    expect(await statuses(db)).toEqual({
      'a-routed': 'processing',
      'a-global-sub-only': 'processing',
      'global-routed': 'processing',
      'global-unrouted': 'failed',
      'b-unrouted': 'processing',
    });
  });

  it('system maintenance correlates each row with its own tenant subscriptions', async () => {
    const { bus, db, as } = await seed();
    as(undefined);
    expect((await bus.maintain()).orphaned).toBe(3);
    expect(await statuses(db)).toEqual({
      'a-routed': 'processing',
      'a-global-sub-only': 'failed',
      'global-routed': 'processing',
      'global-unrouted': 'failed',
      'b-unrouted': 'failed',
    });
  });
}

/** T20: release expired, after-drain and legacy leases, tenant-exact. */
export function defineLeaseReleaseCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  async function seed(tenantId: string | null = null, prefix = '') {
    const ctx = await open();
    const rows = [
      {
        ...abandoned(`${prefix}expired`, 'job.run', { tenantId }),
        attempts: 3,
      },
      {
        ...abandoned(`${prefix}live`, 'job.run', { tenantId }),
        claimedUntil: future(),
      },
      {
        ...abandoned(`${prefix}legacy`, 'job.run', { tenantId }),
        leaseToken: null,
        claimedUntil: null,
      },
      { id: `${prefix}waiting`, type: 'job.run', tenantId },
    ];
    for (const row of rows) await insertRawDispatch(ctx.db, row);
    return ctx;
  }

  it('release-leases expired, legacy and after-drain move rows to pending with attempts kept', async () => {
    const { bus, db } = await seed();

    const preview = await bus.maintain({
      release: 'expired',
      sweepOrphans: false,
      dryRun: true,
    });
    expect(preview).toMatchObject({ released: 1, orphaned: 0, dryRun: true });
    expect((await dispatchLeaseRow(db, 'expired')).status).toBe('processing');

    expect(
      (await bus.maintain({ release: 'expired', sweepOrphans: false }))
        .released,
    ).toBe(1);
    const expired = await dispatchLeaseRow(db, 'expired');
    expect(expired).toMatchObject({
      status: 'pending',
      attempts: 3,
      leaseToken: null,
      claimedUntil: null,
    });
    expect(expired.lastError?.startsWith('[smrt:DISPATCH_RELEASED]')).toBe(
      true,
    );
    expect((await dispatchLeaseRow(db, 'live')).status).toBe('processing');
    expect((await dispatchLeaseRow(db, 'legacy')).status).toBe('processing');

    expect(
      (await bus.maintain({ release: 'legacy', sweepOrphans: false })).released,
    ).toBe(1);
    expect((await dispatchLeaseRow(db, 'legacy')).status).toBe('pending');
    expect((await dispatchLeaseRow(db, 'live')).status).toBe('processing');

    // Rollback after every worker stopped: no leased row remains.
    expect(
      (await bus.maintain({ release: 'afterDrain', sweepOrphans: false }))
        .released,
    ).toBe(1);
    const live = await dispatchLeaseRow(db, 'live');
    expect(live).toMatchObject({ status: 'pending', leaseToken: null });
    expect((await dispatchLeaseRow(db, 'waiting')).status).toBe('pending');
  });

  it('release is tenant-exact', async () => {
    const ctx = await seed(TENANT_A, 'a-');
    for (const row of [
      { ...abandoned('b-expired', 'job.run', { tenantId: TENANT_B }) },
      { ...abandoned('g-expired', 'job.run') },
    ]) {
      await insertRawDispatch(ctx.db, row);
    }
    setDispatchTenantResolver(() => TENANT_A);
    expect(
      (await ctx.bus.maintain({ release: 'afterDrain', sweepOrphans: false }))
        .released,
    ).toBe(2);
    expect((await dispatchLeaseRow(ctx.db, 'b-expired')).status).toBe(
      'processing',
    );
    expect((await dispatchLeaseRow(ctx.db, 'g-expired')).status).toBe(
      'processing',
    );
  });

  it('rejects an unknown release mode', async () => {
    const { bus } = await open();
    await expect(
      bus.maintain({ release: 'everything' as never }),
    ).rejects.toThrow(/release/);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** T10: the opt-in execution deadline. */
export function defineLeaseDeadlineCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);
  const leaseMs = 1_000;

  it('opt-in deadline nulls the token, moves on, and is not re-claimed in the same call', async () => {
    const { bus, db } = await open({
      bus: { leaseMs, maxExecutionMs: leaseMs },
    });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, {
      id: 'hung',
      type: 'job.run',
      createdAt: ago(60_000),
    });
    await insertRawDispatch(db, {
      id: 'next',
      type: 'job.run',
      createdAt: ago(30_000),
    });

    const calls: string[] = [];
    let hungSignal: AbortSignal | undefined;
    let releaseHung = () => {};
    const hungDone = new Promise<void>((resolve) => {
      releaseHung = resolve;
    });
    let stats: DispatchProcessStats | undefined;
    const first = await bus.process(
      'worker',
      async (_payload, metadata) => {
        calls.push(metadata.id);
        if (metadata.id === 'hung' && metadata.attempts === 1) {
          hungSignal = metadata.signal;
          await hungDone;
        }
      },
      { onStats: (value) => (stats = value) },
    );

    expect(first).toBe(1);
    expect(calls).toEqual(['hung', 'next']);
    expect(stats?.timedOut).toBe(1);
    expect(hungSignal?.aborted).toBe(true);
    expect((hungSignal?.reason as { code?: string })?.code).toBe(
      'DISPATCH_EXECUTION_TIMEOUT',
    );
    const timedOut = await dispatchLeaseRow(db, 'hung');
    expect(timedOut.status).toBe('processing');
    expect(timedOut.leaseToken).toBeNull();
    expect(
      timedOut.lastError?.startsWith('[smrt:DISPATCH_EXECUTION_TIMEOUT]'),
    ).toBe(true);

    // Another call reclaims the timed-out row.
    await sleep(5);
    expect(await bus.process('worker', async () => {})).toBe(1);
    const reclaimed = await dispatchLeaseRow(db, 'hung');
    expect(reclaimed.status).toBe('completed');
    expect(reclaimed.attempts).toBe(2);

    // The first attempt finishing late changes nothing.
    releaseHung();
    await sleep(20);
    expect(await dispatchLeaseRow(db, 'hung')).toEqual(reclaimed);
  });

  it('without a deadline a slow handler is never timed out', async () => {
    const { bus, db } = await open({ bus: { leaseMs } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'slow', type: 'job.run' });
    let stats: DispatchProcessStats | undefined;
    const count = await bus.process(
      'worker',
      async () => {
        await sleep(leaseMs + 500);
      },
      { onStats: (value) => (stats = value) },
    );
    expect(count).toBe(1);
    expect(stats?.timedOut).toBe(0);
    expect((await dispatchLeaseRow(db, 'slow')).status).toBe('completed');
  });

  it('a per-call deadline applies to that call', async () => {
    const { bus, db } = await open({ bus: { leaseMs } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'hung', type: 'job.run' });
    let stats: DispatchProcessStats | undefined;
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    await bus.process('worker', async () => done, {
      maxExecutionMs: leaseMs,
      onStats: (value) => (stats = value),
    });
    release();
    expect(stats?.timedOut).toBe(1);
    expect((await dispatchLeaseRow(db, 'hung')).leaseToken).toBeNull();
  });
}

/** T11: the long-lease diagnostic, without a deadline. */
export function defineLongLeaseCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);

  it('warns once when an attempt exceeds 3x leaseMs without a deadline', async () => {
    const leaseMs = 1_000;
    const { bus, db } = await open({ bus: { leaseMs } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, { id: 'long', type: 'job.run' });
    let stats: DispatchProcessStats | undefined;
    const count = await bus.process(
      'worker',
      async () => {
        await sleep(3 * leaseMs + 400);
      },
      { onStats: (value) => (stats = value) },
    );
    expect(count).toBe(1);
    expect(stats?.longLeases).toBe(1);
    expect(stats?.timedOut).toBe(0);
    // Diagnostic only: the attempt kept its lease and settled.
    expect((await dispatchLeaseRow(db, 'long')).status).toBe('completed');
  });
}

/** A `processing` row an older core claimed (no lease), last written `ageMs` ago. */
function legacyClaimed(id: string, ageMs: number, attempts = 1) {
  const at = ago(ageMs);
  return {
    id,
    type: 'job.run',
    status: 'processing',
    attempts,
    createdAt: at,
    updatedAt: at,
  };
}

/** T27, T15 (legacy branch): opt-in reclaim of rows claimed by an older core. */
export function defineLeaseLegacyCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);
  const HOUR = 3_600_000;

  it('pages NULL-lease rows when legacy reclaim is on; untouched when off', async () => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, legacyClaimed('old-1', 2 * HOUR));
    await insertRawDispatch(db, legacyClaimed('old-2', 3 * HOUR));
    await insertRawDispatch(db, legacyClaimed('within-grace', 60_000));
    await insertRawDispatch(db, { id: 'waiting', type: 'job.run' });

    // Off (default): only the pending row is processed.
    const off: string[] = [];
    await bus.process('worker', async (_payload, metadata) => {
      off.push(metadata.id);
    });
    expect(off).toEqual(['waiting']);
    expect((await dispatchLeaseRow(db, 'old-1')).status).toBe('processing');

    // On: legacy rows past the grace period, oldest first.
    const legacy = new DispatchBus(db, { legacyLeaseGraceMs: 30 * 60_000 });
    const on: Array<[string, number]> = [];
    await legacy.process('worker', async (_payload, metadata) => {
      on.push([metadata.id, metadata.attempts]);
    });
    expect(on).toEqual([
      ['old-2', 2],
      ['old-1', 2],
    ]);
    expect((await dispatchLeaseRow(db, 'old-1')).status).toBe('completed');
    expect((await dispatchLeaseRow(db, 'within-grace')).status).toBe(
      'processing',
    );
  });

  it('claim cap applies to the legacy branch when legacy reclaim is on', async () => {
    const { bus, db } = await open({ bus: { maxAttempts: 2 } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, legacyClaimed('legacy-at-cap', 2 * HOUR, 2));

    await bus.process('worker', async () => {});
    expect((await dispatchLeaseRow(db, 'legacy-at-cap')).status).toBe(
      'processing',
    );

    const legacy = new DispatchBus(db, {
      maxAttempts: 2,
      legacyLeaseGraceMs: 60_000,
    });
    const calls: string[] = [];
    await legacy.process('worker', async (_payload, metadata) => {
      calls.push(metadata.id);
    });
    expect(calls).toEqual([]);
    const row = await dispatchLeaseRow(db, 'legacy-at-cap');
    expect(row.status).toBe('failed');
    expect(
      row.lastError?.startsWith('[smrt:DISPATCH_ATTEMPTS_EXHAUSTED]'),
    ).toBe(true);
  });

  it('maintenance fails an unrouted legacy row only when legacy reclaim is on', async () => {
    const { bus, db } = await open();
    await insertRawDispatch(db, {
      ...legacyClaimed('legacy-unrouted', 2 * DAY_MS),
      type: 'nobody.listens',
    });
    expect((await bus.maintain()).orphaned).toBe(0);
    const legacy = new DispatchBus(db, { legacyLeaseGraceMs: 60_000 });
    expect((await legacy.maintain()).orphaned).toBe(1);
    expect((await dispatchLeaseRow(db, 'legacy-unrouted')).status).toBe(
      'failed',
    );
  });
}

/**
 * T26 (legacy half), T34: SQLite-only shapes. A legacy row whose timestamp
 * text JavaScript cannot read is never reclaimed and never blocks healthy
 * rows; statements an older core runs still work on the upgraded table.
 */
export function defineLeaseLegacySqliteCases(
  openDatabase: DispatchOpener,
): void {
  const open = useOpener(openDatabase);

  it('a legacy row with an unreadable timestamp is never reclaimed and never blocks', async () => {
    const { bus, db } = await open({ bus: { legacyLeaseGraceMs: 60_000 } });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    // Sorts below every ISO timestamp, so it is the first legacy candidate.
    await insertRawDispatch(db, {
      ...legacyClaimed('garbage', 0),
      updatedAt: '0000-not-a-time',
    });
    await insertRawDispatch(db, legacyClaimed('healthy', 2 * 3_600_000));
    const calls: string[] = [];
    let stats: DispatchProcessStats | undefined;
    await bus.process(
      'worker',
      async (_payload, metadata) => {
        calls.push(metadata.id);
      },
      { onStats: (value) => (stats = value) },
    );
    expect(calls).toEqual(['healthy']);
    expect(stats?.malformed).toBe(1);
    const garbage = await dispatchLeaseRow(db, 'garbage');
    expect(garbage.status).toBe('processing');
    expect(garbage.leaseToken).toBeNull();
  });

  it('old settle SQL on the upgraded table: no reclaim when legacy is off; old code runs after a legacy release', async () => {
    const { bus, db } = await open();
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await insertRawDispatch(db, legacyClaimed('old-claim', 2 * 3_600_000));

    await bus.process('worker', async () => {
      throw new Error('must not run');
    });
    expect((await dispatchLeaseRow(db, 'old-claim')).status).toBe('processing');

    // The drained older process is gone; release its claim, then an older
    // process claims and settles it with its own statements.
    expect(
      (await bus.maintain({ release: 'legacy', sweepOrphans: false })).released,
    ).toBe(1);
    const now = new Date().toISOString();
    const claimed = await db.query(
      `UPDATE _smrt_dispatch SET status = 'processing', attempts = attempts + 1, updated_at = $1
        WHERE id = $2 AND status = 'pending' RETURNING id`,
      now,
      'old-claim',
    );
    expect(claimed.rows).toHaveLength(1);
    await db.query(
      `UPDATE _smrt_dispatch SET status = 'completed', processed_at = $1,
              processed_by = $2, updated_at = $3 WHERE id = $4`,
      now,
      'old-worker',
      now,
      'old-claim',
    );
    expect((await dispatchLeaseRow(db, 'old-claim')).status).toBe('completed');
  });
}

/** T32 (library half): the read-only preview and the pending-only phases. */
export function defineProcessPreviewCases(openDatabase: DispatchOpener): void {
  const open = useOpener(openDatabase);

  async function seed(options?: Parameters<DispatchOpener>[0]) {
    const ctx = await open(options);
    await ctx.bus.subscribe({ signalType: 'job.*', subscriber: 'worker' });
    await insertRawDispatch(ctx.db, abandoned('expired', 'job.run'));
    await insertRawDispatch(ctx.db, {
      id: 'dated',
      type: 'job.run',
      createdAt: ago(60_000),
    });
    await insertRawDispatch(ctx.db, {
      id: 'undated',
      type: 'job.run',
      createdAt: null,
    });
    await insertRawDispatch(ctx.db, { id: 'unrouted', type: 'mail.send' });
    return ctx;
  }

  it('previewProcess lists claimable rows with their phase and writes nothing', async () => {
    const { bus, db } = await seed();
    const all = await bus.previewProcess('worker');
    expect(all.map(({ dispatch, phase }) => [dispatch.id, phase])).toEqual([
      ['expired', 'expired'],
      ['undated', 'undated'],
      ['dated', 'dated'],
    ]);
    const expired = await dispatchLeaseRow(db, 'expired');
    expect(expired.status).toBe('processing');
    expect(expired.leaseToken).toBe('gone-expired');
    expect(expired.attempts).toBe(1);

    const pending = await bus.previewProcess('worker', { phases: 'pending' });
    expect(pending.map(({ dispatch }) => dispatch.id)).toEqual([
      'undated',
      'dated',
    ]);
    // The limit applies after matching.
    const first = await bus.previewProcess('worker', { limit: 1 });
    expect(first.map(({ dispatch }) => dispatch.id)).toEqual(['expired']);
  });

  it("phases: 'pending' neither reclaims nor cap-sweeps an expired lease", async () => {
    const { bus, db } = await seed({ bus: { maxAttempts: 2 } });
    await insertRawDispatch(db, {
      ...abandoned('expired-at-cap', 'job.run'),
      attempts: 2,
    });

    const calls: string[] = [];
    await bus.process(
      'worker',
      async (_payload, metadata) => {
        calls.push(metadata.id);
      },
      { phases: 'pending' },
    );
    expect(calls).toEqual(['undated', 'dated']);
    expect((await dispatchLeaseRow(db, 'expired')).leaseToken).toBe(
      'gone-expired',
    );
    expect((await dispatchLeaseRow(db, 'expired-at-cap')).status).toBe(
      'processing',
    );

    calls.length = 0;
    await bus.process('worker', async (_payload, metadata) => {
      calls.push(metadata.id);
    });
    expect(calls).toEqual(['expired']);
    expect((await dispatchLeaseRow(db, 'expired-at-cap')).status).toBe(
      'failed',
    );
  });

  it('rejects an unknown phases value', async () => {
    const { bus } = await seed();
    await expect(
      bus.process('worker', async () => {}, { phases: 'some' as never }),
    ).rejects.toThrow(/phases/);
  });
}
