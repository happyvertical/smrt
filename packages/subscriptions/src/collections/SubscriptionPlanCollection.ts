import { SmrtCollection } from '@happyvertical/smrt-core';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';

export class SubscriptionPlanCollection extends SmrtCollection<SubscriptionPlan> {
  static readonly _itemClass = SubscriptionPlan;

  async findByPlanKey(
    tenantId: string | null,
    planKey: string,
  ): Promise<SubscriptionPlan | null> {
    const plans = await this.list({ where: { tenantId, planKey }, limit: 1 });
    return plans[0] ?? null;
  }

  async findActive(): Promise<SubscriptionPlan[]> {
    return this.list({
      where: { status: 'active' },
      orderBy: 'sortOrder ASC',
    });
  }

  async findByProviderPriceId(
    providerPriceId: string,
  ): Promise<SubscriptionPlan | null> {
    const plans = await this.list({ where: { providerPriceId }, limit: 1 });
    return plans[0] ?? null;
  }

  /** @deprecated Provider-neutral integrations should use findByProviderPriceId. */
  async findByStripePriceId(
    stripePriceId: string,
  ): Promise<SubscriptionPlan | null> {
    const plans = await this.list({ where: { stripePriceId }, limit: 1 });
    return plans[0] ?? null;
  }
}
