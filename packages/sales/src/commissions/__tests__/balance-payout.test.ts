/**
 * Tests for CommissionBalanceService (EarnerBalance math incl. negative net
 * from clawbacks) and CommissionPayoutService (threshold refusal,
 * nothing_payable, exact-row stamping, idempotency, completion flipping
 * commissions to paid, the payout state machine incl. resetFromFailed, and
 * provider-reference retention).
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import type { Commission } from '../models/Commission.js';
import type { Earner } from '../models/Earner.js';
import { CommissionBalanceService } from '../services/CommissionBalanceService.js';
import { CommissionPayoutService } from '../services/CommissionPayoutService.js';

describe('Balances and payout batches', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let commissions: CommissionCollection;
  let adjustments: CommissionAdjustmentCollection;
  let payouts: CommissionPayoutCollection;
  let balanceService: CommissionBalanceService;
  let payoutService: CommissionPayoutService;
  let earner: Earner;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    earners = await EarnerCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    adjustments = await CommissionAdjustmentCollection.create({ db });
    payouts = await CommissionPayoutCollection.create({ db });
    balanceService = new CommissionBalanceService(commissions, adjustments);
    payoutService = new CommissionPayoutService({
      earners,
      commissions,
      adjustments,
      payouts,
    });
    earner = await earners.create({
      profileId: 'profile-1',
      displayName: 'Casey Rep',
      status: 'active',
      payoutThresholdCents: 5000,
      payoutMethod: 'paypal',
    });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  let counter = 0;
  async function createCommission(
    overrides: Record<string, unknown> = {},
  ): Promise<Commission> {
    counter += 1;
    return await commissions.create({
      earnerId: earner.id as string,
      amountCents: 1000,
      currency: 'USD',
      dedupeKey: `bp-comm-${counter}`,
      ...overrides,
    });
  }

  async function createAdjustment(
    commission: Commission,
    amountCents: number,
    overrides: Record<string, unknown> = {},
  ) {
    counter += 1;
    return await adjustments.create({
      commissionId: commission.id as string,
      earnerId: earner.id as string,
      adjustmentKind: amountCents < 0 ? 'chargeback' : 'credit',
      amountCents,
      currency: 'USD',
      reason: `test adjustment ${counter}`,
      ...overrides,
    });
  }

  describe('CommissionBalanceService', () => {
    it('computes the full EarnerBalance across mixed statuses and adjustments', async () => {
      await createCommission({ status: 'pending', amountCents: 1000 });
      await createCommission({ status: 'earned', amountCents: 2000 });
      const approved = await createCommission({
        status: 'approved',
        amountCents: 3000,
      });
      await createCommission({ status: 'payable', amountCents: 4000 });
      const paid = await createCommission({
        status: 'paid',
        amountCents: 5000,
      });
      // Settled payable rows don't count toward payableCents.
      await createCommission({
        status: 'payable',
        amountCents: 9000,
        payoutId: 'already-settled',
      });

      // Eligible adjustments: parent earned/approved/payable/paid.
      await createAdjustment(paid, -1500);
      await createAdjustment(approved, 200);
      // Ineligible: parent still pending.
      const pendingParent = await createCommission({
        status: 'pending',
        amountCents: 100,
      });
      await createAdjustment(pendingParent, -9999);
      // Settled adjustments never count.
      const settledAdj = await createAdjustment(paid, -50);
      settledAdj.payoutId = 'already-settled';
      await settledAdj.save();

      const balance = await balanceService.getBalance(
        earner.id as string,
        'USD',
      );
      expect(balance).toEqual({
        earnerId: earner.id,
        currency: 'USD',
        payableCents: 4000,
        pendingCents: 1100,
        earnedCents: 2000,
        approvedCents: 3000,
        unsettledAdjustmentCents: -1300,
        netPayableCents: 2700,
      });
    });

    it('goes negative when clawbacks against paid commissions exceed payables', async () => {
      const paid = await createCommission({
        status: 'paid',
        amountCents: 10000,
      });
      await createAdjustment(paid, -6000);
      await createCommission({ status: 'payable', amountCents: 1000 });

      const balance = await balanceService.getBalance(
        earner.id as string,
        'USD',
      );
      expect(balance.payableCents).toBe(1000);
      expect(balance.unsettledAdjustmentCents).toBe(-6000);
      expect(balance.netPayableCents).toBe(-5000);
    });
  });

  describe('CommissionPayoutService.createPayoutBatch', () => {
    it('refuses below-threshold batches without stamping anything', async () => {
      const c = await createCommission({
        status: 'payable',
        amountCents: 4999,
      });
      const result = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
      });
      expect(result.payout).toBeNull();
      expect(result.created).toBe(false);
      expect(result.reason).toBe('below_threshold');
      expect(result.settledCommissionIds).toEqual([]);
      expect((await commissions.get({ id: c.id }))?.payoutId).toBeFalsy();

      // Caller-supplied threshold override wins over the earner default.
      const overridden = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        minimumThresholdCents: 1000,
        idempotencyKey: 'override-batch',
      });
      expect(overridden.created).toBe(true);
      expect(overridden.payout?.totalAmountCents).toBe(4999);
    });

    it('refuses when nothing is payable or the net is non-positive', async () => {
      const empty = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
      });
      expect(empty.payout).toBeNull();
      expect(empty.reason).toBe('nothing_payable');

      // A clawback that wipes out the payable rows → net <= 0 → refused
      // even though rows exist.
      const paid = await createCommission({
        status: 'paid',
        amountCents: 8000,
      });
      await createAdjustment(paid, -7000);
      await createCommission({ status: 'payable', amountCents: 6000 });
      const wipedOut = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
      });
      expect(wipedOut.payout).toBeNull();
      expect(wipedOut.reason).toBe('nothing_payable');
    });

    it('creates a pending batch, stamps the exact rows, and records totals', async () => {
      const c1 = await createCommission({
        status: 'payable',
        amountCents: 3500,
      });
      const c2 = await createCommission({
        status: 'payable',
        amountCents: 2500,
      });
      // Not gathered: wrong status / other currency / already settled.
      const earned = await createCommission({
        status: 'earned',
        amountCents: 5000,
      });
      const eur = await createCommission({
        status: 'payable',
        amountCents: 5000,
        currency: 'EUR',
      });
      const settled = await createCommission({
        status: 'payable',
        amountCents: 5000,
        payoutId: 'prior-batch',
      });
      const paid = await createCommission({
        status: 'paid',
        amountCents: 4000,
      });
      const clawback = await createAdjustment(paid, -500);
      // Adjustment on a pending parent is NOT eligible.
      const pendingParent = await createCommission({
        status: 'pending',
        amountCents: 50,
      });
      const ineligibleAdj = await createAdjustment(pendingParent, -100);

      const result = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        periodStart: new Date('2026-06-01T00:00:00Z'),
        periodEnd: new Date('2026-06-30T00:00:00Z'),
      });

      expect(result.created).toBe(true);
      expect(result.reason).toBeUndefined();
      const payout = result.payout;
      expect(payout).not.toBeNull();
      if (!payout) throw new Error('payout missing');
      expect(payout.status).toBe('pending');
      expect(payout.commissionTotalCents).toBe(6000);
      expect(payout.adjustmentTotalCents).toBe(-500);
      expect(payout.totalAmountCents).toBe(5500);
      expect(payout.currency).toBe('USD');
      // Method defaulted from the earner.
      expect(payout.payoutMethod).toBe('paypal');
      // Default idempotency key: earner:currency:periodEnd date.
      expect(payout.idempotencyKey).toBe(`${earner.id}:USD:2026-06-30`);

      expect(result.settledCommissionIds.sort()).toEqual([c1.id, c2.id].sort());
      expect(result.settledAdjustmentIds).toEqual([clawback.id]);

      // Exact rows stamped — nothing else. (An unstamped FK hydrates as
      // null/'' depending on the adapter, so assert falsy.)
      expect((await commissions.get({ id: c1.id }))?.payoutId).toBe(payout.id);
      expect((await commissions.get({ id: c2.id }))?.payoutId).toBe(payout.id);
      expect((await adjustments.get({ id: clawback.id }))?.payoutId).toBe(
        payout.id,
      );
      for (const untouched of [earned, eur, pendingParent]) {
        expect(
          (await commissions.get({ id: untouched.id }))?.payoutId,
        ).toBeFalsy();
      }
      expect((await commissions.get({ id: settled.id }))?.payoutId).toBe(
        'prior-batch',
      );
      expect(
        (await adjustments.get({ id: ineligibleAdj.id }))?.payoutId,
      ).toBeFalsy();
    });

    it('is idempotent: a repeated key returns the existing payout without re-stamping', async () => {
      await createCommission({ status: 'payable', amountCents: 6000 });
      const first = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'batch-june',
      });
      expect(first.created).toBe(true);

      // New payable work lands between the two calls.
      const late = await createCommission({
        status: 'payable',
        amountCents: 7000,
      });

      const replay = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'batch-june',
      });
      expect(replay.created).toBe(false);
      expect(replay.payout?.id).toBe(first.payout?.id);
      expect(replay.settledCommissionIds).toEqual([]);
      expect(replay.settledAdjustmentIds).toEqual([]);
      // The late row was NOT swept into the replayed batch.
      expect((await commissions.get({ id: late.id }))?.payoutId).toBeFalsy();
      // Totals unchanged.
      expect(replay.payout?.totalAmountCents).toBe(6000);
    });
  });

  describe('payout lifecycle', () => {
    it('completePayout records the reference and flips settled commissions to paid', async () => {
      const c1 = await createCommission({
        status: 'payable',
        amountCents: 3000,
      });
      const c2 = await createCommission({
        status: 'payable',
        amountCents: 3000,
      });
      const { payout } = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'complete-batch',
      });
      if (!payout) throw new Error('payout missing');

      payout.approve();
      await payout.save();
      payout.markProcessing();
      await payout.save();

      const completed = await payoutService.completePayout(
        payout.id as string,
        'wire-778',
      );
      expect(completed.status).toBe('completed');
      expect(completed.paymentReference).toBe('wire-778');
      expect(completed.paidAt).not.toBeNull();

      for (const c of [c1, c2]) {
        const loaded = await commissions.get({ id: c.id });
        expect(loaded?.status).toBe('paid');
        expect(loaded?.paidAt).not.toBeNull();
        expect(loaded?.payoutId).toBe(payout.id);
      }

      expect(await payouts.sumPaidByEarner(earner.id as string, 'USD')).toBe(
        6000,
      );
    });

    it('enforces the state machine incl. raw-assignment guard and resetFromFailed', async () => {
      await createCommission({ status: 'payable', amountCents: 6000 });
      const { payout } = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'machine-batch',
      });
      if (!payout) throw new Error('payout missing');

      // Illegal method calls.
      expect(() => payout.markProcessing()).toThrow(/cannot mark processing/);
      expect(() => payout.complete('x')).toThrow(/cannot complete/);
      expect(() => payout.resetFromFailed()).toThrow(/cannot reset/);
      await expect(
        payoutService.completePayout(payout.id as string, 'ref'),
      ).rejects.toThrow(/cannot complete/);

      // Raw skip pending → completed is rejected at save time.
      payout.status = 'completed';
      payout.paymentReference = 'forged';
      await expect(payout.save()).rejects.toThrow(/illegal status transition/);

      // Legit path to a failure, retaining the provider reference.
      const fresh = await payouts.get({ id: payout.id });
      if (!fresh) throw new Error('payout missing');
      fresh.providerRef = 'prov-batch-9';
      fresh.approve();
      await fresh.save();
      fresh.markProcessing();
      await fresh.save();
      const failed = await payoutService.failPayout(
        fresh.id as string,
        'bank rejected the transfer',
      );
      expect(failed.status).toBe('failed');
      expect(failed.notes).toContain('bank rejected the transfer');

      // Terminal-ish: failed is only resettable through resetFromFailed().
      failed.status = 'processing';
      await expect(failed.save()).rejects.toThrow(/illegal status transition/);

      const forReset = await payouts.get({ id: fresh.id });
      if (!forReset) throw new Error('payout missing');
      forReset.paymentReference = '';
      forReset.resetFromFailed();
      await forReset.save();
      expect(forReset.status).toBe('pending');
      expect(forReset.paymentReference).toBe('');
      expect(forReset.paidAt).toBeNull();
      // Provider reference and notes survive the reset for audit.
      expect(forReset.providerRef).toBe('prov-batch-9');
      expect(forReset.notes).toContain('bank rejected the transfer');

      // The batch can run again after the reset.
      forReset.approve();
      await forReset.save();
      forReset.markProcessing();
      await forReset.save();
      forReset.complete('wire-retry-1');
      await forReset.save();
      expect(forReset.status).toBe('completed');
      expect(forReset.paymentReference).toBe('wire-retry-1');
    });

    it('enforces the totals invariant on save', async () => {
      await expect(
        payouts.create({
          earnerId: earner.id as string,
          idempotencyKey: 'bad-totals',
          commissionTotalCents: 1000,
          adjustmentTotalCents: -100,
          totalAmountCents: 1000, // should be 900
        }),
      ).rejects.toThrow(/totals invariant/);
    });
  });
});
