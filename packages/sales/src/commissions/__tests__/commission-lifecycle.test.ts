/**
 * Tests for the Commission status machine (strict pending → earned →
 * approved → payable → paid chain with save-time guard), the settlement
 * service sweep/approve helpers, and CommissionAdjustment append-only
 * semantics.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import type { Commission } from '../models/Commission.js';
import type { Earner } from '../models/Earner.js';
import { CommissionSettlementService } from '../services/CommissionSettlementService.js';
import type { CommissionStatus } from '../types.js';

describe('Commission lifecycle', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let commissions: CommissionCollection;
  let adjustments: CommissionAdjustmentCollection;
  let earner: Earner;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    earners = await EarnerCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    adjustments = await CommissionAdjustmentCollection.create({ db });
    earner = await earners.create({
      profileId: 'profile-1',
      displayName: 'Casey Rep',
      status: 'active',
    });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  let commissionCounter = 0;
  async function createCommission(
    overrides: Record<string, unknown> = {},
  ): Promise<Commission> {
    commissionCounter += 1;
    return await commissions.create({
      earnerId: earner.id as string,
      amountCents: 1000,
      currency: 'USD',
      dedupeKey: `comm-${commissionCounter}`,
      ...overrides,
    });
  }

  it('walks the full chain and stamps each timestamp', async () => {
    const commission = await createCommission();
    expect(commission.status).toBe('pending');

    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-01-02T00:00:00Z');
    const t3 = new Date('2026-01-03T00:00:00Z');
    const t4 = new Date('2026-01-04T00:00:00Z');

    commission.markEarned(t1);
    await commission.save();
    commission.approve(t2);
    await commission.save();
    commission.markPayable(t3);
    await commission.save();
    commission.markPaid(t4);
    await commission.save();

    const loaded = await commissions.get({ id: commission.id });
    expect(loaded?.status).toBe('paid');
    expect(loaded?.earnedAt?.toISOString()).toBe(t1.toISOString());
    expect(loaded?.approvedAt?.toISOString()).toBe(t2.toISOString());
    expect(loaded?.payableAt?.toISOString()).toBe(t3.toISOString());
    expect(loaded?.paidAt?.toISOString()).toBe(t4.toISOString());
  });

  it('rejects illegal jumps from the transition methods', async () => {
    const commission = await createCommission();
    expect(() => commission.approve()).toThrow(/cannot transition/);
    expect(() => commission.markPayable()).toThrow(/cannot transition/);
    expect(() => commission.markPaid()).toThrow(/cannot transition/);

    commission.markEarned();
    await commission.save();
    expect(() => commission.markEarned()).toThrow(/cannot transition/);
    expect(() => commission.markPaid()).toThrow(/cannot transition/);
  });

  it('rejects illegal jumps done via raw status assignment + save', async () => {
    const commission = await createCommission();

    // pending → approved skips 'earned'.
    commission.status = 'approved';
    await expect(commission.save()).rejects.toThrow(
      /illegal status transition/,
    );

    // A freshly loaded instance is guarded by the authoritative DB re-read.
    const loaded = await commissions.get({ id: commission.id });
    if (!loaded) throw new Error('commission not found');
    loaded.status = 'paid';
    await expect(loaded.save()).rejects.toThrow(/illegal status transition/);

    // Reversals are rejected too.
    const paid = await createCommission({ status: 'paid' });
    paid.status = 'pending';
    await expect(paid.save()).rejects.toThrow(/illegal status transition/);

    // A single legal step via raw assignment passes the guard (the method
    // is preferred because it stamps the timestamp).
    const stepper = await createCommission();
    stepper.status = 'earned';
    await stepper.save();
    expect(stepper.status).toBe('earned');
  });

  describe('CommissionSettlementService', () => {
    it('sweepClearing earns pending rows whose window passed or is null', async () => {
      const now = new Date('2026-06-01T00:00:00Z');
      const cleared = await createCommission({
        clearingEndsAt: new Date('2026-05-01T00:00:00Z'),
      });
      const stillClearing = await createCommission({
        clearingEndsAt: new Date('2026-07-01T00:00:00Z'),
      });
      // null clearingEndsAt = no clearing window = immediately sweepable.
      const noWindow = await createCommission({ clearingEndsAt: null });

      const service = new CommissionSettlementService(commissions);
      const swept = await service.sweepClearing(now);
      const sweptIds = swept.map((c) => c.id).sort();
      expect(sweptIds).toEqual([cleared.id, noWindow.id].sort());

      expect((await commissions.get({ id: cleared.id }))?.status).toBe(
        'earned',
      );
      expect((await commissions.get({ id: noWindow.id }))?.status).toBe(
        'earned',
      );
      expect((await commissions.get({ id: stillClearing.id }))?.status).toBe(
        'pending',
      );
    });

    it('approveCommissions and markPayable advance exact ids; settleUpToPayable chains', async () => {
      const service = new CommissionSettlementService(commissions);
      const a = await createCommission({ status: 'earned' });
      const b = await createCommission({ status: 'earned' });

      await service.approveCommissions([a.id as string, b.id as string]);
      expect((await commissions.get({ id: a.id }))?.status).toBe('approved');

      await service.markPayable([a.id as string]);
      expect((await commissions.get({ id: a.id }))?.status).toBe('payable');
      expect((await commissions.get({ id: b.id }))?.status).toBe('approved');

      // Strict: approving a non-earned row throws.
      await expect(
        service.approveCommissions([a.id as string]),
      ).rejects.toThrow(/cannot transition/);

      // Chain from pending all the way to payable; already-payable rows
      // are untouched (idempotent).
      const c = await createCommission();
      const chained = await service.settleUpToPayable([
        c.id as string,
        a.id as string,
      ]);
      expect(chained.map((x) => x.status)).toEqual(['payable', 'payable']);
      const cLoaded = await commissions.get({ id: c.id });
      expect(cLoaded?.earnedAt).not.toBeNull();
      expect(cLoaded?.approvedAt).not.toBeNull();
      expect(cLoaded?.payableAt).not.toBeNull();
    });
  });

  describe('CommissionAdjustment', () => {
    async function createAdjustment(
      commission: Commission,
      overrides: Record<string, unknown> = {},
    ) {
      return await adjustments.create({
        commissionId: commission.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'refund',
        amountCents: -400,
        currency: 'USD',
        reason: 'Customer refunded the underlying invoice',
        ...overrides,
      });
    }

    it('stores signed amounts and finds unsettled rows by earner', async () => {
      const commission = await createCommission({ status: 'paid' });
      const clawback = await createAdjustment(commission);
      const bonus = await createAdjustment(commission, {
        adjustmentKind: 'credit',
        amountCents: 250,
        reason: 'Goodwill credit',
      });

      expect(clawback.amountCents).toBe(-400);
      expect(bonus.amountCents).toBe(250);

      const unsettled = await adjustments.findUnsettledByEarner(
        earner.id as string,
        'USD',
      );
      expect(unsettled.map((a) => a.id).sort()).toEqual(
        [clawback.id, bonus.id].sort(),
      );
      expect(
        await adjustments.sumUnsettledByEarner(earner.id as string, 'USD'),
      ).toBe(-150);

      // Settled rows drop out.
      clawback.payoutId = 'payout-1';
      await clawback.save();
      expect(
        (
          await adjustments.findUnsettledByEarner(earner.id as string, 'USD')
        ).map((a) => a.id),
      ).toEqual([bonus.id]);

      const byCommission = await adjustments.findByCommission(
        commission.id as string,
      );
      expect(byCommission).toHaveLength(2);
    });

    it('is append-only: post-create mutation of substance throws; payoutId stamping is allowed', async () => {
      const commission = await createCommission({ status: 'paid' });
      const adjustment = await createAdjustment(commission);

      // The created instance is frozen after its first save.
      adjustment.amountCents = -9999;
      await expect(adjustment.save()).rejects.toThrow(/append-only/);

      // A freshly loaded instance is frozen too.
      const loadKind = await adjustments.get({ id: adjustment.id });
      if (!loadKind) throw new Error('adjustment not found');
      loadKind.adjustmentKind = 'dispute';
      await expect(loadKind.save()).rejects.toThrow(/append-only/);

      const loadReason = await adjustments.get({ id: adjustment.id });
      if (!loadReason) throw new Error('adjustment not found');
      loadReason.reason = 'rewritten history';
      await expect(loadReason.save()).rejects.toThrow(/append-only/);

      const loadCommission = await adjustments.get({ id: adjustment.id });
      if (!loadCommission) throw new Error('adjustment not found');
      loadCommission.commissionId = 'some-other-commission';
      await expect(loadCommission.save()).rejects.toThrow(/append-only/);

      // payoutId stamping (and clearing) is the one allowed mutation.
      const loadStamp = await adjustments.get({ id: adjustment.id });
      if (!loadStamp) throw new Error('adjustment not found');
      loadStamp.payoutId = 'payout-42';
      await loadStamp.save();
      expect((await adjustments.get({ id: adjustment.id }))?.payoutId).toBe(
        'payout-42',
      );

      // Nothing else drifted while stamping.
      const final = await adjustments.get({ id: adjustment.id });
      expect(final?.amountCents).toBe(-400);
      expect(final?.adjustmentKind).toBe('refund');
      expect(final?.reason).toBe('Customer refunded the underlying invoice');
    });
  });

  it('collection queries: findByEarner, findByEvent, findByStatus, findPayableUnsettled, sumPayableByEarner', async () => {
    const other = await earners.create({
      profileId: 'profile-2',
      displayName: 'Riley Rep',
      status: 'active',
    });
    const p1 = await createCommission({
      status: 'payable',
      amountCents: 3000,
      earningEventId: 'evt-a',
    });
    const p2 = await createCommission({
      status: 'payable',
      amountCents: 2000,
      earningEventId: 'evt-b',
    });
    const settled = await createCommission({
      status: 'payable',
      amountCents: 7000,
      payoutId: 'payout-x',
    });
    await createCommission({ status: 'pending', amountCents: 500 });
    await createCommission({
      earnerId: other.id,
      status: 'payable',
      amountCents: 4000,
    });

    expect(await commissions.findByEarner(earner.id as string)).toHaveLength(4);
    expect((await commissions.findByEvent('evt-a')).map((c) => c.id)).toEqual([
      p1.id,
    ]);
    const statuses: CommissionStatus[] = ['payable'];
    expect(await commissions.findByStatus(statuses[0])).toHaveLength(4);

    const payableUnsettled = await commissions.findPayableUnsettled(
      earner.id as string,
      'USD',
    );
    expect(payableUnsettled.map((c) => c.id).sort()).toEqual(
      [p1.id, p2.id].sort(),
    );
    expect(payableUnsettled.map((c) => c.id)).not.toContain(settled.id);
    expect(
      await commissions.sumPayableByEarner(earner.id as string, 'USD'),
    ).toBe(5000);
  });
});
