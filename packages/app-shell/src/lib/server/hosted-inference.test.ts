// Hosted inference in the cloud profile (#5194), end to end on SQLite with the
// real stores: smrt-features' kill switch and flag resolver, smrt-subscriptions'
// plans, subscriptions and spend evaluator, the real hosted gate registered
// through core's seam, and the real tenancy interceptor. The inference
// provider itself is a fake resolver (no network, no containers). NOT
// exercised: PostgreSQL (the spend reader's tag matching and the required
// tenancy reads are dialect-specific).
import {
  AiUsagePersistenceHandler,
  getAiUsageUserResolver,
  getInferenceGate,
  type InferenceResolver,
  InferenceUnavailableError,
  setAiUsageUserResolver,
  setInferenceGate,
} from '@happyvertical/smrt-core';
import {
  FEATURE_INFERENCE_HOSTED,
  KillSwitchService,
} from '@happyvertical/smrt-features';
import { resetHostedGatewayConfig } from '@happyvertical/smrt-inference/node';
import {
  AI_HOSTED_SPEND_METRIC,
  SubscriptionPlanCollection,
  TenantSubscriptionCollection,
} from '@happyvertical/smrt-subscriptions';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  assistantStatus,
  resolveAssistantOptions,
} from './assistant/config.ts';
import {
  CLOUD_MASTER_KEY,
  type CloudHarness,
  openCloudShell,
} from './cloud-test-support.ts';
import { configureShell } from './host.ts';
import {
  assertHostedInferenceEntitled,
  createHostedInferenceDeps,
  installHostedInferenceGate,
  resetHostedInference,
} from './hosted-inference.ts';

const GATEWAY = 'https://gateway.example.test/v1';
const HOSTED_KEY = 'sk-hosted-virtual-key-0123456789';

let h: CloudHarness;

async function plan(
  features: string[],
  capMicros?: number,
): Promise<{ id: string }> {
  const plans = await SubscriptionPlanCollection.create({ db: h.db });
  const row = await plans.create({
    planKey: `plan-${features.length}-${capMicros ?? 'nocap'}`,
    name: 'Plan',
    tenantId: null,
  });
  row.setFeatureGrants(features);
  if (capMicros !== undefined)
    row.setThresholds([
      {
        metricKey: AI_HOSTED_SPEND_METRIC,
        limit: capMicros,
        window: 'month',
        enforcement: 'block',
      },
    ]);
  await row.save();
  return { id: String(row.id) };
}

async function subscribe(tenantId: string, planId: string) {
  await withTenant({ tenantId }, async () => {
    const subs = await TenantSubscriptionCollection.create({ db: h.db });
    const sub = await subs.create({ tenantId, planId, status: 'active' });
    await sub.save();
  });
}

async function spend(tenantId: string, usd: number) {
  await new AiUsagePersistenceHandler(h.db).handle({
    provider: 'openai',
    model: 'hosted-model',
    operation: 'chat',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    duration: 1,
    timestamp: new Date(),
    tags: { source: 'hosted' },
    className: 'AppShellAssistant',
    tenantId,
    estimatedCost: usd,
  });
}

/** A resolver that answers every tier with the operator's gateway binding. */
function hostedResolver(baseUrl = GATEWAY): InferenceResolver {
  return {
    resolve: () => ({
      tierResolved: 'good',
      via: 'resolver',
      mode: 'hosted',
      target: {
        provider: 'openai',
        model: 'gw-model',
        baseUrl,
        apiKey: HOSTED_KEY,
        source: 'hosted',
      },
    }),
  };
}

const config = { tier: 'good' as const };

function useProfile(profile: 'local' | 'cloud') {
  configureShell({
    profile: async () => profile,
    db: async () => h.db,
    dataRoot: async () => h.dir,
    secretMasterKey: async () => CLOUD_MASTER_KEY,
  });
}

beforeAll(async () => {
  vi.stubEnv('SMRT_INFERENCE_HOSTED_PROVIDER', 'litellm');
  vi.stubEnv('SMRT_INFERENCE_HOSTED_BASE_URL', GATEWAY);
  vi.stubEnv('SMRT_INFERENCE_HOSTED_ADMIN_URL', 'https://admin.example.test');
  vi.stubEnv('SMRT_INFERENCE_HOSTED_ADMIN_KEY', 'admin-key');
  resetHostedGatewayConfig();
  h = await openCloudShell();
});
afterAll(async () => {
  await h.close();
  vi.unstubAllEnvs();
  resetHostedGatewayConfig();
});
beforeEach(() => resetHostedInference());
afterEach(() => {
  setInferenceGate(undefined);
  setAiUsageUserResolver(undefined);
  resetHostedInference();
});

const install = async () => {
  const gate = await installHostedInferenceGate({ db: async () => h.db });
  if (!gate) throw new Error('the cloud profile registers a gate');
  return gate;
};

describe('startup', () => {
  it('registers the hosted gate and the usage user resolver in the cloud profile', async () => {
    expect(getInferenceGate()).toBeUndefined();
    const gate = await install();
    expect(getInferenceGate()).toBe(gate);
    expect(getAiUsageUserResolver()).toBeTypeOf('function');
  });

  it('does not start when the stores cannot be read', async () => {
    const deps = await createHostedInferenceDeps(h.db);
    await expect(
      installHostedInferenceGate({
        db: async () => h.db,
        deps: {
          ...deps,
          killSwitch: {
            read: async () => {
              throw new Error('no such table: _smrt_feature_overrides');
            },
          },
        },
      }),
    ).rejects.toThrow(/_smrt_feature_overrides/);
    expect(getInferenceGate()).toBeUndefined();
  });

  it('local profile (the desktop): nothing is registered or built', async () => {
    useProfile('local');
    const db = vi.fn();
    expect(await installHostedInferenceGate({ db })).toBeUndefined();
    expect(db).not.toHaveBeenCalled();
    expect(getInferenceGate()).toBeUndefined();
    expect(getAiUsageUserResolver()).toBeUndefined();
    useProfile('cloud');
  });
});

describe('entitlement and caps (real plans and rows)', () => {
  it('a tenant without the entitlement cannot make a hosted inference call', async () => {
    const gate = await install();
    const request = {
      tierRequested: 'good' as const,
      tier: 'good' as const,
      target: { provider: 'openai', source: 'hosted' as const },
    };
    await expect(
      gate.check({ ...request, tenantId: h.b.tenantId }),
    ).resolves.toMatchObject({
      action: 'block',
      details: { policy: 'subscription' },
    });
    await expect(
      assertHostedInferenceEntitled(h.b.tenantId),
    ).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      entitlement: { policy: 'subscription' },
    });
  });

  it('a subscribed tenant whose plan lacks inference.hosted is still refused', async () => {
    await install();
    const basic = await plan(['sync.devices'], 50_000_000);
    await subscribe(h.b.tenantId, basic.id);
    await expect(assertHostedInferenceEntitled(h.b.tenantId)).rejects.toThrow(
      InferenceUnavailableError,
    );
  });

  it('a tenant whose plan grants inference.hosted is allowed with no ambient tenant or user (attributed to the tenant)', async () => {
    const gate = await install();
    const pro = await plan([FEATURE_INFERENCE_HOSTED], 50_000_000);
    await subscribe(h.a.tenantId, pro.id);
    // A background call: the request names the tenant, nothing is ambient.
    await expect(
      gate.check({
        tierRequested: 'good',
        tier: 'good',
        target: { provider: 'openai', source: 'hosted' },
        tenantId: h.a.tenantId,
        userId: null,
      }),
    ).resolves.toEqual({ action: 'allow' });
    await expect(
      assertHostedInferenceEntitled(h.a.tenantId),
    ).resolves.toBeUndefined();
  });

  it('a tenant over its cap is blocked with a message naming the limit and its reset', async () => {
    await install();
    await spend(h.a.tenantId, 60);
    await expect(
      resolveAssistantOptions(h.a, { ...config, resolver: hostedResolver() }),
    ).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      entitlement: { policy: 'tenant-cap', cap: 50_000_000 },
    });
    const status = await assistantStatus(h.a, {
      ...config,
      resolver: hostedResolver(),
    });
    expect(status).toMatchObject({ configured: false, code: 'ai_unavailable' });
    expect((status as { message: string }).message).toMatch(
      /spending limit has been reached.*resets \d{4}-\d{2}-\d{2}.*own API key/s,
    );
  });

  it('the global kill switch pauses hosted calls for everyone', async () => {
    await install();
    await new KillSwitchService({ db: h.db }).set('inference.hosted.enabled', {
      enabled: false,
    });
    const status = await assistantStatus(h.a, {
      ...config,
      resolver: hostedResolver(),
    });
    expect((status as { message: string }).message).toMatch(/paused/i);
    await new KillSwitchService({ db: h.db }).set('inference.hosted.enabled', {
      enabled: true,
    });
  });
});

describe('the assistant in cloud', () => {
  it('uses hosted inference for an entitled tenant, on the operator gateway only', async () => {
    await install();
    // (the cap rows of the previous test are for tenant A: use a fresh tenant)
    const pro = await plan([FEATURE_INFERENCE_HOSTED]);
    const fresh = await h.newUser('carol@example.test');
    const { ownerTenantFor } = await import('./accounts.ts');
    const tenantId = await ownerTenantFor(h.db, {
      id: fresh.id,
      name: 'carol',
    });
    await subscribe(tenantId, pro.id);
    const carol = { id: fresh.id, tenantId };
    await expect(
      resolveAssistantOptions(carol, { ...config, resolver: hostedResolver() }),
    ).resolves.toMatchObject({ apiKey: HOSTED_KEY, baseUrl: GATEWAY });
    // A binding that names any other endpoint is not the operator's gateway.
    await expect(
      resolveAssistantOptions(carol, {
        ...config,
        resolver: hostedResolver('https://10.0.0.5/v1'),
      }),
    ).rejects.toMatchObject({ code: 'assistant_not_configured' });
  });

  it('never runs a hosted binding with no gate registered', async () => {
    await expect(
      resolveAssistantOptions(h.a, { ...config, resolver: hostedResolver() }),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });

  it('a tenant that is not entitled gets the plan message,', async () => {
    await install();
    const status = await assistantStatus(h.b, {
      ...config,
      resolver: hostedResolver(),
    });
    expect((status as { message: string }).message).toMatch(
      /not included in the current plan.*own API key/s,
    );
  });
});
