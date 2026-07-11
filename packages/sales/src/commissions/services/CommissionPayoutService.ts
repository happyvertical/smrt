/**
 * CommissionPayoutService — mints and drives {@link CommissionPayout}
 * settlement batches.
 *
 * The service is the ONLY sanctioned creation path for payouts (their
 * generated surface is fully read-only): it gathers the exact payable
 * unsettled Commissions and eligible unsettled Adjustments, refuses
 * below-threshold / non-positive batches, stamps `payoutId` on the exact
 * gathered rows, and later flips the batch's commissions to `paid` when the
 * payout completes.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import type { CommissionPayout } from '../models/CommissionPayout.js';
import {
  ADJUSTMENT_SETTLEABLE_COMMISSION_STATUSES,
  type CommissionStatus,
  type PayoutMethod,
} from '../types.js';

/** Collaborators for {@link CommissionPayoutService}. */
export interface CommissionPayoutServiceDeps {
  earners: EarnerCollection;
  commissions: CommissionCollection;
  adjustments: CommissionAdjustmentCollection;
  payouts: CommissionPayoutCollection;
}

/** Input for {@link CommissionPayoutService.createPayoutBatch}. */
export interface CreatePayoutBatchInput {
  earnerId: string;
  currency: string;
  /** Informational period bounds recorded on the payout. */
  periodStart?: Date;
  periodEnd?: Date;
  /**
   * Idempotency natural key. Defaults to
   * `` `${earnerId}:${currency}:${periodEnd ISO date}` `` where the date is
   * the `YYYY-MM-DD` of `periodEnd` (falling back to `now`). Callers running
   * more than one batch per earner/currency/day must supply their own key.
   */
  idempotencyKey?: string;
  /** Overrides the earner's `payoutThresholdCents`. */
  minimumThresholdCents?: number;
  /** Overrides the earner's `payoutMethod`. */
  payoutMethod?: PayoutMethod;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/** Result of {@link CommissionPayoutService.createPayoutBatch}. */
export interface CreatePayoutBatchResult {
  /** The created (or, on an idempotent replay, existing) payout — `null` on refusal. */
  payout: CommissionPayout | null;
  /** `true` only when THIS call minted the payout. */
  created: boolean;
  /** Why no payout was created, when refused. */
  reason?: 'below_threshold' | 'nothing_payable';
  /** Ids of the commissions THIS call stamped onto the payout. */
  settledCommissionIds: string[];
  /** Ids of the adjustments THIS call stamped onto the payout. */
  settledAdjustmentIds: string[];
}

export class CommissionPayoutService {
  constructor(private readonly deps: CommissionPayoutServiceDeps) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<CommissionPayoutService> {
    return new CommissionPayoutService({
      earners: await EarnerCollection.create(classOptions),
      commissions: await CommissionCollection.create(classOptions),
      adjustments: await CommissionAdjustmentCollection.create(classOptions),
      payouts: await CommissionPayoutCollection.create(classOptions),
    });
  }

  /**
   * Create a settlement batch for one earner in one currency.
   *
   * Flow:
   * 1. **Idempotency + repair** — an existing payout with the (defaulted)
   *    key is returned as `{ payout, created: false }`. A clean replay
   *    touches nothing (new payable work is never swept into an existing
   *    batch). A PENDING payout whose stored totals disagree with the rows
   *    stamped with its id — the signature of an interrupted claim pass —
   *    is repaired: the claim pass re-runs and the totals are reconciled
   *    from the verified membership. Past `pending` the batch is frozen.
   * 2. **Gather** — payable unsettled commissions for the earner/currency,
   *    plus unsettled adjustments whose parent commission is
   *    earned/approved/payable/paid (same eligibility as the balance
   *    service, so the batch settles exactly what the balance reports).
   * 3. **Refuse** — `netTotal <= 0` → `'nothing_payable'`;
   *    `netTotal < threshold` (earner default, overridable) →
   *    `'below_threshold'`. Nothing is minted or stamped on refusal.
   * 4. **Mint, claim, reconcile** — create the `pending` payout, then
   *    CLAIM the gathered rows through the collections' conditional
   *    `claimForPayout` (rows grabbed by another batch in the interim are
   *    skipped, never double-claimed), and finally store totals computed
   *    from the rows that were VERIFIABLY claimed — the payout's totals
   *    are always reproducible from its member rows.
   *
   * Concurrency: claims are conditional with post-save verification, which
   * narrows but does not eliminate races between batches with different
   * keys (the collection layer exposes no cross-row transaction — the same
   * stance as commerce/ledgers compensation). Settlement runs are expected
   * to be single-writer per earner; totals are correct-by-construction from
   * claimed rows either way.
   */
  async createPayoutBatch(
    input: CreatePayoutBatchInput,
  ): Promise<CreatePayoutBatchResult> {
    const now = input.now ?? new Date();
    const earner = await this.deps.earners.get({ id: input.earnerId });
    if (!earner) {
      throw new Error(
        `CommissionPayoutService: earner '${input.earnerId}' not found`,
      );
    }

    const idempotencyKey =
      input.idempotencyKey ??
      CommissionPayoutService.defaultIdempotencyKey(
        input.earnerId,
        input.currency,
        input.periodEnd ?? now,
      );

    // Idempotent replay: same key → same payout. A CLEAN replay (stored
    // totals match the stamped membership) returns without touching rows —
    // new payable work is never swept into an existing batch. A pending
    // payout whose stored totals DISAGREE with its membership is the
    // signature of an interrupted claim pass: repair it (re-claim +
    // reconcile totals) instead of returning totals its rows can't
    // reproduce. Anything past pending is frozen.
    const existingPayout =
      await this.deps.payouts.findByIdempotencyKey(idempotencyKey);
    if (existingPayout) {
      if (
        existingPayout.isPending() &&
        !(await this.membershipConsistent(existingPayout))
      ) {
        const repaired = await this.claimAndReconcile(existingPayout, input);
        return { ...repaired, created: false };
      }
      return {
        payout: existingPayout,
        created: false,
        settledCommissionIds: [],
        settledAdjustmentIds: [],
      };
    }

    // Gather the exact rows this batch would settle.
    const commissions = await this.deps.commissions.findPayableUnsettled(
      input.earnerId,
      input.currency,
    );
    const eligibleAdjustments = await this.findEligibleUnsettledAdjustments(
      input.earnerId,
      input.currency,
    );

    const commissionTotalCents = commissions.reduce(
      (sum, c) => sum + c.amountCents,
      0,
    );
    const adjustmentTotalCents = eligibleAdjustments.reduce(
      (sum, a) => sum + a.amountCents,
      0,
    );
    const netTotalCents = commissionTotalCents + adjustmentTotalCents;

    if (netTotalCents <= 0) {
      return {
        payout: null,
        created: false,
        reason: 'nothing_payable',
        settledCommissionIds: [],
        settledAdjustmentIds: [],
      };
    }

    const thresholdCents =
      input.minimumThresholdCents ?? earner.payoutThresholdCents;
    if (netTotalCents < thresholdCents) {
      return {
        payout: null,
        created: false,
        reason: 'below_threshold',
        settledCommissionIds: [],
        settledAdjustmentIds: [],
      };
    }

    const payout = await this.deps.payouts.create({
      // Payouts inherit the earner's tenancy so scheduled batch runs (no
      // active tenant context) still land in the right tenant.
      tenantId: earner.tenantId,
      earnerId: input.earnerId,
      currency: input.currency,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      payoutMethod: input.payoutMethod ?? earner.payoutMethod,
      status: 'pending',
      commissionTotalCents,
      adjustmentTotalCents,
      totalAmountCents: netTotalCents,
      idempotencyKey,
    });

    // Claim the gathered rows conditionally and reconcile the stored
    // totals from what was VERIFIABLY claimed — a row grabbed by another
    // batch between gather and claim is skipped, never double-claimed, and
    // never counted.
    const result = await this.claimAndReconcile(payout, input);
    return { ...result, created: true };
  }

  /**
   * Whether a payout's stored totals are reproducible from the rows
   * actually stamped with its id — the invariant an interrupted claim pass
   * breaks. Clean replays short-circuit on this; repair runs only when it
   * fails.
   */
  private async membershipConsistent(
    payout: CommissionPayout,
  ): Promise<boolean> {
    const payoutId = payout.id ?? '';
    const members = await this.deps.commissions.findByPayout(payoutId);
    const memberAdjustments =
      await this.deps.adjustments.findByPayout(payoutId);
    const commissionTotalCents = members.reduce(
      (sum, c) => sum + c.amountCents,
      0,
    );
    const adjustmentTotalCents = memberAdjustments.reduce(
      (sum, a) => sum + a.amountCents,
      0,
    );
    return (
      payout.commissionTotalCents === commissionTotalCents &&
      payout.adjustmentTotalCents === adjustmentTotalCents &&
      payout.totalAmountCents === commissionTotalCents + adjustmentTotalCents
    );
  }

  /**
   * Claim pass + totals reconciliation for a PENDING payout.
   *
   * The claim set is the union of rows already stamped with this payout
   * (an interrupted earlier pass) and the currently gathered eligible
   * rows. Claims go through the collections' conditional `claimForPayout`
   * (rows owned by another batch are skipped); totals are then recomputed
   * from the claimed rows and saved when they drift from what the payout
   * carries. In the pathological all-rows-raced-away case the payout keeps
   * zero totals and a note — auditable, never double-paid.
   */
  private async claimAndReconcile(
    payout: CommissionPayout,
    input: CreatePayoutBatchInput,
  ): Promise<Omit<CreatePayoutBatchResult, 'created'>> {
    const payoutId = payout.id ?? '';

    const previouslyClaimed =
      await this.deps.commissions.findByPayout(payoutId);
    const gathered = await this.deps.commissions.findPayableUnsettled(
      input.earnerId,
      input.currency,
    );
    const commissionIds = [
      ...new Set(
        [...previouslyClaimed, ...gathered]
          .map((c) => c.id)
          .filter((id): id is string => !!id),
      ),
    ];
    const claimedCommissions = await this.deps.commissions.claimForPayout(
      commissionIds,
      payoutId,
    );

    const previouslyClaimedAdjustments =
      await this.deps.adjustments.findByPayout(payoutId);
    const gatheredAdjustments = await this.findEligibleUnsettledAdjustments(
      input.earnerId,
      input.currency,
    );
    const adjustmentIds = [
      ...new Set(
        [...previouslyClaimedAdjustments, ...gatheredAdjustments]
          .map((a) => a.id)
          .filter((id): id is string => !!id),
      ),
    ];
    const claimedAdjustments = await this.deps.adjustments.claimForPayout(
      adjustmentIds,
      payoutId,
    );

    const commissionTotalCents = claimedCommissions.reduce(
      (sum, c) => sum + c.amountCents,
      0,
    );
    const adjustmentTotalCents = claimedAdjustments.reduce(
      (sum, a) => sum + a.amountCents,
      0,
    );
    const totalAmountCents = commissionTotalCents + adjustmentTotalCents;

    if (
      payout.commissionTotalCents !== commissionTotalCents ||
      payout.adjustmentTotalCents !== adjustmentTotalCents ||
      payout.totalAmountCents !== totalAmountCents
    ) {
      payout.commissionTotalCents = commissionTotalCents;
      payout.adjustmentTotalCents = adjustmentTotalCents;
      payout.totalAmountCents = totalAmountCents;
      if (claimedCommissions.length === 0 && claimedAdjustments.length === 0) {
        payout.notes =
          'no rows claimed (raced by a concurrent batch); nothing will be paid';
      }
      await payout.save();
    }

    return {
      payout,
      settledCommissionIds: claimedCommissions
        .map((c) => c.id)
        .filter((id): id is string => !!id),
      settledAdjustmentIds: claimedAdjustments
        .map((a) => a.id)
        .filter((id): id is string => !!id),
    };
  }

  /**
   * Complete a payout: flip the batch's settled commissions
   * `payable → paid` FIRST, then `payout.complete(paymentReference)`
   * (requires status `processing`). Ordering matters for recoverability —
   * if a member save fails mid-loop the payout is still `processing`, so a
   * retry finishes the remaining members (already-paid ones are skipped)
   * and then finalizes; the terminal transition never strands `payable`
   * members behind a `completed` payout. Adjustments carry no status —
   * stamping `payoutId` at batch time already settled them.
   */
  async completePayout(
    payoutId: string,
    paymentReference: string,
    now: Date = new Date(),
  ): Promise<CommissionPayout> {
    const payout = await this.requirePayout(payoutId);
    if (!payout.isProcessing()) {
      throw new Error(
        `CommissionPayout ${payout.id ?? '<new>'}: cannot complete from status '${payout.status}'`,
      );
    }
    if (!paymentReference) {
      throw new Error(
        `CommissionPayout ${payout.id ?? '<new>'}: complete() requires a paymentReference`,
      );
    }

    const members = await this.deps.commissions.findByPayout(payoutId);
    for (const commission of members) {
      if (commission.isPayable()) {
        commission.markPaid(now);
        await commission.save();
      }
    }

    payout.complete(paymentReference, now);
    await payout.save();
    return payout;
  }

  /**
   * Fail a payout (`approved | processing → failed`). The batch's rows stay
   * stamped — after `resetFromFailed()` the SAME payout retries the SAME
   * rows; releasing the rows to a different batch would double-pay them if
   * the failed remittance later settled.
   */
  async failPayout(
    payoutId: string,
    reason: string,
  ): Promise<CommissionPayout> {
    const payout = await this.requirePayout(payoutId);
    payout.fail(reason);
    await payout.save();
    return payout;
  }

  /**
   * Unsettled adjustments for the earner/currency whose parent commission
   * is earned/approved/payable/paid — the same eligibility rule the balance
   * service applies, so batches settle exactly what balances report.
   */
  private async findEligibleUnsettledAdjustments(
    earnerId: string,
    currency: string,
  ) {
    const unsettled = await this.deps.adjustments.findUnsettledByEarner(
      earnerId,
      currency,
    );
    if (unsettled.length === 0) return unsettled;

    const parentIds = [
      ...new Set(unsettled.map((a) => a.commissionId).filter(Boolean)),
    ];
    const parents = await this.deps.commissions.listByIds(parentIds);
    const parentStatusById = new Map<string, CommissionStatus>();
    for (const parent of parents) {
      if (parent.id) parentStatusById.set(parent.id, parent.status);
    }
    return unsettled.filter((adjustment) => {
      const parentStatus = parentStatusById.get(adjustment.commissionId);
      return (
        parentStatus !== undefined &&
        (
          ADJUSTMENT_SETTLEABLE_COMMISSION_STATUSES as readonly CommissionStatus[]
        ).includes(parentStatus)
      );
    });
  }

  private async requirePayout(payoutId: string): Promise<CommissionPayout> {
    const payout = await this.deps.payouts.get({ id: payoutId });
    if (!payout) {
      throw new Error(
        `CommissionPayoutService: payout '${payoutId}' not found`,
      );
    }
    return payout;
  }

  /** `${earnerId}:${currency}:${YYYY-MM-DD of periodEnd}` — see the input doc. */
  private static defaultIdempotencyKey(
    earnerId: string,
    currency: string,
    periodEnd: Date,
  ): string {
    return `${earnerId}:${currency}:${periodEnd.toISOString().slice(0, 10)}`;
  }
}

export default CommissionPayoutService;
