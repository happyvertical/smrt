import { SmrtCollection } from '@happyvertical/smrt-core';
import { TenantSubscription } from '../models/TenantSubscription.js';

export class TenantSubscriptionCollection extends SmrtCollection<TenantSubscription> {
  static readonly _itemClass = TenantSubscription;

  async findByTenant(tenantId: string): Promise<TenantSubscription[]> {
    return this.list({
      where: { tenantId },
      orderBy: 'created_at DESC',
    });
  }

  async findCurrentForTenant(
    tenantId: string,
  ): Promise<TenantSubscription | null> {
    const subscriptions = await this.findByTenant(tenantId);
    return (
      subscriptions.find((subscription) => subscription.isEntitled()) ??
      subscriptions[0] ??
      null
    );
  }

  async findByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<TenantSubscription | null> {
    const subscriptions = await this.list({
      where: { stripeSubscriptionId },
      limit: 1,
    });
    return subscriptions[0] ?? null;
  }
}
