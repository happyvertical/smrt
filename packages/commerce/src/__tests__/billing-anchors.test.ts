/**
 * Billing-cycle anchors and flat-plan proration (#3116).
 *
 * Scenarios run at fixed dates in 2030 with no usage charges, so every line
 * is a flat plan: SITE's plan billed to NETWORK, SOLO's to itself (2500
 * each), and, where added, STRANGER's site billed to NETWORK.
 */

import { TenantUsageMetricCollection } from '@happyvertical/smrt-subscriptions';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addBillingMonths,
  billingPeriodContaining,
  lastEndedBillingPeriod,
  prorateMinorUnits,
} from '../billing/cycles.js';
import { previousCalendarMonth } from '../billing/period-close.js';
import type { BillingProviderInvoiceInput } from '../billing/provider.js';
import { BillingRuntime } from '../billing/runtime.js';
import * as commerceRoot from '../index.js';
import {
  addNetworkSite,
  at,
  claimedWindows,
  DAY,
  holdFlatClaim,
  invoicesOf,
  overlappingClaims,
  parkNetwork,
  subscriptionOf,
  updateSubscription,
} from './helpers/anchor-fixture.js';
import {
  type BillingWorld,
  createBillingWorld,
  NETWORK,
  PROVIDER,
  SITE,
  SOLO,
  STRANGER,
} from './helpers/billing-fixture.js';

const iso = (date: Date) => date.toISOString();

describe('smrt#3116 billing-cycle schedule math', () => {
  it('adds months from the anchor itself, clamping short months without drift', () => {
    const anchor = at('2031-01-31T09:30:00.000Z');
    expect(
      [0, 1, 2, 3, 13].map((k) => iso(addBillingMonths(anchor, k))),
    ).toEqual([
      '2031-01-31T09:30:00.000Z',
      '2031-02-28T09:30:00.000Z',
      '2031-03-31T09:30:00.000Z',
      '2031-04-30T09:30:00.000Z',
      '2032-02-29T09:30:00.000Z',
    ]);
    expect(iso(addBillingMonths(at('2031-12-15T00:00:00Z'), 1))).toBe(
      '2032-01-15T00:00:00.000Z',
    );
  });

  it('finds the anchored period, the stub before the anchor, and calendar months', () => {
    const anchor = at('2031-01-31T09:30:00.000Z');
    const period = (date: string) => {
      const found = billingPeriodContaining(anchor, at(date));
      return [
        iso(found.periodStart),
        iso(found.periodEnd),
        iso(found.cycleStart),
        iso(found.cycleEnd),
      ];
    };
    // Inside the Feb 28 → Mar 31 period, including its first instant.
    expect(period('2031-03-01T00:00:00Z')).toEqual([
      '2031-02-28T09:30:00.000Z',
      '2031-03-31T09:30:00.000Z',
      '2031-02-28T09:30:00.000Z',
      '2031-03-31T09:30:00.000Z',
    ]);
    expect(period('2031-02-28T09:30:00Z')[0]).toBe('2031-02-28T09:30:00.000Z');
    expect(period('2031-02-28T09:29:59.999Z')[0]).toBe(
      '2031-01-31T09:30:00.000Z',
    );
    // Before the anchor: the stub from the month start, prorated against
    // January, and plain calendar months before that.
    expect(period('2031-01-20T00:00:00Z')).toEqual([
      '2031-01-01T00:00:00.000Z',
      '2031-01-31T09:30:00.000Z',
      '2031-01-01T00:00:00.000Z',
      '2031-02-01T00:00:00.000Z',
    ]);
    expect(period('2030-12-20T00:00:00Z').slice(0, 2)).toEqual([
      '2030-12-01T00:00:00.000Z',
      '2031-01-01T00:00:00.000Z',
    ]);
  });

  it('closes the previous calendar month without an anchor', () => {
    const now = at('2031-03-10T12:00:00Z');
    const last = lastEndedBillingPeriod(null, now);
    expect(last).toMatchObject(previousCalendarMonth(now));
    const anchored = lastEndedBillingPeriod(at('2031-01-23T00:00:00Z'), now);
    expect([iso(anchored.periodStart), iso(anchored.periodEnd)]).toEqual([
      '2031-01-23T00:00:00.000Z',
      '2031-02-23T00:00:00.000Z',
    ]);
  });

  it('prorates in integer minor units, rounding half up', () => {
    expect(prorateMinorUnits(2500, 15 * DAY, 30 * DAY)).toBe(1250);
    expect(prorateMinorUnits(1, 1, 2)).toBe(1); // exactly half rounds up
    expect(prorateMinorUnits(1, 1, 3)).toBe(0);
    expect(prorateMinorUnits(2, 1, 3)).toBe(1); // 0.667
    expect(prorateMinorUnits(2500, 31 * DAY, 31 * DAY)).toBe(2500);
    expect(prorateMinorUnits(2500, 40 * DAY, 31 * DAY)).toBe(2500);
    expect(prorateMinorUnits(2500, 0, 31 * DAY)).toBe(0);
    // Exact beyond 2^53 intermediate products.
    const big = Number.MAX_SAFE_INTEGER;
    expect(prorateMinorUnits(big, 31 * DAY - 1, 31 * DAY)).toBe(
      Number(
        (BigInt(big) * BigInt(31 * DAY - 1) * 2n + BigInt(31 * DAY)) /
          (BigInt(31 * DAY) * 2n),
      ),
    );
    expect(() => prorateMinorUnits(-1, 1, 2)).toThrow('non-negative');
    expect(() => prorateMinorUnits(1.5, 1, 2)).toThrow('non-negative');
  });

  it('exports the schedule helpers from the package root', () => {
    for (const name of [
      'addBillingMonths',
      'billingPeriodContaining',
      'lastEndedBillingPeriod',
      'prorateMinorUnits',
    ]) {
      expect(commerceRoot, name).toHaveProperty(name);
    }
  });
});

describe('smrt#3116 anchored period close', () => {
  let world: BillingWorld;

  beforeEach(async () => {
    const usage = await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    world = await createBillingWorld(usage.db);
  });

  const anchor = (
    payer: string,
    billingAnchorAt: Date | null,
    prorate = false,
  ) =>
    withSystemContext(() =>
      world.provider.upsertAccount({
        payerTenantId: payer,
        name: payer === SOLO ? 'Solo LLC' : 'Network Co',
        billingAnchorAt,
        prorateFlatPlans: prorate,
      }),
    );

  it('closes two payers with different anchors on the same tick, once each', async () => {
    const networkAnchor = at('2030-03-23T09:30:00Z');
    const soloAnchor = at('2030-03-05T00:00:00Z');
    await anchor(NETWORK, networkAnchor);
    await anchor(SOLO, soloAnchor);
    await updateSubscription(world, SITE, { startedAt: networkAnchor });
    await updateSubscription(world, SOLO, { startedAt: soloAnchor });
    const pushed: BillingProviderInvoiceInput[] = [];
    const push = world.provider.provider.pushInvoice.bind(
      world.provider.provider,
    );
    world.provider.provider.pushInvoice = async (input) => {
      pushed.push(input);
      return push(input);
    };

    const result = await world.provider.closePeriod({
      now: at('2030-04-24T00:00:00Z'),
    });
    expect(
      result.groups.map((group) => [
        group.payerTenantId,
        iso(group.periodStart),
        iso(group.periodEnd),
        group.outcome,
      ]),
    ).toEqual([
      [
        NETWORK,
        '2030-03-23T09:30:00.000Z',
        '2030-04-23T09:30:00.000Z',
        'completed',
      ],
      [
        SOLO,
        '2030-03-05T00:00:00.000Z',
        '2030-04-05T00:00:00.000Z',
        'completed',
      ],
    ]);
    // Anchor at signup: a full first period, nothing for the time before it.
    expect((await invoicesOf(world, NETWORK)).map((i) => i.subtotal)).toEqual([
      2500,
    ]);
    expect((await invoicesOf(world, SOLO)).map((i) => i.subtotal)).toEqual([
      2500,
    ]);
    // The provider invoice lines carry the anchored service period.
    const networkLine = pushed
      .flatMap((input) => input.lines)
      .find((line) => line.description.includes(SITE));
    expect(networkLine).toMatchObject({
      amount: 2500,
      periodStart: networkAnchor,
      periodEnd: at('2030-04-23T09:30:00Z'),
    });
    expect(networkLine?.description).toContain('2030-03-23 to 2030-04-23');

    // A daily schedule re-runs the close: nothing is billed twice.
    for (const day of ['2030-04-24T06:00:00Z', '2030-04-25T00:00:00Z']) {
      await world.provider.closePeriod({ now: at(day) });
    }
    expect(world.stripe.invoices.size).toBe(2);

    const next = await world.provider.closePeriod({
      now: at('2030-05-24T00:00:00Z'),
    });
    expect(
      next.groups.map((group) => [group.payerTenantId, iso(group.periodStart)]),
    ).toEqual([
      [NETWORK, '2030-04-23T09:30:00.000Z'],
      [SOLO, '2030-04-05T00:00:00.000Z'],
    ]);
    expect(world.stripe.invoices.size).toBe(4);
    expect(await overlappingClaims(world)).toEqual([]);
  });

  it('keeps calendar months as the default schedule', async () => {
    await updateSubscription(world, SITE, { startedAt: at('2030-01-10') });
    await updateSubscription(world, SOLO, { startedAt: at('2030-01-10') });
    const now = at('2030-03-02T00:00:00Z');
    const result = await world.provider.closePeriod({ now });
    expect([iso(result.periodStart), iso(result.periodEnd)]).toEqual([
      '2030-02-01T00:00:00.000Z',
      '2030-03-01T00:00:00.000Z',
    ]);
    expect(
      result.groups.map((group) => [
        group.payerTenantId,
        iso(group.periodStart),
        group.outcome,
      ]),
    ).toEqual([
      [NETWORK, '2030-02-01T00:00:00.000Z', 'completed'],
      [SOLO, '2030-02-01T00:00:00.000Z', 'completed'],
    ]);
    expect((await invoicesOf(world, SOLO)).map((i) => i.subtotal)).toEqual([
      2500,
    ]);
    expect(
      await world.provider.billingPeriodFor(SOLO, at('2030-03-02')),
    ).toMatchObject({
      periodStart: at('2030-03-01T00:00:00Z'),
      periodEnd: at('2030-04-01T00:00:00Z'),
    });
  });

  it('prorates a site added mid-period to the payer anchor', async () => {
    const networkAnchor = at('2030-03-23T09:30:00Z');
    await anchor(NETWORK, networkAnchor, true);
    await updateSubscription(world, SITE, { startedAt: networkAnchor });
    await updateSubscription(world, SOLO, { startedAt: at('2040-01-01') });
    const added = await addNetworkSite(
      world,
      STRANGER,
      at('2030-04-08T00:00:00Z'),
    );

    await world.provider.closePeriod({ now: at('2030-04-24T00:00:00Z') });
    // 15.5 days less 6h of a 31-day cycle: 2500 × 369.5h / 744h = 1241.6.
    expect(await claimedWindows(world, String(added.id))).toEqual([
      ['2030-04-08T00:00:00.000Z', '2030-04-23T09:30:00.000Z', 1242],
    ]);
    const [first] = await invoicesOf(world, NETWORK);
    expect(first?.subtotal).toBe(2500 + 1242);

    await world.provider.closePeriod({ now: at('2030-05-24T00:00:00Z') });
    expect((await invoicesOf(world, NETWORK)).map((i) => i.subtotal)).toEqual([
      3742, 5000,
    ]);
  });

  it('bills a mid-period addition in full when proration is off', async () => {
    const networkAnchor = at('2030-03-23T09:30:00Z');
    await anchor(NETWORK, networkAnchor);
    await updateSubscription(world, SITE, { startedAt: networkAnchor });
    await updateSubscription(world, SOLO, { startedAt: at('2040-01-01') });
    await addNetworkSite(world, STRANGER, at('2030-04-08T00:00:00Z'));
    await world.provider.closePeriod({ now: at('2030-04-24T00:00:00Z') });
    expect((await invoicesOf(world, NETWORK)).map((i) => i.subtotal)).toEqual([
      5000,
    ]);
  });

  it('prorates a cancellation mid-period and bills nothing after it', async () => {
    const soloAnchor = at('2030-03-05T00:00:00Z');
    await anchor(SOLO, soloAnchor, true);
    await parkNetwork(world);
    const solo = await updateSubscription(world, SOLO, {
      startedAt: soloAnchor,
      status: 'canceled',
      canceledAt: at('2030-04-20T00:00:00Z'),
    });
    await world.provider.closePeriod({ now: at('2030-04-06T00:00:00Z') });
    await world.provider.closePeriod({ now: at('2030-05-06T00:00:00Z') });
    await world.provider.closePeriod({ now: at('2030-06-06T00:00:00Z') });
    // Mar 5 → Apr 5 in full; Apr 5 → Apr 20 is 15 of 30 days.
    expect(await claimedWindows(world, String(solo.id))).toEqual([
      ['2030-03-05T00:00:00.000Z', '2030-04-05T00:00:00.000Z', 2500],
      ['2030-04-05T00:00:00.000Z', '2030-04-20T00:00:00.000Z', 1250],
    ]);
  });

  it('bills from signup to the next anchor when the first period is prorated', async () => {
    // A fixed schedule (calendar months) with proration: signup mid-month
    // bills the partial month, then full months. A trial is not billed.
    await anchor(SOLO, null, true);
    await parkNetwork(world);
    const solo = await updateSubscription(world, SOLO, {
      startedAt: at('2030-03-20T00:00:00Z'),
      trialEndsAt: at('2030-03-23T00:00:00Z'),
    });
    await world.provider.closePeriod({ now: at('2030-04-02T00:00:00Z') });
    await world.provider.closePeriod({ now: at('2030-05-02T00:00:00Z') });
    // Mar 23 → Apr 1: 9 of 31 days = 725.8.
    expect(await claimedWindows(world, String(solo.id))).toEqual([
      ['2030-03-23T00:00:00.000Z', '2030-04-01T00:00:00.000Z', 726],
      ['2030-04-01T00:00:00.000Z', '2030-05-01T00:00:00.000Z', 2500],
    ]);
    const [partial] = await invoicesOf(world, SOLO);
    expect(partial?.subtotal).toBe(726);
  });

  it('moves a calendar payer to an anchor with no gap and no double billing', async () => {
    await parkNetwork(world);
    const solo = await updateSubscription(world, SOLO, {
      startedAt: at('2030-01-01T00:00:00Z'),
    });
    await world.provider.closePeriod({ now: at('2030-03-02T00:00:00Z') });
    await anchor(SOLO, at('2030-03-20T00:00:00Z'));
    for (const day of [
      '2030-03-10T00:00:00Z',
      '2030-03-21T00:00:00Z',
      '2030-04-21T00:00:00Z',
    ]) {
      await world.provider.closePeriod({ now: at(day) });
    }
    // February (calendar), the Mar 1 → Mar 20 stub (19 of 31 days, billed
    // pro rata even without proration), then the first anchored period.
    expect(await claimedWindows(world, String(solo.id))).toEqual([
      ['2030-02-01T00:00:00.000Z', '2030-03-01T00:00:00.000Z', 2500],
      ['2030-03-01T00:00:00.000Z', '2030-03-20T00:00:00.000Z', 1532],
      ['2030-03-20T00:00:00.000Z', '2030-04-20T00:00:00.000Z', 2500],
    ]);
    expect(await overlappingClaims(world)).toEqual([]);
  });

  it('never re-bills time already billed when an anchor moves into it', async () => {
    await parkNetwork(world);
    const solo = await updateSubscription(world, SOLO, {
      startedAt: at('2030-01-01T00:00:00Z'),
    });
    await world.provider.closePeriod({ now: at('2030-03-02T00:00:00Z') });
    // An anchor inside already-billed February.
    await anchor(SOLO, at('2030-02-15T00:00:00Z'));
    await world.provider.closePeriod({ now: at('2030-03-16T00:00:00Z') });
    // Feb 15 → Mar 15 overlaps the billed Feb 15 → Mar 1: only Mar 1 → Mar
    // 15 is billed, 14 of the cycle's 28 days.
    expect(await claimedWindows(world, String(solo.id))).toEqual([
      ['2030-02-01T00:00:00.000Z', '2030-03-01T00:00:00.000Z', 2500],
      ['2030-03-01T00:00:00.000Z', '2030-03-15T00:00:00.000Z', 1250],
    ]);
    const [, second] = await invoicesOf(world, SOLO);
    expect(second?.subtotal).toBe(1250);
  });

  it('closes an explicit period only for payers whose schedule has it', async () => {
    const networkAnchor = at('2030-03-23T09:30:00Z');
    await anchor(NETWORK, networkAnchor);
    await updateSubscription(world, SITE, { startedAt: networkAnchor });
    await updateSubscription(world, SOLO, { startedAt: at('2030-03-01') });
    const march = await world.provider.closePeriod({
      periodStart: at('2030-03-01T00:00:00Z'),
      periodEnd: at('2030-04-01T00:00:00Z'),
      now: at('2030-04-02T00:00:00Z'),
    });
    expect(march.groups.map((group) => group.payerTenantId)).toEqual([SOLO]);
    const anchored = await world.provider.closePeriod({
      periodStart: networkAnchor,
      periodEnd: at('2030-04-23T09:30:00Z'),
      now: at('2030-04-24T00:00:00Z'),
    });
    expect(
      anchored.groups.map((group) => [group.payerTenantId, group.outcome]),
    ).toEqual([[NETWORK, 'completed']]);
    // The due close of the same period finds it done.
    await world.provider.closePeriod({ now: at('2030-04-24T00:00:00Z') });
    expect((await invoicesOf(world, NETWORK)).map((i) => i.subtotal)).toEqual([
      2500,
    ]);
  });

  it('lets only one of two racing claims bill a window when the schedule changes mid-close', async () => {
    await parkNetwork(world);
    await anchor(SOLO, at('2030-02-15T00:00:00Z'));
    const solo = await updateSubscription(world, SOLO, {
      startedAt: at('2030-01-01T00:00:00Z'),
    });
    const peer = await BillingRuntime.create({
      db: world.db,
      sellerTenantId: PROVIDER,
      kind: 'provider',
      provider: world.provider.provider,
      billingRelationships: world.relationships,
      ledger: world.ledger,
    });
    // The provider customer exists already, so neither worker writes the
    // account while racing.
    const account = await world.provider.getAccount(SOLO);
    if (!account) throw new Error('missing account');
    await world.provider.ensureProviderCustomer(account);
    const now = at('2030-03-16T00:00:00Z');
    const hold = holdFlatClaim(world.provider, `subscription|${solo.id}`);
    try {
      // Worker A read the anchored schedule (Feb 15 → Mar 15) and the empty
      // coverage, and is about to insert.
      const stale = world.provider.closePeriod({ now });
      await hold.reached;
      // Meanwhile the payer returns to calendar months and worker B bills
      // February.
      await withSystemContext(() =>
        peer.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo LLC',
          billingAnchorAt: null,
        }),
      );
      await peer.closePeriod({ now });
      hold.release();
      await stale;
    } finally {
      hold.restore();
    }
    // A lost the race for the chain position, re-read, and billed only the
    // time B had not: Mar 1 → Mar 15 of its 28-day cycle.
    expect(await claimedWindows(world, String(solo.id))).toEqual([
      ['2030-02-01T00:00:00.000Z', '2030-03-01T00:00:00.000Z', 2500],
      ['2030-03-01T00:00:00.000Z', '2030-03-15T00:00:00.000Z', 1250],
    ]);
    expect(await overlappingClaims(world)).toEqual([]);
  });

  it('validates the anchor on the account', async () => {
    await expect(anchor(SOLO, new Date(Number.NaN))).rejects.toThrow(
      'billingAnchorAt must be a valid date or null.',
    );
    const saved = await anchor(SOLO, at('2030-03-05T00:00:00Z'), true);
    const reloaded = await world.provider.getAccount(SOLO);
    expect(reloaded?.billingAnchorAt?.toISOString()).toBe(
      saved.billingAnchorAt?.toISOString(),
    );
    expect(reloaded?.prorateFlatPlans).toBe(true);
    expect(await subscriptionOf(world, SOLO)).toBeTruthy();
  });
});
