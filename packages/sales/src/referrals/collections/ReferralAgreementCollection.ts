/**
 * ReferralAgreementCollection — collection manager for
 * {@link ReferralAgreement}.
 *
 * Agreements are versioned rows: amendments insert
 * `(referrerId, programId, maxVersion + 1)` drafts via
 * {@link createAmendment}; existing versions are never rewritten.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ReferralAgreement } from '../models/ReferralAgreement.js';
import type { ReferralAgreementApprovalMode } from '../types.js';

/**
 * Fields an amendment may change relative to the version it copies.
 * `referrerId`/`programId` are fixed (they identify the agreement),
 * `version` is computed, and `status` is always `draft`.
 */
export interface ReferralAgreementAmendmentChanges {
  commissionPlanKey?: string;
  commissionPlanVersion?: number;
  clearingDays?: number;
  approvalMode?: ReferralAgreementApprovalMode;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  contractRef?: string;
  executedArtifactUrl?: string;
  executedArtifactHash?: string;
  acceptanceEvidence?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export class ReferralAgreementCollection extends SmrtCollection<ReferralAgreement> {
  static readonly _itemClass = ReferralAgreement;

  /** Every version of one referrer+program agreement, newest version first. */
  async findByReferrerAndProgram(
    referrerId: string,
    programId: string,
  ): Promise<ReferralAgreement[]> {
    return await this.list({
      where: { referrerId, programId },
      orderBy: 'version DESC',
    });
  }

  /**
   * The agreement governing `(referrerId, programId)` at instant `at`
   * (default now): status `active` AND effective window containing `at`
   * (`effectiveFrom` null = always started; `effectiveTo` null =
   * open-ended). When several active versions overlap — transitional states
   * during amendment activation — the highest version wins. `null` when
   * nothing governs.
   */
  async activeFor(
    referrerId: string,
    programId: string,
    at: Date = new Date(),
  ): Promise<ReferralAgreement | null> {
    const active = await this.list({
      where: { referrerId, programId, status: 'active' },
      orderBy: 'version DESC',
    });
    return active.find((agreement) => agreement.isEffectiveAt(at)) ?? null;
  }

  /**
   * Create an amendment: insert a new DRAFT row with
   * `version = max(existing versions) + 1`, copying the latest existing
   * version's fields and then applying `changes`. The source version is not
   * touched — activate the draft (and supersede the prior active version)
   * as a separate, explicit step.
   *
   * Throws when no version exists for the pair (nothing to amend — use
   * `create` for a brand-new agreement).
   */
  async createAmendment(
    referrerId: string,
    programId: string,
    changes: ReferralAgreementAmendmentChanges = {},
  ): Promise<ReferralAgreement> {
    const versions = await this.findByReferrerAndProgram(referrerId, programId);
    const latest = versions[0];
    if (!latest) {
      throw new Error(
        `ReferralAgreementCollection.createAmendment: no versions exist for referrer '${referrerId}' in program '${programId}' — create the agreement first`,
      );
    }

    const draft = await this.create({
      tenantId: latest.tenantId,
      referrerId,
      programId,
      version: latest.version + 1,
      status: 'draft',
      commissionPlanKey: changes.commissionPlanKey ?? latest.commissionPlanKey,
      commissionPlanVersion:
        changes.commissionPlanVersion ?? latest.commissionPlanVersion,
      clearingDays: changes.clearingDays ?? latest.clearingDays,
      approvalMode: changes.approvalMode ?? latest.approvalMode,
      effectiveFrom:
        changes.effectiveFrom !== undefined
          ? changes.effectiveFrom
          : latest.effectiveFrom,
      effectiveTo:
        changes.effectiveTo !== undefined
          ? changes.effectiveTo
          : latest.effectiveTo,
      contractRef: changes.contractRef ?? latest.contractRef,
      executedArtifactUrl:
        changes.executedArtifactUrl ?? latest.executedArtifactUrl,
      executedArtifactHash:
        changes.executedArtifactHash ?? latest.executedArtifactHash,
      acceptanceEvidence:
        changes.acceptanceEvidence !== undefined
          ? JSON.stringify(changes.acceptanceEvidence)
          : latest.acceptanceEvidence,
      metadata:
        changes.metadata !== undefined
          ? JSON.stringify(changes.metadata)
          : latest.metadata,
    });
    return draft;
  }
}

export default ReferralAgreementCollection;
