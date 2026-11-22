/**
 * Dispatch maintenance suites (P6 T18-T20, T23 orphan half, T27, T34),
 * shared by the default/PGlite lane files and the
 * `*-postgres.optional.test.ts` files: each suite takes an opener, so the
 * same cases run on SQLite, DuckDB, PGlite and PostgreSQL.
 */

import { afterEach, expect, it } from 'vitest';
import { setDispatchTenantResolver } from '../../dispatch/tenant-resolver';
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
