import { SmrtCollection } from '@happyvertical/smrt-core';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';

export class SubscriptionPlanCollection extends SmrtCollection<SubscriptionPlan> {
  static readonly _itemClass = SubscriptionPlan;

  async findByPlanKey(planKey: string): Promise<SubscriptionPlan | null> {
    const plans = await this.list({ where: { planKey }, limit: 1 });
    return plans[0] ?? null;
  }

  async findActive(): Promise<SubscriptionPlan[]> {
    return this.list({
      where: { status: 'active' },
      orderBy: 'sortOrder ASC',
    });
  }

  async findByStripePriceId(
    stripePriceId: string,
  ): Promise<SubscriptionPlan | null> {
    const plans = await this.list({ where: { stripePriceId }, limit: 1 });
    return plans[0] ?? null;
  }
}
