import { randomUUID } from 'node:crypto';
import {
  GlobalInterceptors,
  type InterceptorContext,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { requireTenant } from '@happyvertical/smrt-tenancy';
import type { WebhookDispatcher } from './dispatcher.js';

/** Opt-in lifecycle binding. Explicit model allowlist prevents recursive/internal data publication.
 * Payloads contain record identity only; use dispatch() for authorized custom projections.
 */
export function registerWebhookModelEvents(
  dispatcher: WebhookDispatcher,
  models: readonly string[],
): () => void {
  const internal = new Set([
    'WebhookSubscription',
    'WebhookDelivery',
    'WebhookDeliveryTask',
    'WebhookCursor',
    'SmrtJob',
    'SmrtJobEvent',
    'SmrtWorker',
  ]);
  if (models.some((name) => internal.has(name.split(':').at(-1) ?? name))) {
    throw new Error(
      'Internal queue and webhook models cannot publish lifecycle webhooks.',
    );
  }
  const allowed = new Set(models);
  const pending = new WeakMap<
    InterceptorContext,
    { event: string; id: string }
  >();
  const matches = (context: InterceptorContext) =>
    allowed.has(context.qualifiedClassName ?? context.className);
  async function emit(
    instance: SmrtObject,
    context: InterceptorContext,
    event: string,
  ) {
    if (!matches(context)) return;
    const tenantId = requireTenant().tenantId;
    if ('tenantId' in instance && instance.tenantId !== tenantId)
      throw new Error('Webhook model tenant mismatch.');
    await dispatcher.dispatch({
      id: pending.get(context)?.id ?? randomUUID(),
      event,
      model: context.qualifiedClassName ?? context.className,
      occurredAt: context.timestamp.toISOString(),
      data: { id: instance.id },
    });
  }
  const interceptor = {
    name: `webhook-model-events:${randomUUID()}`,
    beforeSave(instance: SmrtObject, context: InterceptorContext) {
      if (matches(context))
        pending.set(context, {
          event: instance.isPersisted ? 'update' : 'create',
          id: randomUUID(),
        });
    },
    async afterSave(instance: SmrtObject, context: InterceptorContext) {
      await emit(instance, context, pending.get(context)?.event ?? 'update');
    },
    async afterDelete(instance: SmrtObject, context: InterceptorContext) {
      await emit(instance, context, 'delete');
    },
  };
  GlobalInterceptors.register(interceptor);
  return () => {
    GlobalInterceptors.unregister(interceptor);
  };
}
