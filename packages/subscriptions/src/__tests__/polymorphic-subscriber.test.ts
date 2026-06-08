import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { TenantSubscription } from '../models/TenantSubscription.js';
import { TenantUsageMetric } from '../models/TenantUsageMetric.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';
import { TenantUsageMeter } from '../services/usage-meter.js';
import { normalizeSubscriber, subscriberToColumns } from '../utils.js';

/** Walk the .cause chain to find the message most likely to be ours. */
function rootCauseMessage(err: unknown): string {
  let cursor: unknown = err;
  let last = '';
  while (cursor instanceof Error) {
    last = cursor.message;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return last;
}

/** Run a thunk and return whatever it threw (or `undefined`). */
async function catchError(thunk: () => Promise<unknown>): Promise<unknown> {
  try {
    await thunk();
  } catch (error) {
    return error;
  }
  return undefined;
}

const AI_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS _smrt_ai_usage (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    operation TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    estimated_cost REAL,
    duration INTEGER NOT NULL,
    class_name TEXT,
    tenant_id TEXT,
    tags TEXT,
    created_at TIMESTAMP NOT NULL
  )
`;

describe('polymorphic subscriber — model defaults', () => {
  it('defaults TenantSubscription.subscriberKind to "tenant" with no external id', () => {
    const subscription = new TenantSubscription({
      tenantId: 'tenant-1',
      planId: 'plan-1',
    });

    expect(subscription.subscriberKind).toBe('tenant');
    expect(subscription.subscriberExternalId).toBe('');
    expect(subscription.getSubscriber()).toEqual({
      kind: 'tenant',
      tenantId: 'tenant-1',
    });
  });

  it('projects external subscriber columns onto the discriminated union', () => {
    const subscription = new TenantSubscription({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:abc123',
      planId: 'plan-license',
    });

    expect(subscription.getSubscriber()).toEqual({
      kind: 'external',
      tenantId: 'marketplace-tenant',
      externalId: 'buyer-contact:abc123',
    });
  });

  it('returns null from getSubscriber when external kind has no external id', () => {
    // Constructor now refuses this state, so simulate a malformed row arriving
    // via direct DB hydration (e.g. legacy data, manual SQL) by mutating after
    // construction. getSubscriber() must still defend against the invalid
    // combination rather than emit `{ kind: 'external', externalId: '' }`.
    const subscription = new TenantSubscription({
      tenantId: 'marketplace-tenant',
      planId: 'plan-mkt',
    });
    subscription.subscriberKind = 'external';
    subscription.subscriberExternalId = '';

    expect(subscription.getSubscriber()).toBeNull();
  });

  it('defaults TenantUsageMetric to tenant kind and exposes getSubscriber', () => {
    const metric = new TenantUsageMetric({
      tenantId: 'tenant-1',
      metricKey: 'tokens.openai.gpt5',
      quantity: 1247,
    });

    expect(metric.subscriberKind).toBe('tenant');
    expect(metric.getSubscriber()).toEqual({
      kind: 'tenant',
      tenantId: 'tenant-1',
    });
  });

  it('refuses to construct a tenant-kind TenantSubscription with a stray external id', () => {
    expect(
      () =>
        new TenantSubscription({
          tenantId: 'tenant-1',
          // subscriberKind defaults to 'tenant'; the stray external id would
          // slip past the conflict key and let multiple tenant subscriptions
          // exist for the same tenant.
          subscriberExternalId: 'buyer-contact:alice',
          planId: 'plan-pro',
        }),
    ).toThrow(
      /subscriberExternalId must be empty when subscriberKind is "tenant"/,
    );
  });

  it('refuses to construct an external-kind TenantSubscription without an external id', () => {
    expect(
      () =>
        new TenantSubscription({
          tenantId: 'marketplace-tenant',
          subscriberKind: 'external',
          planId: 'plan-mkt',
        }),
    ).toThrow(
      /subscriberKind="external" requires a non-empty subscriberExternalId/,
    );
  });

  it('refuses to construct a tenant-kind TenantUsageMetric with a stray external id', () => {
    expect(
      () =>
        new TenantUsageMetric({
          tenantId: 'tenant-1',
          subscriberExternalId: 'buyer-contact:alice',
          metricKey: 'tokens.openai.gpt5',
          quantity: 100,
        }),
    ).toThrow(
      /subscriberExternalId must be empty when subscriberKind is "tenant"/,
    );
  });

  it('refuses null subscriberExternalId with external kind from JSON/CLI input', () => {
    // Regression for the fifth-pass Codex finding: REST/CLI JSON can pass
    // `null` (or `undefined`) for subscriberExternalId. The `=== ''` check
    // wouldn't catch null, the malformed row would persist with a NULL
    // external id, and `findCurrentForSubscriber()` (which queries by string)
    // would never find it again. We refuse here so the malformed row is
    // impossible end-to-end.
    expect(
      () =>
        new TenantSubscription({
          tenantId: 'marketplace-tenant',
          subscriberKind: 'external',
          subscriberExternalId: null as unknown as string,
          planId: 'plan-mkt',
        }),
    ).toThrow(/subscriberExternalId must be a string/);

    expect(
      () =>
        new TenantUsageMetric({
          tenantId: 'marketplace-tenant',
          subscriberKind: 'external',
          subscriberExternalId: null as unknown as string,
          metricKey: 'license.downloads',
          quantity: 1,
        }),
    ).toThrow(/subscriberExternalId must be a string/);
  });

  it('refuses an invalid subscriberKind discriminator', () => {
    expect(
      () =>
        new TenantSubscription({
          tenantId: 'tenant-1',
          subscriberKind: 'foo' as unknown as 'tenant',
          subscriberExternalId: 'x',
          planId: 'plan-pro',
        }),
    ).toThrow(/subscriberKind must be "tenant" or "external"/);
  });
});

describe('polymorphic subscriber — normalizeSubscriber', () => {
  it('defaults to tenant kind when subscriberKind is omitted', () => {
    expect(normalizeSubscriber({ tenantId: 't-1' })).toEqual({
      kind: 'tenant',
      tenantId: 't-1',
    });
  });

  it('rejects external kind without a non-empty external id', () => {
    expect(() =>
      normalizeSubscriber({
        tenantId: 't-1',
        subscriberKind: 'external',
        subscriberExternalId: '',
      }),
    ).toThrow(/non-empty subscriberExternalId/);

    expect(() =>
      normalizeSubscriber({
        tenantId: 't-1',
        subscriberKind: 'external',
      }),
    ).toThrow(/non-empty subscriberExternalId/);
  });

  it('rejects an external id when subscriberKind defaults to or is explicitly tenant', () => {
    // Without an explicit kind, an external id would be silently dropped and
    // the caller's buyer-scoped usage would land as tenant-scoped usage —
    // breaking the XOR invariant invisibly. We refuse instead.
    expect(() =>
      normalizeSubscriber({
        tenantId: 't-1',
        subscriberExternalId: 'buyer-contact:alice',
      }),
    ).toThrow(/subscriberExternalId is set but subscriberKind is "tenant"/);

    expect(() =>
      normalizeSubscriber({
        tenantId: 't-1',
        subscriberKind: 'tenant',
        subscriberExternalId: 'buyer-contact:alice',
      }),
    ).toThrow(/subscriberExternalId is set but subscriberKind is "tenant"/);
  });

  it('round-trips a tenant subscriber through subscriberToColumns', () => {
    const subscriber = normalizeSubscriber({ tenantId: 't-1' });
    expect(subscriberToColumns(subscriber)).toEqual({
      tenantId: 't-1',
      subscriberKind: 'tenant',
      subscriberExternalId: '',
    });
  });

  it('round-trips an external subscriber through subscriberToColumns', () => {
    const subscriber = normalizeSubscriber({
      tenantId: 'marketplace',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:abc',
    });
    expect(subscriberToColumns(subscriber)).toEqual({
      tenantId: 'marketplace',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:abc',
    });
  });
});

describe('polymorphic subscriber — UsageMeter DB roundtrip', () => {
  let metrics: TenantUsageMetricCollection;

  beforeEach(async () => {
    metrics = await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    await metrics.db.query(AI_USAGE_DDL);
  });

  afterEach(async () => {
    await metrics.db.close?.();
  });

  it('records and summarizes tenant-kind usage (default)', async () => {
    const meter = new TenantUsageMeter(metrics);
    const window = {
      start: new Date('2026-06-01T00:00:00Z'),
      end: new Date('2026-07-01T00:00:00Z'),
    };

    await meter.record({
      tenantId: 'tenant-1',
      metricKey: 'storage.bytes',
      quantity: 1024,
      windowStart: new Date('2026-06-10T00:00:00Z'),
      windowEnd: new Date('2026-06-10T01:00:00Z'),
    });
    await meter.record({
      tenantId: 'tenant-1',
      metricKey: 'storage.bytes',
      quantity: 2048,
      windowStart: new Date('2026-06-20T00:00:00Z'),
      windowEnd: new Date('2026-06-20T01:00:00Z'),
    });

    const summary = await meter.summarize({
      tenantId: 'tenant-1',
      metricKey: 'storage.bytes',
      window,
    });

    expect(summary.quantity).toBe(3072);
    expect(summary.subscriberKind).toBeUndefined();
    expect(summary.subscriberExternalId).toBeUndefined();
  });

  it('records and summarizes external-kind usage scoped under an issuing tenant', async () => {
    const meter = new TenantUsageMeter(metrics);
    const window = {
      start: new Date('2026-06-01T00:00:00Z'),
      end: new Date('2026-07-01T00:00:00Z'),
    };

    await meter.record({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      metricKey: 'license.downloads',
      quantity: 3,
      windowStart: new Date('2026-06-10T00:00:00Z'),
      windowEnd: new Date('2026-06-10T01:00:00Z'),
    });
    await meter.record({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      metricKey: 'license.downloads',
      quantity: 2,
      windowStart: new Date('2026-06-20T00:00:00Z'),
      windowEnd: new Date('2026-06-20T01:00:00Z'),
    });
    // A different buyer scoped under the same issuing tenant; must be excluded.
    await meter.record({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:bob',
      metricKey: 'license.downloads',
      quantity: 99,
      windowStart: new Date('2026-06-15T00:00:00Z'),
      windowEnd: new Date('2026-06-15T01:00:00Z'),
    });
    // The issuing tenant's own tenant-kind usage; must be excluded from the
    // external buyer's summary.
    await meter.record({
      tenantId: 'marketplace-tenant',
      metricKey: 'license.downloads',
      quantity: 7,
      windowStart: new Date('2026-06-12T00:00:00Z'),
      windowEnd: new Date('2026-06-12T01:00:00Z'),
    });

    const summary = await meter.summarize({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      metricKey: 'license.downloads',
      window,
    });

    expect(summary).toMatchObject({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      quantity: 5,
    });
  });

  it('throws when recording external usage without an external id', async () => {
    const meter = new TenantUsageMeter(metrics);

    await expect(
      meter.record({
        tenantId: 'marketplace-tenant',
        subscriberKind: 'external',
        // No subscriberExternalId — XOR violation.
        metricKey: 'license.downloads',
        quantity: 1,
        windowStart: new Date(),
        windowEnd: new Date(),
      }),
    ).rejects.toThrow(/non-empty subscriberExternalId/);
  });

  it('refuses summarize when subscriberExternalId is passed without external kind', async () => {
    const meter = new TenantUsageMeter(metrics);
    // Regression for the second-pass Codex finding: a caller passing an
    // external id but omitting the kind would have bypassed normalization and
    // gotten tenant-wide AI totals from the short-circuit. Now both the AI
    // short-circuit and the standard summarize path refuse the same XOR
    // violation.
    await expect(
      meter.summarize({
        tenantId: 'marketplace-tenant',
        subscriberExternalId: 'buyer-contact:alice',
        metricKey: 'ai.tokens.total',
        window: {
          start: new Date('2026-06-01T00:00:00Z'),
          end: new Date('2026-07-01T00:00:00Z'),
        },
      }),
    ).rejects.toThrow(/subscriberKind is "tenant"/);
  });

  it('bypasses the ai.* short-circuit for external subscribers', async () => {
    const meter = new TenantUsageMeter(metrics);
    const window = {
      start: new Date('2026-06-01T00:00:00Z'),
      end: new Date('2026-07-01T00:00:00Z'),
    };

    // Seed `_smrt_ai_usage` for the issuing tenant — this would normally be
    // picked up by the `ai.*` short-circuit for a tenant-kind summarize.
    await metrics.db.query(
      `INSERT INTO _smrt_ai_usage
       (id, provider, model, operation, prompt_tokens, completion_tokens,
        total_tokens, estimated_cost, duration, class_name, tenant_id, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'ai-1',
      'openai',
      'gpt-5',
      'do',
      100,
      40,
      140,
      0.5,
      0,
      'TestClass',
      'marketplace-tenant',
      null,
      '2026-06-15T12:00:00.000Z',
    );
    // Record buyer-scoped ai.tokens.total separately — that's what the buyer's
    // summary should reflect (not the tenant-scoped _smrt_ai_usage rows).
    await meter.record({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      metricKey: 'ai.tokens.total',
      quantity: 12,
      windowStart: new Date('2026-06-15T12:00:00Z'),
      windowEnd: new Date('2026-06-15T13:00:00Z'),
    });

    const buyerSummary = await meter.summarize({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      metricKey: 'ai.tokens.total',
      window,
    });
    // Buyer summary draws from _smrt_tenant_usage_metrics only, not
    // _smrt_ai_usage — would be 140 if the short-circuit had fired.
    expect(buyerSummary.quantity).toBe(12);

    // Sanity: the issuing tenant's own tenant-kind summary DOES fire the
    // short-circuit and reads the _smrt_ai_usage row.
    const tenantSummary = await meter.summarize({
      tenantId: 'marketplace-tenant',
      metricKey: 'ai.tokens.total',
      window,
    });
    expect(tenantSummary.quantity).toBe(140);
  });
});

describe('polymorphic subscriber — TenantSubscriptionCollection conflict key', () => {
  let subs: TenantSubscriptionCollection;

  beforeEach(async () => {
    subs = await TenantSubscriptionCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
  });

  afterEach(async () => {
    await subs.db.close?.();
  });

  it('persists multiple distinct external subscribers under the same issuing tenant', async () => {
    // Regression for the Codex P1 review on smrt#1454 — the legacy
    // `conflictColumns: ['tenant_id']` made two external subscribers under one
    // tenant collide on the unique index. With the widened
    // (tenant_id, subscriber_kind, subscriber_external_id) key they coexist.
    const alice = await subs.create({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      planId: 'plan-mkt',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    const bob = await subs.create({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:bob',
      planId: 'plan-mkt',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });

    expect(alice.id).toBeTruthy();
    expect(bob.id).toBeTruthy();
    expect(alice.id).not.toBe(bob.id);

    const aliceFound = await subs.findCurrentForSubscriber({
      kind: 'external',
      tenantId: 'marketplace-tenant',
      externalId: 'buyer-contact:alice',
    });
    const bobFound = await subs.findCurrentForSubscriber({
      kind: 'external',
      tenantId: 'marketplace-tenant',
      externalId: 'buyer-contact:bob',
    });

    expect(aliceFound?.id).toBe(alice.id);
    expect(bobFound?.id).toBe(bob.id);
  });

  it('preserves the tenant-uniqueness invariant for tenant-kind subscriptions', async () => {
    // The widened key (tenant_id, subscriber_kind, subscriber_external_id)
    // preserves the pre-polymorphic invariant: at most one *committed*
    // tenant-kind row per tenant. Whether the second insert upserts onto the
    // first row or is rejected by the unique index, the query result must
    // contain a single row — that's the schema-level guarantee callers depend
    // on.
    await subs.create({
      tenantId: 'tenant-1',
      planId: 'plan-pro',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    // Second create may upsert or throw; either is correct under the
    // invariant. We only care that we don't end up with two distinct rows.
    try {
      await subs.create({
        tenantId: 'tenant-1',
        planId: 'plan-pro',
        status: 'canceled',
        currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
      });
    } catch {
      // Unique-constraint rejection is an acceptable outcome.
    }

    const rows = await subs.findByTenant('tenant-1');
    expect(rows.length).toBe(1);
  });

  it('rejects an update-path mutation that breaks the XOR invariant', async () => {
    // Regression for the third-pass Codex finding: SmrtCollection.update()
    // mutates an existing instance via Object.assign() and calls save()
    // directly — the constructor never re-runs. Without a save-time guard a
    // PATCH like `{ subscriberExternalId: 'buyer:alice' }` on a tenant-kind
    // row would persist a malformed conflict key. We refuse via the
    // validateBeforeSave override.
    //
    // save() wraps the underlying validation error inside `Operation failed:
    // save in TenantSubscription#<id>`, so we read the wrapped error's cause
    // chain to verify our invariant fired.
    const sub = await subs.create({
      tenantId: 'tenant-1',
      planId: 'plan-pro',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });

    sub.subscriberExternalId = 'buyer-contact:alice';
    await expect(sub.save()).rejects.toThrow();
    expect(rootCauseMessage(await catchError(() => sub.save()))).toMatch(
      /subscriberExternalId must be empty when subscriberKind is "tenant"/,
    );

    // Mutating the kind without setting an id should also fail.
    const sub2 = await subs.create({
      tenantId: 'tenant-2',
      planId: 'plan-pro',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    sub2.subscriberKind = 'external';
    await expect(sub2.save()).rejects.toThrow();
    expect(rootCauseMessage(await catchError(() => sub2.save()))).toMatch(
      /subscriberKind="external" requires a non-empty subscriberExternalId/,
    );
  });

  it('allows a tenant-kind and an external-kind subscription on the same tenant simultaneously', async () => {
    const tenantSub = await subs.create({
      tenantId: 'marketplace-tenant',
      planId: 'plan-operator',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    const buyerSub = await subs.create({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      planId: 'plan-mkt',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });

    expect(tenantSub.id).not.toBe(buyerSub.id);

    const tenantFound = await subs.findCurrentForTenant('marketplace-tenant');
    expect(tenantFound?.id).toBe(tenantSub.id);
    expect(tenantFound?.planId).toBe('plan-operator');

    const buyerFound = await subs.findCurrentForSubscriber({
      kind: 'external',
      tenantId: 'marketplace-tenant',
      externalId: 'buyer-contact:alice',
    });
    expect(buyerFound?.id).toBe(buyerSub.id);
    expect(buyerFound?.planId).toBe('plan-mkt');
  });
});

describe('polymorphic subscriber — SubscriptionResolver', () => {
  it('resolves an external subscriber via findCurrentForSubscriber', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'marketplace-month',
      name: 'Marketplace Monthly',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-mkt' });
    plan.setFeatureGrants(['marketplace:download']);
    plan.setThresholds([
      {
        metricKey: 'license.downloads',
        limit: 10,
        window: 'month',
        enforcement: 'block',
      },
    ]);

    const buyerSubscription = new TenantSubscription({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      planId: 'plan-mkt',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(buyerSubscription, { id: 'sub-buyer-alice' });

    let seenSubscriber: unknown;
    let seenUsageSubscriberKind: string | undefined;
    const resolver = new SubscriptionResolver({
      plans: {
        async get() {
          return plan;
        },
      },
      subscriptions: {
        async findCurrentForTenant() {
          throw new Error(
            'tenant lookup should not be used for external subscribers',
          );
        },
        async findCurrentForSubscriber(subscriber) {
          seenSubscriber = subscriber;
          return buyerSubscription;
        },
      },
      usage: {
        async summarize(options) {
          seenUsageSubscriberKind = options.subscriberKind;
          return {
            tenantId: options.tenantId,
            metricKey: options.metricKey,
            quantity: 4,
            windowStart: options.window.start,
            windowEnd: options.window.end,
          };
        },
      },
    });

    const resolution = await resolver.resolveEntitlements(
      {
        kind: 'external',
        tenantId: 'marketplace-tenant',
        externalId: 'buyer-contact:alice',
      },
      { now: new Date('2026-06-15T00:00:00Z') },
    );

    expect(seenSubscriber).toEqual({
      kind: 'external',
      tenantId: 'marketplace-tenant',
      externalId: 'buyer-contact:alice',
    });
    expect(seenUsageSubscriberKind).toBe('external');
    expect(resolution).toMatchObject({
      tenantId: 'marketplace-tenant',
      subscriber: {
        kind: 'external',
        tenantId: 'marketplace-tenant',
        externalId: 'buyer-contact:alice',
      },
      planKey: 'marketplace-month',
      status: 'active',
      featureKeys: ['marketplace:download'],
      allowed: true,
    });
    expect(resolution.thresholdEvaluations[0]).toMatchObject({
      state: 'ok',
      remaining: 6,
    });
  });

  it('errors loudly when external resolve has only a legacy tenant reader', async () => {
    const resolver = new SubscriptionResolver({
      plans: {
        async get() {
          return null;
        },
      },
      subscriptions: {
        async findCurrentForTenant() {
          return null;
        },
      },
      usage: {
        async summarize() {
          throw new Error('usage should not be read in this path');
        },
      },
    });

    await expect(
      resolver.resolveEntitlements({
        kind: 'external',
        tenantId: 'marketplace-tenant',
        externalId: 'buyer-contact:alice',
      }),
    ).rejects.toThrow(/findCurrentForSubscriber/);
  });

  it('keeps the legacy resolveTenantEntitlements path working unchanged', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'pro',
      name: 'Pro',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-pro' });
    plan.setFeatureGrants(['smrt:chat']);

    const subscription = new TenantSubscription({
      tenantId: 'tenant-1',
      planId: 'plan-pro',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(subscription, { id: 'sub-1' });

    const resolver = new SubscriptionResolver({
      plans: {
        async get() {
          return plan;
        },
      },
      subscriptions: {
        async findCurrentForTenant() {
          return subscription;
        },
      },
      usage: {
        async summarize() {
          throw new Error('usage should not be read without thresholds');
        },
      },
    });

    const resolution = await resolver.resolveTenantEntitlements('tenant-1', {
      now: new Date('2026-06-15T00:00:00Z'),
    });

    expect(resolution).toMatchObject({
      tenantId: 'tenant-1',
      subscriber: { kind: 'tenant', tenantId: 'tenant-1' },
      planKey: 'pro',
      featureKeys: ['smrt:chat'],
      allowed: true,
    });
  });

  it('throws with the external id in the message when external thresholds block', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'mkt',
      name: 'Mkt',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-mkt' });
    plan.setThresholds([
      {
        metricKey: 'license.downloads',
        limit: 5,
        window: 'month',
        enforcement: 'block',
      },
    ]);

    const subscription = new TenantSubscription({
      tenantId: 'marketplace-tenant',
      subscriberKind: 'external',
      subscriberExternalId: 'buyer-contact:alice',
      planId: 'plan-mkt',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(subscription, { id: 'sub-buyer-alice' });

    const resolver = new SubscriptionResolver({
      plans: {
        async get() {
          return plan;
        },
      },
      subscriptions: {
        async findCurrentForTenant() {
          return null;
        },
        async findCurrentForSubscriber() {
          return subscription;
        },
      },
      usage: {
        async summarize(options) {
          return {
            tenantId: options.tenantId,
            metricKey: options.metricKey,
            quantity: 12,
            windowStart: options.window.start,
            windowEnd: options.window.end,
          };
        },
      },
    });

    await expect(
      resolver.assertWithinThresholds(
        {
          kind: 'external',
          tenantId: 'marketplace-tenant',
          externalId: 'buyer-contact:alice',
        },
        { now: new Date('2026-06-15T00:00:00Z') },
      ),
    ).rejects.toThrow(/external:buyer-contact:alice.*license\.downloads/);
  });
});
