import { createHmac } from 'node:crypto';
import { requireTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  assertHmacSecret,
  sendPublicWebhook,
  type WebhookTransport,
} from './security.js';
import { WebhookStore } from './store.js';
import type { WebhookEventEnvelope } from './types.js';

export interface WebhookDispatcherOptions {
  db: DatabaseInterface;
  runtime: string;
  /** Trusted server integration seam. Default transport pins validated public DNS answers. */
  transport?: WebhookTransport;
}
const runtimes = new Map<string, WebhookDispatcher>();
export function registerWebhookRuntime(
  name: string,
  dispatcher: WebhookDispatcher,
): void {
  if (!name || runtimes.has(name))
    throw new Error('Webhook runtime already registered or invalid.');
  runtimes.set(name, dispatcher);
}
export function unregisterWebhookRuntime(name: string): void {
  runtimes.delete(name);
}

export function assertWebhookEvent(event: WebhookEventEnvelope): void {
  if (
    !event ||
    typeof event !== 'object' ||
    !event.data ||
    Array.isArray(event.data) ||
    typeof event.data !== 'object' ||
    [event.id, event.event, event.model].some(
      (v) => typeof v !== 'string' || !v || v.length > 200 || /[\r\n]/.test(v),
    ) ||
    typeof event.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    Buffer.byteLength(JSON.stringify(event)) > 262144
  )
    throw new Error('Invalid webhook event.');
}

/** Durable tenant-scoped outbound events. Receivers deduplicate x-smrt-delivery. */
export class WebhookDispatcher {
  readonly store: WebhookStore;
  private readonly transport: WebhookTransport;
  constructor(options: WebhookDispatcherOptions) {
    this.store = new WebhookStore(options.db, options.runtime);
    this.transport = options.transport ?? sendPublicWebhook;
  }
  async dispatch(event: WebhookEventEnvelope): Promise<string[]> {
    requireTenant();
    assertWebhookEvent(event);
    const ids: string[] = [];
    for (const sub of await this.store.subscriptions()) {
      if (
        sub.enabled &&
        (!sub.events.length || sub.events.includes(event.event)) &&
        (!sub.models.length || sub.models.includes(event.model))
      ) {
        ids.push(await this.store.accept(sub.id ?? '', event));
      }
    }
    return ids;
  }
  async deliver(
    deliveryId: string,
    expectedGeneration?: number,
  ): Promise<void> {
    requireTenant();
    const before = await this.store.delivery(deliveryId);
    if (
      !before ||
      (expectedGeneration !== undefined &&
        before.generation !== expectedGeneration) ||
      ['delivered', 'failed', 'cancelled'].includes(before.status)
    )
      return;
    const token = await this.store.claim(deliveryId, before.generation);
    if (!token) throw new Error('Webhook delivery is already leased.');
    const delivery = await this.store.delivery(deliveryId);
    if (!delivery) throw new Error('Webhook delivery unavailable.');
    let responseStatus: number | null = null;
    try {
      const sub = await this.store.subscription(delivery.subscriptionId);
      if (!sub?.enabled) {
        await this.store.finish(
          deliveryId,
          token,
          'cancelled',
          null,
          'Subscription disabled.',
        );
        return;
      }
      assertHmacSecret(sub.secret);
      const event = JSON.parse(delivery.payload) as WebhookEventEnvelope;
      assertWebhookEvent(event);
      const timestamp = new Date().toISOString();
      const signature = createHmac('sha256', sub.secret)
        .update(`${timestamp}.${delivery.payload}`)
        .digest('hex');
      responseStatus = await this.transport({
        url: sub.url,
        body: delivery.payload,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'smrt-webhooks/1',
          'x-smrt-event': event.event,
          'x-smrt-delivery': deliveryId,
          'x-smrt-timestamp': timestamp,
          'x-smrt-signature': `sha256=${signature}`,
        },
      });
      if (responseStatus < 200 || responseStatus >= 300)
        throw new Error('Webhook rejected.');
      await this.store.finish(
        deliveryId,
        token,
        'delivered',
        responseStatus,
        null,
      );
    } catch {
      // Never persist/rethrow endpoint errors: URLs, response bodies and secrets may be embedded.
      await this.store.finish(
        deliveryId,
        token,
        delivery.attempts >= 5 ? 'failed' : 'retrying',
        responseStatus,
        'Webhook delivery failed.',
      );
      throw new Error('Webhook delivery failed.');
    }
  }
}
export async function runWebhookDeliveryJob(
  args: Record<string, unknown>,
): Promise<void> {
  const runtime =
    typeof args.runtime === 'string' ? runtimes.get(args.runtime) : undefined;
  if (
    !runtime ||
    typeof args.deliveryId !== 'string' ||
    args.tenantId !== requireTenant().tenantId
  ) {
    throw new Error('Invalid webhook job or unavailable runtime.');
  }
  await runtime.deliver(
    args.deliveryId,
    typeof args.generation === 'number' ? args.generation : 0,
  );
}
