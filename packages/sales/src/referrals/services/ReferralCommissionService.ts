/**
 * ReferralCommissionService — the bridge from qualified Referrals to the
 * commissions financial core (#1932).
 *
 * Given an EarningEvent (e.g. an invoice payment), the service finds the
 * qualified referrals it should pay, loads each one's FROZEN
 * ReferralTermSnapshot, resolves the referrer's Earner, and hands the
 * snapshot's components to `CommissionCalculationService.calculateForEvent`.
 * Calculation NEVER touches a live plan — reproducibility comes from the
 * snapshot, idempotency from the calculation service's dedupe keys.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  type Commission,
  CommissionCalculationService,
  CommissionCollection,
  type CommissionComponentSkip,
  type EarningEvent,
} from '../../commissions/index.js';
import { ReferralCollection } from '../collections/ReferralCollection.js';
import { ReferralTermSnapshotCollection } from '../collections/ReferralTermSnapshotCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import type { Referral } from '../models/Referral.js';

/**
 * The `termsSnapshotKind` every referral-bridged Commission carries —
 * points `termsSnapshotId` at a ReferralTermSnapshot row.
 */
export const REFERRAL_TERMS_SNAPSHOT_KIND = 'referral_term_snapshot';

/** Collaborators for {@link ReferralCommissionService}. */
export interface ReferralCommissionServiceDeps {
  referrals: ReferralCollection;
  snapshots: ReferralTermSnapshotCollection;
  referrers: ReferrerCollection;
  /** The commissions module's calculation service (same package). */
  calculation: CommissionCalculationService;
  /** The commissions module's commission collection (occurrence counting). */
  commissions: CommissionCollection;
}

/** Input for {@link ReferralCommissionService.processEarningEvent}. */
export interface ProcessEarningEventInput {
  /** The (persisted) earning event to pay referrals from. */
  event: EarningEvent;
  /** Resolve qualified referrals by target … */
  targetKind?: string;
  targetId?: string;
  /** … or name them explicitly (takes precedence over the target pair). */
  referralIds?: string[];
  /** Reserved clock override for symmetry with the sibling services. */
  now?: Date;
}

/** Why a referral produced no calculation. */
export type ReferralProcessingSkipReason =
  | 'referral_not_found'
  | 'not_qualified'
  | 'missing_snapshot'
  | 'referrer_missing_earner';

/** One referral the bridge skipped, and why. */
export interface ReferralProcessingSkip {
  referralId: string;
  reason: ReferralProcessingSkipReason;
}

/** Per-referral calculation outcome. */
export interface ReferralCommissionOutcome {
  referralId: string;
  /** Commissions newly created for this referral by THIS call. */
  created: Commission[];
  /** Idempotent replays — commissions that already existed. */
  existing: Commission[];
  /** Components the calculation declined, with reasons. */
  skipped: CommissionComponentSkip[];
}

/** Result of {@link ReferralCommissionService.processEarningEvent}. */
export interface ProcessEarningEventResult {
  /** One entry per qualified referral that reached calculation. */
  results: ReferralCommissionOutcome[];
  /** Referrals that never reached calculation, with reasons. */
  skippedReferrals: ReferralProcessingSkip[];
}

export class ReferralCommissionService {
  constructor(private readonly deps: ReferralCommissionServiceDeps) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<ReferralCommissionService> {
    return new ReferralCommissionService({
      referrals: await ReferralCollection.create(classOptions),
      snapshots: await ReferralTermSnapshotCollection.create(classOptions),
      referrers: await ReferrerCollection.create(classOptions),
      calculation: await CommissionCalculationService.create(classOptions),
      commissions: await CommissionCollection.create(classOptions),
    });
  }

  /**
   * Turn one earning event into Commissions for every qualified referral it
   * concerns.
   *
   * Referral resolution: explicit `referralIds` when given (rows that are
   * missing / not qualified are reported in `skippedReferrals`), else
   * `findQualifiedByTarget(targetKind, targetId)`. One of the two forms is
   * required.
   *
   * Per referral:
   * 1. Load its ReferralTermSnapshot (`'missing_snapshot'` skip when the
   *    pointer is empty/dangling).
   * 2. Resolve the referrer's `earnerId`
   *    (`'referrer_missing_earner'` skip when absent — roles without a
   *    payout account cannot earn).
   * 3. Delegate to `CommissionCalculationService.calculateForEvent` with
   *    the snapshot's plan pin, FROZEN components, currency (mismatches
   *    surface as the calc service's `currency_mismatch` skips),
   *    clearingDays, the referral's `creditFraction` as the share, its
   *    `splitGroupId`, the
   *    `('referral_term_snapshot', snapshot.id)` terms reference, and an
   *    occurrence resolver counting existing Commissions for
   *    `(termsSnapshotId, componentKey)` from PRIOR events.
   *
   * Fully idempotent on replay: the calculation service's dedupe keys
   * return prior rows in each outcome's `existing`.
   */
  async processEarningEvent(
    input: ProcessEarningEventInput,
  ): Promise<ProcessEarningEventResult> {
    const { event } = input;
    if (!event?.id) {
      throw new Error(
        'ReferralCommissionService.processEarningEvent requires a persisted event (missing id)',
      );
    }

    const skippedReferrals: ReferralProcessingSkip[] = [];
    const referrals: Referral[] = [];

    if (input.referralIds && input.referralIds.length > 0) {
      for (const referralId of input.referralIds) {
        const referral = await this.deps.referrals.get({ id: referralId });
        if (!referral) {
          skippedReferrals.push({ referralId, reason: 'referral_not_found' });
          continue;
        }
        if (referral.status !== 'qualified') {
          skippedReferrals.push({ referralId, reason: 'not_qualified' });
          continue;
        }
        referrals.push(referral);
      }
    } else if (input.targetKind && input.targetId) {
      referrals.push(
        ...(await this.deps.referrals.findQualifiedByTarget(
          input.targetKind,
          input.targetId,
        )),
      );
    } else {
      throw new Error(
        'ReferralCommissionService.processEarningEvent requires referralIds or a (targetKind, targetId) pair',
      );
    }

    const results: ReferralCommissionOutcome[] = [];
    for (const referral of referrals) {
      const referralId = referral.id ?? '';

      const snapshot = referral.snapshotId
        ? await this.deps.snapshots.get({ id: referral.snapshotId })
        : null;
      if (!snapshot?.id) {
        skippedReferrals.push({ referralId, reason: 'missing_snapshot' });
        continue;
      }

      const referrer = await this.deps.referrers.get({
        id: referral.referrerId,
      });
      if (!referrer?.earnerId) {
        skippedReferrals.push({
          referralId,
          reason: 'referrer_missing_earner',
        });
        continue;
      }

      const snapshotId = snapshot.id;
      const calculation = await this.deps.calculation.calculateForEvent({
        event,
        planKey: snapshot.planKey,
        planVersion: snapshot.planVersion,
        components: snapshot.getComponents(),
        earnerId: referrer.earnerId,
        shareFraction: referral.creditFraction,
        splitGroupId: referral.splitGroupId,
        termsSnapshotKind: REFERRAL_TERMS_SNAPSHOT_KIND,
        termsSnapshotId: snapshotId,
        currency: snapshot.currency,
        clearingDays: snapshot.clearingDays,
        // Occurrences consumed under THESE terms from PRIOR events — the
        // current event must not count against recurrence limits (its own
        // replay is handled by the calc service's idempotency).
        occurrenceCountResolver: async (componentKey: string) => {
          const prior = await this.deps.commissions.list({
            where: { termsSnapshotId: snapshotId, componentKey },
          });
          return prior.filter(
            (commission) => commission.earningEventId !== event.id,
          ).length;
        },
      });

      results.push({
        referralId,
        created: calculation.created,
        existing: calculation.existing,
        skipped: calculation.skipped,
      });
    }

    return { results, skippedReferrals };
  }
}

export default ReferralCommissionService;
