/**
 * The `backup.vault` gate reads the account's resolved entitlements through
 * the real feature resolver and subscription grant source, never a client
 * claim. Off, lapsed, and operator-disabled accounts are refused on every
 * route, and an entitlement lookup that fails denies.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  FEATURE_BACKUP_VAULT,
  FeatureOverrideCollection,
  FeatureOverrideEffect,
  FeatureResolver,
} from '@happyvertical/smrt-features';
import {
  SubscriptionFeatureSource,
  SubscriptionPlan,
  SubscriptionResolver,
  TenantSubscription,
} from '@happyvertical/smrt-subscriptions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VaultRelayEntitlements } from '../relay.js';
import {
  createHarness,
  type Harness,
  newDevice,
  registerDevice,
  signed,
  type TestDevice,
  uploadSnapshot,
} from './helpers.js';

function plan(planKey: string, featureKeys: string[]): SubscriptionPlan {
  const value = new SubscriptionPlan({ planKey, name: planKey.toUpperCase() });
  value.setFeatureGrants(featureKeys);
  Object.assign(value, { id: `plan-${planKey}` });
  return value;
}

const plans = [plan('vault', [FEATURE_BACKUP_VAULT]), plan('free', [])];

const subscriptions: Record<string, TenantSubscription> = {
  'acct-paid': new TenantSubscription({
    tenantId: 'acct-paid',
    planId: 'plan-vault',
    status: 'active',
  }),
  'acct-lapsed': new TenantSubscription({
    tenantId: 'acct-lapsed',
    planId: 'plan-vault',
    status: 'past_due',
  }),
  'acct-cancelled': new TenantSubscription({
    tenantId: 'acct-cancelled',
    planId: 'plan-vault',
    status: 'canceled',
  }),
  'acct-free': new TenantSubscription({
    tenantId: 'acct-free',
    planId: 'plan-free',
    status: 'active',
  }),
};

function grantSource(): SubscriptionFeatureSource {
  return new SubscriptionFeatureSource({
    resolver: new SubscriptionResolver({
      plans: { get: async ({ id }) => plans.find((p) => p.id === id) ?? null },
      subscriptions: {
        findCurrentForTenant: async (tenantId: string) =>
          subscriptions[tenantId] ?? null,
      },
      usage: {
        summarize: async () => {
          throw new Error('the gate must not read usage meters');
        },
      },
    }),
    plans: { findActive: async () => plans },
  });
}

let h: Harness;
let featuresDb: Awaited<ReturnType<typeof getTestDatabase>>;
const devices: Record<string, TestDevice> = {};

beforeEach(async () => {
  featuresDb = await getTestDatabase({
    classes: ['FeatureDefinition', 'FeatureOverride'],
  });
  const entitlements: VaultRelayEntitlements = {
    resolver: new FeatureResolver(
      { db: featuresDb },
      { tenantHierarchyLoader: async () => null },
    ),
    grantSource,
  };
  h = await createHarness({ entitlements });
  for (const account of Object.keys(subscriptions).concat('acct-none')) {
    devices[account] = newDevice(account, 'device-1');
    await registerDevice(h, devices[account]);
  }
});

afterEach(async () => {
  await h.close();
});

async function status(account: string, method: string, path: string) {
  return (await h.relay.handle(signed(h, devices[account], method, path)))
    .status;
}

describe('backup.vault entitlement gate', () => {
  it('admits an account whose active plan grants backup.vault', async () => {
    expect(await status('acct-paid', 'GET', '/v1/snapshots')).toBe(200);
    expect(
      (await uploadSnapshot(h, devices['acct-paid'], 1, new Uint8Array(8)))
        .status,
    ).toBe(201);
  });

  it.each([
    ['acct-free', 'a plan without the grant'],
    ['acct-none', 'no subscription'],
    ['acct-lapsed', 'a past-due subscription'],
    ['acct-cancelled', 'a cancelled subscription'],
  ])('refuses %s (%s) on every route with an upgrade answer', async (account) => {
    for (const [method, path] of [
      ['GET', '/v1/lease'],
      ['POST', '/v1/lease/acquire'],
      ['POST', '/v1/lease/renew'],
      ['POST', '/v1/lease/release'],
      ['GET', '/v1/snapshots'],
      ['GET', '/v1/snapshots/latest'],
      ['GET', '/v1/snapshots/1'],
      ['GET', '/v1/snapshots/1/chunks/0'],
      ['DELETE', '/v1/snapshots/1'],
      ['POST', '/v1/uploads'],
      ['PUT', '/v1/uploads/00000000-0000-4000-8000-000000000000/chunks/0'],
      ['POST', '/v1/uploads/00000000-0000-4000-8000-000000000000/commit'],
      ['DELETE', '/v1/uploads/00000000-0000-4000-8000-000000000000'],
    ] as const) {
      const response = await h.relay.handle(
        signed(h, devices[account], method, path),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        code: 'feature_upgrade_required',
        featureKey: FEATURE_BACKUP_VAULT,
        grantingPlan: { planKey: 'vault' },
      });
    }
  });

  it('refuses a paid account that lapses after uploading, including downloads', async () => {
    expect(
      (await uploadSnapshot(h, devices['acct-paid'], 1, new Uint8Array(8)))
        .status,
    ).toBe(201);
    subscriptions['acct-paid'].status = 'past_due';
    try {
      expect(await status('acct-paid', 'GET', '/v1/snapshots/1/chunks/0')).toBe(
        403,
      );
    } finally {
      subscriptions['acct-paid'].status = 'active';
    }
  });

  it('honours an operator DISABLE override over the plan grant', async () => {
    const overrides = await FeatureOverrideCollection.create({
      db: featuresDb,
    });
    await overrides.setTenantOverride(
      FEATURE_BACKUP_VAULT,
      'acct-paid',
      FeatureOverrideEffect.DISABLE,
    );
    const response = await h.relay.handle(
      signed(h, devices['acct-paid'], 'GET', '/v1/snapshots'),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'feature_disabled' });
  });

  it('ignores any client-supplied entitlement claim', async () => {
    const response = await h.relay.handle(
      signed(h, devices['acct-free'], 'GET', '/v1/snapshots', {
        headers: {
          'x-vault-entitlement': FEATURE_BACKUP_VAULT,
          'x-feature-keys': FEATURE_BACKUP_VAULT,
        },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('fails closed when the entitlement lookup errors', async () => {
    const local = await createHarness({
      entitlements: {
        resolver: {
          explain: async () => {
            throw new Error('database unavailable');
          },
          findGrantingPlan: async () => null,
        },
      },
    });
    try {
      const device = newDevice('acct-a', 'device-a1');
      await registerDevice(local, device);
      const response = await local.relay.handle(
        signed(local, device, 'GET', '/v1/snapshots'),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'entitlement_unavailable',
      });
    } finally {
      await local.close();
    }
  });
});
