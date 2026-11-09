/**
 * Hosted AI spend cap (#4760): plan caps on `ai.hosted.spend_micros` (tenant)
 * and `ai.hosted.user_spend_micros` (per user) in integer micro-dollars,
 * metered from `_smrt_ai_usage`; the hosted gate (smrt-inference `./gate`)
 * with smrt-features' kill switch, end to end through core's seam.
 */
import {
  AiUsagePersistenceHandler,
  getTestDatabase,
  InferenceUnavailableError,
  SmrtClass,
  setInferenceGate,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KillSwitchService } from '../../../features/src/index.js';
import {
  createHostedInferenceGate,
  HOSTED_INFERENCE_KILL_SWITCH,
  setHostedInferenceEnabled,
} from '../../../inference/src/gate.js';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import {
  AI_HOSTED_SPEND_METRIC,
  AI_HOSTED_USER_SPEND_METRIC,
  createHostedAiSpendReader,
  decideHostedAiSpend,
  evaluateHostedAiSpendThreshold,
  HostedAiSpendEvaluator,
  HostedAiSpendPolicyError,
  type HostedAiSpendReader,
  hostedAiSpendThresholds,
  hostedAiTagFragment,
} from '../services/hosted-ai-spend.js';
import type { PlanThreshold, UsageWindow } from '../types.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const MONTH: UsageWindow = {
  start: new Date('2026-11-01T00:00:00.000Z'),
  end: new Date('2026-12-01T00:00:00.000Z'),
};

function cap(
  metricKey: string,
  limit: number,
  extra: Partial<PlanThreshold> = {},
): PlanThreshold {
  return {
    metricKey,
    limit,
    window: 'month',
    enforcement: 'block',
    ...extra,
  };
}

describe('hosted spend thresholds (#4760)', () => {
  const at = (spend: number, threshold: PlanThreshold) =>
    evaluateHostedAiSpendThreshold('user-cap', threshold, { spend }, MONTH)
      .state;

  it('allows below the warning ratio, warns from it, blocks at the cap', () => {
    const limit = cap(AI_HOSTED_USER_SPEND_METRIC, 1_000_000);
    expect(at(0, limit)).toBe('ok');
    expect(at(799_999, limit)).toBe('ok');
    expect(at(800_000, limit)).toBe('warn');
    expect(at(999_999, limit)).toBe('warn');
    expect(at(1_000_000, limit)).toBe('blocked');
    expect(at(1_500_000, limit)).toBe('blocked');
    const early = cap(AI_HOSTED_USER_SPEND_METRIC, 1_000_000, {
      warningRatio: 0.5,
    });
    expect(at(500_000, early)).toBe('warn');
  });

  it('warn enforcement never blocks; observe never affects a call', () => {
    const warnOnly = cap(AI_HOSTED_USER_SPEND_METRIC, 100, {
      enforcement: 'warn',
    });
    expect(at(5_000, warnOnly)).toBe('warn');
    const observe = cap(AI_HOSTED_USER_SPEND_METRIC, 100, {
      enforcement: 'observe',
    });
    expect(at(5_000, observe)).toBe('ok');
  });

  it('a zero cap blocks every hosted call', () => {
    expect(at(0, cap(AI_HOSTED_SPEND_METRIC, 0))).toBe('blocked');
  });

  it('refuses a malformed hosted cap instead of skipping it', () => {
    for (const bad of [
      cap(AI_HOSTED_USER_SPEND_METRIC, 1.5),
      cap(AI_HOSTED_USER_SPEND_METRIC, -1),
      cap(AI_HOSTED_SPEND_METRIC, 10, { window: 'hour' as never }),
      cap(AI_HOSTED_SPEND_METRIC, 10, { enforcement: 'stop' as never }),
    ]) {
      expect(() => hostedAiSpendThresholds([bad])).toThrow(
        HostedAiSpendPolicyError,
      );
    }
    // Other metrics are not this policy's business, valid or not.
    expect(
      hostedAiSpendThresholds([
        cap('ai.cost.estimated', 1.5),
        cap(AI_HOSTED_SPEND_METRIC, 10),
      ]),
    ).toHaveLength(1);
  });

  it('a block names the cap that lifts last', () => {
    const early = evaluateHostedAiSpendThreshold(
      'user-cap',
      cap(AI_HOSTED_USER_SPEND_METRIC, 10, { window: 'day' }),
      { spend: 20 },
      {
        start: new Date('2026-11-18T00:00:00.000Z'),
        end: new Date('2026-11-19T00:00:00.000Z'),
      },
    );
    const late = evaluateHostedAiSpendThreshold(
      'tenant-cap',
      cap(AI_HOSTED_SPEND_METRIC, 10),
      { spend: 20 },
      MONTH,
    );
    const decision = decideHostedAiSpend([early, late], {
      entitled: true,
      planId: 'p',
      planKey: 'k',
    });
    expect(decision.state).toBe('blocked');
    expect(decision.decidedBy?.policy).toBe('tenant-cap');
    expect(decision.decidedBy?.resetsAt?.toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });

  it('a rolling cap reports no reset by itself (the evaluator computes it)', () => {
    const evaluation = evaluateHostedAiSpendThreshold(
      'user-cap',
      cap(AI_HOSTED_USER_SPEND_METRIC, 10, { window: 'rolling' }),
      { spend: 10 },
      MONTH,
    );
    expect(evaluation).toMatchObject({ state: 'blocked', resetsAt: null });
  });

  it('tag fragments anchor the JSON value', () => {
    expect(hostedAiTagFragment('userId', 'u_1%"')).toBe('"userId":"u_1%\\""');
  });
});

describe('HostedAiSpendEvaluator (#4760)', () => {
  function evaluatorWith(thresholds: PlanThreshold[], spend: number) {
    const reads: Array<{ userId?: string; window: UsageWindow }> = [];
    const reader: HostedAiSpendReader = {
      summarize: async ({ userId, window }) => {
        reads.push({ ...(userId ? { userId } : {}), window });
        return { spend };
      },
    };
    const resolvePlanThresholds = vi.fn(async () => ({
      entitled: true,
      thresholds,
      planId: 'plan-1',
      planKey: 'pro',
      planVersionId: null,
      subscriptionId: 'sub-1',
    }));
    const evaluator = new HostedAiSpendEvaluator({
      resolver: { resolvePlanThresholds },
      spend: reader,
      now: () => NOW,
    });
    return { evaluator, reads, resolvePlanThresholds };
  }

  it('meters the tenant cap per tenant window and the user cap per user window', async () => {
    const { evaluator, reads } = evaluatorWith(
      [
        cap(AI_HOSTED_SPEND_METRIC, 100_000_000),
        cap(AI_HOSTED_USER_SPEND_METRIC, 2_000_000, { window: 'day' }),
      ],
      2_000_000,
    );
    const decision = await evaluator.evaluate({
      tenantId: 't1',
      userId: 'u1',
    });
    expect(reads).toEqual([
      { window: MONTH },
      {
        userId: 'u1',
        window: {
          start: new Date('2026-11-18T00:00:00.000Z'),
          end: new Date('2026-11-19T00:00:00.000Z'),
        },
      },
    ]);
    expect(decision.state).toBe('blocked');
    expect(decision.decidedBy).toMatchObject({
      policy: 'user-cap',
      cap: 2_000_000,
      spend: 2_000_000,
      resetsAt: new Date('2026-11-19T00:00:00.000Z'),
    });
    expect(decision.evaluations.map((e) => e.state)).toEqual(['ok', 'blocked']);
  });

  it('skips per-user caps when there is no user (jobs, shared agents)', async () => {
    const { evaluator, reads } = evaluatorWith(
      [cap(AI_HOSTED_USER_SPEND_METRIC, 1)],
      50,
    );
    const decision = await evaluator.evaluate({ tenantId: 't1' });
    expect(decision.state).toBe('ok');
    expect(reads).toEqual([]);
  });

  it('resolves plan thresholds once per burst and reads spend every time', async () => {
    const { evaluator, reads, resolvePlanThresholds } = evaluatorWith(
      [cap(AI_HOSTED_SPEND_METRIC, 10)],
      1,
    );
    await evaluator.evaluate({ tenantId: 't1' });
    await evaluator.evaluate({ tenantId: 't1' });
    expect(resolvePlanThresholds).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(2);
    evaluator.invalidate('t1');
    await evaluator.evaluate({ tenantId: 't1' });
    expect(resolvePlanThresholds).toHaveBeenCalledTimes(2);
  });

  it('propagates and forgets a failed entitlement read', async () => {
    const resolvePlanThresholds = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValue({
        entitled: true,
        thresholds: [],
        planId: null,
        planKey: null,
        planVersionId: null,
        subscriptionId: null,
      });
    const evaluator = new HostedAiSpendEvaluator({
      resolver: { resolvePlanThresholds },
      spend: { summarize: async () => ({ spend: 0 }) },
    });
    await expect(evaluator.evaluate({ tenantId: 't1' })).rejects.toThrow(
      'connection terminated',
    );
    await expect(evaluator.evaluate({ tenantId: 't1' })).resolves.toMatchObject(
      { state: 'ok' },
    );
  });
});

describe('hosted spend gate end to end (#4760)', () => {
  let host: SmrtClass;
  let db: DatabaseInterface;
  let tenantId: string;
  const userId = 'user-1';

  async function usageRow(row: {
    cost: number;
    tags: Record<string, string>;
    tenant?: string;
    operation?: string;
    at?: string;
  }): Promise<void> {
    await new AiUsagePersistenceHandler(db).handle({
      provider: 'openai',
      model: 'hosted-model',
      operation: row.operation ?? 'chat',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      duration: 10,
      timestamp: new Date(row.at ?? '2026-11-10T00:00:00.000Z'),
      tags: row.tags,
      className: 'Doc',
      tenantId: row.tenant ?? tenantId,
      estimatedCost: row.cost,
    });
  }

  async function subscribe(thresholds: PlanThreshold[]): Promise<void> {
    const plans = await SubscriptionPlanCollection.create({ db });
    const plan = await plans.create({
      planKey: 'pro',
      name: 'Pro',
      tenantId: null,
    });
    plan.setThresholds(thresholds);
    await plan.save();
    const subscriptions = await TenantSubscriptionCollection.create({ db });
    const subscription = await subscriptions.create({
      tenantId,
      planId: String(plan.id),
      status: 'active',
    });
    await subscription.save();
  }

  beforeEach(async () => {
    host = new SmrtClass({ db: { type: 'sqlite', url: ':memory:' } });
    await (host as unknown as { initialize(): Promise<void> }).initialize();
    db = host.db as DatabaseInterface;
    await getTestDatabase({
      db,
      classes: [
        'FeatureOverride',
        'SubscriptionPlan',
        'SubscriptionPlanVersion',
        'TenantSubscription',
      ],
    });
    tenantId = '7d9b9a8e-6a0b-4f33-9c55-2f4f0a3f9e01';
  });

  afterEach(async () => {
    setInferenceGate(undefined);
    setInferenceResolver(undefined);
    host.destroy();
    await db.close?.();
  });

  it('meters only hosted, non-blocked rows of the tenant (and user) in the window', async () => {
    await usageRow({ cost: 0.5, tags: { source: 'hosted', userId } });
    await usageRow({
      cost: 0.25,
      tags: { source: 'hosted', userId: 'user-10' },
    });
    await usageRow({ cost: 0.125, tags: { source: 'hosted' } });
    await usageRow({ cost: 9, tags: { source: 'byo', userId } });
    await usageRow({ cost: 9, tags: { userId } });
    await usageRow({
      cost: 9,
      tags: { source: 'hosted', userId },
      tenant: 'other-tenant',
    });
    await usageRow({
      cost: 9,
      tags: { source: 'hosted', userId },
      at: '2026-10-31T23:59:59.000Z',
    });
    await usageRow({
      cost: 9,
      tags: { source: 'hosted', userId, reason: 'entitlement' },
      operation: 'blocked',
    });
    const reader = createHostedAiSpendReader(db);
    await expect(
      reader.summarize({ tenantId, window: MONTH }),
    ).resolves.toMatchObject({ spend: 875_000 });
    await expect(
      reader.summarize({ tenantId, userId, window: MONTH }),
    ).resolves.toMatchObject({ spend: 500_000 });
    // `_` in an id is literal, not a one-character wildcard.
    await usageRow({ cost: 1, tags: { source: 'hosted', userId: 'u_1' } });
    await usageRow({ cost: 2, tags: { source: 'hosted', userId: 'ux1' } });
    await expect(
      reader.summarize({ tenantId, userId: 'u_1', window: MONTH }),
    ).resolves.toMatchObject({ spend: 1_000_000 });
    // Matching is case-sensitive on SQLite too (LIKE would fold ASCII case).
    await usageRow({ cost: 3, tags: { source: 'hosted', userId: 'Alice' } });
    await usageRow({ cost: 4, tags: { source: 'hosted', userId: 'alice' } });
    await expect(
      reader.summarize({ tenantId, userId: 'Alice', window: MONTH }),
    ).resolves.toMatchObject({ spend: 3_000_000 });
    await usageRow({ cost: 5, tags: { source: 'HOSTED', userId } });
    await expect(
      reader.summarize({ tenantId, userId, window: MONTH }),
    ).resolves.toMatchObject({ spend: 500_000 });
  });

  function gate(options: { requireSubscription?: boolean } = {}) {
    return (async () =>
      createHostedInferenceGate({
        killSwitch: new KillSwitchService({ db }),
        spend: await HostedAiSpendEvaluator.create({ db }),
        principal: () => ({ tenantId, userId }),
        ...options,
      }))();
  }

  const request = {
    tierRequested: 'good' as const,
    tier: 'good' as const,
    target: { provider: 'openai', source: 'hosted' as const },
  };

  it('blocks a user over the per-user cap with cap, spend and reset', async () => {
    await subscribe([
      cap(AI_HOSTED_SPEND_METRIC, 100_000_000),
      cap(AI_HOSTED_USER_SPEND_METRIC, 1_000_000),
    ]);
    await usageRow({ cost: 1.2, tags: { source: 'hosted', userId } });
    const hosted = await gate();
    const decision = await hosted.check({ ...request, tenantId });
    expect(decision).toEqual({
      action: 'block',
      details: {
        policy: 'user-cap',
        cap: 1_000_000,
        spend: 1_200_000,
        resetsAt: expect.any(String),
      },
    });
    // Another user of the same tenant is still under the cap.
    const other = createHostedInferenceGate({
      killSwitch: new KillSwitchService({ db }),
      spend: await HostedAiSpendEvaluator.create({ db }),
      principal: () => ({ tenantId, userId: 'user-2' }),
    });
    await expect(other.check({ ...request, tenantId })).resolves.toEqual({
      action: 'allow',
    });
  });

  it('blocks a tenant with no entitled subscription unless told not to', async () => {
    await expect(
      (await gate()).check({ ...request, tenantId }),
    ).resolves.toEqual({
      action: 'block',
      details: { policy: 'subscription' },
    });
    await expect(
      (await gate({ requireSubscription: false })).check({
        ...request,
        tenantId,
      }),
    ).resolves.toEqual({ action: 'allow' });
  });

  it('kill switch: global beats everything, then the tenant; enable lifts it', async () => {
    await subscribe([]);
    const switches = new KillSwitchService({ db });
    const hosted = await gate();
    await expect(hosted.check({ ...request, tenantId })).resolves.toEqual({
      action: 'allow',
    });

    await setHostedInferenceEnabled(switches, { enabled: false, tenantId });
    await expect(hosted.check({ ...request, tenantId })).resolves.toEqual({
      action: 'block',
      details: { policy: 'kill-switch', disabledBy: 'tenant' },
    });
    // Another tenant is unaffected by a tenant switch.
    await expect(
      createHostedInferenceGate({
        killSwitch: switches,
        spend: {
          evaluate: async () => ({
            state: 'ok',
            entitled: true,
            decidedBy: null,
          }),
        },
        principal: () => undefined,
      }).check({ ...request, tenantId: 'other' }),
    ).resolves.toEqual({ action: 'allow' });

    await setHostedInferenceEnabled(switches, { enabled: false });
    // A tenant ENABLE row (written as a flag override would be) cannot
    // re-enable a tenant under a global disable.
    const { FeatureOverrideCollection, FeatureOverrideEffect } = await import(
      '../../../features/src/index.js'
    );
    const overrides = await FeatureOverrideCollection.create({ db });
    await overrides.setTenantOverride(
      HOSTED_INFERENCE_KILL_SWITCH,
      tenantId,
      FeatureOverrideEffect.ENABLE,
    );
    await expect(hosted.check({ ...request, tenantId })).resolves.toEqual({
      action: 'block',
      details: { policy: 'kill-switch', disabledBy: 'global' },
    });
    // No tenant at all: the global switch still answers first.
    await expect(
      createHostedInferenceGate({
        killSwitch: switches,
        spend: {
          evaluate: async () => ({
            state: 'ok',
            entitled: true,
            decidedBy: null,
          }),
        },
        principal: () => undefined,
      }).check(request),
    ).resolves.toMatchObject({ details: { policy: 'kill-switch' } });

    await setHostedInferenceEnabled(switches, { enabled: true });
    await expect(hosted.check({ ...request, tenantId })).resolves.toEqual({
      action: 'allow',
    });
  });

  it('reports when a blocked rolling cap lifts, after enough spend expires', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * day).toISOString();
    await subscribe([
      cap(AI_HOSTED_USER_SPEND_METRIC, 1_000_000, { window: 'rolling' }),
    ]);
    await usageRow({ cost: 1, tags: { source: 'hosted', userId }, at: at(20) });
    await usageRow({ cost: 1, tags: { source: 'hosted', userId }, at: at(10) });
    const decision = await (await gate()).check({ ...request, tenantId });
    expect(decision).toMatchObject({
      action: 'block',
      details: { policy: 'user-cap', cap: 1_000_000, spend: 2_000_000 },
    });
    // The first expiry leaves spend at the cap; the call runs again only
    // when the second row leaves the 30-day window.
    const resetsAt = Date.parse(
      (decision as { details: { resetsAt: string } }).details.resetsAt,
    );
    expect(Math.abs(resetsAt - (now + 20 * day))).toBeLessThan(5_000);
  });

  it('rounds the rolling lift like the spend it lifts (fractional micro-dollars)', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * day).toISOString();
    for (const daysAgo of [9, 8, 7]) {
      await usageRow({
        cost: 0.0000004,
        tags: { source: 'hosted', userId },
        at: at(daysAgo),
      });
    }
    const reader = createHostedAiSpendReader(db);
    const scope = {
      tenantId,
      userId,
      window: { start: new Date(now - 30 * day), end: new Date(now + day) },
    };
    // 1.2 micro-dollars rounds to 1: at the cap of 1.
    await expect(reader.summarize(scope)).resolves.toEqual({ spend: 1 });
    // Expiring the oldest leaves 0.8 (rounds to 1, still at the cap);
    // expiring the second leaves 0.4 (rounds to 0): it lifts then.
    const lifts = await reader.liftsAt?.({
      ...scope,
      cap: 1,
      windowMs: 30 * day,
    });
    expect(Math.abs((lifts?.getTime() ?? 0) - (now + 22 * day))).toBeLessThan(
      5_000,
    );
    await expect(
      reader.liftsAt?.({ ...scope, cap: 0, windowMs: 30 * day }),
    ).resolves.toBeNull();
    await expect(
      reader.liftsAt?.({ ...scope, cap: 5, windowMs: 30 * day }),
    ).resolves.toBeNull();
  });

  it('fails closed on a malformed cap in the pinned plan version', async () => {
    await subscribe([
      cap(AI_HOSTED_USER_SPEND_METRIC, 1_000_000, { window: 'hour' as never }),
    ]);
    await expect(
      (await gate()).check({ ...request, tenantId }),
    ).rejects.toThrow(HostedAiSpendPolicyError);
  });

  it('fails closed on a resolver transport failure, counting no spend', async () => {
    await subscribe([cap(AI_HOSTED_SPEND_METRIC, 100_000_000)]);
    await usageRow({ cost: 0.5, tags: { source: 'hosted', userId } });
    const broken = new HostedAiSpendEvaluator({
      resolver: {
        resolvePlanThresholds: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
          });
        },
      },
      spend: createHostedAiSpendReader(db),
    });
    setInferenceGate(
      createHostedInferenceGate({
        killSwitch: new KillSwitchService({ db }),
        spend: broken,
        principal: () => ({ tenantId, userId }),
      }),
    );
    setInferenceResolver({
      resolve: () => ({
        tierResolved: 'good',
        via: 'resolver',
        target: {
          provider: 'openai',
          baseUrl: 'https://hosted.example/v1',
          apiKey: 'sk-hosted',
          model: 'hosted-model',
          source: 'hosted',
        },
      }),
    });
    const { resolveInferenceTarget } = await import('@happyvertical/smrt-core');
    const error = await resolveInferenceTarget({
      base: { provider: 'openai', apiKey: 'sk-base' },
      tenantId,
      usage: { db },
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InferenceUnavailableError);
    expect((error as InferenceUnavailableError).entitlement).toEqual({
      policy: 'gate-error',
    });
    const blocked = (
      await db.query(
        "SELECT estimated_cost, total_tokens, tags FROM _smrt_ai_usage WHERE operation = 'blocked'",
      )
    ).rows as Array<Record<string, unknown>>;
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.total_tokens).toBe(0);
    expect(Number(blocked[0]?.estimated_cost ?? 0)).toBe(0);
    // The blocked row never counts as spend.
    await expect(
      createHostedAiSpendReader(db).summarize({ tenantId, window: MONTH }),
    ).resolves.toMatchObject({ spend: 500_000 });
  });
});
