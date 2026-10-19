/**
 * Processed connected-payment webhook events (#3831).
 *
 * The payments SDK only remembers event ids in memory, so a restart or a
 * second replica would act on a redelivery again. Each event id the
 * connected-payments webhook handler finishes is recorded here, once per
 * backend and environment. System table: it is written before a tenant is
 * known to be the right one and is not tenant-scoped, so it has no generated
 * surface.
 *
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/** What the handler did with an event. */
export type TenantPaymentWebhookOutcome =
  | 'settled'
  | 'already_settled'
  | 'pending'
  | 'account_updated'
  | 'stale_account_update'
  | 'application_fee'
  | 'refund_reported'
  | 'ignored';

/** One processed provider webhook event. */
@smrt({
  tableName: '_smrt_tenant_payment_webhook_events',
  indexes: [
    {
      name: '_smrt_tenant_payment_webhook_events_event',
      columns: ['backendId', 'environment', 'eventId'],
      unique: true,
    },
  ],
  api: false,
  cli: false,
  mcp: false,
})
export class TenantPaymentWebhookEvent extends SmrtObject {
  /** Payment backend adapter id, for example `stripe`. */
  @field({ required: true })
  backendId: string = '';

  /** `test` or `live`. */
  @field({ required: true })
  environment: string = '';

  /** Provider event id, for example a Stripe `evt_...`. */
  @field({ required: true })
  eventId: string = '';

  /** Provider event type. */
  eventType: string = '';

  /** Endpoint the event arrived on: `connect` or `platform`. */
  endpoint: string = '';

  /** Tenant the event's connected account resolved to. */
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  tenantId: string = '';

  /** Connected provider account the event was routed by. */
  providerAccountId: string = '';

  /** What the handler did. */
  outcome: TenantPaymentWebhookOutcome = 'ignored';

  /** PaymentIntent the event settled or referred to, when any. */
  paymentIntentId: string = '';

  /** When the handler finished the event. */
  @field({ type: 'datetime', nullable: true })
  processedAt: Date | null = null;
}

/** @internal Collection for {@link TenantPaymentWebhookEvent}; not exported. */
export class TenantPaymentWebhookEventCollection extends SmrtCollection<TenantPaymentWebhookEvent> {
  static readonly _itemClass = TenantPaymentWebhookEvent;

  /** @internal An unsaved event record, saved once processing finished. */
  async build(
    options: Parameters<SmrtCollection<TenantPaymentWebhookEvent>['create']>[0],
  ): Promise<TenantPaymentWebhookEvent> {
    return this.createUnsaved(options);
  }
}
