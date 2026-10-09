import { SmrtRecipe } from '@happyvertical/smrt-core';
import {
  WebhookCursor,
  WebhookDelivery,
  WebhookDeliveryTask,
  WebhookSubscription,
} from './models.js';
/** Server-backed administration; runtime/surface declarations follow #3708. */
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
  static nav = [];
  static help = './webhooks.recipe.md';
}
