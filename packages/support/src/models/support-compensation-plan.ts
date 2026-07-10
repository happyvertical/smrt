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

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_compensation_plans',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
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
   * effective ranges) prefer the latest `effectiveFrom`.
   */
  async resolveForSpecialist(
    specialistId: string,
    at: Date = new Date(),
  ): Promise<SupportCompensationPlan | null> {
    const candidates = await this.list({
      where: { status: 'active' },
    });
    const effective = candidates.filter((plan) => plan.isEffectiveAt(at));
    const pick = (plans: SupportCompensationPlan[]) =>
      plans.sort(
        (a, b) =>
          (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0),
      )[0] ?? null;
    const specific = pick(
      effective.filter((plan) => plan.specialistId === specialistId),
    );
    if (specific) return specific;
    return pick(effective.filter((plan) => plan.specialistId === null));
  }
}

export default SupportCompensationPlan;
