/**
 * An in-memory Stripe REST double for the billing host tests (#4786).
 *
 * It sits behind the real `@happyvertical/accounting` Stripe provider through
 * that provider's `fetch` option, so the tests exercise the SDK's request
 * encoding and its real webhook signature verification; only the network is
 * fake. No request leaves the process.
 */
import { createHmac } from 'node:crypto';
import {
  getAccountingProvider,
  type StripeAccountingProvider,
} from '@happyvertical/accounting';

export const SECRET_KEY = 'sk_test_fake_key_do_not_leak_123456';
export const WEBHOOK_SECRET = 'whsec_test_billing_host_secret_987654';

export interface RecordedRequest {
  method: string;
  path: string;
  /** Form parameters by their flattened Stripe name, e.g. `line_items[0][price]`. */
  params: Record<string, string>;
  idempotencyKey?: string;
}

export interface FakeSubscription {
  id: string;
  customer: string;
  status: string;
  priceId: string;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
  startDate?: number;
}

export class FakeStripe {
  readonly requests: RecordedRequest[] = [];
  readonly subscriptions = new Map<string, FakeSubscription>();
  private readonly idempotent = new Map<string, unknown>();
  private failures: Array<{ method: string; path: RegExp; message: string }> =
    [];
  private counter = 0;

  /** Make the next matching request fail with `message` as Stripe's text. */
  fail(method: string, path: RegExp, message = 'injected failure'): void {
    this.failures.push({ method, path, message });
  }

  requestsTo(method: string, path: RegExp): RecordedRequest[] {
    return this.requests.filter(
      (request) => request.method === method && path.test(request.path),
    );
  }

  setSubscription(subscription: FakeSubscription): void {
    this.subscriptions.set(subscription.id, subscription);
  }

  provider(): Promise<StripeAccountingProvider> {
    return getAccountingProvider({
      type: 'stripe',
      secretKey: SECRET_KEY,
      apiBaseUrl: 'https://stripe.test',
      webhookSecret: WEBHOOK_SECRET,
      maxRetries: 1,
      fetch: this.fetch,
    }) as Promise<StripeAccountingProvider>;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const params =
      typeof init?.body === 'string'
        ? Object.fromEntries(new URLSearchParams(init.body).entries())
        : Object.fromEntries(url.searchParams.entries());
    const idempotencyKey = headers.get('Idempotency-Key') ?? undefined;
    this.requests.push({
      method,
      path: url.pathname,
      params,
      idempotencyKey,
    });

    const failure = this.failures.find(
      (entry) => entry.method === method && entry.path.test(url.pathname),
    );
    if (failure) {
      this.failures = this.failures.filter((entry) => entry !== failure);
      return json(401, { error: { message: failure.message } });
    }
    const replayKey = idempotencyKey
      ? `${method} ${url.pathname} ${idempotencyKey}`
      : undefined;
    if (replayKey && this.idempotent.has(replayKey)) {
      return json(200, this.idempotent.get(replayKey));
    }

    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      this.counter += 1;
      const id = `cs_test_${this.counter}`;
      const body = {
        id,
        object: 'checkout.session',
        url: `https://checkout.stripe.test/${id}`,
        mode: params.mode,
        customer: params.customer ?? null,
      };
      if (replayKey) this.idempotent.set(replayKey, body);
      return json(200, body);
    }
    if (method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
      this.counter += 1;
      const id = `bps_test_${this.counter}`;
      return json(200, {
        id,
        object: 'billing_portal.session',
        url: `https://billing.stripe.test/${id}`,
      });
    }
    const match = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (method === 'GET' && match) {
      const subscription = this.subscriptions.get(match[1] as string);
      if (!subscription) return json(404, { error: { message: 'no such' } });
      return json(200, subscriptionObject(subscription));
    }
    return json(404, { error: { message: `${method} ${url.pathname}` } });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A Stripe subscription object as it appears in events and API reads. */
export function subscriptionObject(
  subscription: FakeSubscription,
): Record<string, unknown> {
  return {
    id: subscription.id,
    object: 'subscription',
    customer: subscription.customer,
    status: subscription.status,
    start_date: subscription.startDate ?? subscription.periodStart,
    current_period_start: subscription.periodStart,
    current_period_end: subscription.periodEnd,
    cancel_at_period_end: subscription.cancelAtPeriodEnd ?? false,
    canceled_at: subscription.canceledAt ?? null,
    trial_end: null,
    items: { data: [{ price: { id: subscription.priceId } }] },
    metadata: {},
  };
}

export interface SignOptions {
  secret?: string;
  /** Seconds since the epoch used in the `t=` part (default: now). */
  timestamp?: number;
}

/** A signed Stripe webhook delivery of `event`. */
export function signedDelivery(
  event: Record<string, unknown>,
  options: SignOptions = {},
): { payload: string; signature: string } {
  const payload = JSON.stringify(event);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', options.secret ?? WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return { payload, signature: `t=${timestamp},v1=${digest}` };
}

export function subscriptionEvent(
  id: string,
  type: string,
  created: number,
  subscription: FakeSubscription,
): Record<string, unknown> {
  return {
    id,
    object: 'event',
    type,
    created,
    data: { object: subscriptionObject(subscription) },
  };
}

export function checkoutCompletedEvent(
  id: string,
  created: number,
  session: {
    id: string;
    customer: string;
    subscription: string;
    metadata: Record<string, string>;
    mode?: string;
    paymentStatus?: string;
  },
): Record<string, unknown> {
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    created,
    data: {
      object: {
        id: session.id,
        object: 'checkout.session',
        mode: session.mode ?? 'subscription',
        payment_status: session.paymentStatus ?? 'paid',
        customer: session.customer,
        subscription: session.subscription,
        metadata: session.metadata,
      },
    },
  };
}
