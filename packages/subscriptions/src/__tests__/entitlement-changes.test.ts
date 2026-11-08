/**
 * Entitlement change hook (#4759): snapshot before/after a webhook write,
 * diff gained/lost/changed keys, notify listeners, collect failures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { TenantSubscription } from '../models/TenantSubscription.js';
import {
  diffEntitlements,
  type EntitlementChange,
  emptyEntitlementSnapshot,
  getEntitlementChangeListeners,
  notifyEntitlementChange,
  registerEntitlementChangeListener,
  snapshotEntitlements,
  trackEntitlementChange,
} from '../services/entitlement-changes.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';
import type { PlanFeatureGrant } from '../types.js';

const HOSTED = 'inference.hosted';

function plan(planKey: string, grants: Array<string | PlanFeatureGrant>) {
  const value = new SubscriptionPlan({ planKey, name: planKey });
  value.setFeatureGrants(grants);
  Object.assign(value, { id: `plan-${planKey}` });
  return value;
}

function world(plans: SubscriptionPlan[]) {
  const current: Record<string, TenantSubscription | null> = {};
  const resolver = new SubscriptionResolver({
    plans: { get: async ({ id }) => plans.find((p) => p.id === id) ?? null },
    subscriptions: {
      findCurrentForTenant: async (tenantId: string) =>
        current[tenantId] ?? null,
    },
    usage: {
      summarize: async () => {
        throw new Error('entitlement snapshots must not read usage meters');
      },
    },
  });
  const subscribe = (tenantId: string, planId: string | null) => {
    current[tenantId] = planId
      ? new TenantSubscription({ tenantId, planId, status: 'active' })
      : null;
  };
  return { resolver, subscribe };
}

const free = plan('free', ['sync.devices']);
const cloud = plan('cloud', [
  'sync.devices',
  { featureKey: HOSTED, metadata: { budget: { limitMicros: 5_000_000 } } },
]);
const cloudPlus = plan('cloud-plus', [
  'sync.devices',
  { featureKey: HOSTED, metadata: { budget: { limitMicros: 20_000_000 } } },
]);

const unregister: Array<() => void> = [];
afterEach(() => {
  for (const fn of unregister.splice(0)) fn();
});

describe('entitlement changes (#4759)', () => {
  it('snapshots grants with metadata, sorted, without usage reads', async () => {
    const { resolver, subscribe } = world([cloud]);
    subscribe('t1', 'plan-cloud');
    const snapshot = await snapshotEntitlements(resolver, 't1');
    expect(snapshot.featureKeys).toEqual([HOSTED, 'sync.devices']);
    expect(snapshot.grants[0]).toMatchObject({
      featureKey: HOSTED,
      metadata: { budget: { limitMicros: 5_000_000 } },
    });
    expect(snapshot.planKey).toBe('cloud');
    expect(await snapshotEntitlements(resolver, 'nobody')).toEqual(
      emptyEntitlementSnapshot(),
    );
  });

  it('diffs gained, lost and metadata-changed keys', async () => {
    const { resolver, subscribe } = world([free, cloud, cloudPlus]);
    subscribe('t1', 'plan-free');
    const a = await snapshotEntitlements(resolver, 't1');
    subscribe('t1', 'plan-cloud');
    const b = await snapshotEntitlements(resolver, 't1');
    subscribe('t1', 'plan-cloud-plus');
    const c = await snapshotEntitlements(resolver, 't1');

    expect(diffEntitlements('t1', a, b)).toMatchObject({
      gained: [HOSTED],
      lost: [],
      changed: [],
    });
    expect(diffEntitlements('t1', b, c)).toMatchObject({
      gained: [],
      lost: [],
      changed: [HOSTED],
    });
    expect(diffEntitlements('t1', c, a)).toMatchObject({
      gained: [],
      lost: [HOSTED],
      changed: [],
    });
  });

  it('tracks a webhook write and notifies registered listeners', async () => {
    const { resolver, subscribe } = world([free, cloud]);
    subscribe('t1', 'plan-free');
    const seen: EntitlementChange[] = [];
    unregister.push(
      registerEntitlementChangeListener((change) => {
        seen.push(change);
      }),
    );
    const outcome = await trackEntitlementChange(
      { tenantId: 't1', resolver },
      async () => {
        subscribe('t1', 'plan-cloud');
        return 'applied';
      },
    );
    expect(outcome.result).toBe('applied');
    expect(outcome.failures).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tenantId: 't1', gained: [HOSTED] });
  });

  it('collects listener failures without throwing and keeps notifying', async () => {
    const boom = new Error('provision failed');
    const after = vi.fn();
    const { resolver, subscribe } = world([free, cloud]);
    subscribe('t1', 'plan-cloud');
    const outcome = await trackEntitlementChange(
      {
        tenantId: 't1',
        resolver,
        listeners: [
          () => {
            throw boom;
          },
          after,
        ],
      },
      async () => subscribe('t1', 'plan-free'),
    );
    expect(outcome.failures).toEqual([{ error: boom }]);
    expect(after).toHaveBeenCalledTimes(1);
    expect(outcome.change.lost).toEqual([HOSTED]);
  });

  it('notifies nobody for a write that changes no entitlement', async () => {
    const listener = vi.fn();
    const { resolver, subscribe } = world([cloud]);
    subscribe('t1', 'plan-cloud');
    await trackEntitlementChange(
      { tenantId: 't1', resolver, listeners: [listener] },
      async () => subscribe('t1', 'plan-cloud'),
    );
    expect(listener).not.toHaveBeenCalled();
    const same = await snapshotEntitlements(resolver, 't1');
    await notifyEntitlementChange(diffEntitlements('t1', same, same), {
      listeners: [listener],
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('propagates an apply failure and notifies nobody', async () => {
    const listener = vi.fn();
    const { resolver } = world([cloud]);
    await expect(
      trackEntitlementChange(
        { tenantId: 't1', resolver, listeners: [listener] },
        async () => {
          throw new Error('webhook write failed');
        },
      ),
    ).rejects.toThrow('webhook write failed');
    expect(listener).not.toHaveBeenCalled();
  });

  it('registers a listener once and unregisters it', () => {
    const listener = vi.fn();
    const off = registerEntitlementChangeListener(listener);
    registerEntitlementChangeListener(listener);
    expect(
      getEntitlementChangeListeners().filter((entry) => entry === listener),
    ).toHaveLength(1);
    off();
    expect(getEntitlementChangeListeners()).not.toContain(listener);
  });
});
