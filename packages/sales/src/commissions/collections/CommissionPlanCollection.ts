/**
 * CommissionPlanCollection — collection manager for {@link CommissionPlan}.
 *
 * Plans are versioned rows: amendments insert `(planKey, maxVersion + 1)`
 * drafts via {@link createAmendment}; existing versions are never rewritten.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  CommissionPlan,
  validateCommissionPlanComponents,
} from '../models/CommissionPlan.js';
import type {
  CommissionPlanComponent,
  CommissionPlanStatus,
} from '../types.js';

/**
 * Fields an amendment may change relative to the version it copies.
 * `planKey` is fixed (it identifies the plan), `version` is computed, and
 * `status` is always `draft` — a caller cannot mint a pre-activated
 * amendment.
 */
export interface CommissionPlanAmendmentChanges {
  name?: string;
  description?: string;
  components?: CommissionPlanComponent[];
  currency?: string;
  effectiveFrom?: Date | null;
  metadata?: Record<string, unknown>;
}

export class CommissionPlanCollection extends SmrtCollection<CommissionPlan> {
  static readonly _itemClass = CommissionPlan;

  /** Every version of a plan, newest version first. */
  async findByPlanKey(planKey: string): Promise<CommissionPlan[]> {
    return await this.list({
      where: { planKey },
      orderBy: 'version DESC',
    });
  }

  /** Plans by status. */
  async findByStatus(status: CommissionPlanStatus): Promise<CommissionPlan[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * The highest ACTIVE version of a plan already IN EFFECT at `at`, or
   * `null` when none is. This is what calculation callers resolve terms
   * from when no frozen snapshot pins a specific version. A future-dated
   * amendment can be activated ahead of its effective date without
   * governing earlier qualifications (`effectiveFrom: null` = effective
   * immediately).
   */
  async latestActiveByKey(
    planKey: string,
    at: Date = new Date(),
    tenantId?: string | null,
  ): Promise<CommissionPlan | null> {
    const results = await this.list({
      where: { planKey, status: 'active' },
      orderBy: 'version DESC',
    });
    const inEffect = results.filter(
      (plan) => plan.effectiveFrom === null || plan.effectiveFrom <= at,
    );
    if (tenantId === undefined) {
      // No explicit scope: ambient tenant scoping (when present) applies.
      return inEffect[0] ?? null;
    }
    // Explicit scope (system/background paths run without ambient tenant
    // context): the tenant's own versions form their own key-space; global
    // (NULL-tenant) versions are the fallback. Never another tenant's.
    return (
      inEffect.find((plan) => plan.tenantId === tenantId) ??
      inEffect.find((plan) => plan.tenantId === null) ??
      null
    );
  }

  /**
   * Create an amendment: insert a new DRAFT row with
   * `version = max(existing versions) + 1`, copying the latest existing
   * version's fields and then applying `changes`. The source version is not
   * touched — activate the draft (and supersede the prior active version)
   * as a separate, explicit step.
   *
   * Throws when no version of `planKey` exists (nothing to amend — use
   * `create` for a brand-new plan).
   */
  async createAmendment(
    planKey: string,
    changes: CommissionPlanAmendmentChanges = {},
  ): Promise<CommissionPlan> {
    const versions = await this.findByPlanKey(planKey);
    const latest = versions[0];
    if (!latest) {
      throw new Error(
        `CommissionPlanCollection.createAmendment: no versions exist for plan key '${planKey}' — create the plan first`,
      );
    }
    // Validate amended components BEFORE persisting anything, so a bad
    // amendment fails cleanly instead of leaving a malformed draft row.
    if (changes.components !== undefined) {
      validateCommissionPlanComponents(changes.components);
    }

    const draft = await this.create({
      tenantId: latest.tenantId,
      planKey,
      version: latest.version + 1,
      status: 'draft',
      name: changes.name ?? latest.name,
      description: changes.description ?? latest.description,
      currency: changes.currency ?? latest.currency,
      effectiveFrom:
        changes.effectiveFrom !== undefined
          ? changes.effectiveFrom
          : latest.effectiveFrom,
      components:
        changes.components !== undefined
          ? JSON.stringify(changes.components)
          : latest.components,
      metadata:
        changes.metadata !== undefined
          ? JSON.stringify(changes.metadata)
          : latest.metadata,
    });
    return draft;
  }
}

export default CommissionPlanCollection;
