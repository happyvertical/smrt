import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  backgroundEligible,
  type JobExecutionContext,
} from '@happyvertical/smrt-jobs';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { assertHmacSecret, assertWebhookUrl } from './security.js';

/** Server-only subscription. Hosts authorize administration before accessing it. */
@smrt({
  tableName: '_smrt_webhook_subscriptions',
  api: false,
  cli: false,
  mcp: false,
})
@TenantScoped({ mode: 'required' })
export class WebhookSubscription extends SmrtObject {
  @tenantId() tenantId: string = '';
  @field({ type: 'text', required: true }) url: string = '';
  @field({ type: 'json' }) events: string[] = [];
  @field({ type: 'json' }) models: string[] = [];
  @field({ type: 'text', sensitive: true, required: true }) secret: string = '';
  @field({ type: 'boolean', default: true }) enabled: boolean = true;

  override async save(): Promise<this> {
    assertWebhookUrl(this.url);
    assertHmacSecret(this.secret);
    for (const values of [this.events, this.models]) {
      if (
        !Array.isArray(values) ||
        values.length > 100 ||
        values.some((v) => typeof v !== 'string' || !v || v.length > 200)
      ) {
        throw new Error('Webhook filters must be lists of nonempty names.');
      }
    }
    return super.save();
  }
}
export class WebhookSubscriptionCollection extends SmrtCollection<WebhookSubscription> {
  static readonly _itemClass = WebhookSubscription;
}

/** Durable outbox and safe outcome metadata; payload never appears in public projections. */
@smrt({
  tableName: '_smrt_webhook_deliveries',
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: '_smrt_webhook_delivery_identity',
      columns: ['tenantId', 'subscriptionId', 'eventId'],
      unique: true,
    },
  ],
})
@TenantScoped({ mode: 'required' })
export class WebhookDelivery extends SmrtObject {
  @tenantId() tenantId: string = '';
  @foreignKey(WebhookSubscription, {
    onUpdate: 'RESTRICT',
    onDelete: 'RESTRICT',
  })
  subscriptionId: string = '';
  @field({ type: 'text', required: true }) eventId: string = '';
  @field({ type: 'text', required: true, sensitive: true }) payload: string =
    '';
  @field({ type: 'text', default: 'pending' }) status: string = 'pending';
  @field({ type: 'integer', default: 0 }) generation: number = 0;
  @field({ type: 'integer', default: 0 }) attempts: number = 0;
  @field({ type: 'integer', nullable: true }) responseStatus: number | null =
    null;
  @field({ type: 'text', nullable: true }) error: string | null = null;
  @field({ type: 'text', nullable: true, sensitive: true }) leaseToken:
    | string
    | null = null;
  @field({ type: 'datetime', nullable: true }) leaseUntil: Date | null = null;
}
export class WebhookDeliveryCollection extends SmrtCollection<WebhookDelivery> {
  static readonly _itemClass = WebhookDelivery;
}

/** Jobs queue entry point; persisted arguments contain IDs only. */
@smrt({
  tableName: '_smrt_webhook_delivery_tasks',
  api: false,
  cli: false,
  mcp: false,
})
export class WebhookDeliveryTask extends SmrtObject {
  @backgroundEligible()
  async deliver(
    args: Record<string, unknown> = {},
    _context?: JobExecutionContext,
  ): Promise<void> {
    const { runWebhookDeliveryJob } = await import('./dispatcher.js');
    await runWebhookDeliveryJob(args);
  }
}

/** Tenant-bound durable cursor for replayable model change-feed publication. */
@smrt({
  tableName: '_smrt_webhook_cursors',
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: '_smrt_webhook_cursor_identity',
      columns: ['tenantId', 'runtime'],
      unique: true,
    },
  ],
})
@TenantScoped({ mode: 'required' })
export class WebhookCursor extends SmrtObject {
  @tenantId() tenantId: string = '';
  @field({ type: 'text', required: true }) runtime: string = '';
  @field({ type: 'integer', default: 0 }) position: number = 0;
}
