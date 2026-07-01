import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { TenantSubscription } from '../models/TenantSubscription.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';
import { evaluateThreshold } from '../services/threshold-evaluator.js';
import { TenantUsageMeter } from '../services/usage-meter.js';
import type { PlanThreshold, UsageSummary } from '../types.js';
import { isValidThreshold } from '../utils.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('batches threshold usage summaries by usage window', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'scale',
      name: 'Scale',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-scale' });
    plan.setThresholds([
      {
        metricKey: 'messages.sent',
        limit: 100,
        window: 'month',
        enforcement: 'warn',
      },
      {
        metricKey: 'ai.tokens.total',
        limit: 1000,
        window: 'month',
        enforcement: 'block',
      },
      {
        metricKey: 'messages.sent',
        limit: 200,
        window: 'month',
        enforcement: 'block',
      },
    ]);

    const subscription = new TenantSubscription({
      tenantId: 'tenant-1',
      planId: 'plan-scale',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(subscription, { id: 'sub-scale' });

    const summarize = vi.fn(async () => {
      throw new Error('single-metric usage reader should not be called');
    });
    const summarizeBatch = vi.fn(async () => [
      {
        tenantId: 'tenant-1',
        metricKey: 'messages.sent',
        quantity: 150,
        windowStart: new Date('2026-06-01T00:00:00Z'),
        windowEnd: new Date('2026-07-01T00:00:00Z'),
      },
      {
        tenantId: 'tenant-1',
        metricKey: 'ai.tokens.total',
        quantity: 750,
        windowStart: new Date('2026-06-01T00:00:00Z'),
        windowEnd: new Date('2026-07-01T00:00:00Z'),
      },
    ]);

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
        summarize,
        summarizeBatch,
      },
    });

    const resolution = await resolver.resolveTenantEntitlements('tenant-1', {
      now: new Date('2026-06-15T00:00:00Z'),
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(summarizeBatch).toHaveBeenCalledTimes(1);
    expect(summarizeBatch).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      subscriberKind: 'tenant',
      subscriberExternalId: undefined,
      metricKeys: ['messages.sent', 'ai.tokens.total'],
      window: {
        start: new Date('2026-06-01T00:00:00Z'),
        end: new Date('2026-07-01T00:00:00Z'),
      },
    });
    expect(
      resolution.thresholdEvaluations.map((evaluation) => evaluation.state),
    ).toEqual(['warn', 'ok', 'ok']);
  });

  it('resolves AI thresholds when the optional AI usage table is absent', async () => {
    const metrics = await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const usage = new TenantUsageMeter(metrics);
    try {
      const plan = new SubscriptionPlan({
        planKey: 'ai-safe',
        name: 'AI Safe',
        status: 'active',
      });
      Object.assign(plan, { id: 'plan-ai-safe' });
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
        planId: 'plan-ai-safe',
        status: 'active',
        currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
      });
      Object.assign(subscription, { id: 'sub-ai-safe' });

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
        usage,
      });

      const resolution = await resolver.resolveTenantEntitlements('tenant-1', {
        now: new Date('2026-06-15T00:00:00Z'),
      });

      expect(resolution.allowed).toBe(true);
      expect(resolution.thresholdEvaluations[0]).toMatchObject({
        state: 'ok',
        allowed: true,
        usage: {
          metricKey: 'ai.tokens.total',
          quantity: 0,
        },
      });
    } finally {
      await metrics.db.close?.();
    }
  });

  it('loads entitlement context once and reuses it across resolution', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'team',
      name: 'Team',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-team' });
    plan.setFeatureGrants(['smrt:billing']);

    const subscription = new TenantSubscription({
      tenantId: 'tenant-1',
      planId: 'plan-team',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(subscription, { id: 'sub-team' });

    const getPlan = vi.fn(async () => plan);
    const findCurrentForTenant = vi.fn(async () => subscription);
    const resolver = new SubscriptionResolver({
      plans: { get: getPlan },
      subscriptions: { findCurrentForTenant },
      usage: {
        async summarize() {
          throw new Error('usage should not be read without thresholds');
        },
      },
    });

    const now = new Date('2026-06-15T00:00:00Z');
    const context = await resolver.loadEntitlementContext('tenant-1', { now });
    const resolution = await resolver.resolveTenantEntitlements('tenant-1', {
      context,
      now,
    });

    expect(context).toEqual({ subscription, plan });
    expect(resolution).toMatchObject({
      tenantId: 'tenant-1',
      planKey: 'team',
      featureKeys: ['smrt:billing'],
      allowed: true,
    });
    expect(findCurrentForTenant).toHaveBeenCalledTimes(1);
    expect(getPlan).toHaveBeenCalledTimes(1);
  });

  it('treats undefined context values as absent and falls back to readers', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'team',
      name: 'Team',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-team' });
    plan.setFeatureGrants(['smrt:billing']);

    const subscription = new TenantSubscription({
      tenantId: 'tenant-1',
      planId: 'plan-team',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(subscription, { id: 'sub-team' });

    const getPlan = vi.fn(async () => plan);
    const findCurrentForTenant = vi.fn(async () => subscription);
    const resolver = new SubscriptionResolver({
      plans: { get: getPlan },
      subscriptions: { findCurrentForTenant },
      usage: {
        async summarize() {
          throw new Error('usage should not be read without thresholds');
        },
      },
    });

    const resolution = await resolver.resolveTenantEntitlements('tenant-1', {
      context: { plan: undefined, subscription: undefined },
      now: new Date('2026-06-15T00:00:00Z'),
    });

    expect(resolution).toMatchObject({
      tenantId: 'tenant-1',
      planKey: 'team',
      featureKeys: ['smrt:billing'],
      allowed: true,
    });
    expect(findCurrentForTenant).toHaveBeenCalledTimes(1);
    expect(getPlan).toHaveBeenCalledTimes(1);
  });

  it('rejects unverifiable context plans instead of trusting stale entitlements', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'wrong',
      name: 'Wrong',
      status: 'active',
    });
    plan.setFeatureGrants(['smrt:wrong']);

    const subscription = new TenantSubscription({
      tenantId: 'tenant-1',
      planId: 'plan-team',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(subscription, { id: 'sub-team' });

    const resolver = new SubscriptionResolver({
      plans: {
        async get() {
          throw new Error('plan reader should not run with provided context');
        },
      },
      subscriptions: {
        async findCurrentForTenant() {
          return subscription;
        },
      },
      usage: {
        async summarize() {
          throw new Error('usage should not be read with invalid context');
        },
      },
    });

    await expect(
      resolver.resolveTenantEntitlements('tenant-1', {
        context: { plan, subscription },
        now: new Date('2026-06-15T00:00:00Z'),
      }),
    ).rejects.toThrow(/context plan/);
  });

  it('creates a resolver with reusable default readers', async () => {
    const plan = new SubscriptionPlan({
      planKey: 'factory',
      name: 'Factory',
      status: 'active',
    });
    Object.assign(plan, { id: 'plan-factory' });

    const subscription = new TenantSubscription({
      tenantId: 'tenant-1',
      planId: 'plan-factory',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    Object.assign(subscription, { id: 'sub-factory' });

    const plans = {
      async get() {
        throw new Error('plan reader should not run with provided context');
      },
    } as unknown as SubscriptionPlanCollection;
    const subscriptions = {
      async findCurrentForTenant() {
        throw new Error(
          'subscription reader should not run with provided context',
        );
      },
    } as unknown as TenantSubscriptionCollection;
    const usage = {
      async summarize() {
        throw new Error('usage should not be read without thresholds');
      },
    } as unknown as TenantUsageMeter;

    const createPlans = vi
      .spyOn(SubscriptionPlanCollection, 'create')
      .mockResolvedValue(plans);
    const createSubscriptions = vi
      .spyOn(TenantSubscriptionCollection, 'create')
      .mockResolvedValue(subscriptions);
    const createUsage = vi
      .spyOn(TenantUsageMeter, 'create')
      .mockResolvedValue(usage);

    const resolver = await SubscriptionResolver.create();
    const resolution = await resolver.resolveTenantEntitlements('tenant-1', {
      context: { subscription, plan },
      now: new Date('2026-06-15T00:00:00Z'),
    });

    expect(createPlans).toHaveBeenCalledTimes(1);
    expect(createSubscriptions).toHaveBeenCalledTimes(1);
    expect(createUsage).toHaveBeenCalledTimes(1);
    expect(resolution).toMatchObject({
      tenantId: 'tenant-1',
      planKey: 'factory',
      allowed: true,
    });
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
