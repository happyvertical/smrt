import { SmrtCollection } from '@happyvertical/smrt-core';
import { TenantSubscription } from '../models/TenantSubscription.js';
import type { Subscriber } from '../types.js';

export class TenantSubscriptionCollection extends SmrtCollection<TenantSubscription> {
  static readonly _itemClass = TenantSubscription;

  /**
   * List subscriptions whose owning tenant scope is `tenantId`. Includes both
   * `'tenant'`-kind (subscriber == owner) and `'external'`-kind (subscriber is
   * an external identity scoped under this tenant) rows.
   */
  async findByTenant(tenantId: string): Promise<TenantSubscription[]> {
    return this.list({
      where: { tenantId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Legacy single-tenant accessor: returns the current subscription where the
   * tenant IS the subscriber (`subscriberKind = 'tenant'`). External-kind rows
   * scoped under this tenant are intentionally excluded so existing callers
   * are not surprised by buyer/agent subscriptions.
   */
  async findCurrentForTenant(
    tenantId: string,
    now = new Date(),
  ): Promise<TenantSubscription | null> {
    return this.findCurrentForSubscriber({ kind: 'tenant', tenantId }, now);
  }

  /**
   * Polymorphic current-subscription accessor.
   *
   * For `'tenant'` subscribers we match rows with `subscriberKind = 'tenant'`
   * under the same `tenantId`. For `'external'` subscribers we match by
   * `(tenantId, subscriberExternalId)` with `subscriberKind = 'external'`.
   */
  async findCurrentForSubscriber(
    subscriber: Subscriber,
    now = new Date(),
  ): Promise<TenantSubscription | null> {
    const where: Record<string, unknown> = {
      tenantId: subscriber.tenantId,
      subscriberKind: subscriber.kind,
    };
    if (subscriber.kind === 'external') {
      where.subscriberExternalId = subscriber.externalId;
    }

    const subscriptions = await this.list({
      where,
      orderBy: 'created_at DESC',
    });
    return (
      subscriptions.find((subscription) => subscription.isEntitled(now)) ??
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
