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

  describe('settlement atomicity (codex P1 hardening)', () => {
    it('repairs an interrupted claim pass on a same-key replay', async () => {
      const c1 = await createCommission({
        status: 'payable',
        amountCents: 4000,
      });
      const c2 = await createCommission({
        status: 'payable',
        amountCents: 3000,
      });
      const first = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'repair-1',
      });
      const payoutId = first.payout?.id as string;
      expect(first.settledCommissionIds).toHaveLength(2);

      // Manufacture the interrupted state codex flagged: the payout exists
      // with full totals but one member row never got stamped.
      const interrupted = await commissions.get({ id: c2.id });
      if (!interrupted) throw new Error('missing row');
      interrupted.payoutId = '';
      await interrupted.save();
      expect(
        (await commissions.findByPayout(payoutId)).map((c) => c.id),
      ).toEqual([c1.id]);

      // Same-key replay detects the totals/membership mismatch and repairs.
      const replay = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'repair-1',
      });
      expect(replay.created).toBe(false);
      expect(replay.payout?.id).toBe(payoutId);
      expect(new Set(replay.settledCommissionIds)).toEqual(
        new Set([c1.id, c2.id]),
      );
      expect((await commissions.get({ id: c2.id }))?.payoutId).toBe(payoutId);
      // Totals are reproducible from the (repaired) membership again.
      expect(replay.payout?.commissionTotalCents).toBe(7000);
      expect(replay.payout?.totalAmountCents).toBe(7000);
    });

    it('never re-claims a row owned by a different payout', async () => {
      const c1 = await createCommission({
        status: 'payable',
        amountCents: 6000,
      });
      // Simulate another batch owning the row.
      const owned = await commissions.get({ id: c1.id });
      if (!owned) throw new Error('missing row');
      owned.payoutId = 'some-other-payout';
      await owned.save();

      const claimed = await commissions.claimForPayout(
        [c1.id as string],
        'my-payout',
      );
      expect(claimed).toEqual([]);
      expect((await commissions.get({ id: c1.id }))?.payoutId).toBe(
        'some-other-payout',
      );
    });

    it('claimForPayout skips rows that are no longer payable', async () => {
      const c1 = await createCommission({
        status: 'earned',
        amountCents: 2500,
      });
      const claimed = await commissions.claimForPayout(
        [c1.id as string],
        'my-payout',
      );
      expect(claimed).toEqual([]);
      expect((await commissions.get({ id: c1.id }))?.payoutId).toBeFalsy();
    });

    it('completePayout flips members before finalizing so a retry can finish the batch', async () => {
      const c1 = await createCommission({
        status: 'payable',
        amountCents: 4000,
      });
      const c2 = await createCommission({
        status: 'payable',
        amountCents: 2000,
      });
      const batch = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'complete-order-1',
      });
      const payout = batch.payout;
      if (!payout) throw new Error('expected payout');
      payout.approve();
      await payout.save();
      payout.markProcessing();
      await payout.save();

      // Manufacture the mid-completion crash state: one member already paid
      // while the payout is still processing.
      const paidEarly = await commissions.get({ id: c1.id });
      if (!paidEarly) throw new Error('missing row');
      paidEarly.markPaid(new Date('2026-07-01T00:00:00Z'));
      await paidEarly.save();

      // The retry completes the remaining member and only then finalizes.
      const completed = await payoutService.completePayout(
        payout.id as string,
        'wire-retry-1',
      );
      expect(completed.status).toBe('completed');
      expect((await commissions.get({ id: c1.id }))?.status).toBe('paid');
      expect((await commissions.get({ id: c2.id }))?.status).toBe('paid');
    });

    it('completePayout refuses non-processing payouts without touching members', async () => {
      const c1 = await createCommission({
        status: 'payable',
        amountCents: 9000,
      });
      const batch = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'complete-guard-1',
      });
      await expect(
        payoutService.completePayout(batch.payout?.id as string, 'wire-x'),
      ).rejects.toThrow(/cannot complete from status 'pending'/);
      expect((await commissions.get({ id: c1.id }))?.status).toBe('payable');
    });

    it('never approves a batch with a non-positive total (codex P2)', async () => {
      const hollow = await payouts.create({
        earnerId: earner.id as string,
        idempotencyKey: 'hollow-1',
        commissionTotalCents: 0,
        adjustmentTotalCents: 0,
        totalAmountCents: 0,
      });
      expect(() => hollow.approve()).toThrow(/non-positive total/);
    });
  });
  describe('CommissionPayoutService.createPayoutBatch — scoped batches (Anytown integration)', () => {
    // These tests exercise SCOPE, not the threshold gate — drop the earner's
    // default 5000 threshold so batch amounts don't have to clear it.
    beforeEach(async () => {
      earner.payoutThresholdCents = 0;
      await earner.save();
    });

    it('scopes a batch to one source: claims only that network, leaves others', async () => {
      const a1 = await createCommission({
        status: 'payable',
        amountCents: 3000,
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      const a2 = await createCommission({
        status: 'payable',
        amountCents: 2000,
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      const b1 = await createCommission({
        status: 'payable',
        amountCents: 9000,
        sourceKind: 'ad_network',
        sourceId: 'net-b',
      });

      const batchA = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      expect(batchA.created).toBe(true);
      expect(new Set(batchA.settledCommissionIds)).toEqual(
        new Set([a1.id, a2.id]),
      );
      expect(batchA.payout?.commissionTotalCents).toBe(5000);
      // net-b is untouched and still claimable.
      expect((await commissions.get({ id: b1.id }))?.payoutId).toBeFalsy();
    });

    it('runs two per-source batches concurrently over disjoint rows', async () => {
      const a1 = await createCommission({
        status: 'payable',
        amountCents: 4000,
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      const b1 = await createCommission({
        status: 'payable',
        amountCents: 6000,
        sourceKind: 'ad_network',
        sourceId: 'net-b',
      });

      const [batchA, batchB] = await Promise.all([
        payoutService.createPayoutBatch({
          earnerId: earner.id as string,
          currency: 'USD',
          sourceKind: 'ad_network',
          sourceId: 'net-a',
        }),
        payoutService.createPayoutBatch({
          earnerId: earner.id as string,
          currency: 'USD',
          sourceKind: 'ad_network',
          sourceId: 'net-b',
        }),
      ]);

      expect(batchA.settledCommissionIds).toEqual([a1.id]);
      expect(batchB.settledCommissionIds).toEqual([b1.id]);
      expect(batchA.payout?.id).not.toBe(batchB.payout?.id);
      // Distinct default idempotency keys (source folded in) → distinct payouts.
      expect((await commissions.get({ id: a1.id }))?.payoutId).toBe(
        batchA.payout?.id,
      );
      expect((await commissions.get({ id: b1.id }))?.payoutId).toBe(
        batchB.payout?.id,
      );
    });

    it('settles an explicit set of commission ids and ignores ineligible ones', async () => {
      const c1 = await createCommission({
        status: 'payable',
        amountCents: 2500,
      });
      const c2 = await createCommission({
        status: 'payable',
        amountCents: 1500,
      });
      const notPayable = await createCommission({
        status: 'earned',
        amountCents: 9999,
      });
      const otherCurrency = await createCommission({
        status: 'payable',
        amountCents: 8888,
        currency: 'EUR',
      });
      const alsoPayable = await createCommission({
        status: 'payable',
        amountCents: 7000,
      });

      const batch = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'explicit-set-1',
        commissionIds: [
          c1.id as string,
          c2.id as string,
          notPayable.id as string,
          otherCurrency.id as string,
        ],
      });
      // Only the two eligible USD-payable ids are claimed.
      expect(new Set(batch.settledCommissionIds)).toEqual(
        new Set([c1.id, c2.id]),
      );
      expect(batch.payout?.commissionTotalCents).toBe(4000);
      // Ineligible ids and the unlisted payable row are untouched.
      expect(
        (await commissions.get({ id: notPayable.id }))?.payoutId,
      ).toBeFalsy();
      expect(
        (await commissions.get({ id: otherCurrency.id }))?.payoutId,
      ).toBeFalsy();
      expect(
        (await commissions.get({ id: alsoPayable.id }))?.payoutId,
      ).toBeFalsy();
    });

    it('narrows adjustments to the batch source', async () => {
      const a = await createCommission({
        status: 'payable',
        amountCents: 5000,
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      const b = await createCommission({
        status: 'payable',
        amountCents: 5000,
        sourceKind: 'ad_network',
        sourceId: 'net-b',
      });
      // A clawback on each network's commission.
      const adjA = await createAdjustment(a, -1000, {
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      await createAdjustment(b, -2000, {
        sourceKind: 'ad_network',
        sourceId: 'net-b',
      });

      const batchA = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      // net-a's commission (5000) minus net-a's adjustment (1000) = 4000; net-b's
      // adjustment does not touch this batch.
      expect(batchA.settledAdjustmentIds).toEqual([adjA.id]);
      expect(batchA.payout?.commissionTotalCents).toBe(5000);
      expect(batchA.payout?.adjustmentTotalCents).toBe(-1000);
      expect(batchA.payout?.totalAmountCents).toBe(4000);
    });

    it('a source batch and the earner-wide batch on the same day do not collide', async () => {
      await createCommission({
        status: 'payable',
        amountCents: 3000,
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      await createCommission({ status: 'payable', amountCents: 4000 });

      const now = new Date('2026-08-01T00:00:00Z');
      const scoped = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        sourceKind: 'ad_network',
        sourceId: 'net-a',
        now,
      });
      const wide = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        now,
      });
      // Different default idempotency keys → both mint, no collision.
      expect(scoped.created).toBe(true);
      expect(wide.created).toBe(true);
      expect(scoped.payout?.id).not.toBe(wide.payout?.id);
      // The wide batch swept the remaining (unclaimed) row only — the scoped
      // batch's row was already owned.
      expect(scoped.payout?.commissionTotalCents).toBe(3000);
      expect(wide.payout?.commissionTotalCents).toBe(4000);
    });

    it('rejects malformed or conflicting scope', async () => {
      const base = { earnerId: earner.id as string, currency: 'USD' };
      await expect(
        payoutService.createPayoutBatch({ ...base, sourceKind: 'ad_network' }),
      ).rejects.toThrow(/must be set together/);
      await expect(
        payoutService.createPayoutBatch({ ...base, sourceId: 'net-a' }),
      ).rejects.toThrow(/must be set together/);
      await expect(
        payoutService.createPayoutBatch({
          ...base,
          sourceKind: 'ad_network',
          sourceId: 'net-a',
          idempotencyKey: 'x',
          commissionIds: ['c1'],
        }),
      ).rejects.toThrow(/mutually exclusive/);
      await expect(
        payoutService.createPayoutBatch({ ...base, commissionIds: ['c1'] }),
      ).rejects.toThrow(/requires an idempotencyKey/);
    });

    it('a present empty commissionIds settles nothing (never fails open) — codex P1', async () => {
      // Payable rows exist for the earner...
      const c1 = await createCommission({
        status: 'payable',
        amountCents: 3000,
      });
      const c2 = await createCommission({
        status: 'payable',
        amountCents: 4000,
      });

      // ...but a dynamically-computed empty explicit set must claim NONE of
      // them, not fall through to an earner-wide sweep.
      const batch = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'empty-set-1',
        commissionIds: [],
      });
      expect(batch.created).toBe(false);
      expect(batch.reason).toBe('nothing_payable');
      expect(batch.settledCommissionIds).toEqual([]);
      expect((await commissions.get({ id: c1.id }))?.payoutId).toBeFalsy();
      expect((await commissions.get({ id: c2.id }))?.payoutId).toBeFalsy();
    });

    it('a present empty commissionIds still requires an idempotencyKey', async () => {
      await expect(
        payoutService.createPayoutBatch({
          earnerId: earner.id as string,
          currency: 'USD',
          commissionIds: [],
        }),
      ).rejects.toThrow(/requires an idempotencyKey/);
    });

    it('length-prefixed source keys do not collide for ambiguous strings — codex P2', async () => {
      // net-a source ('a:b','c') and ('a','b:c') would collide under naive
      // `${sourceKind}:${sourceId}` concatenation; each must mint its own.
      const x = await createCommission({
        status: 'payable',
        amountCents: 1000,
        sourceKind: 'a:b',
        sourceId: 'c',
      });
      const y = await createCommission({
        status: 'payable',
        amountCents: 2000,
        sourceKind: 'a',
        sourceId: 'b:c',
      });
      const now = new Date('2026-09-01T00:00:00Z');
      const first = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        sourceKind: 'a:b',
        sourceId: 'c',
        now,
      });
      const second = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        sourceKind: 'a',
        sourceId: 'b:c',
        now,
      });
      // Distinct keys → two distinct payouts, each settling its own row.
      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(first.payout?.id).not.toBe(second.payout?.id);
      expect(first.settledCommissionIds).toEqual([x.id]);
      expect(second.settledCommissionIds).toEqual([y.id]);
    });

    it('repairs an interrupted scoped batch without pulling out-of-scope rows', async () => {
      const a1 = await createCommission({
        status: 'payable',
        amountCents: 3000,
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      const a2 = await createCommission({
        status: 'payable',
        amountCents: 2000,
        sourceKind: 'ad_network',
        sourceId: 'net-a',
      });
      await createCommission({
        status: 'payable',
        amountCents: 9000,
        sourceKind: 'ad_network',
        sourceId: 'net-b',
      });

      const first = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        sourceKind: 'ad_network',
        sourceId: 'net-a',
        idempotencyKey: 'scoped-repair-1',
      });
      const payoutId = first.payout?.id as string;

      // Simulate an interrupted claim: unstamp one member so totals disagree.
      const interrupted = await commissions.get({ id: a2.id });
      if (!interrupted) throw new Error('missing row');
      interrupted.payoutId = '';
      await interrupted.save();

      const replay = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        sourceKind: 'ad_network',
        sourceId: 'net-a',
        idempotencyKey: 'scoped-repair-1',
      });
      expect(replay.created).toBe(false);
      // Repair re-claims a1+a2 (net-a) — never the net-b row.
      expect(new Set(replay.settledCommissionIds)).toEqual(
        new Set([a1.id, a2.id]),
      );
      expect(replay.payout?.commissionTotalCents).toBe(5000);
    });
  });
});
