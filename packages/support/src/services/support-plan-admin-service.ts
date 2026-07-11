/**
 * SupportPlanAdminService — the permission-gated write surface for
 * commercial terms: Managed Support Plans (client pricing/service terms) and
 * Support Compensation Plans (provider earning terms).
 *
 * The `support.manage-plans` split is the gate (the
 * `personas.activate-directive` idiom): the generated CRUD routes on both
 * models are read-only, so every plan write flows through here, carries an
 * accountable principal, and refuses cross-tenant acts. Plan history stays
 * safe regardless — cases snapshot plan terms at apply time and settlements
 * snapshot rates at approval time — but only holders of the split may shape
 * future terms.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  type SupportCompensationPlan,
  SupportCompensationPlanCollection,
} from '../models/support-compensation-plan.js';
import {
  type SupportPlan,
  SupportPlanCollection,
} from '../models/support-plan.js';
import {
  MANAGE_PLANS_PERMISSION,
  type SupportPrincipal,
} from '../permissions.js';

/** Thrown when a plan write is attempted without the manage-plans split. */
export class PlanAdminDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanAdminDeniedError';
  }
}

export interface PlanAdminActor {
  principal: SupportPrincipal;
}

export class SupportPlanAdminService {
  readonly plans: SupportPlanCollection;
  readonly compensationPlans: SupportCompensationPlanCollection;

  protected constructor(collections: {
    plans: SupportPlanCollection;
    compensationPlans: SupportCompensationPlanCollection;
  }) {
    this.plans = collections.plans;
    this.compensationPlans = collections.compensationPlans;
  }

  static async create(
    options: SmrtObjectOptions,
  ): Promise<SupportPlanAdminService> {
    const [plans, compensationPlans] = await Promise.all([
      SupportPlanCollection.create(options),
      SupportCompensationPlanCollection.create(options),
    ]);
    return new SupportPlanAdminService({ plans, compensationPlans });
  }

  /** Create (or overwrite via natural key) a Managed Support Plan. */
  async savePlan(
    input: PlanAdminActor & { fields: Record<string, unknown> },
  ): Promise<SupportPlan> {
    this.assertManager(input.principal, 'writing a Managed Support Plan');
    this.assertTenant(
      input.principal,
      (input.fields.tenantId as string | null | undefined) ?? null,
    );
    return this.plans.create(input.fields);
  }

  /** Update an existing Managed Support Plan's fields. */
  async updatePlan(
    planId: string,
    input: PlanAdminActor & { fields: Record<string, unknown> },
  ): Promise<SupportPlan> {
    this.assertManager(input.principal, 'updating a Managed Support Plan');
    const plan = await this.plans.get({ id: planId });
    if (!plan) {
      throw new Error(`SupportPlan not found: ${planId}`);
    }
    this.assertTenant(input.principal, plan.tenantId);
    Object.assign(plan, input.fields);
    await plan.save();
    return plan;
  }

  /** Archive a Managed Support Plan (soft retirement; history untouched). */
  async archivePlan(
    planId: string,
    input: PlanAdminActor,
  ): Promise<SupportPlan> {
    return this.updatePlan(planId, {
      principal: input.principal,
      fields: { status: 'archived' },
    });
  }

  /** Create a Support Compensation Plan (effective-dated earning terms). */
  async saveCompensationPlan(
    input: PlanAdminActor & { fields: Record<string, unknown> },
  ): Promise<SupportCompensationPlan> {
    this.assertManager(input.principal, 'writing a Support Compensation Plan');
    this.assertTenant(
      input.principal,
      (input.fields.tenantId as string | null | undefined) ?? null,
    );
    return this.compensationPlans.create(input.fields);
  }

  /** Update an existing Support Compensation Plan's fields. */
  async updateCompensationPlan(
    planId: string,
    input: PlanAdminActor & { fields: Record<string, unknown> },
  ): Promise<SupportCompensationPlan> {
    this.assertManager(input.principal, 'updating a Support Compensation Plan');
    const plan = await this.compensationPlans.get({ id: planId });
    if (!plan) {
      throw new Error(`SupportCompensationPlan not found: ${planId}`);
    }
    this.assertTenant(input.principal, plan.tenantId);
    Object.assign(plan, input.fields);
    await plan.save();
    return plan;
  }

  /** Archive a Support Compensation Plan. */
  async archiveCompensationPlan(
    planId: string,
    input: PlanAdminActor,
  ): Promise<SupportCompensationPlan> {
    return this.updateCompensationPlan(planId, {
      principal: input.principal,
      fields: { status: 'archived' },
    });
  }

  protected assertManager(
    principal: SupportPrincipal | undefined,
    act: string,
  ): void {
    if (!principal?.can(MANAGE_PLANS_PERMISSION)) {
      throw new PlanAdminDeniedError(
        `Denied ${act}: principal lacks '${MANAGE_PLANS_PERMISSION}'.`,
      );
    }
  }

  /** Cross-tenant plan writes are refused when both sides carry a tenant. */
  protected assertTenant(
    principal: SupportPrincipal,
    planTenantId: string | null,
  ): void {
    if (!principal.tenantId || !planTenantId) {
      return;
    }
    if (principal.tenantId !== planTenantId) {
      throw new PlanAdminDeniedError(
        `Denied: principal tenant '${principal.tenantId}' does not match the plan tenant '${planTenantId}'.`,
      );
    }
  }
}

export default SupportPlanAdminService;
