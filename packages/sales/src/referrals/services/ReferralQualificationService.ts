/**
 * ReferralQualificationService — turns an attributed Referral into a
 * QUALIFIED one by freezing the governing terms into an immutable
 * ReferralTermSnapshot.
 *
 * Qualification is the moment terms bind: the active ReferralAgreement is
 * resolved, the CommissionPlan version is pinned (the agreement's explicit
 * pin, or the latest active version when unpinned), and the plan's
 * components are COPIED into the snapshot. Everything the commission bridge
 * later needs comes from that frozen row — plan amendments after
 * qualification change nothing unless {@link requalify} is explicitly
 * invoked.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  type CommissionPlan,
  CommissionPlanCollection,
} from '../../commissions/index.js';
import { AttributionPolicyCollection } from '../collections/AttributionPolicyCollection.js';
import { ReferralAgreementCollection } from '../collections/ReferralAgreementCollection.js';
import { ReferralCollection } from '../collections/ReferralCollection.js';
import { ReferralTermSnapshotCollection } from '../collections/ReferralTermSnapshotCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import type { Referral } from '../models/Referral.js';
import type { ReferralAgreement } from '../models/ReferralAgreement.js';
import type { ReferralTermSnapshot } from '../models/ReferralTermSnapshot.js';

/** Collaborators for {@link ReferralQualificationService}. */
export interface ReferralQualificationServiceDeps {
  referrals: ReferralCollection;
  agreements: ReferralAgreementCollection;
  /** The commissions module's plan collection (same package). */
  plans: CommissionPlanCollection;
  policies: AttributionPolicyCollection;
  snapshots: ReferralTermSnapshotCollection;
  referrers: ReferrerCollection;
}

/** Why {@link ReferralQualificationService.qualify} refused. */
export type QualificationRefusalReason =
  | 'not_attributed'
  | 'existing_client_ineligible'
  | 'self_referral_ineligible'
  | 'no_active_agreement'
  | 'no_active_plan';

/** Input for {@link ReferralQualificationService.qualify}. */
export interface QualifyReferralInput {
  referralId: string;
  /** Clock override for deterministic tests. */
  now?: Date;
  /** Re-check flag: the prospect is already a client. */
  isExistingClient?: boolean;
  /** Re-check flag: the prospect's own profile id (self-referral gate). */
  subjectProfileId?: string;
}

/** Result of {@link ReferralQualificationService.qualify}. */
export interface QualifyReferralResult {
  /** Whether the referral is (now or already) qualified. */
  qualified: boolean;
  /** `true` only when THIS call minted the snapshot. */
  created: boolean;
  /** The governing snapshot (`null` on refusal). */
  snapshot: ReferralTermSnapshot | null;
  /** The (re)loaded referral (`null` only when the id is unknown). */
  referral: Referral | null;
  /** Why qualification was refused, when it was. */
  reason?: QualificationRefusalReason;
}

/** Input for {@link ReferralQualificationService.requalify}. */
export interface RequalifyReferralInput {
  referralId: string;
  /** Non-empty rationale recorded in the referral metadata. Required. */
  reason: string;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/** Result of {@link ReferralQualificationService.requalify}. */
export interface RequalifyReferralResult {
  /** Whether a new snapshot now governs the referral. */
  requalified: boolean;
  /** The NEW governing snapshot (`null` on refusal). */
  snapshot: ReferralTermSnapshot | null;
  /** The previously governing snapshot's id (kept as history). */
  previousSnapshotId: string;
  /** Why requalification was refused, when it was. */
  reason?: 'no_active_agreement' | 'no_active_plan';
}

export class ReferralQualificationService {
  constructor(private readonly deps: ReferralQualificationServiceDeps) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<ReferralQualificationService> {
    return new ReferralQualificationService({
      referrals: await ReferralCollection.create(classOptions),
      agreements: await ReferralAgreementCollection.create(classOptions),
      plans: await CommissionPlanCollection.create(classOptions),
      policies: await AttributionPolicyCollection.create(classOptions),
      snapshots: await ReferralTermSnapshotCollection.create(classOptions),
      referrers: await ReferrerCollection.create(classOptions),
    });
  }

  /**
   * Qualify an attributed referral.
   *
   * Flow:
   * 1. **Status** — the referral must be `attributed`
   *    (`reason: 'not_attributed'` otherwise). Already `qualified` →
   *    IDEMPOTENT: the existing snapshot returns with `created: false`.
   * 2. **Eligibility re-check** — the attribution-time policy version's
   *    flags are re-applied against the caller's current knowledge:
   *    `isExistingClient` (`existing_client_ineligible`) and
   *    `subjectProfileId` vs the referrer's profile
   *    (`self_referral_ineligible`). Refusals do NOT change the referral's
   *    status — disqualification stays an explicit caller decision.
   * 3. **Agreement** — the ACTIVE ReferralAgreement for
   *    (referrerId, programId) effective at `now`
   *    (`reason: 'no_active_agreement'` when none).
   * 4. **Plan** — the agreement's pinned `commissionPlanVersion`, or the
   *    latest active version when the pin is `0`; the resolved version must
   *    be ACTIVE (`reason: 'no_active_plan'` otherwise).
   * 5. **Snapshot** — mint the immutable ReferralTermSnapshot (frozen
   *    component copy, currency, clearingDays, approvalMode, agreement +
   *    plan + policy version refs), point `referral.snapshotId` at it, and
   *    transition `attributed → qualified` (stamping `qualifiedAt`).
   */
  async qualify(input: QualifyReferralInput): Promise<QualifyReferralResult> {
    const now = input.now ?? new Date();
    const referral = await this.requireReferral(input.referralId, 'qualify');

    // Idempotent replay: already qualified → hand back the governing
    // snapshot without touching anything.
    if (referral.status === 'qualified') {
      const snapshot = referral.snapshotId
        ? await this.deps.snapshots.get({ id: referral.snapshotId })
        : null;
      return { qualified: true, created: false, snapshot, referral };
    }

    if (referral.status !== 'attributed') {
      return {
        qualified: false,
        created: false,
        snapshot: null,
        referral,
        reason: 'not_attributed',
      };
    }

    // Re-check the policy eligibility flags with the caller's CURRENT
    // knowledge — facts learned between attribution and qualification
    // (existing-client discovery, prospect identity) must still gate.
    const policy = await this.findPolicyVersion(
      referral.policyKey,
      referral.policyVersion,
      referral.tenantId,
    );
    if (policy) {
      if (input.isExistingClient && !policy.allowExistingClients) {
        return {
          qualified: false,
          created: false,
          snapshot: null,
          referral,
          reason: 'existing_client_ineligible',
        };
      }
      if (input.subjectProfileId && !policy.allowSelfReferral) {
        const referrer = await this.deps.referrers.get({
          id: referral.referrerId,
        });
        if (referrer && referrer.profileId === input.subjectProfileId) {
          return {
            qualified: false,
            created: false,
            snapshot: null,
            referral,
            reason: 'self_referral_ineligible',
          };
        }
      }
    }

    const agreement = await this.deps.agreements.activeFor(
      referral.referrerId,
      referral.programId,
      now,
    );
    if (!agreement) {
      return {
        qualified: false,
        created: false,
        snapshot: null,
        referral,
        reason: 'no_active_agreement',
      };
    }

    const plan = await this.resolvePlan(agreement, now);
    if (!plan) {
      return {
        qualified: false,
        created: false,
        snapshot: null,
        referral,
        reason: 'no_active_plan',
      };
    }

    const snapshot = await this.mintSnapshot(referral, agreement, plan);
    referral.snapshotId = snapshot.id ?? '';
    referral.markQualified(now);
    await referral.save();

    return { qualified: true, created: true, snapshot, referral };
  }

  /**
   * Explicitly re-snapshot a QUALIFIED referral under the CURRENT terms —
   * the "amendment explicitly applied" path: after a plan/agreement
   * amendment, earnings keep flowing through the OLD snapshot until an
   * operator invokes this.
   *
   * Creates a NEW snapshot from the currently active agreement/plan,
   * repoints `referral.snapshotId`, leaves the old snapshot row untouched
   * (history — commissions it produced still reference it), and appends
   * `{ at, reason, fromSnapshotId, toSnapshotId }` to the referral
   * metadata's `requalifications` array.
   *
   * Throws on misuse (unknown referral, non-qualified status, empty
   * reason); refuses with a typed reason when no active agreement/plan
   * currently governs.
   */
  async requalify(
    input: RequalifyReferralInput,
  ): Promise<RequalifyReferralResult> {
    if (!input.reason?.trim()) {
      throw new Error(
        'ReferralQualificationService.requalify requires a non-empty reason',
      );
    }
    const now = input.now ?? new Date();
    const referral = await this.requireReferral(input.referralId, 'requalify');
    if (referral.status !== 'qualified') {
      throw new Error(
        `ReferralQualificationService.requalify: referral '${input.referralId}' is '${referral.status}' — only qualified referrals can be re-snapshotted`,
      );
    }

    const agreement = await this.deps.agreements.activeFor(
      referral.referrerId,
      referral.programId,
      now,
    );
    if (!agreement) {
      return {
        requalified: false,
        snapshot: null,
        previousSnapshotId: referral.snapshotId,
        reason: 'no_active_agreement',
      };
    }
    const plan = await this.resolvePlan(agreement, now);
    if (!plan) {
      return {
        requalified: false,
        snapshot: null,
        previousSnapshotId: referral.snapshotId,
        reason: 'no_active_plan',
      };
    }

    const previousSnapshotId = referral.snapshotId;
    const snapshot = await this.mintSnapshot(referral, agreement, plan);

    const meta = referral.getMetadata();
    const history = Array.isArray(meta.requalifications)
      ? (meta.requalifications as unknown[])
      : [];
    history.push({
      at: now.toISOString(),
      reason: input.reason,
      fromSnapshotId: previousSnapshotId,
      toSnapshotId: snapshot.id ?? '',
    });
    referral.setMetadata({ ...meta, requalifications: history });
    referral.snapshotId = snapshot.id ?? '';
    await referral.save();

    return { requalified: true, snapshot, previousSnapshotId };
  }

  // -------- Internals --------

  private async requireReferral(
    referralId: string,
    method: string,
  ): Promise<Referral> {
    const referral = await this.deps.referrals.get({ id: referralId });
    if (!referral) {
      throw new Error(
        `ReferralQualificationService.${method}: referral '${referralId}' not found`,
      );
    }
    return referral;
  }

  /**
   * The exact policy version pinned on the referral, when it exists —
   * resolved in the REFERRAL's tenant lane (global fallback): background
   * qualification runs without ambient tenant context, and another
   * tenant's same-keyed policy must never supply the eligibility flags.
   */
  private async findPolicyVersion(
    policyKey: string,
    version: number,
    tenantId: string | null = null,
  ) {
    if (!policyKey || version <= 0) return null;
    const results = await this.deps.policies.list({
      where: { policyKey, version },
    });
    return (
      results.find((policy) => policy.tenantId === tenantId) ??
      results.find((policy) => policy.tenantId === null) ??
      null
    );
  }

  /**
   * The CommissionPlan an agreement binds: the pinned version when
   * `commissionPlanVersion > 0`, else the latest active version. Either
   * way the resolved row must be ACTIVE — superseded/retired terms cannot
   * govern a NEW qualification (an amendment should be activated, or the
   * agreement re-pinned, first).
   */
  private async resolvePlan(
    agreement: ReferralAgreement,
    at: Date = new Date(),
  ): Promise<CommissionPlan | null> {
    if (!agreement.commissionPlanKey) return null;
    if (agreement.commissionPlanVersion > 0) {
      // Pinned lookup, scoped to the AGREEMENT's tenant with global
      // fallback — system/background qualification runs without ambient
      // tenant context, and another tenant's same-named plan must never be
      // frozen into this tenant's snapshot.
      const results = await this.deps.plans.list({
        where: {
          planKey: agreement.commissionPlanKey,
          version: agreement.commissionPlanVersion,
          status: 'active',
        },
      });
      return (
        results.find((plan) => plan.tenantId === agreement.tenantId) ??
        results.find((plan) => plan.tenantId === null) ??
        null
      );
    }
    // Unpinned agreements resolve the version in effect at the
    // qualification clock, in the agreement's tenant lane — a future-dated
    // active amendment must not govern earlier qualifications.
    return await this.deps.plans.latestActiveByKey(
      agreement.commissionPlanKey,
      at,
      agreement.tenantId,
    );
  }

  /**
   * Mint the immutable snapshot: agreement/plan/policy refs plus the FROZEN
   * component copy and the calculation inputs. `planVersion` records the
   * RESOLVED version — this is where an unpinned (`0`) agreement version
   * gets pinned.
   */
  private async mintSnapshot(
    referral: Referral,
    agreement: ReferralAgreement,
    plan: CommissionPlan,
  ): Promise<ReferralTermSnapshot> {
    return await this.deps.snapshots.create({
      tenantId: referral.tenantId,
      referralId: referral.id ?? '',
      agreementId: agreement.id ?? '',
      agreementVersion: agreement.version,
      planKey: plan.planKey,
      planVersion: plan.version,
      policyKey: referral.policyKey,
      policyVersion: referral.policyVersion,
      components: plan.components,
      currency: plan.currency,
      clearingDays: agreement.clearingDays,
      approvalMode: agreement.approvalMode,
    });
  }
}

export default ReferralQualificationService;
