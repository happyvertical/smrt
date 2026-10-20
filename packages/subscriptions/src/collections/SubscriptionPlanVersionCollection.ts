import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  getTenantId,
  isSystemContext,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import { SubscriptionPlanVersion } from '../models/SubscriptionPlanVersion.js';

/**
 * Effective-dated plan versions (#4032). Reads follow the caller's tenancy;
 * a tenant caller additionally sees the versions of legacy global plans
 * (`tenantId: null`), the same bounded fallback subscriptions use for plans.
 */
export class SubscriptionPlanVersionCollection extends SmrtCollection<SubscriptionPlanVersion> {
  static readonly _itemClass = SubscriptionPlanVersion;

  /**
   * One version by id, through the caller's tenancy plus the bounded
   * fallback to legacy global plans' versions.
   */
  async findVisibleById(id: string): Promise<SubscriptionPlanVersion | null> {
    const rows = await this.withGlobalFallback((where) =>
      this.list({ where: { ...where, id }, limit: 1 }),
    );
    return rows[0] ?? null;
  }

  /** Every version of a plan, oldest first. */
  async listForPlan(planId: string): Promise<SubscriptionPlanVersion[]> {
    return this.withGlobalFallback((where) =>
      this.list({ where: { ...where, planId }, orderBy: 'version ASC' }),
    );
  }

  /**
   * The most recently published version of a plan. Pass `tenantId` to name
   * the owner explicitly (`null` for a global plan); omit it to read through
   * the caller's tenancy.
   */
  async findLatest(
    planId: string,
    tenantId?: string | null,
  ): Promise<SubscriptionPlanVersion | null> {
    const read = (where: Record<string, unknown>) =>
      this.list({
        where: { ...where, planId },
        orderBy: 'version DESC',
        limit: 1,
      });
    const rows =
      tenantId === undefined
        ? await this.withGlobalFallback(read)
        : await read({ tenantId });
    return rows[0] ?? null;
  }

  /**
   * The version of a plan in force at `at`: the latest version whose
   * `effectiveFrom` is at or before `at`. An instant before the first
   * version resolves to the first version, so subscriptions that predate
   * versioning keep the terms they were sold. Returns null only when the plan
   * has no versions.
   */
  async findInForce(
    planId: string,
    at: Date,
  ): Promise<SubscriptionPlanVersion | null> {
    const versions = await this.listForPlan(planId);
    const time = at.getTime();
    let inForce: SubscriptionPlanVersion | null = versions[0] ?? null;
    for (const version of versions) {
      if (version.effectiveFrom.getTime() <= time) inForce = version;
    }
    return inForce;
  }

  private async withGlobalFallback(
    read: (
      where: Record<string, unknown>,
    ) => Promise<SubscriptionPlanVersion[]>,
  ): Promise<SubscriptionPlanVersion[]> {
    const scoped = await read({});
    if (scoped.length > 0 || isSystemContext() || !getTenantId()) {
      return scoped;
    }
    return withSystemContext(() => read({ tenantId: null }));
  }
}
