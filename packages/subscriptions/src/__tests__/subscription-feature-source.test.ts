import { getTestDatabase } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_INFERENCE_HOSTED,
  FEATURE_SYNC_DEVICES,
  FEATURE_GRANT_SOURCE_SLOT_KEY as FEATURES_SLOT_KEY,
  FeatureOverrideCollection,
  FeatureOverrideEffect,
  FeatureResolver,
  featureGateResponse,
  getFeatureGrantSource,
  setFeatureGrantSource,
} from '../../../features/src/index.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { TenantSubscription } from '../models/TenantSubscription.js';
import {
  FEATURE_GRANT_SOURCE_SLOT_KEY,
  isMissingSubscriptionTableError,
  registerSubscriptionFeatureSource,
  SubscriptionFeatureSource,
} from '../services/subscription-feature-source.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';

function plan(
  planKey: string,
  featureKeys: string[],
  extra: Partial<SubscriptionPlan> = {},
): SubscriptionPlan {
  const value = new SubscriptionPlan({ planKey, name: planKey.toUpperCase() });
  value.setFeatureGrants(featureKeys);
  Object.assign(value, { id: `plan-${planKey}`, ...extra });
  return value;
}

function fixture(
  subscriptions: Record<string, TenantSubscription>,
  plans: SubscriptionPlan[],
) {
  const findCurrentForTenant = vi.fn(
    async (tenantId: string) => subscriptions[tenantId] ?? null,
  );
  const resolver = new SubscriptionResolver({
    plans: {
      get: async ({ id }) => plans.find((p) => p.id === id) ?? null,
    },
    subscriptions: { findCurrentForTenant },
    usage: {
      summarize: async () => {
        throw new Error('flag checks must not read usage meters');
      },
    },
  });
  return { resolver, findCurrentForTenant };
}

function subscription(
  tenantId: string,
  planId: string,
  status: TenantSubscription['status'] = 'active',
): TenantSubscription {
  return new TenantSubscription({ tenantId, planId, status });
}

afterEach(() => {
  registerSubscriptionFeatureSource(undefined);
  vi.restoreAllMocks();
});

describe('SubscriptionFeatureSource (#4761)', () => {
  const cloud = plan(
    'cloud',
    [FEATURE_INFERENCE_HOSTED, FEATURE_SYNC_DEVICES],
    {
      thresholds: JSON.stringify([
        {
          metricKey: 'ai.tokens',
          limit: 1,
          window: 'month',
          enforcement: 'block',
        },
      ]),
    } as Partial<SubscriptionPlan>,
  );

  it('reports the entitled plan grants without evaluating thresholds', async () => {
    const { resolver } = fixture({ t1: subscription('t1', 'plan-cloud') }, [
      cloud,
    ]);
    const source = new SubscriptionFeatureSource({ resolver });
    await expect(source.getGrants('t1')).resolves.toEqual({
      featureKeys: [FEATURE_INFERENCE_HOSTED, FEATURE_SYNC_DEVICES],
      planId: 'plan-cloud',
      planKey: 'cloud',
    });
  });

  it('reports no grants without an entitled subscription', async () => {
    const { resolver } = fixture(
      { lapsed: subscription('lapsed', 'plan-cloud', 'past_due') },
      [cloud],
    );
    const source = new SubscriptionFeatureSource({ resolver });
    await expect(source.getGrants('none')).resolves.toBeNull();
    await expect(source.getGrants('lapsed')).resolves.toBeNull();
  });

  it('reuses one resolution per tenant for a request-scoped source', async () => {
    const { resolver, findCurrentForTenant } = fixture(
      { t1: subscription('t1', 'plan-cloud') },
      [cloud],
    );
    const spy = vi.spyOn(resolver, 'resolveFeatureGrants');
    const source = new SubscriptionFeatureSource({ resolver });
    const features = new FeatureResolver(
      {
        db: await getTestDatabase({
          classes: ['FeatureDefinition', 'FeatureOverride'],
        }),
      },
      { tenantHierarchyLoader: async () => null },
    );
    for (const key of [FEATURE_INFERENCE_HOSTED, FEATURE_SYNC_DEVICES]) {
      await expect(
        features.isEnabled(key, { tenantId: 't1', grantSource: source }),
      ).resolves.toBe(true);
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(findCurrentForTenant).toHaveBeenCalledTimes(1);

    const shared = new SubscriptionFeatureSource({ resolver, memoize: false });
    await shared.getGrants('t1');
    await shared.getGrants('t1');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed lookup', async () => {
    const { resolver } = fixture({ t1: subscription('t1', 'plan-cloud') }, [
      cloud,
    ]);
    const spy = vi
      .spyOn(resolver, 'resolveFeatureGrants')
      .mockRejectedValueOnce(new Error('connection reset'));
    const source = new SubscriptionFeatureSource({ resolver });
    await expect(source.getGrants('t1')).rejects.toThrow('connection reset');
    await expect(source.getGrants('t1')).resolves.toMatchObject({
      planKey: 'cloud',
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('names the first active plan that grants a key', async () => {
    const { resolver } = fixture({}, []);
    const basic = plan('basic', ['notes.share']);
    const source = new SubscriptionFeatureSource({
      resolver,
      plans: { findActive: async () => [basic, cloud] },
    });
    await expect(
      source.findGrantingPlan(FEATURE_INFERENCE_HOSTED, 't1'),
    ).resolves.toEqual({
      planKey: 'cloud',
      planId: 'plan-cloud',
      name: 'CLOUD',
    });
    await expect(
      source.findGrantingPlan('plugins.remote', 't1'),
    ).resolves.toBeNull();
    await expect(
      new SubscriptionFeatureSource({ resolver }).findGrantingPlan(
        FEATURE_INFERENCE_HOSTED,
        't1',
      ),
    ).resolves.toBeNull();
  });

  it('plugs into smrt-features: grant, overrides, fall-through and gate responses', async () => {
    expect(FEATURE_GRANT_SOURCE_SLOT_KEY).toBe(FEATURES_SLOT_KEY);
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    const { resolver } = fixture(
      {
        t1: subscription('t1', 'plan-cloud'),
        t2: subscription('t2', 'plan-cloud'),
      },
      [cloud],
    );
    const source = new SubscriptionFeatureSource({
      resolver,
      plans: { findActive: async () => [cloud] },
      memoize: false,
    });
    registerSubscriptionFeatureSource(source);
    expect(getFeatureGrantSource()).toBe(source);

    const overrides = await (FeatureOverrideCollection as any).create({ db });
    await overrides.setTenantOverride(
      FEATURE_SYNC_DEVICES,
      't2',
      FeatureOverrideEffect.DISABLE,
    );
    const features = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null },
    );

    await expect(
      features.isEnabled(FEATURE_INFERENCE_HOSTED, { tenantId: 't1' }),
    ).resolves.toBe(true);
    await expect(
      features.isEnabled(FEATURE_SYNC_DEVICES, { tenantId: 't2' }),
    ).resolves.toBe(false);
    await expect(
      features.isEnabled('plugins.remote', { tenantId: 't1' }),
    ).resolves.toBe(false);

    const denied = await featureGateResponse(FEATURE_INFERENCE_HOSTED, {
      resolver: features,
      tenantId: 'free',
    });
    expect(denied?.status).toBe(403);
    await expect(denied?.json()).resolves.toMatchObject({
      code: 'feature_upgrade_required',
      featureKey: FEATURE_INFERENCE_HOSTED,
      grantingPlan: { planKey: 'cloud', name: 'CLOUD' },
    });

    // A global DISABLE is an operator stop: it beats the plan grant, and the
    // gate says "disabled", not "upgrade".
    await overrides.setGlobalOverride(
      FEATURE_INFERENCE_HOSTED,
      FeatureOverrideEffect.DISABLE,
    );
    await expect(
      features.isEnabled(FEATURE_INFERENCE_HOSTED, { tenantId: 't1' }),
    ).resolves.toBe(false);
    const stopped = await featureGateResponse(FEATURE_INFERENCE_HOSTED, {
      resolver: features,
      tenantId: 't1',
    });
    expect(stopped?.status).toBe(403);
    await expect(stopped?.json()).resolves.toMatchObject({
      code: 'feature_disabled',
      disabledBy: 'global_override',
    });
    setFeatureGrantSource(undefined);
  });

  it('reports no grants and logs nothing when the subscription tables are missing', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');
    const source = await SubscriptionFeatureSource.create({ db });
    // The tables really are absent: the underlying resolver throws.
    const raw = await SubscriptionResolver.create({ db });
    const failure = await raw
      .resolveFeatureGrants({ kind: 'tenant', tenantId: 't1' })
      .catch((caught: unknown) => caught);
    expect(isMissingSubscriptionTableError(failure)).toBe(true);
    await expect(source.getGrants('t1')).resolves.toBeNull();
    await expect(
      source.findGrantingPlan(FEATURE_INFERENCE_HOSTED, 't1'),
    ).resolves.toBeNull();

    const features = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null },
    );
    await expect(
      features.isEnabled(FEATURE_INFERENCE_HOSTED, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('classifies only missing subscription tables as "no grants"', () => {
    expect(
      isMissingSubscriptionTableError(
        Object.assign(new Error('Table missing'), {
          code: 'DB_SCHEMA_MISSING',
          details: { tableName: '_smrt_tenant_subscriptions' },
        }),
      ),
    ).toBe(true);
    expect(
      isMissingSubscriptionTableError(
        Object.assign(new Error('no such table: _smrt_subscription_plans'), {
          code: 'SQLITE_ERROR',
        }),
      ),
    ).toBe(true);
    expect(
      isMissingSubscriptionTableError(
        Object.assign(
          new Error('relation "_smrt_tenant_subscriptions" does not exist'),
          { code: '42P01' },
        ),
      ),
    ).toBe(true);
    expect(
      isMissingSubscriptionTableError(
        Object.assign(new Error('relation "invoices" does not exist'), {
          code: '42P01',
        }),
      ),
    ).toBe(false);
    expect(
      isMissingSubscriptionTableError(
        Object.assign(new Error('Table missing'), {
          code: 'DB_SCHEMA_MISSING',
          details: { tableName: 'invoices' },
        }),
      ),
    ).toBe(false);
    expect(isMissingSubscriptionTableError(new Error('connection reset'))).toBe(
      false,
    );
  });
});
