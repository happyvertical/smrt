/**
 * SupportCompensationPlan — the provider-facing **Support Compensation Plan**
 * (FR-32/FR-35): the effective-dated terms under which a Support Specialist
 * earns for delivered support time. Deliberately separate from
 * {@link SupportPlan} (client pricing) so margin stays measurable and client
 * terms never leak provider terms.
 *
 * Resolution: the specialist-specific plan effective at the work instant
 * wins; otherwise the tenant default (`specialistId` null) effective at that
 * instant applies.
 */

import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { parseJsonField } from '../types.js';

// Provider earning terms are written only through the
// `support.manage-plans`-gated `SupportPlanAdminService`; the generated
// surface stays read-only (see SupportPlan for the rationale).
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_compensation_plans',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'specialist_id', 'effective_from'],
})
export class SupportCompensationPlan extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Specialist this plan compensates; null = tenant default plan. */
  @foreignKey('SupportSpecialist')
  specialistId: string | null = null;

  /** Display name (inherited `name`; uniqueness comes from conflictColumns). */
  name: string = '';

  /** Hourly earning rate for delivered support time. */
  hourlyRate: number = 0.0;

  @field({ type: 'text' })
  currency: string = 'USD';

  /** Effective-dating: null bounds mean open-ended. */
  effectiveFrom: Date | null = null;

  effectiveTo: Date | null = null;

  /** `active` | `archived`. */
  @field({ type: 'text' })
  status: string = 'active';

  /** Additional agreement terms (JSON object; free-form, snapshotted). */
  @field({ type: 'text' })
  terms: string = '{}';

  getTerms(): Record<string, unknown> {
    return parseJsonField(this.terms, {});
  }

  setTerms(value: Record<string, unknown>): void {
    this.terms = JSON.stringify(value ?? {});
  }

  /** Whether the plan is effective at the given instant. */
  isEffectiveAt(at: Date = new Date()): boolean {
    if (this.status !== 'active') return false;
    if (this.effectiveFrom && at < this.effectiveFrom) return false;
    if (this.effectiveTo && at >= this.effectiveTo) return false;
    return true;
  }
}

export class SupportCompensationPlanCollection extends SmrtCollection<SupportCompensationPlan> {
  static readonly _itemClass = SupportCompensationPlan;

  /**
   * Resolve the plan compensating a specialist at a work instant:
   * specialist-specific first, then the tenant default. Ties (overlapping
   * effective ranges) prefer an exact tenant match over a global
   * (NULL-tenant) plan, then the latest `effectiveFrom`.
   *
   * Pass `options.tenantId` (the work's tenant) whenever resolution may run
   * without an ambient tenant context (system/job paths list across
   * tenants): candidates are then limited to that tenant's plans plus
   * global NULL-tenant plans, so another tenant's default can never price
   * this tenant's work.
   */
  async resolveForSpecialist(
    specialistId: string,
    at: Date = new Date(),
    options: { tenantId?: string | null } = {},
  ): Promise<SupportCompensationPlan | null> {
    const candidates = await this.list({
      where: { status: 'active' },
    });
    const tenantId = options.tenantId;
    const effective = candidates.filter(
      (plan) =>
        plan.isEffectiveAt(at) &&
        (tenantId === undefined ||
          plan.tenantId === null ||
          plan.tenantId === tenantId),
    );
    const pick = (plans: SupportCompensationPlan[]) =>
      plans.sort((a, b) => {
        if (tenantId !== undefined) {
          const aExact = a.tenantId === tenantId ? 1 : 0;
          const bExact = b.tenantId === tenantId ? 1 : 0;
          if (aExact !== bExact) return bExact - aExact;
        }
        return (
          (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0)
        );
      })[0] ?? null;
    const specific = pick(
      effective.filter((plan) => plan.specialistId === specialistId),
    );
    if (specific) return specific;
    return pick(effective.filter((plan) => plan.specialistId === null));
  }
}

export default SupportCompensationPlan;
