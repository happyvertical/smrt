/**
 * Hosted spend from real calls (#5489): calls core sends on a hosted tier
 * binding through the tracked client are read back by the default spend
 * reader.
 */
import {
  AiUsagePersistenceHandler,
  createTrackedAiClient,
  getTestDatabase,
  HOSTED_AI_HOLD_OPERATION,
  HOSTED_AI_HOLD_TTL_MS,
  type InferenceResolver,
  InferenceUnavailableError,
  SmrtClass,
  setInferenceGate,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KillSwitchService } from '../../../features/src/index.js';
import { createHostedInferenceGate } from '../../../inference/src/gate.js';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import {
  AI_HOSTED_SPEND_METRIC,
  createHostedAiSpendReader,
  HostedAiSpendEvaluator,
} from '../services/hosted-ai-spend.js';
import { getWindowForThreshold } from '../utils.js';

const TENANT = '7d9b9a8e-6a0b-4f33-9c55-2f4f0a3f9e02';

/** Every tier bound to `gpt-4o` (priced) as a binding of `source`. */
function binding(source: 'hosted' | 'byo'): InferenceResolver {
  return {
    resolve(request) {
      return {
        tierResolved:
          request.tier === 'auto' ? 'good' : (request.tier as 'good'),
        via: 'resolver',
        target: { model: 'gpt-4o', source },
      };
    },
  };
}

/**
 * A provider client that answers with its usage on the response (as a
 * `chat()` answer does): 100 prompt and 50 completion tokens, $0.00075 on
 * the default `openai:gpt-4o` rate.
 */
function answeringModel() {
  return {
    async embed() {
      return [];
    },
    async message(_text: string, _options: Record<string, unknown> = {}) {
      return {
        content: 'ok',
        model: 'gpt-4o',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  };
}

describe('hosted spend meters tracked calls (#5489)', () => {
  let host: SmrtClass;
  let db: DatabaseInterface;

  beforeEach(async () => {
    host = new SmrtClass({ db: { type: 'sqlite', url: ':memory:' } });
    await (host as unknown as { initialize(): Promise<void> }).initialize();
    db = host.db as DatabaseInterface;
  });

  afterEach(async () => {
    setInferenceGate(undefined);
    setInferenceResolver(undefined);
    host.destroy();
    await db.close?.();
  });

  async function spend(): Promise<number> {
    const reader = createHostedAiSpendReader(db);
    const { spend } = await reader.summarize({
      tenantId: TENANT,
      window: getWindowForThreshold('month', new Date()),
    });
    return spend;
  }

  async function trackedCall(): Promise<void> {
    const tracked = createTrackedAiClient({
      db,
      tenantId: TENANT,
      ai: answeringModel() as never,
      label: { provider: 'openai', model: 'gpt-4o' },
    });
    const run = await tracked.openRun({ type: 'turn' });
    const client = await tracked.client(
      { promptKey: 'test.hosted.metered', tier: 'good' },
      { runContext: run.context },
    );
    await client.message('hello', { maxTokens: 64 } as never);
  }

  it('counts a tracked call on a hosted binding at its recorded cost', async () => {
    setInferenceResolver(binding('hosted'));
    await trackedCall();
    expect(await spend()).toBe(750);
  });

  it('does not count a tracked call on a byo binding', async () => {
    setInferenceResolver(binding('byo'));
    await trackedCall();
    expect(await spend()).toBe(0);
  });
});

describe('hosted spend holds against a plan cap (#5489)', () => {
  let host: SmrtClass;
  let db: DatabaseInterface;
  const MONTH = getWindowForThreshold('month', new Date());

  async function subscribe(capMicros: number): Promise<void> {
    const plans = await SubscriptionPlanCollection.create({ db });
    const plan = await plans.create({
      planKey: 'pro',
      name: 'Pro',
      tenantId: null,
    });
    plan.setThresholds([
      {
        metricKey: AI_HOSTED_SPEND_METRIC,
        limit: capMicros,
        window: 'month',
        enforcement: 'block',
      },
    ]);
    await plan.save();
    const subscriptions = await TenantSubscriptionCollection.create({ db });
    const subscription = await subscriptions.create({
      tenantId: TENANT,
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
  });

  afterEach(async () => {
    setInferenceGate(undefined);
    setInferenceResolver(undefined);
    host.destroy();
    await db.close?.();
  });

  async function hold(cost: number, at: Date): Promise<void> {
    await new AiUsagePersistenceHandler(db).handle({
      provider: 'openai',
      model: 'gpt-4o',
      operation: HOSTED_AI_HOLD_OPERATION,
      duration: 0,
      timestamp: at,
      tags: { source: 'hosted' },
      tenantId: TENANT,
      estimatedCost: cost,
    });
    // The persistence handler mints its own id; give the row a hold id.
    await db.query(
      `UPDATE _smrt_ai_usage SET id = ? WHERE operation = ? AND id NOT LIKE ?`,
      `${HOSTED_AI_HOLD_OPERATION}:${at.getTime()}`,
      HOSTED_AI_HOLD_OPERATION,
      `${HOSTED_AI_HOLD_OPERATION}:%`,
    );
  }

  it('refuses a call that overlaps one already holding the rest of the cap', async () => {
    // One call's estimate ("hello", maxTokens 100 on gpt-4o) is 1,005
    // micro-dollars: one fits under a 1,500 cap, two in flight do not.
    await subscribe(1_500);
    setInferenceResolver(binding('hosted'));
    setInferenceGate(
      createHostedInferenceGate({
        killSwitch: new KillSwitchService({ db }),
        spend: await HostedAiSpendEvaluator.create({ db }),
        principal: () => ({ tenantId: TENANT, userId: 'user-1' }),
      }),
    );
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    let calls = 0;
    const model = {
      async embed() {
        return [];
      },
      async message() {
        calls++;
        if (calls === 1) await pending;
        return {
          content: 'ok',
          model: 'gpt-4o',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      },
    };
    const tracked = createTrackedAiClient({
      db,
      tenantId: TENANT,
      ai: model as never,
      label: { provider: 'openai', model: 'gpt-4o' },
    });
    const run = await tracked.openRun({ type: 'turn' });
    const client = await tracked.client(
      { promptKey: 'test.hosted.held', tier: 'good' },
      { runContext: run.context },
    );
    const first = client.message('hello', { maxTokens: 100 } as never);
    await vi.waitFor(() => expect(calls).toBe(1));
    await expect(
      client.message('hello', { maxTokens: 100 } as never),
    ).rejects.toBeInstanceOf(InferenceUnavailableError);
    expect(calls).toBe(1);
    release();
    await first;
    // The first call's own row is its spend; no hold is left behind.
    const reader = createHostedAiSpendReader(db);
    await expect(
      reader.summarize({ tenantId: TENANT, window: MONTH }),
    ).resolves.toMatchObject({ spend: 750 });
  });

  it('counts a hold while it is fresh and ignores one past its time to live', async () => {
    const reader = createHostedAiSpendReader(db);
    const window = {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: new Date(Date.now() + 60_000),
    };
    await hold(0.002, new Date(Date.now() - HOSTED_AI_HOLD_TTL_MS - 60_000));
    await expect(
      reader.summarize({ tenantId: TENANT, window }),
    ).resolves.toMatchObject({ spend: 0 });
    await hold(0.001, new Date());
    await expect(
      reader.summarize({ tenantId: TENANT, window }),
    ).resolves.toMatchObject({ spend: 1_000 });
  });
});
