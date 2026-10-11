export type WebhookEvent = 'create' | 'update' | 'delete' | 'custom';
export interface WebhookEventEnvelope {
  id: string;
  event: WebhookEvent | string;
  model: string;
  occurredAt: string;
  data: Record<string, unknown>;
}
export interface WebhookSubscriptionRecord {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  models: string[];
  enabled: boolean;
}
export interface WebhookDeliveryRecord {
  id: string;
  tenantId: string;
  subscriptionId: string;
  eventId: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
}
