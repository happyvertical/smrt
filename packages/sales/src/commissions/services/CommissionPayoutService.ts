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
   * 1. **Idempotency** — an existing payout with the (defaulted) key is
   *    returned as `{ payout, created: false }` WITHOUT re-gathering or
   *    re-stamping anything (`settled*Ids` come back empty on a replay).
   * 2. **Gather** — payable unsettled commissions for the earner/currency,
   *    plus unsettled adjustments whose parent commission is
   *    earned/approved/payable/paid (same eligibility as the balance
   *    service, so the batch settles exactly what the balance reports).
   * 3. **Refuse** — `netTotal <= 0` → `'nothing_payable'`;
   *    `netTotal < threshold` (earner default, overridable) →
   *    `'below_threshold'`. Nothing is stamped on refusal.
   * 4. **Mint + stamp** — create the `pending` payout carrying the totals
   *    (`commissionTotalCents` / `adjustmentTotalCents` /
   *    `totalAmountCents`) and stamp `payoutId` on the EXACT gathered rows.
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

    // Idempotent replay: same key → same payout, nothing re-stamped.
    const existingPayout =
      await this.deps.payouts.findByIdempotencyKey(idempotencyKey);
    if (existingPayout) {
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

    // Stamp the EXACT gathered rows — the payout settles these and only
    // these, so its totals stay reproducible from its member rows.
    const settledCommissionIds: string[] = [];
    for (const commission of commissions) {
      commission.payoutId = payout.id ?? '';
      await commission.save();
      if (commission.id) settledCommissionIds.push(commission.id);
    }
    const settledAdjustmentIds: string[] = [];
    for (const adjustment of eligibleAdjustments) {
      adjustment.payoutId = payout.id ?? '';
      await adjustment.save();
      if (adjustment.id) settledAdjustmentIds.push(adjustment.id);
    }

    return {
      payout,
      created: true,
      settledCommissionIds,
      settledAdjustmentIds,
    };
  }

  /**
   * Complete a payout: `payout.complete(paymentReference)` (requires status
   * `processing`), then flip the batch's settled commissions
   * `payable → paid`. Adjustments carry no status — stamping `payoutId` at
   * batch time already settled them.
   */
  async completePayout(
    payoutId: string,
    paymentReference: string,
    now: Date = new Date(),
  ): Promise<CommissionPayout> {
    const payout = await this.requirePayout(payoutId);
    payout.complete(paymentReference, now);
    await payout.save();

    const members = await this.deps.commissions.findByPayout(payoutId);
    for (const commission of members) {
      if (commission.isPayable()) {
        commission.markPaid(now);
        await commission.save();
      }
    }
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
