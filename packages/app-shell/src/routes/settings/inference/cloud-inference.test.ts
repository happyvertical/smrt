// The cloud profile's inference boundary (#5191): an owner is the owner of ONE
// tenant. Two owners on one shell database (the cloud harness), the real
// registered resolver, the real route actions; the operator's provider key is
// in the environment and an app-scope `tier` binding names its provider, the
// shape that used to run an account with no key of its own on the operator's.

import { resolveInference } from '@happyvertical/smrt-core';
import { InferenceSettingsService } from '@happyvertical/smrt-inference/server';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  assertPublicProviderEndpoint,
  assistantStatus,
  resolveAssistantOptions,
} from '$lib/server/assistant/config';
import {
  type CloudHarness,
  openCloudShell,
} from '$lib/server/cloud-test-support';
import { installShellInference } from '$lib/server/inference';
import { runAs } from '$lib/server/owner';
import { actions, load } from './+page.server';

const OPERATOR_KEY = 'sk-operator-env-0123456789';
const ANN_KEY = 'sk-ann-own-key-0123456789';
const BOB_KEY = 'sk-bob-own-key-0123456789';
const ENV = { OPENAI_API_KEY: OPERATOR_KEY };

let h: CloudHarness;

const localsOf = (who: { id: string; tenantId: string }) => ({
  user: { id: who.id },
  tenantId: who.tenantId,
  permissions: [] as string[],
});

function post(name: keyof typeof actions, who: typeof h.a, payload: unknown) {
  const body = new FormData();
  body.set('payload', JSON.stringify(payload));
  return (actions[name] as (e: unknown) => Promise<unknown>)({
    request: new Request(`http://localhost/settings/inference?/${name}`, {
      method: 'POST',
      body,
    }),
    locals: localsOf(who),
  }) as Promise<{ status?: number; ok?: boolean }>;
}

const loadAs = async (who: typeof h.a) =>
  (await (load as (e: unknown) => unknown)({
    locals: localsOf(who),
    url: new URL('http://localhost/settings/inference'),
    depends: () => {},
  })) as {
    tiers: { tier: string; tenantTarget: unknown; appTarget: unknown }[];
    aliases: unknown[];
  };

const overrideRows = async () =>
  JSON.stringify(
    (await h.db.query('SELECT * FROM _smrt_inference_overrides')).rows,
  );

let operator: InferenceSettingsService;

beforeAll(async () => {
  vi.stubEnv('OPENAI_API_KEY', OPERATOR_KEY);
  h = await openCloudShell();
  installShellInference();
  // The operator's deployment-wide tier binding: it names a provider and no
  // key, so the provider's conventional variable would supply the key.
  operator = await InferenceSettingsService.create(
    { db: h.db },
    { authorize: () => true },
  );
  await operator.setTierOverride({
    tier: 'good',
    scopeType: 'app',
    scopeId: '__app__',
    target: { provider: 'openai', model: 'gpt-4o-mini' },
  });
  // Tenants bind a tier only to what the operator's allow-list names.
  await operator.setAlias({
    name: 'operatorchain',
    alias: {
      candidates: [{ provider: 'openai', model: 'operator-secret-model' }],
    },
  });
  await operator.setFusion({
    name: 'operatorfusion',
    definition: {
      mode: 'pair',
      seats: [
        { name: 'a', prompt: 'operator.prompt.a', target: 'good' },
        { name: 'b', prompt: 'operator.prompt.b', target: 'good' },
        { name: 'c', prompt: 'operator.prompt.c', target: 'great' },
      ],
    },
  });
  await operator.setTenantAllowList({
    binding: 'tier:good',
    allowList: ['model:openai/gpt-4.1'],
  });
});
afterAll(async () => {
  await h.close();
  vi.unstubAllEnvs();
});
afterEach(() => undefined);

describe('cloud: the assistant runs only on the owner’s own key', () => {
  it('an account with no key gets assistant_not_configured while the operator key is in the environment', async () => {
    const config = { env: ENV, tier: 'good' as const };
    await expect(resolveAssistantOptions(h.b, config)).rejects.toMatchObject({
      code: 'assistant_not_configured',
    });
    expect(await assistantStatus(h.b, config)).toMatchObject({
      configured: false,
      code: 'assistant_not_configured',
    });
  });

  it('refuses an owner-typed or local endpoint for a key, so the server never calls one', async () => {
    const config = { env: ENV, tier: 'good' as const };
    for (const input of [
      { provider: 'openai', key: BOB_KEY, baseUrl: 'https://10.0.0.5/v1' },
      {
        provider: 'openai',
        key: BOB_KEY,
        baseUrl: 'http://localhost:11434/v1',
      },
      { provider: 'ollama', key: BOB_KEY },
    ]) {
      const outcome = await post('saveKey', h.b, input);
      expect((outcome as { status?: number }).status).toBeGreaterThanOrEqual(
        400,
      );
    }
    await expect(resolveAssistantOptions(h.b, config)).rejects.toMatchObject({
      code: 'assistant_not_configured',
    });
  });

  it('accepts a preset target on its own public endpoint (OpenRouter) and refuses any other destination', () => {
    // A preset reaches the resolver as an OpenAI-compatible base URL.
    expect(() =>
      assertPublicProviderEndpoint({
        provider: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).not.toThrow();
    expect(() =>
      assertPublicProviderEndpoint({ provider: 'openai' }),
    ).not.toThrow();
    for (const baseUrl of [
      'https://10.0.0.5/v1',
      'http://localhost:11434/v1',
      'https://169.254.169.254/latest',
      'not a url',
    ])
      expect(() =>
        assertPublicProviderEndpoint({ provider: 'openai', baseUrl }),
      ).toThrow(/not configured|assistant/i);
  });

  it('a tenant with its own key runs on that key, and the other still does not', async () => {
    expect(
      await post('saveKey', h.a, { provider: 'openai', key: ANN_KEY }),
    ).toMatchObject({
      ok: true,
    });
    const config = { env: ENV, tier: 'good' as const };
    expect(await resolveAssistantOptions(h.a, config)).toMatchObject({
      apiKey: ANN_KEY,
    });
    await expect(resolveAssistantOptions(h.b, config)).rejects.toMatchObject({
      code: 'assistant_not_configured',
    });
    // And Bob's own key is Bob's, never Ann's.
    await post('saveKey', h.b, { provider: 'openai', key: BOB_KEY });
    expect(await resolveAssistantOptions(h.b, config)).toMatchObject({
      apiKey: BOB_KEY,
    });
    expect(await resolveAssistantOptions(h.a, config)).toMatchObject({
      apiKey: ANN_KEY,
    });
  });
});

describe('cloud: the operator’s deployment-wide rows are not shown', () => {
  it('shows no app tier target, alias, fusion or transcript setting, only the tenant’s own', async () => {
    const page = await loadAs(h.a);
    const text = JSON.stringify(page);
    for (const secret of [
      'gpt-4o-mini',
      'operator-secret-model',
      'operatorchain',
      'operatorfusion',
      'operator.prompt',
    ])
      expect(text, secret).not.toContain(secret);
    expect(page.aliases).toEqual([]);
    expect((page as unknown as { fusions: unknown[] }).fusions).toEqual([]);
    expect(
      (page as unknown as { transcripts: unknown }).transcripts,
    ).toBeNull();
    for (const row of page.tiers) expect(row.appTarget).toBeNull();
    expect((page as unknown as { hosted: boolean }).hosted).toBe(true);
  });

  it('keeps the tenant’s own override visible and the other tenant’s hidden', async () => {
    await post('saveTier', h.a, {
      tier: 'good',
      scope: 'tenant',
      target: { provider: 'openai', model: 'gpt-4.1' },
    });
    const ann = (await loadAs(h.a)).tiers.find((t) => t.tier === 'good');
    expect(JSON.stringify(ann?.tenantTarget)).toContain('gpt-4.1');
    expect(JSON.stringify(await loadAs(h.b))).not.toContain('gpt-4.1');
  });
});

describe('cloud: a tenant override the operator has since blocked', () => {
  it('does not fall through to the operator’s value on the page', async () => {
    await post('saveTier', h.a, {
      tier: 'good',
      scope: 'tenant',
      target: { provider: 'openai', model: 'gpt-4.1' },
    });
    await operator.setTenantAllowList({
      binding: 'tier:good',
      allowList: ['model:openai/gpt-4.1-nano'],
    });
    try {
      const page = await loadAs(h.a);
      const row = page.tiers.find((t) => t.tier === 'good') as unknown as {
        tenantBlocked?: boolean;
        effectiveLabel: string;
      };
      expect(row.tenantBlocked).toBe(true);
      expect(row.effectiveLabel).toBe('Provided by the platform');
      expect(JSON.stringify(page)).not.toContain('gpt-4o-mini');
    } finally {
      await operator.setTenantAllowList({
        binding: 'tier:good',
        allowList: ['model:openai/gpt-4.1'],
      });
    }
  });
});

describe('cloud: settings authority is the tenant’s own', () => {
  it('refuses every app-scope write and leaves the deployment rows untouched', async () => {
    const before = await overrideRows();
    const target = { provider: 'openai', model: 'gpt-4o' };
    const writes = [
      post('saveTier', h.a, { tier: 'good', scope: 'app', target }),
      post('saveDefaultTier', h.a, { scope: 'app', tier: 'best' }),
      post('saveAlias', h.a, {
        name: 'mine',
        candidates: [{ provider: 'openai', model: 'gpt-4o' }],
      }),
      post('saveFusion', h.a, {
        name: 'mine',
        definition: {
          mode: 'pair',
          seats: [
            { name: 'a', prompt: 'p.a', target: 'good' },
            { name: 'b', prompt: 'p.b', target: 'good' },
            { name: 'c', prompt: 'p.c', target: 'great' },
          ],
        },
      }),
      post('saveTranscripts', h.a, { settings: { enabled: true } }),
    ];
    const outcomes = await Promise.all(writes);
    expect(outcomes.map((o) => o.status)).toEqual([403, 403, 403, 403, 403]);
    expect(await overrideRows()).toBe(before);
  });

  it('refuses the probes: no server-side connection to an address the owner typed', async () => {
    for (const name of ['testConnection', 'testCandidate'] as const)
      expect(
        await post(name, h.a, { baseUrl: 'http://169.254.169.254/' }),
      ).toMatchObject({ status: 403 });
    expect(
      await (actions.discoverModels as (e: unknown) => Promise<unknown>)({
        locals: localsOf(h.a),
      }),
    ).toMatchObject({ discovered: [] });
  });

  it('one tenant’s settings write changes nothing the other resolves or reads', async () => {
    const resolveFor = (who: typeof h.a) =>
      runAs(who, () =>
        resolveInference({ tier: 'good', tenantId: who.tenantId }),
      ).then((r) => JSON.stringify(r.target));
    const bobBefore = await resolveFor(h.b);
    const bobPage = JSON.stringify(await loadAs(h.b));
    expect(
      await post('saveTier', h.a, {
        tier: 'good',
        scope: 'tenant',
        target: { provider: 'openai', model: 'gpt-4.1' },
      }),
    ).toMatchObject({ ok: true });
    // Ann's own row is hers: she reads it, Bob neither resolves nor reads it.
    const ann = (await loadAs(h.a)).tiers.find((t) => t.tier === 'good');
    expect(JSON.stringify(ann?.tenantTarget)).toContain('gpt-4.1');
    expect(await resolveFor(h.b)).toBe(bobBefore);
    expect(JSON.stringify(await loadAs(h.b))).toBe(bobPage);
    expect(
      (await loadAs(h.b)).tiers.find((t) => t.tier === 'good')?.tenantTarget,
    ).toBeNull();
  });
});
