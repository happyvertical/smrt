import { SmrtRecipe } from '@happyvertical/smrt-core';
import {
  WebhookCursor,
  WebhookDelivery,
  WebhookDeliveryTask,
  WebhookSubscription,
} from './models.js';
/** Server-backed administration through authenticated host callbacks. */
export class WebhooksRecipe extends SmrtRecipe {
  static id = 'integrations.webhooks';
  static label = 'Outbound webhooks';
  static summary =
    'Deliver signed model events and inspect delivery attempts from a server.';
  static models = [
    WebhookSubscription,
    WebhookDelivery,
    WebhookDeliveryTask,
    WebhookCursor,
  ];
  static group = {
    id: 'integrations',
    label: 'Integrations',
    summary: 'Connect your application to external services.',
  };
  static runtime = 'server' as const;
  static surfaces = [
    {
      kind: 'settings-panel',
      export: '@happyvertical/smrt-webhooks/svelte#WebhookAdmin',
      label: 'Outbound webhooks',
    },
  ] as const;
  // Administration uses the authorized service, never generated model CRUD.
  static nav = [];
  static help = './webhooks.recipe.md';
}
