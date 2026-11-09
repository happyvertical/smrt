/**
 * Plan lookup, price mapping and purchasability for the billing glue (#4786).
 *
 * Plans are read in a system context and then checked explicitly: a plan is
 * visible to a tenant only when it is the tenant's own or a global
 * (`tenantId: null`) plan. The provider price always comes from server
 * configuration or the plan's own binding, never from a request.
 */

import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import type { SubscriptionPlan } from '../models/SubscriptionPlan.js';

export function planVisibleToTenant(
  plan: SubscriptionPlan,
  tenantId: string,
): boolean {
  return plan.tenantId === null || plan.tenantId === tenantId;
}

function providerIsStripe(plan: SubscriptionPlan): boolean {
  return !plan.externalProvider || plan.externalProvider === 'stripe';
}

/** The provider price id a plan is sold under, or undefined when unset. */
export function priceIdForPlan(
  plan: SubscriptionPlan,
  prices: Record<string, string> | undefined,
): string | undefined {
  const configured = prices?.[plan.planKey]?.trim();
  if (configured) return configured;
  if (!providerIsStripe(plan)) return undefined;
  return (
    plan.providerPriceId?.trim() || plan.stripePriceId?.trim() || undefined
  );
}

/**
 * Whose plans may be sold and resolved from a provider price. `deny` (the
 * default) is operator plans only: a tenant that can write its own
 * `SubscriptionPlan` rows (for example through a mounted generated API) cannot
 * mint a plan, or shadow a global plan key, and buy the entitlements it wrote.
 */
export type TenantPlanPolicy = 'deny' | 'allow';

export class PlanDirectory {
  constructor(
    private readonly db: DatabaseInterface,
    private readonly prices: Record<string, string> | undefined,
    private readonly tenantPlans: TenantPlanPolicy = 'deny',
  ) {}

  private sellable(plan: SubscriptionPlan, tenantId: string): boolean {
    return this.tenantPlans === 'allow'
      ? planVisibleToTenant(plan, tenantId)
      : plan.tenantId === null;
  }

  /**
   * The plan a subscription row already points at, for status-only updates:
   * visibility only, so a row on a legacy tenant plan keeps resolving.
   */
  async findExisting(
    tenantId: string,
    planId: string,
  ): Promise<SubscriptionPlan | null> {
    return withSystemContext(async () => {
      const plan = await (await this.collection()).get(
        { id: planId },
        { cache: false },
      );
      return plan && planVisibleToTenant(plan, tenantId) ? plan : null;
    });
  }

  private collection(): Promise<SubscriptionPlanCollection> {
    return SubscriptionPlanCollection.create({ db: this.db });
  }

  /** A plan `tenantId` may buy, by key (own plan first if allowed) or by id. */
  async find(
    tenantId: string,
    ref: { planKey?: string; planId?: string },
  ): Promise<SubscriptionPlan | null> {
    return withSystemContext(async () => {
      const plans = await this.collection();
      if (ref.planId) {
        const plan = await plans.get({ id: ref.planId }, { cache: false });
        return plan && this.sellable(plan, tenantId) ? plan : null;
      }
      if (ref.planKey) {
        const own =
          this.tenantPlans === 'allow'
            ? await plans.findByPlanKey(tenantId, ref.planKey)
            : null;
        return own ?? (await plans.findByPlanKey(null, ref.planKey));
      }
      return null;
    });
  }

  /**
   * The plan a provider price id is sold as, for `tenantId`: configured
   * price map first, then plan price bindings. The tenant's own plan beats a
   * global one.
   */
  async findByPriceId(
    tenantId: string,
    priceId: string,
  ): Promise<SubscriptionPlan | null> {
    const mappedKeys = Object.entries(this.prices ?? {})
      .filter(([, price]) => price === priceId)
      .map(([planKey]) => planKey);
    return withSystemContext(async () => {
      const plans = await this.collection();
      const candidates: SubscriptionPlan[] = [];
      for (const planKey of mappedKeys) {
        const own =
          this.tenantPlans === 'allow'
            ? await plans.findByPlanKey(tenantId, planKey)
            : null;
        const global = await plans.findByPlanKey(null, planKey);
        if (own) candidates.push(own);
        if (global) candidates.push(global);
      }
      if (candidates.length === 0) {
        candidates.push(
          ...(await plans.list({ where: { providerPriceId: priceId } })),
          ...(await plans.list({ where: { stripePriceId: priceId } })),
        );
      }
      const visible = candidates
        .filter(
          (plan) => this.sellable(plan, tenantId) && providerIsStripe(plan),
        )
        .sort(
          (a, b) =>
            Number(b.tenantId === tenantId) - Number(a.tenantId === tenantId),
        );
      return visible[0] ?? null;
    });
  }
}
