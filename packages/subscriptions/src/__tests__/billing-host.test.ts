/**
 * Billing host glue (#4786): checkout, signed idempotent webhook, portal link.
 *
 * Security review: each threat in the issue is closed by a named test in the
 * `threat:` describe blocks below. The accounting provider is the real
 * `@happyvertical/accounting` Stripe provider over an in-memory `fetch`, so
 * signature verification is the SDK's own and no request leaves the process.
 */
import type { StripeAccountingProvider } from '@happyvertical/accounting';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lockBillingKeys } from '../billing/apply.js';
import {
  METADATA_EXPIRY_KEY,
  recordCheckoutSession,
} from '../billing/checkout-sessions.js';
import {
  type BillingHost,
  BillingHostError,
  type BillingHostOptions,
  type BillingProviderPort,
  createBillingHost,
  priceEnvName,
  readBillingEnv,
} from '../billing/index.js';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import { BillingCheckoutSessionCollection } from '../models/BillingCheckoutSession.js';
import { TenantSubscription } from '../models/TenantSubscription.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';
import {
  checkoutCompletedEvent,
  FakeStripe,
  type FakeSubscription,
  SECRET_KEY,
  signedDelivery,
  subscriptionEvent,
  WEBHOOK_SECRET,
} from './helpers/fake-stripe.js';

const NORTH = '0b000000-0000-4000-8000-000000000001';
const SOUTH = '0b000000-0000-4000-8000-000000000002';
const URLS = {
  successUrl: 'https://app.example.com/billing?checkout=success',
  cancelUrl: 'https://app.example.com/billing?checkout=cancelled',
  portalReturnUrl: 'https://app.example.com/billing',
};
/** Event times are placed ahead of the clock so reads-back never outrank them. */
const BASE = Math.floor(Date.now() / 1000) + 10_000;
const DAY = 86_400;

// A StripeAccountingProvider is assignable to the structural port.
const portCheck = (provider: StripeAccountingProvider): BillingProviderPort =>
  provider;
void portCheck;

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, unknown> | undefined;
}

async function world(options: Partial<BillingHostOptions> = {}) {
  const stripe = new FakeStripe();
  const provider = await stripe.provider();
  const planCollection = await SubscriptionPlanCollection.create({
    db: { type: 'sqlite', url: ':memory:' },
  });
  const db = planCollection.db;
  const logs: LogLine[] = [];
  const logger = {
    info: (message: string, fields?: Record<string, unknown>) =>
      logs.push({ level: 'info', message, fields }),
    warn: (message: string, fields?: Record<string, unknown>) =>
      logs.push({ level: 'warn', message, fields }),
    error: (message: string, fields?: Record<string, unknown>) =>
      logs.push({ level: 'error', message, fields }),
  };

  const plan = (extra: Record<string, unknown>) =>
    withSystemContext(() => planCollection.create(extra as never));
  const free = await plan({
    planKey: 'free',
    name: 'Free',
    pricingMode: 'free',
    features: JSON.stringify(['core']),
  });
  const starter = await plan({
    planKey: 'starter',
    name: 'Starter',
    priceAmount: 900,
    features: JSON.stringify(['core', 'sync.devices']),
  });
  const pro = await plan({
    planKey: 'pro',
    name: 'Pro',
    priceAmount: 1900,
    providerPriceId: 'price_pro',
    features: JSON.stringify([
      'core',
      'sync.devices',
      'backup.vault',
      'cloud.hosted',
    ]),
  });
  const southOnly = await plan({
    tenantId: SOUTH,
    planKey: 'south_secret',
    name: 'South only',
    priceAmount: 500,
    providerPriceId: 'price_south',
    features: JSON.stringify(['south.exclusive']),
  });
  const archived = await plan({
    planKey: 'legacy',
    name: 'Legacy',
    status: 'archived',
    priceAmount: 700,
    providerPriceId: 'price_legacy',
  });
  const donate = await plan({
    planKey: 'donate',
    name: 'Donate',
    pricingMode: 'pay_what_you_can',
    minimumAmount: 100,
    suggestedAmount: 500,
    providerPriceId: 'price_donate',
  });
  const unpriced = await plan({
    planKey: 'unpriced',
    name: 'Unpriced',
    priceAmount: 1200,
  });

  const host: BillingHost = createBillingHost({
    provider,
    db,
    webhookSecret: WEBHOOK_SECRET,
    urls: URLS,
    prices: { starter: 'price_starter_cfg' },
    logger,
    ...options,
  });

  const subscriptions = await TenantSubscriptionCollection.create({ db });
  const resolver = await SubscriptionResolver.create({ db });
  const responses: unknown[] = [];

  const deliver = async (
    event: Record<string, unknown>,
    sign: { secret?: string; timestamp?: number } = {},
  ) => {
    const { payload, signature } = signedDelivery(event, sign);
    const result = await host.handleWebhook({ payload, signature });
    responses.push(result);
    return result;
  };

  const rowFor = (tenantId: string) =>
    withSystemContext(async () => {
      const rows = await subscriptions.list({
        where: { tenantId, subscriberKind: 'tenant' },
      });
      return rows[0] ?? null;
    });
  const allRows = () =>
    withSystemContext(() => subscriptions.list({ where: {} }));
  const featureKeys = (tenantId: string) =>
    withTenant({ tenantId }, async () =>
      [
        ...(await resolver.resolveTenantEntitlements(tenantId)).featureKeys,
      ].sort(),
    );

  const sub = (
    id: string,
    customer: string,
    priceId: string,
    extra: Partial<FakeSubscription> = {},
  ): FakeSubscription => ({
    id,
    customer,
    priceId,
    status: 'active',
    periodStart: BASE,
    periodEnd: BASE + 30 * DAY,
    ...extra,
  });

  /** Run real checkout, then deliver the completed event it would produce. */
  const buy = async (
    tenantId: string,
    planKey: string,
    ids: { sub: string; customer: string; event: string; created?: number },
    priceOverride?: string,
  ) => {
    const before = stripe.requests.length;
    const checkout = await host.createCheckout({ tenantId }, { planKey });
    const request = stripe.requests
      .slice(before)
      .find((entry) => entry.path === '/v1/checkout/sessions');
    const metadata = Object.fromEntries(
      Object.entries(request?.params ?? {})
        .filter(([key]) => key.startsWith('metadata['))
        .map(([key, value]) => [key.slice(9, -1), value]),
    );
    const priceId =
      priceOverride ?? request?.params['line_items[0][price]'] ?? 'price_pro';
    const subscription = sub(ids.sub, ids.customer, priceId);
    stripe.setSubscription(subscription);
    const result = await deliver(
      checkoutCompletedEvent(ids.event, ids.created ?? BASE + 1, {
        id: checkout.sessionId,
        customer: ids.customer,
        subscription: ids.sub,
        metadata,
      }),
    );
    return { checkout, result, metadata, subscription };
  };

  return {
    stripe,
    host,
    db,
    logs,
    responses,
    deliver,
    rowFor,
    allRows,
    featureKeys,
    sub,
    buy,
    plans: { free, starter, pro, southOnly, archived, donate, unpriced },
    subscriptions,
    planCollection,
  };
}

type World = Awaited<ReturnType<typeof world>>;

async function refusal(run: () => Promise<unknown>): Promise<BillingHostError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BillingHostError) return error;
    throw error;
  }
  throw new Error('expected a BillingHostError');
}

/** Nothing the module emitted may contain a credential. */
function expectNoSecrets(w: World, ...extra: unknown[]) {
  const text = JSON.stringify([w.logs, w.responses, ...extra]);
  expect(text).not.toContain(SECRET_KEY);
  expect(text).not.toContain('sk_test');
  expect(text).not.toContain(WEBHOOK_SECRET);
  expect(text).not.toContain('whsec_');
}

describe('checkout', () => {
  it('creates a hosted subscription checkout priced and routed from server state', async () => {
    const w = await world();
    const result = await w.host.createCheckout(
      { tenantId: NORTH, email: 'owner@north.example' },
      { planKey: 'pro' },
    );
    expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.test\/cs_test_/);

    const [request] = w.stripe.requestsTo('POST', /checkout\/sessions$/);
    expect(request?.params).toMatchObject({
      mode: 'subscription',
      success_url: URLS.successUrl,
      cancel_url: URLS.cancelUrl,
      customer_email: 'owner@north.example',
      client_reference_id: NORTH,
      'line_items[0][price]': 'price_pro',
      'line_items[0][quantity]': '1',
      'metadata[smrt_tenant_id]': NORTH,
      'metadata[smrt_plan_id]': String(w.plans.pro.id),
    });
    expect(request?.params['metadata[smrt_sig]']).toMatch(/^[0-9a-f]{64}$/);
    expect(request?.idempotencyKey).toMatch(/^smrt-sub-checkout:/);
  });

  it('prefers the configured price map over the plan binding', async () => {
    const w = await world();
    await w.host.createCheckout({ tenantId: NORTH }, { planKey: 'starter' });
    const [request] = w.stripe.requestsTo('POST', /checkout\/sessions$/);
    expect(request?.params['line_items[0][price]']).toBe('price_starter_cfg');
  });

  it('a repeated click inside the window reuses one provider session', async () => {
    const w = await world();
    const first = await w.host.createCheckout(
      { tenantId: NORTH },
      { planKey: 'pro' },
    );
    const second = await w.host.createCheckout(
      { tenantId: NORTH },
      { planKey: 'pro' },
    );
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('reuses the tenant billing customer once it has one', async () => {
    const w = await world();
    await w.buy(NORTH, 'pro', {
      sub: 'sub_n',
      customer: 'cus_n',
      event: 'evt_1',
    });
    await w.deliver(
      subscriptionEvent(
        'evt_cancel',
        'customer.subscription.deleted',
        BASE + 50,
        w.sub('sub_n', 'cus_n', 'price_pro', { status: 'canceled' }),
      ),
    );
    await w.host.createCheckout({ tenantId: NORTH }, { planKey: 'pro' });
    const requests = w.stripe.requestsTo('POST', /checkout\/sessions$/);
    const latest = requests[requests.length - 1];
    expect(latest?.params.customer).toBe('cus_n');
    expect(latest?.params.customer_email).toBeUndefined();
  });

  describe('threat: checkout for a plan the tenant may not buy', () => {
    it("another tenant's private plan is indistinguishable from an unknown plan", async () => {
      const w = await world({ tenantPlans: 'allow' });
      const other = await refusal(() =>
        w.host.createCheckout({ tenantId: NORTH }, { planKey: 'south_secret' }),
      );
      const unknown = await refusal(() =>
        w.host.createCheckout({ tenantId: NORTH }, { planKey: 'nope' }),
      );
      const byId = await refusal(() =>
        w.host.createCheckout(
          { tenantId: NORTH },
          { planId: String(w.plans.southOnly.id) },
        ),
      );
      expect([other.code, unknown.code, byId.code]).toEqual([
        'plan_unavailable',
        'plan_unavailable',
        'plan_unavailable',
      ]);
      expect(other.message).toBe(unknown.message);
      expect(w.stripe.requests).toHaveLength(0);
      // The owner can buy it.
      await w.host.createCheckout(
        { tenantId: SOUTH },
        { planKey: 'south_secret' },
      );
    });

    it('refuses archived, free, pay-what-you-can and unpriced plans without calling the provider', async () => {
      const w = await world();
      const codes = [];
      for (const planKey of ['legacy', 'free', 'donate', 'unpriced']) {
        codes.push(
          (
            await refusal(() =>
              w.host.createCheckout({ tenantId: NORTH }, { planKey }),
            )
          ).code,
        );
      }
      expect(codes).toEqual([
        'plan_unavailable',
        'plan_not_purchasable',
        'plan_not_purchasable',
        'price_unconfigured',
      ]);
      expect(w.stripe.requests).toHaveLength(0);
    });

    it('refuses a tenant that already has a live subscription', async () => {
      const w = await world();
      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      const before = w.stripe.requests.length;
      const error = await refusal(() =>
        w.host.createCheckout({ tenantId: NORTH }, { planKey: 'starter' }),
      );
      expect(error.code).toBe('already_subscribed');
      expect(w.stripe.requests).toHaveLength(before);
    });

    it('honours the host purchase policy', async () => {
      const w = await world({
        canPurchasePlan: ({ tenantId, plan }) =>
          !(tenantId === NORTH && plan.planKey === 'pro'),
      });
      expect(
        (
          await refusal(() =>
            w.host.createCheckout({ tenantId: NORTH }, { planKey: 'pro' }),
          )
        ).code,
      ).toBe('plan_forbidden');
      await w.host.createCheckout({ tenantId: SOUTH }, { planKey: 'pro' });
    });

    it('refuses a tenant that is not the active request tenant', async () => {
      const w = await world();
      const error = await refusal(() =>
        withTenant({ tenantId: SOUTH }, () =>
          w.host.createCheckout({ tenantId: NORTH }, { planKey: 'pro' }),
        ),
      );
      expect(error.code).toBe('tenant_mismatch');
      expect(w.stripe.requests).toHaveLength(0);
    });

    it('rejects malformed plan references', async () => {
      const w = await world();
      for (const input of [
        {},
        { planKey: 'pro', planId: 'x' },
        { planKey: 'a b' },
        { planKey: '' },
        { planKey: 'x'.repeat(200) },
      ]) {
        expect(
          (
            await refusal(() =>
              w.host.createCheckout({ tenantId: NORTH }, input),
            )
          ).code,
        ).toBe('invalid_request');
      }
      expect(
        (
          await refusal(() =>
            w.host.createCheckout({ tenantId: '' }, { planKey: 'pro' }),
          )
        ).code,
      ).toBe('invalid_request');
    });
  });

  describe('request handler', () => {
    const post = (body: unknown, type = 'application/json') =>
      new Request('https://app.example.com/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': type },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    it('ignores any tenant, price, amount or URL the client sends', async () => {
      const w = await world();
      const response = await w.host.handlers.checkout(
        post({
          planKey: 'pro',
          tenantId: SOUTH,
          priceId: 'price_evil',
          priceAmount: 1,
          successUrl: 'https://evil.example/steal',
          customer: 'cus_victim',
        }),
        { tenantId: NORTH },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const [request] = w.stripe.requestsTo('POST', /checkout\/sessions$/);
      expect(request?.params['line_items[0][price]']).toBe('price_pro');
      expect(request?.params.success_url).toBe(URLS.successUrl);
      expect(request?.params.client_reference_id).toBe(NORTH);
      expect(request?.params.customer).toBeUndefined();
      expect(JSON.stringify(request?.params)).not.toContain('evil');
    });

    it('accepts a form post and maps refusals to stable statuses', async () => {
      const w = await world();
      const ok = await w.host.handlers.checkout(
        post('planKey=pro', 'application/x-www-form-urlencoded'),
        { tenantId: NORTH },
      );
      expect(ok.status).toBe(200);
      const missing = await w.host.handlers.checkout(
        post({ planKey: 'nope' }),
        {
          tenantId: NORTH,
        },
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: 'plan_unavailable',
        message: 'That plan is not available.',
      });
    });

    it('rejects wrong methods, malformed and oversized bodies', async () => {
      const w = await world();
      const get = await w.host.handlers.checkout(
        new Request('https://app.example.com/api/billing/checkout'),
        { tenantId: NORTH },
      );
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      expect(
        (await w.host.handlers.checkout(post('{not json'), { tenantId: NORTH }))
          .status,
      ).toBe(400);
      expect(
        (await w.host.handlers.checkout(post([1]), { tenantId: NORTH })).status,
      ).toBe(400);
      expect(
        (
          await w.host.handlers.checkout(post({ planKey: 5 }), {
            tenantId: NORTH,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await w.host.handlers.checkout(
            post({ planKey: 'pro', pad: 'x'.repeat(20_000) }),
            {
              tenantId: NORTH,
            },
          )
        ).status,
      ).toBe(400);
      expect(w.stripe.requests).toHaveLength(0);
    });
  });
});

describe('customer portal', () => {
  it('opens the portal for the tenant own billing customer', async () => {
    const w = await world();
    await w.buy(NORTH, 'pro', {
      sub: 'sub_n',
      customer: 'cus_n',
      event: 'evt_1',
    });
    const link = await w.host.createPortalLink({ tenantId: NORTH });
    expect(link.url).toMatch(/^https:\/\/billing\.stripe\.test\//);
    const [request] = w.stripe.requestsTo('POST', /billing_portal\/sessions$/);
    expect(request?.params).toMatchObject({
      customer: 'cus_n',
      return_url: URLS.portalReturnUrl,
    });
  });

  describe('threat: portal link for the wrong customer', () => {
    it("never uses another tenant's customer or a client-named customer", async () => {
      const w = await world();
      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      await w.buy(SOUTH, 'pro', {
        sub: 'sub_s',
        customer: 'cus_s',
        event: 'evt_2',
      });

      const response = await w.host.handlers.portal(
        new Request(
          'https://app.example.com/api/billing/portal?customer=cus_s',
          {
            method: 'POST',
            body: JSON.stringify({ customer: 'cus_s', tenantId: SOUTH }),
            headers: { 'content-type': 'application/json' },
          },
        ),
        { tenantId: NORTH },
      );
      expect(response.status).toBe(200);
      const requests = w.stripe.requestsTo('POST', /billing_portal\/sessions$/);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.params.customer).toBe('cus_n');
    });

    it('refuses a tenant with no billing customer even when others have one', async () => {
      const w = await world();
      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      const error = await refusal(() =>
        w.host.createPortalLink({ tenantId: SOUTH }),
      );
      expect(error.code).toBe('no_billing_account');
      expect(w.stripe.requestsTo('POST', /billing_portal/)).toHaveLength(0);
    });

    it('refuses a tenant that is not the active request tenant', async () => {
      const w = await world();
      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      const error = await refusal(() =>
        withTenant({ tenantId: SOUTH }, () =>
          w.host.createPortalLink({ tenantId: NORTH }),
        ),
      );
      expect(error.code).toBe('tenant_mismatch');
      expect(w.stripe.requestsTo('POST', /billing_portal/)).toHaveLength(0);
    });

    it('does not accept a tenant row that only looks linked by a free plan', async () => {
      const w = await world();
      await withSystemContext(() =>
        w.subscriptions.create({
          tenantId: NORTH,
          planId: String(w.plans.free.id),
          status: 'active',
        } as never),
      );
      expect(
        (await refusal(() => w.host.createPortalLink({ tenantId: NORTH })))
          .code,
      ).toBe('no_billing_account');
    });
  });

  it('maps a provider failure to a fixed message with no provider text', async () => {
    const w = await world();
    await w.buy(NORTH, 'pro', {
      sub: 'sub_n',
      customer: 'cus_n',
      event: 'evt_1',
    });
    w.stripe.fail(
      'POST',
      /billing_portal/,
      `Invalid API Key provided: ${SECRET_KEY}`,
    );
    const response = await w.host.handlers.portal(
      new Request('https://app.example.com/api/billing/portal'),
      { tenantId: NORTH },
    );
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('sk_');
    expect(JSON.parse(text)).toEqual({
      error: 'provider_error',
      message: 'The billing provider could not complete the request.',
    });
    expectNoSecrets(w);
  });
});

describe('webhook', () => {
  describe('threat: forged or unsigned webhook', () => {
    it('rejects a delivery signed with the wrong secret and changes nothing', async () => {
      const w = await world();
      const event = checkoutCompletedEvent('evt_forged', BASE, {
        id: 'cs_x',
        customer: 'cus_x',
        subscription: 'sub_x',
        metadata: {},
      });
      const result = await w.deliver(event, { secret: 'whsec_attacker_guess' });
      expect(result).toEqual({
        status: 400,
        body: { received: false, error: 'invalid_signature' },
      });
      expect(await w.allRows()).toHaveLength(0);
      expect(w.stripe.requests).toHaveLength(0);
    });

    it('rejects a missing, empty, malformed or tampered signature', async () => {
      const w = await world();
      const { payload, signature } = signedDelivery(
        subscriptionEvent(
          'evt_1',
          'customer.subscription.updated',
          BASE,
          w.sub('sub_1', 'cus_1', 'price_pro'),
        ),
      );
      const tampered = payload.replace('price_pro', 'price_free');
      for (const [body, header] of [
        [payload, null],
        [payload, ''],
        [payload, 'garbage'],
        [payload, 't=abc,v1=deadbeef'],
        [payload, `t=${Math.floor(Date.now() / 1000)}`],
        [payload, signature.replace(/v1=.*/, `v1=${'0'.repeat(64)}`)],
        [tampered, signature],
      ] as const) {
        const result = await w.host.handleWebhook({
          payload: body,
          signature: header,
        });
        expect(result.status).toBe(400);
        expect(result.body.error).toBe('invalid_signature');
      }
    });

    it('fails closed through the fetch handler: no secret in the response, 400 not 5xx', async () => {
      const w = await world();
      const response = await w.host.handlers.webhook(
        new Request('https://app.example.com/api/billing/webhook', {
          method: 'POST',
          body: '{"id":"evt_1","type":"customer.subscription.updated"}',
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        received: false,
        error: 'invalid_signature',
      });
    });

    it('only accepts POST and bounded bodies', async () => {
      const w = await world({ maxWebhookBodyBytes: 200 });
      const get = await w.host.handlers.webhook(
        new Request('https://app.example.com/api/billing/webhook'),
      );
      expect(get.status).toBe(405);
      const big = signedDelivery({
        id: 'evt_big',
        type: 'x',
        created: BASE,
        pad: 'y'.repeat(500),
      });
      const response = await w.host.handlers.webhook(
        new Request('https://app.example.com/api/billing/webhook', {
          method: 'POST',
          headers: { 'stripe-signature': big.signature },
          body: big.payload,
        }),
      );
      expect(response.status).toBe(413);
    });

    it('stops reading a chunked body that has no length once it is over the cap', async () => {
      const w = await world({ maxWebhookBodyBytes: 200 });
      const chunk = new TextEncoder().encode('z'.repeat(150));
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const response = await w.host.handlers.webhook(
        new Request('https://app.example.com/api/billing/webhook', {
          method: 'POST',
          body,
          duplex: 'half',
        } as RequestInit),
      );
      expect(response.status).toBe(413);
    });

    it('refuses to start without a webhook secret or with a bad configuration', async () => {
      const w = await world();
      const base = {
        provider: await w.stripe.provider(),
        db: w.db,
        urls: URLS,
      };
      expect(() => createBillingHost({ ...base, webhookSecret: '' })).toThrow(
        /webhook signing secret/,
      );
      expect(() =>
        createBillingHost({
          ...base,
          webhookSecret: 'whsec_x',
          webhookToleranceSeconds: 100_000,
        }),
      ).toThrow(/tolerance/);
      expect(() =>
        createBillingHost({
          ...base,
          webhookSecret: 'whsec_x',
          urls: { ...URLS, successUrl: 'http://app.example.com/ok' },
        }),
      ).toThrow(/https/);
      expect(() =>
        createBillingHost({
          ...base,
          db: {} as never,
          webhookSecret: 'whsec_x',
        }),
      ).toThrow(/transaction/);
    });
  });

  describe('threat: stale timestamp replay', () => {
    it('refuses a header with two timestamps so the SDK and this check cannot disagree', async () => {
      const w = await world();
      const old = Math.floor(Date.now() / 1000) - 3600;
      const event = subscriptionEvent(
        'evt_two_t',
        'customer.subscription.updated',
        BASE,
        w.sub('sub_1', 'cus_1', 'price_pro'),
      );
      const { payload, signature } = signedDelivery(event, { timestamp: old });
      // A fresh-looking first `t` in front of a genuinely old signed one.
      const forgedHeader = `t=${Math.floor(Date.now() / 1000)},${signature}`;
      const result = await w.host.handleWebhook({
        payload,
        signature: forgedHeader,
      });
      expect(result.status).toBe(400);
      expect(
        w.logs.some((l) => l.fields?.reason === 'malformed_signature'),
      ).toBe(true);
    });

    it('rejects a correctly signed delivery older than the tolerance', async () => {
      const w = await world();
      const event = subscriptionEvent(
        'evt_old',
        'customer.subscription.updated',
        BASE,
        w.sub('sub_1', 'cus_1', 'price_pro'),
      );
      const old = Math.floor(Date.now() / 1000) - 3600;
      const result = await w.deliver(event, { timestamp: old });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_signature');
      expect(
        w.logs.some((l) => l.fields?.reason === 'timestamp_outside_tolerance'),
      ).toBe(true);
    });

    it('rejects a delivery dated in the future', async () => {
      const w = await world();
      const event = subscriptionEvent(
        'evt_future',
        'customer.subscription.updated',
        BASE,
        w.sub('sub_1', 'cus_1', 'price_pro'),
      );
      const result = await w.deliver(event, {
        timestamp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(result.status).toBe(400);
    });

    it('enforces its own tolerance even when the provider is more permissive', async () => {
      const w = await world({ webhookToleranceSeconds: 60 });
      const event = subscriptionEvent(
        'evt_edge',
        'customer.subscription.updated',
        BASE,
        w.sub('sub_1', 'cus_1', 'price_pro'),
      );
      // Inside the SDK's 300s window, outside this host's 60s.
      const result = await w.deliver(event, {
        timestamp: Math.floor(Date.now() / 1000) - 120,
      });
      expect(result.status).toBe(400);
      expect(
        w.logs.some((l) => l.fields?.reason === 'timestamp_outside_tolerance'),
      ).toBe(true);
    });

    it('a captured delivery cannot be replayed after the tolerance passes', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const w = await world();
        const { subscription } = await w.buy(NORTH, 'pro', {
          sub: 'sub_n',
          customer: 'cus_n',
          event: 'evt_1',
        });
        const captured = signedDelivery(
          subscriptionEvent(
            'evt_captured',
            'customer.subscription.updated',
            BASE + 5,
            {
              ...subscription,
              status: 'past_due',
            },
          ),
        );
        vi.setSystemTime(Date.now() + 10 * 60 * 1000);
        const result = await w.host.handleWebhook(captured);
        expect(result.status).toBe(400);
        expect((await w.rowFor(NORTH))?.status).toBe('active');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('subscribing: checkout.session.completed', () => {
    it('links the tenant and flips feature keys within the one webhook', async () => {
      const w = await world();
      expect(await w.featureKeys(NORTH)).toEqual([]);
      const { result } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      expect(result).toEqual({
        status: 200,
        body: { received: true, outcome: 'applied' },
      });
      const row = await w.rowFor(NORTH);
      expect(row).toMatchObject({
        planId: String(w.plans.pro.id),
        status: 'active',
        externalProvider: 'stripe',
        stripeCustomerId: 'cus_n',
        stripeSubscriptionId: 'sub_n',
      });
      expect(row?.currentPeriodEnd?.getTime()).toBe((BASE + 30 * DAY) * 1000);
      expect(await w.featureKeys(NORTH)).toEqual([
        'backup.vault',
        'cloud.hosted',
        'core',
        'sync.devices',
      ]);
      // The other tenant is untouched.
      expect(await w.featureKeys(SOUTH)).toEqual([]);
    });

    it('replaces the tenant free-plan row instead of adding a second one', async () => {
      const w = await world();
      await withSystemContext(() =>
        w.subscriptions.create({
          tenantId: NORTH,
          planId: String(w.plans.free.id),
          status: 'active',
        } as never),
      );
      expect(await w.featureKeys(NORTH)).toEqual(['core']);
      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      expect(await w.allRows()).toHaveLength(1);
      expect((await w.featureKeys(NORTH)).includes('backup.vault')).toBe(true);
    });

    it('ignores a checkout whose billed price is not the one it was created for', async () => {
      const w = await world();
      // Signed for the starter price, but the subscription bills price_pro.
      await w.buy(
        NORTH,
        'starter',
        { sub: 'sub_n', customer: 'cus_n', event: 'evt_1' },
        'price_pro',
      );
      expect(await w.rowFor(NORTH)).toBeNull();
      expect(
        w.logs.some((l) => l.message === 'billing.checkout.binding_mismatch'),
      ).toBe(true);
    });

    it('records an incomplete first payment as non-entitling', async () => {
      const w = await world();
      const before = w.stripe.requests.length;
      const checkout = await w.host.createCheckout(
        { tenantId: NORTH },
        { planKey: 'pro' },
      );
      const metadata = Object.fromEntries(
        Object.entries(w.stripe.requests[before]?.params ?? {})
          .filter(([key]) => key.startsWith('metadata['))
          .map(([key, value]) => [key.slice(9, -1), value]),
      );
      w.stripe.setSubscription(
        w.sub('sub_n', 'cus_n', 'price_pro', { status: 'incomplete' }),
      );
      await w.deliver(
        checkoutCompletedEvent('evt_1', BASE + 1, {
          id: checkout.sessionId,
          customer: 'cus_n',
          subscription: 'sub_n',
          metadata,
          paymentStatus: 'unpaid',
        }),
      );
      expect((await w.rowFor(NORTH))?.status).toBe('incomplete');
      expect(await w.featureKeys(NORTH)).toEqual([]);
    });
  });

  describe('threat: forged checkout metadata (another integration on the same account)', () => {
    const forged = (w: World, metadata: Record<string, string>, id = 'evt_f') =>
      w.deliver(
        checkoutCompletedEvent(id, BASE + 1, {
          id: 'cs_f',
          customer: 'cus_f',
          subscription: 'sub_f',
          metadata,
        }),
      );

    it('ignores a session whose metadata is unsigned', async () => {
      const w = await world();
      w.stripe.setSubscription(w.sub('sub_f', 'cus_f', 'price_pro'));
      const result = await forged(w, {
        smrt_purpose: 'tenant_subscription',
        smrt_tenant_id: SOUTH,
        smrt_plan_id: String(w.plans.pro.id),
      });
      expect(result.body).toEqual({ received: true, outcome: 'ignored' });
      expect(await w.allRows()).toHaveLength(0);
      expect(w.stripe.requestsTo('GET', /subscriptions/)).toHaveLength(0);
    });

    describe('metadata secret rotation', () => {
      /** Create a checkout under `before`, return its signed metadata. */
      const sessionUnder = async (w: World) => {
        const mark = w.stripe.requests.length;
        const checkout = await w.host.createCheckout(
          { tenantId: SOUTH },
          { planKey: 'pro' },
        );
        const params =
          w.stripe.requests
            .slice(mark)
            .find((entry) => entry.path === '/v1/checkout/sessions')?.params ??
          {};
        return {
          sessionId: checkout.sessionId,
          metadata: Object.fromEntries(
            Object.entries(params)
              .filter(([key]) => key.startsWith('metadata['))
              .map(([key, value]) => [key.slice(9, -1), value]),
          ),
        };
      };
      const completed = (
        w: World,
        host: BillingHost,
        session: { sessionId: string; metadata: Record<string, string> },
      ) => {
        w.stripe.setSubscription(w.sub('sub_r', 'cus_r', 'price_pro'));
        return host.handleWebhook(
          signedDelivery(
            checkoutCompletedEvent('evt_rot', BASE + 1, {
              id: session.sessionId,
              customer: 'cus_r',
              subscription: 'sub_r',
              metadata: session.metadata,
            }),
          ),
        );
      };
      it('accepts a session signed under a retired secret that is listed, and refuses it (loudly) when not', async () => {
        // The default signing secret is the webhook secret; after it rotates
        // to a new value the retired one is listed for verification.
        const old = await world({ webhookSecret: WEBHOOK_SECRET });
        const session = await sessionUnder(old);
        const options = {
          provider: await old.stripe.provider(),
          db: old.db,
          urls: URLS,
          logger: undefined,
        };

        // Rotated, retired secret NOT listed: dropped, and an error is logged.
        const errors: string[] = [];
        const dropped = createBillingHost({
          ...options,
          webhookSecret: 'whsec_rotated_secret_value',
          logger: {
            info: () => undefined,
            warn: () => undefined,
            error: (message: string) => errors.push(message),
          },
        });
        const refused = await dropped.handleWebhook(
          signedDelivery(
            checkoutCompletedEvent('evt_rot', BASE + 1, {
              id: session.sessionId,
              customer: 'cus_r',
              subscription: 'sub_r',
              metadata: session.metadata,
            }),
            { secret: 'whsec_rotated_secret_value' },
          ),
        );
        expect(refused.body.outcome).toBe('ignored');
        expect(errors).toContain('billing.webhook.checkout_signature_invalid');
        expect(await old.allRows()).toHaveLength(0);

        // Rotated, retired secret listed (padded, as an env value might be):
        // the same paid session links the tenant.
        old.stripe.setSubscription(old.sub('sub_r', 'cus_r', 'price_pro'));
        const kept = createBillingHost({
          ...options,
          webhookSecret: ' whsec_rotated_secret_value ',
          metadataVerificationSecrets: [` ${WEBHOOK_SECRET} `],
        });
        const accepted = await kept.handleWebhook(
          signedDelivery(
            checkoutCompletedEvent('evt_rot2', BASE + 2, {
              id: session.sessionId,
              customer: 'cus_r',
              subscription: 'sub_r',
              metadata: session.metadata,
            }),
            { secret: 'whsec_rotated_secret_value' },
          ),
        );
        expect(accepted.body.outcome).toBe('applied');
        expect(await old.featureKeys(SOUTH)).toContain('backup.vault');
      });

      it('a retired secret never signs new sessions', async () => {
        const w = await world({
          metadataSigningSecret: 'whsec_current_signing',
          metadataVerificationSecrets: [WEBHOOK_SECRET],
        });
        const session = await sessionUnder(w);
        // Verifies under the current secret, not the retired verify-only one.
        const retiredOnly = await world();
        const result = await completed(retiredOnly, retiredOnly.host, session);
        expect(result.body.outcome).toBe('ignored');
      });
    });

    it('ignores metadata signed with another secret, and tampered metadata', async () => {
      const other = await world({
        metadataSigningSecret: 'whsec_some_other_secret',
      });
      const w = await world();
      w.stripe.setSubscription(w.sub('sub_f', 'cus_f', 'price_pro'));
      // A genuine checkout from a host with a different signing secret.
      const { metadata } = await (async () => {
        const before = other.stripe.requests.length;
        await other.host.createCheckout(
          { tenantId: SOUTH },
          { planKey: 'pro' },
        );
        const params = other.stripe.requests[before]?.params ?? {};
        return {
          metadata: Object.fromEntries(
            Object.entries(params)
              .filter(([key]) => key.startsWith('metadata['))
              .map(([key, value]) => [key.slice(9, -1), value]),
          ),
        };
      })();
      expect((await forged(w, metadata, 'evt_a')).body.outcome).toBe('ignored');

      // A genuine signed session, then the tenant swapped.
      const real = await w.buy(NORTH, 'starter', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_b',
      });
      const swapped = await forged(
        w,
        { ...real.metadata, smrt_tenant_id: SOUTH },
        'evt_c',
      );
      expect(swapped.body.outcome).toBe('ignored');
      expect(await w.rowFor(SOUTH)).toBeNull();
    });

    it('ignores a non-subscription or other-purpose session without a claim', async () => {
      const w = await world();
      const result = await w.deliver(
        checkoutCompletedEvent('evt_pay', BASE, {
          id: 'cs_p',
          customer: 'cus_p',
          subscription: 'sub_p',
          metadata: { smrt_purpose: 'credit_purchase' },
          mode: 'payment',
        }),
      );
      expect(result.body.outcome).toBe('ignored');
      expect(await w.allRows()).toHaveLength(0);
    });
  });

  describe('threat: signed checkout metadata copied from a real session', () => {
    it('binds the session to the server price and the known customer', async () => {
      const w = await world();
      const first = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      await w.deliver(
        subscriptionEvent(
          'evt_end',
          'customer.subscription.deleted',
          BASE + 50,
          w.sub('sub_n', 'cus_n', 'price_pro', { status: 'canceled' }),
        ),
      );
      // The re-subscribe checkout now carries the tenant billing customer.
      const before = w.stripe.requests.length;
      await w.host.createCheckout({ tenantId: NORTH }, { planKey: 'pro' });
      const copied = Object.fromEntries(
        Object.entries(w.stripe.requests[before]?.params ?? {})
          .filter(([key]) => key.startsWith('metadata['))
          .map(([key, value]) => [key.slice(9, -1), value]),
      );
      expect(copied.smrt_customer_id).toBe('cus_n');
      expect(copied.smrt_price_id).toBe('price_pro');

      // Another integration copies that metadata onto its own session,
      // customer and subscription (same price, so only the customer differs).
      w.stripe.setSubscription(w.sub('sub_evil', 'cus_evil', 'price_pro'));
      const evil = await w.deliver(
        checkoutCompletedEvent('evt_evil', BASE + 100, {
          id: 'cs_evil',
          customer: 'cus_evil',
          subscription: 'sub_evil',
          metadata: copied,
        }),
      );
      expect(evil.body.outcome).toBe('ignored');
      expect((await w.rowFor(NORTH))?.stripeSubscriptionId).toBe('sub_n');
      expect((await w.rowFor(NORTH))?.stripeCustomerId).toBe('cus_n');

      // The same metadata on a different price is refused too.
      w.stripe.setSubscription(w.sub('sub_cheap', 'cus_n', 'price_unrelated'));
      const cheap = await w.deliver(
        checkoutCompletedEvent('evt_cheap', BASE + 101, {
          id: 'cs_cheap',
          customer: 'cus_n',
          subscription: 'sub_cheap',
          metadata: first.metadata,
        }),
      );
      expect(cheap.body.outcome).toBe('ignored');
      expect((await w.rowFor(NORTH))?.stripeSubscriptionId).toBe('sub_n');
    });
  });

  describe('threat: first-purchase metadata not bound to a host session (#4814)', () => {
    const records = (w: World) =>
      withSystemContext(async () =>
        (await BillingCheckoutSessionCollection.create({ db: w.db })).list({
          where: {},
        }),
      );
    const recordOf = async (w: World, sessionId: string) =>
      (await records(w)).find((row) => row.sessionId === sessionId);
    /** Run a real checkout and return its session id and signed metadata. */
    const open = async (w: World, tenantId: string, planKey = 'pro') => {
      const before = w.stripe.requests.length;
      const checkout = await w.host.createCheckout({ tenantId }, { planKey });
      const metadata = Object.fromEntries(
        Object.entries(w.stripe.requests[before]?.params ?? {})
          .filter(([key]) => key.startsWith('metadata['))
          .map(([key, value]) => [key.slice(9, -1), value]),
      );
      return { checkout, metadata };
    };
    const complete = (
      w: World,
      event: string,
      created: number,
      session: { id: string; sub: string; customer: string },
      metadata: Record<string, string>,
    ) => {
      w.stripe.setSubscription(
        w.sub(session.sub, session.customer, 'price_pro'),
      );
      return w.deliver(
        checkoutCompletedEvent(event, created, {
          id: session.id,
          customer: session.customer,
          subscription: session.sub,
          metadata,
        }),
      );
    };

    it('records the session it creates, with the signed expiry, once per window', async () => {
      const w = await world();
      const { checkout, metadata } = await open(w, NORTH);
      const again = await open(w, NORTH);
      expect(again.checkout.sessionId).toBe(checkout.sessionId);
      expect(again.metadata).toEqual(metadata);
      const rows = await records(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: checkout.sessionId,
        targetTenantId: NORTH,
        status: 'pending',
      });
      expect(rows[0]?.expiresAt.getTime()).toBe(
        Number(metadata[METADATA_EXPIRY_KEY]) * 1000,
      );
    });

    it('refuses metadata copied onto a session the host never created, keeps the paid event for an operator, and links nothing', async () => {
      const w = await world();
      const { metadata } = await open(w, NORTH);
      // Valid signature, but another integration's own session and customer.
      const evil = await complete(
        w,
        'evt_evil',
        BASE + 1,
        { id: 'cs_evil', sub: 'sub_evil', customer: 'cus_evil' },
        metadata,
      );
      expect(evil.status).toBe(200);
      expect(evil.body.outcome).toBe('needs_reconciliation');
      expect(await w.rowFor(NORTH)).toBeNull();
      expect(await w.featureKeys(NORTH)).toEqual([]);
      const flagged = await recordOf(w, 'cs_evil');
      expect(flagged).toMatchObject({
        status: 'needs_reconciliation',
        reason: 'session_record_missing',
        targetTenantId: '',
      });
      expect(await w.host.listCheckoutsNeedingReconciliation()).toMatchObject([
        {
          sessionId: 'cs_evil',
          reason: 'session_record_missing',
          claimedTenantId: NORTH,
          subscriptionId: 'sub_evil',
          eventId: 'evt_evil',
        },
      ]);
      const alert = w.logs.find(
        (l) => l.message === 'billing.checkout.needs_reconciliation',
      );
      expect(alert?.level).toBe('error');
      expect(alert?.fields).toMatchObject({
        eventId: 'evt_evil',
        sessionId: 'cs_evil',
        reason: 'session_record_missing',
      });
      expectNoSecrets(w);
      // The event is claimed (not discarded and not retried); a redelivery
      // is a duplicate no-op.
      const redelivery = await w.deliver(
        checkoutCompletedEvent('evt_evil', BASE + 1, {
          id: 'cs_evil',
          customer: 'cus_evil',
          subscription: 'sub_evil',
          metadata,
        }),
      );
      expect(redelivery.body.outcome).toBe('duplicate');
      expect(await w.rowFor(NORTH)).toBeNull();
    });

    it('happy path: the recorded session links the tenant once and is then completed', async () => {
      const w = await world();
      const bought = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      expect(bought.result.body.outcome).toBe('applied');
      expect((await w.rowFor(NORTH))?.stripeCustomerId).toBe('cus_n');
      expect(await w.featureKeys(NORTH)).toContain('backup.vault');
      const row = await recordOf(w, bought.checkout.sessionId);
      expect(row?.status).toBe('completed');
      expect(row?.completedAt).toBeTruthy();
    });

    it('a completed session is single use: a second completion neither relinks nor flags', async () => {
      const w = await world();
      const first = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      const again = await complete(
        w,
        'evt_again',
        BASE + 500,
        { id: first.checkout.sessionId, sub: 'sub_2', customer: 'cus_2' },
        first.metadata,
      );
      expect(again.body).toMatchObject({
        outcome: 'ignored',
      });
      const row = await w.rowFor(NORTH);
      expect(row?.stripeSubscriptionId).toBe('sub_n');
      expect(row?.stripeCustomerId).toBe('cus_n');
      expect((await recordOf(w, first.checkout.sessionId))?.status).toBe(
        'completed',
      );
      expect(await w.host.listCheckoutsNeedingReconciliation()).toEqual([]);
      expect(
        w.logs.some(
          (l) =>
            l.message === 'billing.checkout.not_relinked' &&
            l.fields?.reason === 'session_already_completed',
        ),
      ).toBe(true);
    });

    it('refuses a completion dated after the signed expiry, whatever the delivery time', async () => {
      const w = await world();
      const { checkout, metadata } = await open(w, NORTH);
      const exp = Number(metadata[METADATA_EXPIRY_KEY]);
      const late = await complete(
        w,
        'evt_late',
        exp + 10,
        { id: checkout.sessionId, sub: 'sub_n', customer: 'cus_n' },
        metadata,
      );
      expect(late.body.outcome).toBe('needs_reconciliation');
      expect(await w.rowFor(NORTH)).toBeNull();
      expect((await recordOf(w, checkout.sessionId))?.reason).toBe(
        'session_expired',
      );
      // An expiry edited into the metadata breaks the signature instead.
      const other = await open(w, SOUTH);
      const tampered = await complete(
        w,
        'evt_tamper',
        BASE + 1,
        { id: other.checkout.sessionId, sub: 'sub_s', customer: 'cus_s' },
        { ...other.metadata, smrt_exp: String(exp + 10 * DAY) },
      );
      expect(tampered.body.outcome).toBe('ignored');
      expect(await w.rowFor(SOUTH)).toBeNull();
    });

    it('a payment completed before the expiry still links when the webhook is retried late', async () => {
      const w = await world();
      const { checkout, metadata } = await open(w, NORTH);
      // Event time is in time; only the retry is late (the signature
      // tolerance is on the delivery, not the event).
      const result = await complete(
        w,
        'evt_ok',
        Number(metadata[METADATA_EXPIRY_KEY]) - 60,
        { id: checkout.sessionId, sub: 'sub_n', customer: 'cus_n' },
        metadata,
      );
      expect(result.body.outcome).toBe('applied');
    });

    it('refuses a session recorded for another tenant than the signed metadata names', async () => {
      const w = await world();
      const north = await open(w, NORTH);
      const south = await open(w, SOUTH);
      const result = await complete(
        w,
        'evt_x',
        BASE + 1,
        { id: south.checkout.sessionId, sub: 'sub_n', customer: 'cus_n' },
        north.metadata,
      );
      expect(result.body.outcome).toBe('needs_reconciliation');
      expect(await w.rowFor(NORTH)).toBeNull();
      expect(await w.rowFor(SOUTH)).toBeNull();
      expect((await recordOf(w, south.checkout.sessionId))?.reason).toBe(
        'session_record_mismatch',
      );
    });

    it('a lost record is reconciled by an operator, once, on purpose', async () => {
      const w = await world();
      const { checkout, metadata } = await open(w, NORTH);
      await withSystemContext(async () => {
        const sessions = await BillingCheckoutSessionCollection.create({
          db: w.db,
        });
        await (await sessions.get({ sessionId: checkout.sessionId }))?.delete();
      });
      const paid = await complete(
        w,
        'evt_lost',
        BASE + 1,
        { id: checkout.sessionId, sub: 'sub_n', customer: 'cus_n' },
        metadata,
      );
      expect(paid.body.outcome).toBe('needs_reconciliation');
      expect(await w.rowFor(NORTH)).toBeNull();

      const input = {
        sessionId: checkout.sessionId,
        tenantId: NORTH,
        operatorId: 'operator-1',
      };
      // Bad input and unknown sessions are refused before anything is read.
      expect(
        (
          await refusal(() =>
            w.host.reconcileCheckout({ ...input, operatorId: '' }),
          )
        ).code,
      ).toBe('invalid_request');
      expect(
        (
          await refusal(() =>
            w.host.reconcileCheckout({ ...input, sessionId: 'cs_unknown' }),
          )
        ).code,
      ).toBe('checkout_not_reconcilable');

      expect(await w.host.reconcileCheckout(input)).toEqual({
        outcome: 'applied',
      });
      const row = await w.rowFor(NORTH);
      expect(row).toMatchObject({
        stripeSubscriptionId: 'sub_n',
        stripeCustomerId: 'cus_n',
        stripeCheckoutSessionId: checkout.sessionId,
      });
      expect(await w.featureKeys(NORTH)).toContain('backup.vault');
      expect(await w.host.listCheckoutsNeedingReconciliation()).toEqual([]);
      const audit = w.logs.find(
        (l) => l.message === 'billing.checkout.reconciled',
      );
      expect(audit?.fields).toMatchObject({
        sessionId: checkout.sessionId,
        tenantId: NORTH,
        operatorId: 'operator-1',
      });
      expectNoSecrets(w);
      // Single use: a second reconcile is refused.
      expect((await refusal(() => w.host.reconcileCheckout(input))).code).toBe(
        'checkout_not_reconcilable',
      );
    });

    it('reconcile re-reads the provider and refuses a subscription that changed customer', async () => {
      const w = await world();
      const { metadata } = await open(w, NORTH);
      await complete(
        w,
        'evt_evil',
        BASE + 1,
        { id: 'cs_evil', sub: 'sub_evil', customer: 'cus_evil' },
        metadata,
      );
      w.stripe.setSubscription(w.sub('sub_evil', 'cus_other', 'price_pro'));
      const result = await w.host.reconcileCheckout({
        sessionId: 'cs_evil',
        tenantId: NORTH,
        operatorId: 'operator-1',
      });
      expect(result).toEqual({
        outcome: 'ignored',
        reason: 'checkout_subscription_mismatch',
      });
      expect(await w.rowFor(NORTH)).toBeNull();
      expect((await recordOf(w, 'cs_evil'))?.status).toBe(
        'needs_reconciliation',
      );
    });
  });

  describe('threat: a tenant that writes its own plan rows', () => {
    it('cannot sell itself entitlements it defined by reusing a price or shadowing a plan key', async () => {
      const w = await world();
      const create = (extra: Record<string, unknown>) =>
        withSystemContext(() => w.planCollection.create(extra as never));
      // Trigger A: its own plan bound to the cheapest global plan price.
      const ultimate = await create({
        tenantId: NORTH,
        planKey: 'ultimate',
        name: 'Ultimate',
        priceAmount: 1,
        providerPriceId: 'price_starter_cfg',
        features: JSON.stringify(['core', 'north.everything']),
      });
      // Trigger B: its own plan shadowing the global `pro` key.
      await create({
        tenantId: NORTH,
        planKey: 'pro',
        name: 'North pro',
        priceAmount: 1900,
        providerPriceId: 'price_pro',
        features: JSON.stringify(['north.everything']),
      });
      for (const ref of [
        { planKey: 'ultimate' },
        { planId: String(ultimate.id) },
      ]) {
        expect(
          (await refusal(() => w.host.createCheckout({ tenantId: NORTH }, ref)))
            .code,
        ).toBe('plan_unavailable');
      }
      expect(w.stripe.requests).toHaveLength(0);

      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      expect((await w.rowFor(NORTH))?.planId).toBe(String(w.plans.pro.id));
      expect(await w.featureKeys(NORTH)).not.toContain('north.everything');

      // A price swap at the provider cannot move it onto its own plan either.
      await w.deliver(
        subscriptionEvent(
          'evt_swap',
          'customer.subscription.updated',
          BASE + 100,
          w.sub('sub_n', 'cus_n', 'price_starter_cfg'),
        ),
      );
      expect((await w.rowFor(NORTH))?.planId).toBe(String(w.plans.starter.id));
    });
  });

  describe('threat: late events after a read-back', () => {
    it('an event created before the read-back is stale even when newer than the checkout event', async () => {
      const w = await world();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
        created: nowSeconds - 50,
      });
      const late = await w.deliver(
        subscriptionEvent(
          'evt_between',
          'customer.subscription.updated',
          nowSeconds - 20,
          { ...subscription, status: 'past_due' },
        ),
      );
      expect(late.body.outcome).toBe('ignored');
      expect((await w.rowFor(NORTH))?.status).toBe('active');
    });
  });

  describe('threat: webhook for an unknown or another tenant customer', () => {
    it('ignores subscription events for a subscription no tenant owns', async () => {
      const w = await world();
      const result = await w.deliver(
        subscriptionEvent(
          'evt_x',
          'customer.subscription.updated',
          BASE,
          w.sub('sub_stranger', 'cus_stranger', 'price_pro'),
        ),
      );
      expect(result.body).toEqual({ received: true, outcome: 'ignored' });
      expect(await w.allRows()).toHaveLength(0);
      expect(
        w.logs.some((l) => l.fields?.reason === 'unlinked_subscription'),
      ).toBe(true);
    });

    it('a signed checkout cannot take over a subscription or customer another tenant owns', async () => {
      const w = await world();
      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      const before = await w.rowFor(NORTH);

      // SOUTH completes a genuine checkout but the provider reports NORTH's ids.
      const southCheckout = await w.buy(SOUTH, 'starter', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_2',
      });
      expect(southCheckout.result.body).toEqual({
        received: true,
        outcome: 'ignored',
      });
      expect(w.logs.some((l) => l.fields?.reason === 'tenant_mismatch')).toBe(
        true,
      );
      expect(await w.rowFor(SOUTH)).toBeNull();
      const after = await w.rowFor(NORTH);
      expect(after?.planId).toBe(before?.planId);
      expect(after?.stripeSubscriptionId).toBe('sub_n');
    });

    it('ignores an event whose customer does not match the subscription link', async () => {
      const w = await world();
      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      const result = await w.deliver(
        subscriptionEvent(
          'evt_2',
          'customer.subscription.deleted',
          BASE + 100,
          w.sub('sub_n', 'cus_other', 'price_pro', { status: 'canceled' }),
        ),
      );
      expect(result.body.outcome).toBe('ignored');
      expect((await w.rowFor(NORTH))?.status).toBe('active');
      expect(w.logs.some((l) => l.fields?.reason === 'customer_mismatch')).toBe(
        true,
      );
    });

    it('a second checkout cannot double-book a tenant that is already subscribed', async () => {
      const w = await world();
      await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      // Two tabs: the second session was opened before the first completed.
      const request = w.stripe.requestsTo('POST', /checkout\/sessions$/)[0];
      const metadata = Object.fromEntries(
        Object.entries(request?.params ?? {})
          .filter(([key]) => key.startsWith('metadata['))
          .map(([key, value]) => [key.slice(9, -1), value]),
      );
      await recordCheckoutSession(w.db, {
        sessionId: 'cs_2',
        tenantId: NORTH,
        expiresAt: new Date(Number(metadata[METADATA_EXPIRY_KEY]) * 1000),
      });
      w.stripe.setSubscription(w.sub('sub_second', 'cus_n', 'price_pro'));
      const result = await w.deliver(
        checkoutCompletedEvent('evt_2', BASE + 200, {
          id: 'cs_2',
          customer: 'cus_n',
          subscription: 'sub_second',
          metadata,
        }),
      );
      expect(result.body.outcome).toBe('ignored');
      expect((await w.rowFor(NORTH))?.stripeSubscriptionId).toBe('sub_n');
      // The untracked paid subscription is an operator alert, not a debug line.
      const alert = w.logs.find(
        (l) => l.message === 'billing.checkout.orphaned_subscription',
      );
      expect(alert?.level).toBe('error');
      expect(alert?.fields).toMatchObject({
        tenantId: NORTH,
        subscriptionId: 'sub_second',
      });
    });
  });

  describe('threat: duplicate event delivery', () => {
    it('a replayed event is a 2xx no-op and does not touch the provider or the row', async () => {
      const w = await world();
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      const event = subscriptionEvent(
        'evt_upd',
        'customer.subscription.updated',
        BASE + 100,
        { ...subscription, status: 'past_due' },
      );
      const first = await w.deliver(event);
      expect(first.body.outcome).toBe('applied');
      const rowAfterFirst = await w.rowFor(NORTH);

      // Stripe re-signs each retry, so the replay carries a fresh timestamp.
      const second = await w.deliver(event, {
        timestamp: Math.floor(Date.now() / 1000) + 1,
      });
      expect(second).toEqual({
        status: 200,
        body: { received: true, outcome: 'duplicate' },
      });
      const rowAfterSecond = await w.rowFor(NORTH);
      expect(rowAfterSecond?.status).toBe('past_due');
      expect(String(rowAfterSecond?.updatedAt)).toBe(
        String(rowAfterFirst?.updatedAt),
      );
      expect(
        w.logs.filter((l) => l.message === 'billing.subscription.applied'),
      ).toHaveLength(2);
    });

    it('a replayed checkout completion does not read the subscription back again', async () => {
      const w = await world();
      const { subscription, checkout, metadata } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      const reads = w.stripe.requestsTo('GET', /subscriptions/).length;
      const again = await w.deliver(
        checkoutCompletedEvent('evt_1', BASE + 1, {
          id: checkout.sessionId,
          customer: 'cus_n',
          subscription: subscription.id,
          metadata,
        }),
      );
      expect(again.body.outcome).toBe('duplicate');
      expect(w.stripe.requestsTo('GET', /subscriptions/)).toHaveLength(reads);
    });

    it('concurrent deliveries of one event apply it exactly once', async () => {
      const w = await world();
      const { subscription } = await w.buy(
        NORTH,
        'starter',
        {
          sub: 'sub_n',
          customer: 'cus_n',
          event: 'evt_1',
        },
        'price_starter_cfg',
      );
      const applied = () =>
        w.logs.filter((l) => l.message === 'billing.subscription.applied')
          .length;
      const before = applied();
      const event = subscriptionEvent(
        'evt_race',
        'customer.subscription.updated',
        BASE + 100,
        {
          ...subscription,
          priceId: 'price_pro',
        },
      );
      const results = await Promise.all([
        w.deliver(event),
        w.deliver(event),
        w.deliver(event),
      ]);
      for (const result of results) {
        expect([200, 409]).toContain(result.status);
      }
      expect(applied() - before).toBe(1);
      expect(await w.allRows()).toHaveLength(1);
      expect((await w.rowFor(NORTH))?.planId).toBe(String(w.plans.pro.id));
    });

    it('survives a failed apply: the claim rolls back and the retry succeeds', async () => {
      const w = await world();
      w.stripe.fail('GET', /subscriptions/, 'upstream unavailable');
      const first = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      expect(first.result.status).toBe(500);
      expect(first.result.body).toEqual({
        received: false,
        error: 'processing_failed',
      });
      expect(await w.rowFor(NORTH)).toBeNull();

      // Failure inside the transaction rolls the claim back with the write.
      const save = vi
        .spyOn(TenantSubscription.prototype, 'save')
        .mockRejectedValueOnce(new Error('disk full'));
      const event = checkoutCompletedEvent('evt_1', BASE + 1, {
        id: first.checkout.sessionId,
        customer: 'cus_n',
        subscription: 'sub_n',
        metadata: first.metadata,
      });
      expect((await w.deliver(event)).status).toBe(500);
      expect(save).toHaveBeenCalled();
      save.mockRestore();
      expect(await w.rowFor(NORTH)).toBeNull();

      const retry = await w.deliver(event);
      expect(retry.body.outcome).toBe('applied');
      expect((await w.rowFor(NORTH))?.stripeSubscriptionId).toBe('sub_n');
    });
  });

  describe('threat: out-of-order delivery', () => {
    it('an older update delivered late does not undo a newer one', async () => {
      const w = await world();
      const { subscription } = await w.buy(
        NORTH,
        'starter',
        {
          sub: 'sub_n',
          customer: 'cus_n',
          event: 'evt_1',
        },
        'price_starter_cfg',
      );
      const newer = await w.deliver(
        subscriptionEvent(
          'evt_new',
          'customer.subscription.updated',
          BASE + 300,
          {
            ...subscription,
            priceId: 'price_pro',
          },
        ),
      );
      expect(newer.body.outcome).toBe('applied');
      const stale = await w.deliver(
        subscriptionEvent(
          'evt_old',
          'customer.subscription.updated',
          BASE + 200,
          {
            ...subscription,
            priceId: 'price_starter_cfg',
            status: 'past_due',
          },
        ),
      );
      expect(stale.body).toEqual({ received: true, outcome: 'ignored' });
      expect(w.logs.some((l) => l.fields?.reason === 'stale_event')).toBe(true);
      const row = await w.rowFor(NORTH);
      expect(row?.planId).toBe(String(w.plans.pro.id));
      expect(row?.status).toBe('active');
    });

    it('a cancellation is not resurrected by a late or same-second update', async () => {
      const w = await world();
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      await w.deliver(
        subscriptionEvent(
          'evt_del',
          'customer.subscription.deleted',
          BASE + 500,
          {
            ...subscription,
            status: 'canceled',
          },
        ),
      );
      expect((await w.rowFor(NORTH))?.status).toBe('canceled');
      expect(await w.featureKeys(NORTH)).toEqual([]);
      for (const [id, created] of [
        ['evt_late', BASE + 400],
        ['evt_tie', BASE + 500],
      ] as const) {
        const result = await w.deliver(
          subscriptionEvent(
            id,
            'customer.subscription.updated',
            created,
            subscription,
          ),
        );
        expect(result.body.outcome).toBe('ignored');
      }
      expect((await w.rowFor(NORTH))?.status).toBe('canceled');
      expect(await w.featureKeys(NORTH)).toEqual([]);
    });

    it('a subscription event that beats its checkout is not lost', async () => {
      const w = await world();
      const subscription = w.sub('sub_n', 'cus_n', 'price_pro');
      const early = await w.deliver(
        subscriptionEvent(
          'evt_created',
          'customer.subscription.created',
          BASE,
          subscription,
        ),
      );
      expect(early.body.outcome).toBe('ignored');
      const { result } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_co',
      });
      expect(result.body.outcome).toBe('applied');
      expect((await w.rowFor(NORTH))?.status).toBe('active');
      expect(await w.featureKeys(NORTH)).toContain('backup.vault');
    });

    it('a checkout completion never rewinds what the read-back already saw', async () => {
      const w = await world();
      // The subscription was cancelled before the (delayed) checkout event ran.
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_co',
        created: BASE,
      });
      const row = await w.rowFor(NORTH);
      // The read-back time, not just the event time, orders later events.
      const stripe = row?.getMetadata()?.stripe as
        | { lastEventAt: string }
        | undefined;
      const lastAt = new Date(String(stripe?.lastEventAt)).getTime();
      expect(lastAt).toBeGreaterThanOrEqual(BASE * 1000);
      const stale = await w.deliver(
        subscriptionEvent(
          'evt_before',
          'customer.subscription.updated',
          BASE - 5,
          {
            ...subscription,
            status: 'past_due',
          },
        ),
      );
      expect(stale.body.outcome).toBe('ignored');
    });
  });

  describe('plan changes made at the provider', () => {
    it('flips feature keys on an upgrade and again on a mid-period downgrade', async () => {
      const w = await world();
      const { subscription } = await w.buy(
        NORTH,
        'starter',
        {
          sub: 'sub_n',
          customer: 'cus_n',
          event: 'evt_1',
        },
        'price_starter_cfg',
      );
      expect(await w.featureKeys(NORTH)).toEqual(['core', 'sync.devices']);

      await w.deliver(
        subscriptionEvent(
          'evt_up',
          'customer.subscription.updated',
          BASE + 100,
          {
            ...subscription,
            priceId: 'price_pro',
          },
        ),
      );
      expect(await w.featureKeys(NORTH)).toEqual([
        'backup.vault',
        'cloud.hosted',
        'core',
        'sync.devices',
      ]);

      // Honoured immediately: the provider billed it and prorated the change.
      await w.deliver(
        subscriptionEvent(
          'evt_down',
          'customer.subscription.updated',
          BASE + 200,
          {
            ...subscription,
            priceId: 'price_starter_cfg',
          },
        ),
      );
      expect(await w.featureKeys(NORTH)).toEqual(['core', 'sync.devices']);
      const row = await w.rowFor(NORTH);
      expect(row?.planId).toBe(String(w.plans.starter.id));
      expect(row?.planVersionPinReason).toBe('authorized');
      expect(row?.planVersionPinNote).toBe('stripe:evt_down');
    });

    it('holds the row (no entitlement, plan kept) when an unmapped price replaces the recorded one', async () => {
      const w = await world();
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      expect((await w.featureKeys(NORTH)).includes('backup.vault')).toBe(true);
      // Status is still active: before the fix this kept every pro feature.
      await w.deliver(
        subscriptionEvent(
          'evt_odd',
          'customer.subscription.updated',
          BASE + 100,
          { ...subscription, priceId: 'price_unmapped', status: 'active' },
        ),
      );
      let row = await w.rowFor(NORTH);
      expect(row?.planId).toBe(String(w.plans.pro.id));
      expect(row?.status).toBe('incomplete');
      expect(await w.featureKeys(NORTH)).toEqual([]);
      expect(
        w.logs.some(
          (l) =>
            l.level === 'error' && l.message === 'billing.price.unmapped_held',
        ),
      ).toBe(true);

      // A later event at the same unmapped price is still held: the recorded
      // price was not overwritten by the unknown one.
      await w.deliver(
        subscriptionEvent(
          'evt_odd2',
          'customer.subscription.updated',
          BASE + 200,
          { ...subscription, priceId: 'price_unmapped', status: 'active' },
        ),
      );
      row = await w.rowFor(NORTH);
      expect(row?.status).toBe('incomplete');
      expect(await w.featureKeys(NORTH)).toEqual([]);

      // The price returning to the recorded one restores the entitlement.
      await w.deliver(
        subscriptionEvent(
          'evt_back',
          'customer.subscription.updated',
          BASE + 300,
          { ...subscription, priceId: 'price_pro', status: 'active' },
        ),
      );
      expect((await w.featureKeys(NORTH)).includes('backup.vault')).toBe(true);
    });

    it('refuses a second checkout over a held row, and never relinks a late one', async () => {
      const w = await world();
      // A session created before the hold, completed after it.
      const mark = w.stripe.requests.length;
      await w.host.createCheckout({ tenantId: NORTH }, { planKey: 'pro' });
      const earlyParams =
        w.stripe.requests
          .slice(mark)
          .find((entry) => entry.path === '/v1/checkout/sessions')?.params ??
        {};
      const earlyMetadata = Object.fromEntries(
        Object.entries(earlyParams)
          .filter(([key]) => key.startsWith('metadata['))
          .map(([key, value]) => [key.slice(9, -1), value]),
      );
      // The provider keys one session per idempotency window, so a second,
      // distinct session the host created is recorded directly.
      await recordCheckoutSession(w.db, {
        sessionId: 'cs_early',
        tenantId: NORTH,
        expiresAt: new Date(Number(earlyMetadata[METADATA_EXPIRY_KEY]) * 1000),
      });
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      await w.deliver(
        subscriptionEvent(
          'evt_odd',
          'customer.subscription.updated',
          BASE + 100,
          { ...subscription, priceId: 'price_unmapped', status: 'active' },
        ),
      );
      expect((await w.rowFor(NORTH))?.status).toBe('incomplete');

      // The tenant lost its features but the provider subscription is live:
      // buying again would leave the first one billing untracked.
      const refused = await refusal(() =>
        w.host.createCheckout({ tenantId: NORTH }, { planKey: 'pro' }),
      );
      expect(refused.code).toBe('already_subscribed');

      // A session created before the hold is not allowed to relink the row.
      w.stripe.setSubscription(w.sub('sub_2', 'cus_n', 'price_pro'));
      const late = await w.deliver(
        checkoutCompletedEvent('evt_late', BASE + 200, {
          id: 'cs_early',
          customer: 'cus_n',
          subscription: 'sub_2',
          metadata: earlyMetadata,
        }),
      );
      expect(late.body.outcome).toBe('ignored');
      expect((await w.rowFor(NORTH))?.stripeSubscriptionId).toBe('sub_n');
      expect(
        w.logs.some(
          (l) => l.message === 'billing.checkout.orphaned_subscription',
        ),
      ).toBe(true);
    });

    it('still lets a cancellation through while an unmapped price is held', async () => {
      const w = await world();
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      await w.deliver(
        subscriptionEvent(
          'evt_cancel',
          'customer.subscription.deleted',
          BASE + 100,
          { ...subscription, priceId: 'price_unmapped', status: 'canceled' },
        ),
      );
      expect((await w.rowFor(NORTH))?.status).toBe('canceled');
      // Cancelled for good: the tenant may buy again.
      const again = await w.host.createCheckout(
        { tenantId: NORTH },
        { planKey: 'pro' },
      );
      expect(again.url).toBeTruthy();
    });

    it('keeps the plan and applies the provider status when an unmapped price equals the recorded one', async () => {
      const w = await world();
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      await w.deliver(
        subscriptionEvent(
          'evt_pd',
          'customer.subscription.updated',
          BASE + 100,
          { ...subscription, status: 'past_due' },
        ),
      );
      const row = await w.rowFor(NORTH);
      expect(row?.planId).toBe(String(w.plans.pro.id));
      expect(row?.status).toBe('past_due');
    });

    it('never moves a tenant onto a plan that is not visible to it', async () => {
      const w = await world();
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      await w.deliver(
        subscriptionEvent(
          'evt_s',
          'customer.subscription.updated',
          BASE + 100,
          {
            ...subscription,
            priceId: 'price_south',
          },
        ),
      );
      expect((await w.rowFor(NORTH))?.planId).toBe(String(w.plans.pro.id));
    });

    it('cancel at period end keeps entitlements until the period ends, then cancellation ends them', async () => {
      const w = await world();
      const { subscription } = await w.buy(NORTH, 'pro', {
        sub: 'sub_n',
        customer: 'cus_n',
        event: 'evt_1',
      });
      await w.deliver(
        subscriptionEvent(
          'evt_c',
          'customer.subscription.updated',
          BASE + 100,
          {
            ...subscription,
            cancelAtPeriodEnd: true,
          },
        ),
      );
      expect((await w.rowFor(NORTH))?.cancelAtPeriodEnd).toBe(true);
      expect(await w.featureKeys(NORTH)).toContain('backup.vault');
      await w.deliver(
        subscriptionEvent(
          'evt_d',
          'customer.subscription.deleted',
          BASE + 200,
          {
            ...subscription,
            status: 'canceled',
            canceledAt: BASE + 200,
          },
        ),
      );
      expect(await w.featureKeys(NORTH)).toEqual([]);
    });
  });

  it('acknowledges event types it does not handle without storing them', async () => {
    const w = await world();
    const result = await w.deliver({
      id: 'evt_charge',
      type: 'charge.succeeded',
      created: BASE,
      data: { object: { id: 'ch_1' } },
    });
    expect(result.body).toEqual({ received: true, outcome: 'ignored' });
    expect(await w.allRows()).toHaveLength(0);
  });
});

describe('threat: secrets in logs or responses', () => {
  it('keeps credentials out of every response and log, including provider failures', async () => {
    const w = await world();
    await w.buy(NORTH, 'pro', {
      sub: 'sub_n',
      customer: 'cus_n',
      event: 'evt_1',
    });
    // A provider error that echoes the key it was called with.
    w.stripe.fail(
      'POST',
      /checkout\/sessions$/,
      `Invalid API Key provided: ${SECRET_KEY}`,
    );
    const failed = await w.host.handlers.checkout(
      new Request('https://app.example.com/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planKey: 'starter' }),
      }),
      { tenantId: SOUTH },
    );
    expect(failed.status).toBe(502);
    // A failing apply whose error text echoes the key.
    const save = vi
      .spyOn(TenantSubscription.prototype, 'save')
      .mockRejectedValueOnce(new Error(`boom ${SECRET_KEY} ${WEBHOOK_SECRET}`));
    await w.deliver(
      subscriptionEvent(
        'evt_boom',
        'customer.subscription.updated',
        BASE + 100,
        w.sub('sub_n', 'cus_n', 'price_pro', { status: 'past_due' }),
      ),
    );
    save.mockRestore();
    expect(w.logs.some((l) => l.level === 'error')).toBe(true);
    expectNoSecrets(w, await failed.clone().text());
  });

  it('exposes no secret on the host object or the env config', async () => {
    const w = await world();
    expect(JSON.stringify(w.host)).not.toContain('whsec_');
    expect(Object.values(w.host).map(String).join()).not.toContain(
      WEBHOOK_SECRET,
    );
  });
});

describe('readBillingEnv', () => {
  const env = {
    STRIPE_SECRET_KEY: SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_WEBHOOK_TOLERANCE: '120',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_PRICE_TEAM_PLUS: 'price_team',
    BILLING_SUCCESS_URL: URLS.successUrl,
    BILLING_CANCEL_URL: URLS.cancelUrl,
    BILLING_PORTAL_RETURN_URL: URLS.portalReturnUrl,
  };

  it('reads the documented variables and maps plan keys to price variables', () => {
    const config = readBillingEnv(env, {
      planKeys: ['pro', 'team-plus', 'free'],
    });
    expect(config.prices).toEqual({
      pro: 'price_pro',
      'team-plus': 'price_team',
    });
    expect(config.stripe.webhookTolerance).toBe(120);
    expect(config.stripe.secretKey).toBe(SECRET_KEY);
    expect(config.urls).toEqual(URLS);
    expect(priceEnvName('team-plus')).toBe('STRIPE_PRICE_TEAM_PLUS');
  });

  it('reads separate metadata signing secrets and keeps them out of JSON', () => {
    const config = readBillingEnv(
      {
        ...env,
        BILLING_METADATA_SECRET: 'meta_current_secret_value',
        BILLING_METADATA_PREVIOUS_SECRETS: ' meta_old_one , ,meta_old_two ',
      },
      { planKeys: [] },
    );
    expect(config.metadata.signingSecret).toBe('meta_current_secret_value');
    expect(config.metadata.previousSecrets).toEqual([
      'meta_old_one',
      'meta_old_two',
    ]);
    expect(JSON.stringify(config)).not.toContain('meta_');
    const bare = readBillingEnv(env, { planKeys: [] });
    expect(bare.metadata.signingSecret).toBeUndefined();
    expect(bare.metadata.previousSecrets).toEqual([]);
  });

  it('keeps the secrets out of JSON and enumeration', () => {
    const config = readBillingEnv(env, { planKeys: [] });
    expect(JSON.stringify(config)).not.toContain('sk_');
    expect(JSON.stringify(config)).not.toContain('whsec_');
    expect(Object.keys(config.stripe)).toEqual(['webhookTolerance']);
  });

  it('names the variable, never its value, when configuration is wrong', () => {
    const attempts: Array<[Record<string, string | undefined>, RegExp]> = [
      [
        { ...env, STRIPE_SECRET_KEY: undefined },
        /STRIPE_SECRET_KEY is required/,
      ],
      [{ ...env, STRIPE_SECRET_KEY: 'pk_live_publishable_oops' }, /secret key/],
      [
        { ...env, STRIPE_WEBHOOK_SECRET: 'not-a-secret' },
        /STRIPE_WEBHOOK_SECRET/,
      ],
      [
        { ...env, STRIPE_WEBHOOK_TOLERANCE: '99999' },
        /STRIPE_WEBHOOK_TOLERANCE/,
      ],
      [{ ...env, STRIPE_WEBHOOK_TOLERANCE: 'abc' }, /STRIPE_WEBHOOK_TOLERANCE/],
      [
        { ...env, BILLING_SUCCESS_URL: 'http://app.example.com' },
        /BILLING_SUCCESS_URL must use https/,
      ],
      [
        { ...env, BILLING_CANCEL_URL: 'https://u:p@app.example.com' },
        /credentials/,
      ],
      [{ ...env, BILLING_PORTAL_RETURN_URL: 'nope' }, /absolute URL/],
    ];
    for (const [bad, pattern] of attempts) {
      let message = '';
      try {
        readBillingEnv(bad as never, { planKeys: [] });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(pattern);
      expect(message).not.toContain('pk_live');
      expect(message).not.toContain('u:p');
    }
  });

  it('allows plain http only for a loopback development host', () => {
    const config = readBillingEnv(
      {
        ...env,
        BILLING_SUCCESS_URL:
          'http://localhost:5173/billing?s={CHECKOUT_SESSION_ID}',
        BILLING_CANCEL_URL: 'http://127.0.0.1:5173/billing',
      },
      { planKeys: [] },
    );
    expect(config.urls.successUrl).toContain('{CHECKOUT_SESSION_ID}');
  });
});

describe('PostgreSQL ordering lock', () => {
  it('takes one transaction-scoped advisory lock per key, in sorted order, only on PostgreSQL', async () => {
    const calls: Array<[string, string]> = [];
    const db = {
      query: async (sql: string, key: string) => {
        calls.push([sql, key]);
        return { rows: [] };
      },
    } as never;
    await lockBillingKeys({ db, postgres: false }, ['subscription:sub_1']);
    expect(calls).toHaveLength(0);
    await lockBillingKeys({ db, postgres: true }, [
      'tenant:t1',
      'subscription:sub_1',
      'tenant:t1',
    ]);
    expect(calls.map(([, key]) => key)).toEqual([
      'smrt-subscriptions:billing:subscription:sub_1',
      'smrt-subscriptions:billing:tenant:t1',
    ]);
    expect(calls.every(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(
      true,
    );
  });
});
