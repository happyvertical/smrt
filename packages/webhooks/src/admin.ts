import { requireTenant } from '@happyvertical/smrt-tenancy';
import { WebhookSubscriptionCollection } from './models.js';
import type { WebhookStore } from './store.js';
import type {
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord,
} from './types.js';
export interface WebhookAdminView {
  subscriptions: WebhookSubscriptionRecord[];
  deliveries: WebhookDeliveryRecord[];
}
/** Allowlisted projection; never spread persistence objects into a browser response. */
export function webhookAdminView(
  subscriptions: WebhookSubscriptionRecord[],
  deliveries: WebhookDeliveryRecord[],
): WebhookAdminView {
  return {
    subscriptions: subscriptions.map((s) => ({
      id: s.id,
      tenantId: s.tenantId,
      url: s.url,
      models: s.models,
      events: s.events,
      enabled: s.enabled,
    })),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      tenantId: d.tenantId,
      subscriptionId: d.subscriptionId,
      eventId: d.eventId,
      status: d.status,
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      error: d.error,
    })),
  };
}
/** Host supplies its administrator permission check and authenticated tenant context. */
export class WebhookAdminService {
  constructor(
    private readonly store: WebhookStore,
    private readonly authorize: () => Promise<boolean>,
  ) {}
  private async guard() {
    requireTenant();
    if (!(await this.authorize()))
      throw new Error('Webhook administration forbidden.');
  }
  async view(): Promise<WebhookAdminView> {
    await this.guard();
    await this.store.reconcile();
    const subscriptions = await this.store.subscriptions();
    const deliveries = await this.store.deliveries();
    return webhookAdminView(
      subscriptions.map((s) => ({ ...s, id: s.id ?? '' })),
      deliveries.map((d) => ({ ...d, id: d.id ?? '' })),
    );
  }
  async create(input: {
    url: string;
    events: string[];
    models: string[];
    secret: string;
  }): Promise<void> {
    await this.guard();
    const collection = await WebhookSubscriptionCollection.create({
      db: this.store.db,
    });
    const sub = await collection.create({
      tenantId: requireTenant().tenantId,
      url: input.url,
      events: input.events,
      models: input.models,
      secret: input.secret,
      enabled: true,
    });
    await sub.save();
  }
  async toggle(id: string, enabled: boolean): Promise<void> {
    await this.guard();
    if (typeof enabled !== 'boolean') throw new Error('Invalid enabled value.');
    const sub = await this.store.subscription(id);
    if (!sub) throw new Error('Webhook subscription not found.');
    sub.enabled = enabled;
    await sub.save();
  }
  async replay(id: string): Promise<boolean> {
    await this.guard();
    return this.store.replay(id);
  }
}
