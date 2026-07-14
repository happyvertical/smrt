/**
 * Tests for atomic source-authorized payout lifecycle transitions (#1987):
 * the full action matrix (approve / mark_processing / complete / fail /
 * reject), fail-closed source authorization over every member commission
 * and adjustment parent, totals recompute + drift refusal under the lock,
 * expected-state and concurrent-call determinism, idempotent terminal
 * completion that never rewrites payment metadata, reject releasing the
 * batch's membership, and transaction atomicity (a mid-completion failure
 * rolls back the member flips).
 *
 * Real in-memory SQLite — no mocks of database operations. The one fault
 * injection uses the framework's own GlobalInterceptors seam.
 */

import { GlobalInterceptors, getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import type { Commission } from '../models/Commission.js';
import { CommissionPayout } from '../models/CommissionPayout.js';
import type { Earner } from '../models/Earner.js';
import { CommissionPayoutService } from '../services/CommissionPayoutService.js';

const NETWORK_A = { sourceKind: 'ad_network', sourceId: 'net-a' };
const NETWORK_B = { sourceKind: 'ad_network', sourceId: 'net-b' };

describe('Source-authorized payout lifecycle transitions (#1987)', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let commissions: CommissionCollection;
  let adjustments: CommissionAdjustmentCollection;
  let payouts: CommissionPayoutCollection;
  let service: CommissionPayoutService;
  let earner: Earner;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    earners = await EarnerCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    adjustments = await CommissionAdjustmentCollection.create({ db });
    payouts = await CommissionPayoutCollection.create({ db });
    service = new CommissionPayoutService({
      earners,
      commissions,
      adjustments,
      payouts,
    });
    earner = await earners.create({
      profileId: 'profile-1',
      displayName: 'Casey Earner',
      status: 'active',
      payoutThresholdCents: 1,
    });
  });

  afterEach(async () => {
    GlobalInterceptors.unregister('test-terminal-save-fault');
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  let counter = 0;
  async function createPayableCommission(
    source: { sourceKind: string; sourceId: string },
    overrides: Record<string, unknown> = {},
  ): Promise<Commission> {
    counter += 1;
    return await commissions.create({
      earnerId: earner.id as string,
      amountCents: 1000,
      currency: 'USD',
      status: 'payable',
      dedupeKey: `trans-comm-${counter}`,
      ...source,
      ...overrides,
    });
  }

  async function cutPendingBatch(
    source: { sourceKind: string; sourceId: string },
    key: string,
  ): Promise<CommissionPayout> {
    const result = await service.createPayoutBatch({
      earnerId: earner.id as string,
      currency: 'USD',
      ...source,
      idempotencyKey: key,
    });
    expect(result.payout).not.toBeNull();
    return result.payout as CommissionPayout;
  }

  describe('action matrix and source authorization', () => {
    it('drives the full happy path atomically and flips members to paid on complete', async () => {
      const one = await createPayableCommission(NETWORK_A);
      const two = await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'happy');

      const approved = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(approved.outcome).toBe('transitioned');
      expect(approved.payout?.isApproved()).toBe(true);

      const processing = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'mark_processing',
      });
      expect(processing.outcome).toBe('transitioned');

      const completed = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'complete',
        paymentReference: 'wire-42',
      });
      expect(completed.outcome).toBe('transitioned');
      expect(completed.payout?.isCompleted()).toBe(true);
      expect(completed.payout?.paymentReference).toBe('wire-42');
      expect(completed.payout?.paidAt).toBeInstanceOf(Date);

      for (const id of [one.id, two.id]) {
        const member = await commissions.get({ id: id as string });
        expect(member?.isPaid()).toBe(true);
      }
    });

    it('refuses a transition authorized against the wrong source, leaving everything untouched', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'wrong-source');

      const refused = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_B,
        action: 'approve',
      });
      expect(refused.outcome).toBe('refused');
      expect(refused.refusal?.reason).toBe('source_mismatch');
      expect(refused.payout?.isPending()).toBe(true);
    });

    it('refuses when membership mixes sources or an earner/currency disagrees', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'mixed-members');

      // A NETWORK_B commission sneaks into the batch (hand-stamped).
      const intruder = await createPayableCommission(NETWORK_B);
      intruder.payoutId = payout.id as string;
      await intruder.save();
      const mixed = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(mixed.outcome).toBe('refused');
      expect(mixed.refusal?.reason).toBe('source_mismatch');

      // Repair, then stamp a foreign-earner row instead.
      intruder.payoutId = '';
      await intruder.save();
      const stranger = await earners.create({
        profileId: 'profile-2',
        displayName: 'Other Earner',
        status: 'active',
      });
      const foreign = await commissions.create({
        earnerId: stranger.id as string,
        amountCents: 500,
        currency: 'USD',
        status: 'payable',
        dedupeKey: 'trans-foreign',
        ...NETWORK_A,
        payoutId: payout.id as string,
      });
      const earnerMismatch = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(earnerMismatch.outcome).toBe('refused');
      expect(earnerMismatch.refusal?.reason).toBe('earner_mismatch');

      foreign.payoutId = '';
      await foreign.save();

      // And a currency-mismatched row.
      const euro = await commissions.create({
        earnerId: earner.id as string,
        amountCents: 500,
        currency: 'EUR',
        status: 'payable',
        dedupeKey: 'trans-euro',
        ...NETWORK_A,
        payoutId: payout.id as string,
      });
      const currencyMismatch = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(currencyMismatch.outcome).toBe('refused');
      expect(currencyMismatch.refusal?.reason).toBe('currency_mismatch');
      euro.payoutId = '';
      await euro.save();
    });

    it('checks the adjustment parent against the payout account, not just its source', async () => {
      // An adjustment whose DENORMALIZED earner/currency match the payout
      // can still hang off another earner's commission — the parent must
      // agree with the payout on every account axis.
      const stranger = await earners.create({
        profileId: 'profile-parent-check',
        displayName: 'Stranger',
        status: 'active',
      });
      const strangerCommission = await commissions.create({
        earnerId: stranger.id as string,
        amountCents: 700,
        currency: 'USD',
        status: 'payable',
        dedupeKey: 'trans-stranger-parent',
        ...NETWORK_A,
      });
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'parent-account');
      await adjustments.create({
        commissionId: strangerCommission.id as string,
        // Denormalized fields LOOK coherent with the payout…
        earnerId: earner.id as string,
        adjustmentKind: 'credit',
        amountCents: 100,
        currency: 'USD',
        reason: 'mis-parented credit',
        payoutId: payout.id as string,
      });

      const refused = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(refused.outcome).toBe('refused');
      expect(refused.refusal?.reason).toBe('earner_mismatch');
      expect(refused.refusal?.detail).toMatch(/parent commission/);
    });

    it('proves adjustment ownership through the parent and fails closed when the parent cannot vouch', async () => {
      // Batch whose membership is one adjustment; its parent commission
      // belongs to NETWORK_A — authorizing against NETWORK_B must refuse.
      const parent = await createPayableCommission(NETWORK_A);
      await cutPendingBatch(NETWORK_A, 'adj-parent-base');
      await adjustments.create({
        commissionId: parent.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'credit',
        amountCents: 300,
        currency: 'USD',
        reason: 'later credit',
      });
      const adjOnly = await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...NETWORK_A,
        idempotencyKey: 'adj-parent-batch',
      });
      const adjPayout = adjOnly.payout as CommissionPayout;

      const wrongSource = await service.transitionPayoutForSource({
        payoutId: adjPayout.id as string,
        ...NETWORK_B,
        action: 'approve',
      });
      expect(wrongSource.outcome).toBe('refused');
      expect(wrongSource.refusal?.reason).toBe('source_mismatch');

      const rightSource = await service.transitionPayoutForSource({
        payoutId: adjPayout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(rightSource.outcome).toBe('transitioned');

      // An adjustment whose parent row is unloadable can vouch for
      // nothing: approve must refuse adjustment_parent_missing.
      const orphanBatch = await payouts.create({
        earnerId: earner.id as string,
        currency: 'USD',
        status: 'pending',
        commissionTotalCents: 0,
        adjustmentTotalCents: 120,
        totalAmountCents: 120,
        idempotencyKey: 'adj-orphan-batch',
        ...NETWORK_A,
      });
      await adjustments.create({
        commissionId: '00000000-0000-4000-8000-00000000dead',
        earnerId: earner.id as string,
        adjustmentKind: 'credit',
        amountCents: 120,
        currency: 'USD',
        reason: 'orphaned adjustment',
        payoutId: orphanBatch.id as string,
      });
      const orphaned = await service.transitionPayoutForSource({
        payoutId: orphanBatch.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(orphaned.outcome).toBe('refused');
      expect(orphaned.refusal?.reason).toBe('adjustment_parent_missing');
    });

    it('refuses memberless payouts through the source-authorized door', async () => {
      const artifact = await payouts.create({
        earnerId: earner.id as string,
        currency: 'USD',
        status: 'pending',
        idempotencyKey: 'memberless',
        ...NETWORK_A,
      });
      const refused = await service.transitionPayoutForSource({
        payoutId: artifact.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(refused.outcome).toBe('refused');
      expect(refused.refusal?.reason).toBe('membership_empty');
    });

    it('validates inputs loudly and maps malformed ids to payout_not_found', async () => {
      await expect(
        service.transitionPayoutForSource({
          payoutId: '00000000-0000-4000-8000-000000000000',
          sourceKind: '',
          sourceId: 'x',
          action: 'approve',
        }),
      ).rejects.toThrow(/required/);
      await expect(
        service.transitionPayoutForSource({
          payoutId: '00000000-0000-4000-8000-000000000000',
          ...NETWORK_A,
          // A typo'd action must never silently no-op.
          action: 'aprove' as never,
        }),
      ).rejects.toThrow(/unknown action/);
      await expect(
        service.transitionPayoutForSource({
          payoutId: '00000000-0000-4000-8000-000000000000',
          ...NETWORK_A,
          action: 'complete',
        }),
      ).rejects.toThrow(/paymentReference/);
      await expect(
        service.transitionPayoutForSource({
          payoutId: '00000000-0000-4000-8000-000000000000',
          ...NETWORK_A,
          action: 'reject',
        }),
      ).rejects.toThrow(/reason/);

      const malformed = await service.transitionPayoutForSource({
        payoutId: 'not-a-uuid',
        ...NETWORK_A,
        action: 'approve',
      });
      expect(malformed.outcome).toBe('refused');
      expect(malformed.refusal?.reason).toBe('payout_not_found');

      const absent = await service.transitionPayoutForSource({
        payoutId: '00000000-0000-4000-8000-000000000000',
        ...NETWORK_A,
        action: 'approve',
      });
      expect(absent.outcome).toBe('refused');
      expect(absent.refusal?.reason).toBe('payout_not_found');
    });
  });

  describe('totals recompute under the lock', () => {
    it('refuses money-forward actions on drifted totals; defensive actions proceed', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'drift');

      // Membership changed after mint: a new adjustment lands on the
      // member commission and is claimed by a same-key repair replay run
      // by "another worker" — here simulated by hand-stamping.
      const member = (await commissions.findByPayout(payout.id as string))[0];
      await adjustments.create({
        commissionId: member.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'chargeback',
        amountCents: -400,
        currency: 'USD',
        reason: 'late chargeback',
        payoutId: payout.id as string,
      });

      const approve = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(approve.outcome).toBe('refused');
      expect(approve.refusal?.reason).toBe('totals_drift');
      expect(approve.refusal?.detail).toMatch(/createPayoutBatch replay/);

      // The documented repair: replay the same idempotency key while
      // pending — totals reconcile to the stamped membership.
      const repaired = await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...NETWORK_A,
        idempotencyKey: 'drift',
      });
      expect(repaired.payout?.totalAmountCents).toBe(600);

      const approveAfterRepair = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(approveAfterRepair.outcome).toBe('transitioned');
    });

    it('rejecting a drifted batch is allowed — reject IS the remedy', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'drift-reject');
      const member = (await commissions.findByPayout(payout.id as string))[0];
      await adjustments.create({
        commissionId: member.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'chargeback',
        amountCents: -100,
        currency: 'USD',
        reason: 'drift for reject',
        payoutId: payout.id as string,
      });

      const rejected = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'reject',
        reason: 'declining drifted batch',
      });
      expect(rejected.outcome).toBe('transitioned');
      expect(rejected.payout?.isRejected()).toBe(true);
    });

    it('never approves a batch whose membership nets non-positive', async () => {
      const parent = await createPayableCommission(NETWORK_A, {
        amountCents: 100,
      });
      const payout = await cutPendingBatch(NETWORK_A, 'non-positive');
      // A clawback exceeding the commission lands and is claimed; a repair
      // replay reconciles totals to the (now non-positive) membership.
      await adjustments.create({
        commissionId: parent.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'chargeback',
        amountCents: -250,
        currency: 'USD',
        reason: 'clawback beyond commission',
        payoutId: payout.id as string,
      });
      await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...NETWORK_A,
        idempotencyKey: 'non-positive',
      });

      const refused = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(refused.outcome).toBe('refused');
      expect(refused.refusal?.reason).toBe('non_positive_total');
    });
  });

  describe('expected state and concurrency determinism', () => {
    it('enforces expectedStatus against the locked row', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'expected');
      await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });

      const stale = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'mark_processing',
        expectedStatus: 'pending',
      });
      expect(stale.outcome).toBe('refused');
      expect(stale.refusal?.reason).toBe('status_conflict');
      expect(stale.refusal?.detail).toMatch(/expected status 'pending'/);
    });

    it('resolves concurrent duplicate actions as exactly one transition plus already_applied echoes', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'concurrent-approve');

      const [a, b, c] = await Promise.all([
        service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action: 'approve',
        }),
        service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action: 'approve',
        }),
        service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action: 'approve',
        }),
      ]);
      const outcomes = [a.outcome, b.outcome, c.outcome];
      expect(outcomes.filter((o) => o === 'transitioned')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'already_applied')).toHaveLength(2);

      const settled = await payouts.get({ id: payout.id as string });
      expect(settled?.isApproved()).toBe(true);
    });

    it('resolves concurrent complete calls exactly once and preserves the winning payment metadata', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'concurrent-complete');
      for (const action of ['approve', 'mark_processing'] as const) {
        await service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action,
        });
      }

      const [first, second] = await Promise.all([
        service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action: 'complete',
          paymentReference: 'wire-first',
        }),
        service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action: 'complete',
          paymentReference: 'wire-second',
        }),
      ]);
      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(['already_applied', 'transitioned']);

      const winnerRef =
        first.outcome === 'transitioned' ? 'wire-first' : 'wire-second';
      const settled = await payouts.get({ id: payout.id as string });
      expect(settled?.paymentReference).toBe(winnerRef);
    });
  });

  describe('terminal completion idempotency', () => {
    it('a completion replay never rewrites paymentReference, providerRef, or paidAt', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'terminal-meta');
      for (const action of ['approve', 'mark_processing'] as const) {
        await service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action,
        });
      }
      // Provider stamps its remittance-file reference during processing.
      const processing = await payouts.get({ id: payout.id as string });
      if (!processing) throw new Error('payout disappeared');
      processing.providerRef = 'remit-batch-77';
      await processing.save();

      const done = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'complete',
        paymentReference: 'wire-original',
        now: new Date('2026-07-13T10:00:00Z'),
      });
      expect(done.outcome).toBe('transitioned');

      const replay = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'complete',
        paymentReference: 'wire-DIFFERENT',
        now: new Date('2026-07-14T10:00:00Z'),
      });
      expect(replay.outcome).toBe('already_applied');
      expect(replay.payout?.paymentReference).toBe('wire-original');
      expect(replay.payout?.providerRef).toBe('remit-batch-77');
      expect(replay.payout?.paidAt?.toISOString()).toBe(
        '2026-07-13T10:00:00.000Z',
      );
    });
  });

  describe('reject releases the membership', () => {
    it('reject frees every member commission and adjustment for a future batch', async () => {
      const one = await createPayableCommission(NETWORK_A);
      const two = await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'reject-release');
      const memberAdjustment = await adjustments.create({
        commissionId: one.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'credit',
        amountCents: 100,
        currency: 'USD',
        reason: 'bundled credit',
        payoutId: payout.id as string,
      });
      // Reconcile the drifted totals so the release list demonstrably
      // carries the adjustment too.
      await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...NETWORK_A,
        idempotencyKey: 'reject-release',
      });

      const rejected = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'reject',
        reason: 'operator declined the batch',
      });
      expect(rejected.outcome).toBe('transitioned');
      expect(rejected.payout?.isRejected()).toBe(true);
      expect(rejected.payout?.notes).toMatch(/operator declined the batch/);
      expect(rejected.releasedCommissionIds?.sort()).toEqual(
        [one.id, two.id].sort(),
      );
      expect(rejected.releasedAdjustmentIds).toEqual([memberAdjustment.id]);

      // Every released row is unsettled again and re-batchable.
      const regathered = await commissions.findPayableUnsettled(
        earner.id as string,
        'USD',
        NETWORK_A,
      );
      expect(regathered.map((c) => c.id).sort()).toEqual(
        [one.id, two.id].sort(),
      );
      const rebatch = await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...NETWORK_A,
        idempotencyKey: 'reject-rebatch',
      });
      expect(rebatch.payout?.totalAmountCents).toBe(2100);

      // The rejected batch is terminal.
      const revive = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      expect(revive.outcome).toBe('refused');
      expect(revive.refusal?.reason).toBe('status_conflict');
    });

    it('reject is refused once processing has started', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'reject-late');
      for (const action of ['approve', 'mark_processing'] as const) {
        await service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action,
        });
      }
      const late = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'reject',
        reason: 'too late',
      });
      expect(late.outcome).toBe('refused');
      expect(late.refusal?.reason).toBe('status_conflict');
    });
  });

  describe('tenant-scope cardinality guard', () => {
    it('refuses a transition when stamped rows are invisible to the tenant scope', async () => {
      enableTenancy();
      // Tenant A's coherent batch…
      const { payout } = await withTenant(
        { tenantId: 'tenant-a' },
        async () => {
          const scoped = await earners.create({
            profileId: 'profile-tenant-a',
            displayName: 'Tenant A earner',
            status: 'active',
            payoutThresholdCents: 1,
          });
          const member = await commissions.create({
            earnerId: scoped.id as string,
            amountCents: 1000,
            currency: 'USD',
            status: 'payable',
            dedupeKey: 'tenant-a-member',
            ...NETWORK_A,
          });
          const minted = await payouts.create({
            earnerId: scoped.id as string,
            currency: 'USD',
            status: 'pending',
            commissionTotalCents: 1000,
            adjustmentTotalCents: 0,
            totalAmountCents: 1000,
            idempotencyKey: 'tenant-a-cardinality',
            ...NETWORK_A,
          });
          member.payoutId = minted.id as string;
          await member.save();
          return { payout: minted };
        },
      );

      // …plus a FOREIGN tenant's row stamped onto the same payout (only
      // representable outside sanctioned paths — exactly what the guard
      // must catch).
      const foreignEarner = await earners.create({
        profileId: 'profile-tenant-b',
        displayName: 'Tenant B earner',
        status: 'active',
        tenantId: 'tenant-b',
      });
      await commissions.create({
        tenantId: 'tenant-b',
        earnerId: foreignEarner.id as string,
        amountCents: 500,
        currency: 'USD',
        status: 'payable',
        dedupeKey: 'tenant-b-intruder',
        ...NETWORK_A,
        payoutId: payout.id as string,
      });

      // Inside tenant A the foreign row is invisible — verification over
      // the visible subset alone would authorize incomplete membership.
      const refused = await withTenant({ tenantId: 'tenant-a' }, () =>
        service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action: 'approve',
        }),
      );
      expect(refused.outcome).toBe('refused');
      expect(refused.refusal?.reason).toBe('tenant_mismatch');
      expect(refused.refusal?.detail).toMatch(
        /visible in the current tenant scope/,
      );

      // The stamped-but-foreign row also keeps the payout out of tenant
      // A's source history, fail-closed with the same reason.
      const history = await withTenant({ tenantId: 'tenant-a' }, () =>
        service.getSourcePayoutHistory({ ...NETWORK_A, limit: 10 }),
      );
      expect(history.payouts).toEqual([]);
      expect(history.excluded).toEqual([
        {
          payoutId: payout.id,
          reason: 'tenant_mismatch',
          detail: expect.stringMatching(/visible in the current tenant scope/),
        },
      ]);
    });
  });

  describe('failure handling', () => {
    it('fail records the reason and resetFromFailed keeps the same rows for retry', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'fail-retry');
      await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'approve',
      });

      const failed = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'fail',
        reason: 'bank rejected the remittance file',
      });
      expect(failed.outcome).toBe('transitioned');
      expect(failed.payout?.isFailed()).toBe(true);
      expect(failed.payout?.notes).toMatch(/bank rejected/);

      // Rows stay stamped — the SAME payout retries the SAME rows.
      const members = await commissions.findByPayout(payout.id as string);
      expect(members).toHaveLength(1);
    });

    it('a mid-completion failure rolls back the member flips (atomicity)', async () => {
      const one = await createPayableCommission(NETWORK_A);
      const two = await createPayableCommission(NETWORK_A);
      const payout = await cutPendingBatch(NETWORK_A, 'atomic-rollback');
      for (const action of ['approve', 'mark_processing'] as const) {
        await service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action,
        });
      }

      // Real fault injection through the framework's interceptor seam: the
      // terminal payout save throws AFTER both member commissions were
      // flipped to paid inside the same transaction.
      GlobalInterceptors.register({
        name: 'test-terminal-save-fault',
        beforeSave(instance) {
          if (
            instance instanceof CommissionPayout &&
            instance.status === 'completed'
          ) {
            throw new Error('injected terminal-save fault');
          }
        },
      });
      // The injected fault surfaces framework-wrapped as a failed save.
      await expect(
        service.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...NETWORK_A,
          action: 'complete',
          paymentReference: 'wire-crash',
        }),
      ).rejects.toThrow(/save in CommissionPayout/);
      GlobalInterceptors.unregister('test-terminal-save-fault');

      // NOTHING stuck halfway: the payout is still processing and every
      // member is still payable — the transaction rolled the flips back.
      const after = await payouts.get({ id: payout.id as string });
      expect(after?.isProcessing()).toBe(true);
      for (const id of [one.id, two.id]) {
        const member = await commissions.get({ id: id as string });
        expect(member?.isPayable()).toBe(true);
        expect(member?.payoutId).toBe(payout.id);
      }

      // The retry completes cleanly.
      const retry = await service.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...NETWORK_A,
        action: 'complete',
        paymentReference: 'wire-retry',
      });
      expect(retry.outcome).toBe('transitioned');
      expect(retry.payout?.paymentReference).toBe('wire-retry');
      for (const id of [one.id, two.id]) {
        const member = await commissions.get({ id: id as string });
        expect(member?.isPaid()).toBe(true);
      }
    });
  });
});
