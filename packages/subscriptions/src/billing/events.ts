/**
 * Normalise verified Stripe webhook payloads into the facts this module acts
 * on (#4786). Pure: no I/O, no trust decisions beyond reading shapes.
 */
import type { SubscriptionStatus } from '../types.js';
import type { BillingSubscriptionState } from './types.js';

export const SUBSCRIPTION_EVENT_TYPES = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

export const CHECKOUT_COMPLETED = 'checkout.session.completed';
export const SUBSCRIPTION_DELETED = 'customer.subscription.deleted';

/** What the provider says about one subscription at a point in time. */
export interface SubscriptionSnapshot {
  subscriptionId: string;
  customerId: string;
  status: SubscriptionStatus;
  priceId?: string;
  startedAt?: Date | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date | null;
  endedAt?: Date | null;
}

export interface CheckoutCompletedFacts {
  sessionId: string;
  mode: string | undefined;
  paymentStatus: string | undefined;
  customerId: string | undefined;
  subscriptionId: string | undefined;
  metadata: Record<string, string>;
}

type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A Stripe id that is either a string or an expanded `{ id }` object. */
export function externalId(value: unknown): string | undefined {
  return asString(value) ?? asString(asRecord(value)?.id);
}

export function stripeObject(payload: unknown): UnknownRecord | null {
  return asRecord(asRecord(asRecord(payload)?.data)?.object);
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000);
  }
  return null;
}

const STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'canceled',
  incomplete: 'incomplete',
  // An abandoned first payment never entitled anything.
  incomplete_expired: 'canceled',
  // Paused subscriptions do not entitle.
  paused: 'unpaid',
};

/** Unknown provider statuses fail closed to a non-entitling status. */
export function mapSubscriptionStatus(
  value: string | undefined,
): SubscriptionStatus {
  return (value && STATUS_MAP[value]) || 'incomplete';
}

function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const record = asRecord(value);
  if (!record) return result;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function itemList(object: UnknownRecord): UnknownRecord[] {
  const data = asRecord(object.items)?.data;
  return Array.isArray(data)
    ? data.map(asRecord).filter((item): item is UnknownRecord => item !== null)
    : [];
}

/** The first line-item price id: what the provider actually bills. */
export function subscriptionPriceId(object: UnknownRecord): string | undefined {
  for (const item of itemList(object)) {
    const price = externalId(asRecord(item.price)?.id ?? item.price);
    if (price) return price;
  }
  return undefined;
}

/**
 * Billing periods live on the subscription in older API versions and on its
 * items in newer ones; read either.
 */
function periodDate(
  object: UnknownRecord,
  key: 'current_period_start' | 'current_period_end',
): Date | null | undefined {
  if (key in object) return toDate(object[key]);
  for (const item of itemList(object)) {
    if (key in item) return toDate(item[key]);
  }
  return undefined;
}

/** Facts from a `customer.subscription.*` event object. */
export function subscriptionSnapshotFromObject(
  object: UnknownRecord,
  eventType: string,
): SubscriptionSnapshot | null {
  const subscriptionId = asString(object.id);
  const customerId = externalId(object.customer);
  if (!subscriptionId || !customerId) return null;
  return {
    subscriptionId,
    customerId,
    status:
      eventType === SUBSCRIPTION_DELETED
        ? 'canceled'
        : mapSubscriptionStatus(asString(object.status)),
    priceId: subscriptionPriceId(object),
    startedAt: toDate(object.start_date),
    currentPeriodStart: periodDate(object, 'current_period_start'),
    currentPeriodEnd: periodDate(object, 'current_period_end'),
    trialEndsAt: 'trial_end' in object ? toDate(object.trial_end) : undefined,
    cancelAtPeriodEnd:
      typeof object.cancel_at_period_end === 'boolean'
        ? object.cancel_at_period_end
        : undefined,
    canceledAt:
      'canceled_at' in object ? toDate(object.canceled_at) : undefined,
    endedAt: 'ended_at' in object ? toDate(object.ended_at) : undefined,
  };
}

/** Facts from a provider subscription read back through the SDK. */
export function subscriptionSnapshotFromState(
  state: BillingSubscriptionState,
): SubscriptionSnapshot {
  const raw = asRecord(state.raw);
  return {
    subscriptionId: state.externalId,
    customerId: state.customerExternalId,
    status: mapSubscriptionStatus(state.status),
    priceId: raw ? subscriptionPriceId(raw) : undefined,
    startedAt: raw && 'start_date' in raw ? toDate(raw.start_date) : undefined,
    currentPeriodStart:
      state.currentPeriodStart ??
      (raw ? periodDate(raw, 'current_period_start') : undefined),
    currentPeriodEnd:
      state.currentPeriodEnd ??
      (raw ? periodDate(raw, 'current_period_end') : undefined),
    trialEndsAt: state.trialEnd ?? null,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    canceledAt: state.canceledAt ?? null,
    endedAt: raw && 'ended_at' in raw ? toDate(raw.ended_at) : undefined,
  };
}

export function checkoutFactsFromObject(
  object: UnknownRecord,
): CheckoutCompletedFacts | null {
  const sessionId = asString(object.id);
  if (!sessionId) return null;
  return {
    sessionId,
    mode: asString(object.mode),
    paymentStatus: asString(object.payment_status),
    customerId: externalId(object.customer),
    subscriptionId: externalId(object.subscription),
    metadata: stringMap(object.metadata),
  };
}
