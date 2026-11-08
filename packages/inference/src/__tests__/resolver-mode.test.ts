/**
 * Inference mode stored beside the provider config (#4757): `off` answers
 * every tier and untiered calls as unavailable, an explicit mode binds only
 * its own kind of stored binding, a mode needs no key, and a mode change
 * takes effect on the next call through the cache invalidation (#4756).
 */
import {
  getInferenceStatus,
  InferenceUnavailableError,
  resolveInference,
  resolveInferenceMode,
  resolveInferenceTarget,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerInference } from '../index.js';
import {
  createUserInferenceResolver,
  type InferencePrincipal,
  InferenceProviderConfigError,
  type InferenceSecretStore,
  inferenceProviderConfigSecretName,
  parseInferenceProviderConfig,
  redactInferenceProviderConfig,
  registerUserInferenceResolver,
} from '../resolver.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const USER_NAME = inferenceProviderConfigSecretName({ userId: USER });
const TENANT_NAME = inferenceProviderConfigSecretName({});

const byoBinding = {
  provider: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'user/model',
  apiKey: 'sk-user-secret',
};
const localBinding = {
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:8000/v1',
  model: 'local-qwen',
  apiKey: 'smrt-local',
};

/** In-memory secrets keyed by name (one tenant), like SecretService. */
function fakeSecrets() {
  const rows = new Map<string, string>();
  return {
    rows,
    retrieve: vi.fn(async (name: string) => {
      const value = rows.get(name);
      if (value === undefined) throw new Error(`Secret '${name}' not found`);
      return { value };
    }),
    store: vi.fn(async (name: string, value: string) => {
      rows.set(name, value);
      return {};
    }),
    delete: vi.fn(async (name: string) => rows.delete(name)),
    seed(name: string, value: unknown) {
      rows.set(name, JSON.stringify(value));
    },
  } satisfies InferenceSecretStore & Record<string, unknown>;
}

function setup(
  principal: InferencePrincipal | null = { tenantId: TENANT, userId: USER },
) {
  const secrets = fakeSecrets();
  const resolver = createUserInferenceResolver({
    secrets,
    principal: () => principal ?? undefined,
  });
  return { secrets, resolver };
}

afterEach(() => {
  setInferenceResolver(undefined);
});

describe('stored inference mode', () => {
  it('parses, validates and redacts mode, including a mode-only config', () => {
    expect(parseInferenceProviderConfig({ mode: 'off' })).toEqual({
      mode: 'off',
    });
    expect(() => parseInferenceProviderConfig({ mode: 'sometimes' })).toThrow(
      InferenceProviderConfigError,
    );
    const redacted = redactInferenceProviderConfig(
      parseInferenceProviderConfig({ ...byoBinding, mode: 'byo' }),
    );
    expect(redacted).toMatchObject({ mode: 'byo', hasApiKey: true });
    expect(JSON.stringify(redacted)).not.toContain('sk-user-secret');
  });

  it('off answers every tier as unavailable, even over a stored key', async () => {
    const { secrets, resolver } = setup();
    secrets.seed(USER_NAME, { ...byoBinding, mode: 'off' });
    for (const tier of ['cheap', 'good', 'great', 'best', 'auto'] as const) {
      const resolution = await resolveInference({ tier }, { resolver });
      expect(resolution).toMatchObject({
        mode: 'off',
        unavailable: 'off',
        target: {},
      });
    }
    expect(await resolveInferenceMode({}, { resolver })).toEqual({
      mode: 'off',
      unavailable: 'off',
    });
  });

  it("the user's mode wins over the tenant's; the tenant's applies otherwise", async () => {
    const { secrets, resolver } = setup();
    secrets.seed(TENANT_NAME, { ...byoBinding, mode: 'off' });
    expect(
      await resolveInference({ tier: 'good' }, { resolver }),
    ).toMatchObject({ unavailable: 'off' });
    secrets.seed(USER_NAME, { ...localBinding, mode: 'local' });
    resolver.invalidate();
    expect(
      await resolveInference({ tier: 'good' }, { resolver }),
    ).toMatchObject({ mode: 'local', target: { source: 'local' } });
  });

  it('an explicit mode binds only its own source and never falls through to app config', async () => {
    const { secrets, resolver } = setup();
    secrets.seed(TENANT_NAME, localBinding);
    secrets.seed(USER_NAME, { mode: 'byo' });
    const resolution = await resolveInference(
      { tier: 'best' },
      {
        resolver,
        config: { tiers: { best: { provider: 'anthropic', model: 'app' } } },
      },
    );
    expect(resolution).toMatchObject({
      mode: 'off',
      unavailable: 'unconfigured',
    });
  });

  it('reports the binding source as mode without an explicit mode', async () => {
    const { secrets, resolver } = setup();
    secrets.seed(USER_NAME, localBinding);
    expect(
      await resolveInference({ tier: 'cheap' }, { resolver }),
    ).toMatchObject({ mode: 'local' });
    expect(await resolveInferenceMode({}, { resolver })).toBeUndefined();
  });

  it('agents (userId: null) see only the tenant mode', async () => {
    const { secrets, resolver } = setup();
    secrets.seed(USER_NAME, { mode: 'off' });
    secrets.seed(TENANT_NAME, byoBinding);
    expect(
      await resolveInference({ tier: 'good', userId: null }, { resolver }),
    ).toMatchObject({ mode: 'byo', target: { apiKey: 'sk-user-secret' } });
    expect(
      await resolveInferenceMode({ userId: null }, { resolver }),
    ).toBeUndefined();
  });

  it('setMode works without a key, keeps the binding, and applies on the next call', async () => {
    const { secrets, resolver } = setup();
    registerUserInferenceResolver(resolver);
    registerInference();
    await resolver.setMode('user', 'off');
    expect(JSON.parse(secrets.rows.get(USER_NAME) ?? '{}')).toEqual({
      mode: 'off',
    });
    await expect(
      resolveInferenceTarget({ tier: 'good', className: 'Probe' }),
    ).rejects.toBeInstanceOf(InferenceUnavailableError);

    // Entering a key and switching to byo turns AI on without a restart.
    await resolver.write('user', { ...byoBinding, mode: 'off' });
    await resolver.setMode('user', 'byo');
    expect(JSON.parse(secrets.rows.get(USER_NAME) ?? '{}')).toMatchObject({
      ...byoBinding,
      mode: 'byo',
    });
    const resolved = await resolveInferenceTarget({ tier: 'good' });
    expect(resolved.options).toMatchObject({ model: 'user/model' });
    expect(resolved.resolution.mode).toBe('byo');
    expect((await resolver.resolveBindings()).mode).toEqual({
      mode: 'byo',
      layer: 'user',
    });

    await resolver.setMode('user', null);
    expect(
      JSON.parse(secrets.rows.get(USER_NAME) ?? '{}').mode,
    ).toBeUndefined();
    await resolver.remove('user');
    await resolver.setMode('user', 'off');
    await resolver.setMode('user', null);
    expect(secrets.rows.has(USER_NAME)).toBe(false);
  });

  it('an explicit mode without its binding leaves untiered probes unconfigured', async () => {
    const { resolver } = setup();
    registerUserInferenceResolver(resolver);
    registerInference();
    await resolver.setMode('user', 'byo');
    // The app has a configured provider, but a keyless `byo` choice never
    // runs on it: untiered calls route through `auto` (core #4757).
    const configured = { provider: 'openai', baseUrl: 'https://app.example' };
    expect(await getInferenceStatus({ configured })).toEqual({
      available: false,
      mode: 'off',
      reason: 'unconfigured',
    });
    await resolver.write('user', { ...byoBinding, mode: 'byo' });
    expect(await getInferenceStatus({ configured })).toEqual({
      available: true,
      mode: 'byo',
    });
  });

  it('the validating wrapper forwards mode() only when the base has it', async () => {
    const { secrets, resolver } = setup();
    secrets.seed(USER_NAME, { mode: 'off' });
    registerUserInferenceResolver(resolver);
    registerInference();
    expect(await resolveInferenceMode({})).toEqual({
      mode: 'off',
      unavailable: 'off',
    });
    setInferenceResolver(undefined);
    registerInference();
    expect(await resolveInferenceMode({})).toBeUndefined();
  });

  it('no principal: no stored mode applies', async () => {
    const { secrets, resolver } = setup(null);
    secrets.seed(USER_NAME, { mode: 'off' });
    expect(await resolveInferenceMode({}, { resolver })).toBeUndefined();
    expect(
      (await resolveInference({ tier: 'good' }, { resolver })).unavailable,
    ).toBeUndefined();
  });
});
