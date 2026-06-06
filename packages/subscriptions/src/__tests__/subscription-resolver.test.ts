import { describe, expect, it } from 'vitest';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { TenantSubscription } from '../models/TenantSubscription.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';
import { evaluateThreshold } from '../services/threshold-evaluator.js';
import type { PlanThreshold, UsageSummary } from '../types.js';
import { isValidThreshold } from '../utils.js';

describe('smrt-subscriptions', () => {
  it('stores plan feature grants and thresholds as typed accessors', () => {
    const plan = new SubscriptionPlan({
      planKey: 'growth',
      name: 'Growth',
    });

    plan.setFeatureGrants([
      'smrt:chat',
      { featureKey: 'smrt:video', enabled: false },
    ]);
    plan.setThresholds([
      {
        metricKey: 'ai.tokens.total',
        limit: 1000,
        window: 'month',
        enforcement: 'warn',
      },
    ]);

    expect(plan.getFeatureKeys()).toEqual(['smrt:chat']);
    expect(plan.getThresholds()).toHaveLength(1);
    expect(plan.getThresholds()[0]?.metricKey).toBe('ai.tokens.total');
  });

  it('evaluates warn and block thresholds', () => {
    const usage: UsageSummary = {
      tenantId: 'tenant-1',
      metricKey: 'messages.sent',
      quantity: 90,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:00:00Z'),
    };

    expect(
      evaluateThreshold(
        {
          metricKey: 'messages.sent',
          limit: 100,
          window: 'month',
          enforcement: 'warn',
        },
        usage,
      ),
    ).toMatchObject({ state: 'warn', allowed: true, remaining: 10 });

    expect(
      evaluateThreshold(
        {
          metricKey: 'messages.sent',
          limit: 90,
          window: 'month',
          enforcement: 'block',
        },
        usage,
      ),
    ).toMatchObject({ state: 'blocked', allowed: false, remaining: 0 });

    const zeroUsage: UsageSummary = {
      ...usage,
      quantity: 0,
    };

    expect(
      evaluateThreshold(
        {
          metricKey: 'messages.sent',
          limit: 0,
          window: 'month',
          enforcement: 'block',
        },
        zeroUsage,
      ),
    ).toMatchObject({ state: 'ok', allowed: true, remaining: 0 });

    expect(
      evaluateThreshold(
        {
          metricKey: 'messages.sent',
          limit: 0,
          window: 'month',
          enforcement: 'block',
        },
        {
          ...zeroUsage,
          quantity: 1,
        },
      ),
    ).toMatchObject({ state: 'blocked', allowed: false, remaining: 0 });
  });

  it('rejects malformed threshold values parsed from JSON', () => {
    const validThreshold: PlanThreshold = {
      metricKey: 'ai.tokens.total',
      limit: 100,
      window: 'month',
      enforcement: 'warn',
      warningRatio: 0.8,
    };

    expect(isValidThreshold(validThreshold)).toBe(true);
    expect(
      isValidThreshold({
        ...validThreshold,
        window: 'forever',
      } as unknown as PlanThreshold),
    ).toBe(false);
    expect(
      isValidThreshold({
        ...validThreshold,
        enforcement: 'disable',
      } as unknown as PlanThreshold),
    ).toBe(false);
    expect(
      isValidThreshold({
        ...validThreshold,
        warningRatio: 1.5,
      }),
    ).toBe(false);
  });

  it('resolves feature entitlements and threshold blocks', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'pro',
      name: 'Pro',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-pro' });
    plan.setFeatureGrants(['smrt:chat', 'smrt:projects']);
    plan.setThresholds([
      {
        metricKey: 'ai.tokens.total',
        limit: 100,
        window: 'month',
        enforcement: 'block',
      },
    ]);

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
          return {
            tenantId: 'tenant-1',
            metricKey: 'ai.tokens.total',
            quantity: 125,
            windowStart: new Date('2026-06-01T00:00:00Z'),
            windowEnd: new Date('2026-07-01T00:00:00Z'),
          };
        },
      },
    });

    const resolution = await resolver.resolveTenantEntitlements('tenant-1', {
      now: new Date('2026-06-15T00:00:00Z'),
    });

    expect(resolution).toMatchObject({
      tenantId: 'tenant-1',
      planKey: 'pro',
      featureKeys: ['smrt:chat', 'smrt:projects'],
      allowed: false,
    });
    expect(resolution.thresholdEvaluations[0]).toMatchObject({
      state: 'blocked',
      allowed: false,
    });
    await expect(
      resolver.assertWithinThresholds('tenant-1', {
        now: new Date('2026-06-15T00:00:00Z'),
      }),
    ).rejects.toThrow('ai.tokens.total');
  });

  it('returns a closed resolution without a subscription', async () => {
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
          throw new Error('usage should not be read without a plan');
        },
      },
    });

    await expect(
      resolver.resolveTenantEntitlements('tenant-1'),
    ).resolves.toMatchObject({
      tenantId: 'tenant-1',
      status: 'none',
      allowed: false,
      featureKeys: [],
    });
  });

  it('uses the resolver time when selecting the current subscription', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'pro',
      name: 'Pro',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-pro' });

    const subscription = new TenantSubscription({
      tenantId: 'tenant-1',
      planId: 'plan-pro',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(subscription, { id: 'sub-1' });

    const expectedNow = new Date('2026-06-15T00:00:00Z');
    let selectedAt: Date | undefined;
    const resolver = new SubscriptionResolver({
      plans: {
        async get() {
          return plan;
        },
      },
      subscriptions: {
        async findCurrentForTenant(_tenantId, now) {
          selectedAt = now;
          return subscription;
        },
      },
      usage: {
        async summarize() {
          throw new Error('usage should not be read without thresholds');
        },
      },
    });

    await resolver.resolveTenantEntitlements('tenant-1', {
      now: expectedNow,
    });

    expect(selectedAt).toBe(expectedNow);
  });
});
