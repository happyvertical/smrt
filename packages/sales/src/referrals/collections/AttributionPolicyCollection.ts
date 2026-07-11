/**
 * AttributionPolicyCollection — collection manager for
 * {@link AttributionPolicy}.
 *
 * Policies are versioned rows: amendments insert `(policyKey, maxVersion +
 * 1)` drafts via {@link createAmendment}; existing versions are never
 * rewritten (CommissionPlan pattern).
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AttributionPolicy } from '../models/AttributionPolicy.js';
import type {
  AttributionConflictBehavior,
  AttributionCreditMode,
  AttributionPolicyStatus,
} from '../types.js';

/**
 * Fields an amendment may change relative to the version it copies.
 * `policyKey` is fixed (it identifies the policy), `version` is computed,
 * and `status` is always `draft` — a caller cannot mint a pre-activated
 * amendment.
 */
export interface AttributionPolicyAmendmentChanges {
  windowDays?: number;
  creditMode?: AttributionCreditMode;
  conflictBehavior?: AttributionConflictBehavior;
  allowSelfReferral?: boolean;
  allowExistingClients?: boolean;
  eligibleServices?: string[];
  eligibleCampaigns?: string[];
  eligibleRegions?: string[];
  effectiveFrom?: Date | null;
  metadata?: Record<string, unknown>;
}

export class AttributionPolicyCollection extends SmrtCollection<AttributionPolicy> {
  static readonly _itemClass = AttributionPolicy;

  /** Every version of a policy, newest version first. */
  async findByPolicyKey(policyKey: string): Promise<AttributionPolicy[]> {
    return await this.list({
      where: { policyKey },
      orderBy: 'version DESC',
    });
  }

  /** Policies by status. */
  async findByStatus(
    status: AttributionPolicyStatus,
  ): Promise<AttributionPolicy[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * The highest ACTIVE version of a policy, or `null` when no version is
   * active. This is what `AttributionService.resolve()` loads when the
   * caller doesn't pin a version.
   */
  async latestActiveByKey(
    policyKey: string,
  ): Promise<AttributionPolicy | null> {
    const results = await this.list({
      where: { policyKey, status: 'active' },
      orderBy: 'version DESC',
      limit: 1,
    });
    return results[0] ?? null;
  }

  /**
   * Create an amendment: insert a new DRAFT row with
   * `version = max(existing versions) + 1`, copying the latest existing
   * version's fields and then applying `changes`. The source version is not
   * touched — activate the draft (and supersede the prior active version)
   * as a separate, explicit step.
   *
   * Throws when no version of `policyKey` exists (nothing to amend — use
   * `create` for a brand-new policy).
   */
  async createAmendment(
    policyKey: string,
    changes: AttributionPolicyAmendmentChanges = {},
  ): Promise<AttributionPolicy> {
    const versions = await this.findByPolicyKey(policyKey);
    const latest = versions[0];
    if (!latest) {
      throw new Error(
        `AttributionPolicyCollection.createAmendment: no versions exist for policy key '${policyKey}' — create the policy first`,
      );
    }

    const draft = await this.create({
      tenantId: latest.tenantId,
      policyKey,
      version: latest.version + 1,
      status: 'draft',
      windowDays: changes.windowDays ?? latest.windowDays,
      creditMode: changes.creditMode ?? latest.creditMode,
      conflictBehavior: changes.conflictBehavior ?? latest.conflictBehavior,
      allowSelfReferral: changes.allowSelfReferral ?? latest.allowSelfReferral,
      allowExistingClients:
        changes.allowExistingClients ?? latest.allowExistingClients,
      eligibleServices:
        changes.eligibleServices !== undefined
          ? JSON.stringify(changes.eligibleServices)
          : latest.eligibleServices,
      eligibleCampaigns:
        changes.eligibleCampaigns !== undefined
          ? JSON.stringify(changes.eligibleCampaigns)
          : latest.eligibleCampaigns,
      eligibleRegions:
        changes.eligibleRegions !== undefined
          ? JSON.stringify(changes.eligibleRegions)
          : latest.eligibleRegions,
      effectiveFrom:
        changes.effectiveFrom !== undefined
          ? changes.effectiveFrom
          : latest.effectiveFrom,
      metadata:
        changes.metadata !== undefined
          ? JSON.stringify(changes.metadata)
          : latest.metadata,
    });
    return draft;
  }
}

export default AttributionPolicyCollection;
