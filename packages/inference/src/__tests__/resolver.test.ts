/**
 * Per-user and per-tenant inference bindings over smrt-secrets (#4756):
 * precedence, the no-principal fallthrough, the cache and its invalidation,
 * the redacted settings shape, and composition with #4752's validation.
 */
import {
  getInferenceResolver,
  type InferenceConfig,
  resolveInference,
  resolveInferenceTarget,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceConfigError, registerInference } from '../index.js';
import {
  createUserInferenceResolver,
  type InferencePrincipal,
  InferenceProviderConfigError,
  type InferenceSecretStore,
  inferenceProviderConfigSecretName,
  inferenceProviderTargets,
  invalidateUserInferenceResolvers,
  parseInferenceProviderConfig,
  redactInferenceProviderConfig,
  registerUserInferenceResolver,
} from '../resolver.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const USER_KEY = 'sk-user-secret-value';
const TENANT_KEY = 'sk-tenant-secret-value';

/** An in-memory secret store keyed by (tenant, name), like SecretService. */
function fakeSecrets(tenantOf: () => string | undefined) {
  const rows = new Map<string, string>();
  const key = (name: string) => `${tenantOf() ?? '(none)'}|${name}`;
  const store = {
    retrieve: vi.fn(async (name: string) => {
      const value = rows.get(key(name));
      if (value === undefined) throw new Error(`Secret '${name}' not found`);
      return { value };
    }),
    store: vi.fn(async (name: string, value: string) => {
      rows.set(key(name), value);
      return {};
    }),
    delete: vi.fn(async (name: string) => rows.delete(key(name))),
    seed(tenantId: string, name: string, value: unknown) {
      rows.set(`${tenantId}|${name}`, JSON.stringify(value));
    },
  } satisfies InferenceSecretStore & Record<string, unknown>;
  return store;
}

async function currentTenant(): Promise<string | undefined> {
  const { getCurrentTenant } = await import('@happyvertical/smrt-tenancy');
  return getCurrentTenant()?.tenantId;
}

function setup(
  options: {
    principal?: InferencePrincipal | undefined;
    now?: () => number;
  } = {},
) {
  let tenantInContext: string | undefined;
  const secrets = fakeSecrets(() => tenantInContext);
  // Track the tenancy context the resolver runs secret calls in.
  const wrap = <K extends 'retrieve' | 'store' | 'delete'>(name: K) => {
    const inner = secrets[name] as (...args: unknown[]) => Promise<unknown>;
    (secrets as Record<string, unknown>)[name] = vi.fn(
      async (...args: unknown[]) => {
        tenantInContext = await currentTenant();
        return inner(...args);
      },
    );
  };
  wrap('retrieve');
  wrap('store');
  wrap('delete');
  const principal = { current: options.principal };
  const resolver = createUserInferenceResolver({
    secrets,
    principal: () => principal.current,
    ...(options.now ? { now: options.now } : {}),
  });
  return { secrets, resolver, principal };
}

const userConfig = {
  provider: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'user/default-model',
  apiKey: USER_KEY,
};
const tenantConfig = {
  provider: 'openai',
  baseUrl: 'https://tenant.example/v1',
  model: 'tenant/model',
  apiKey: TENANT_KEY,
};

const appConfig: InferenceConfig = {
  tiers: { best: { provider: 'anthropic', model: 'app-best' } },
};

afterEach(() => {
  setInferenceResolver(undefined);
});

describe('createUserInferenceResolver precedence', () => {
  it('binds user, then tenant, then app config, then the configured client', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      tiers: { great: userConfig },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({}), {
      tiers: { great: tenantConfig, good: tenantConfig },
    });

    const resolve = (tier: 'great' | 'good' | 'best' | 'cheap') =>
      resolveInference({ tier }, { resolver, config: appConfig });

    const great = await resolve('great');
    expect(great).toMatchObject({
      tierResolved: 'great',
      via: 'resolver',
      target: { model: 'user/default-model', apiKey: USER_KEY, source: 'byo' },
    });
    expect((await resolve('good')).target).toMatchObject({
      model: 'tenant/model',
      apiKey: TENANT_KEY,
    });
    expect(await resolve('best')).toMatchObject({
      via: 'config',
      target: { model: 'app-best', source: 'app' },
    });
    expect(await resolve('cheap')).toEqual({
      tierResolved: 'cheap',
      via: 'default',
      target: { source: 'app' },
    });
  });

  it('applies the user default to every tier until a tier is bound individually', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
      tiers: { best: { preset: 'lemonade', model: 'local-qwen' } },
    });
    const cheap = await resolveInference(
      { tier: 'cheap' },
      { resolver, config: appConfig },
    );
    expect(cheap.target.model).toBe('user/default-model');
    const best = await resolveInference(
      { tier: 'best' },
      { resolver, config: appConfig },
    );
    expect(best.target).toMatchObject({
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:13305/v1',
      model: 'local-qwen',
      apiKey: 'smrt-local',
      source: 'local',
    });
  });

  it('resolves auto to the app default tier before binding', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      tiers: { cheap: userConfig },
    });
    const auto = await resolveInference(
      { tier: 'auto' },
      { resolver, config: { defaultTier: 'cheap' } },
    );
    expect(auto).toMatchObject({ tierResolved: 'cheap', via: 'resolver' });
  });

  it('keeps a hosted source declared by the stored config (#4759)', async () => {
    const { secrets, resolver } = setup({ principal: { tenantId: TENANT } });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({}), {
      ...tenantConfig,
      source: 'hosted',
    });
    const res = await resolveInference({ tier: 'good' }, { resolver });
    expect(res.target.source).toBe('hosted');
  });

  it('defers to the fallback resolver before app config', async () => {
    const fallback = {
      resolve: vi.fn(async () => ({
        tierResolved: 'good' as const,
        target: { provider: 'openai', model: 'fallback' },
        via: 'resolver' as const,
      })),
    };
    const secrets = fakeSecrets(() => undefined);
    const resolver = createUserInferenceResolver({
      secrets,
      fallback,
      principal: () => undefined,
    });
    const res = await resolveInference({ tier: 'good' }, { resolver });
    expect(res.target).toEqual({
      provider: 'openai',
      model: 'fallback',
      source: 'app',
    });
  });
});

describe('identity', () => {
  it('skips the user layer with no principal and never reads a user secret', async () => {
    const { secrets, resolver } = setup({ principal: undefined });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
    });
    // No tenant either: nothing stored is read; the app binds.
    const none = await resolveInference(
      { tier: 'best' },
      { resolver, config: appConfig },
    );
    expect(none.target).toMatchObject({ model: 'app-best', source: 'app' });
    expect(secrets.retrieve).not.toHaveBeenCalled();

    // A tenant named by the request (an object's tenant) gets its tenant
    // layer, still without any user layer.
    secrets.seed(TENANT, inferenceProviderConfigSecretName({}), tenantConfig);
    const tenantOnly = await resolveInference(
      { tier: 'best', tenantId: TENANT },
      { resolver, config: appConfig },
    );
    expect(tenantOnly.target.apiKey).toBe(TENANT_KEY);
    const names = secrets.retrieve.mock.calls.map((call) => call[0]);
    expect(names).toEqual([inferenceProviderConfigSecretName({})]);
  });

  it('reads nothing stored when the request acts for another tenant', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
    });
    secrets.seed(
      OTHER_TENANT,
      inferenceProviderConfigSecretName({}),
      tenantConfig,
    );
    const res = await resolveInference(
      { tier: 'best', tenantId: OTHER_TENANT },
      { resolver, config: appConfig },
    );
    expect(res.target).toMatchObject({ model: 'app-best', source: 'app' });
    expect(secrets.retrieve).not.toHaveBeenCalled();
  });

  it('reads the other tenant layer only with allowCrossTenant, never a user', async () => {
    const secrets = fakeSecrets(() => undefined);
    const names: string[] = [];
    const tenants: (string | undefined)[] = [];
    const resolver = createUserInferenceResolver({
      allowCrossTenant: true,
      principal: () => ({ tenantId: TENANT, userId: USER }),
      secrets: {
        ...secrets,
        retrieve: async (name) => {
          names.push(name);
          tenants.push(await currentTenant());
          if (name === inferenceProviderConfigSecretName({})) {
            return { value: JSON.stringify(tenantConfig) };
          }
          throw new Error(`Secret '${name}' not found`);
        },
      },
    });
    const res = await resolveInference(
      { tier: 'best', tenantId: OTHER_TENANT },
      { resolver, config: appConfig },
    );
    expect(res.target.apiKey).toBe(TENANT_KEY);
    expect(names).toEqual([inferenceProviderConfigSecretName({})]);
    expect(tenants).toEqual([OTHER_TENANT]);
  });

  it('skips the user layer for a request marked userId: null (shared clients)', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({}), tenantConfig);
    const res = await resolveInference(
      { tier: 'good', userId: null },
      { resolver },
    );
    expect(res.target.apiKey).toBe(TENANT_KEY);
    const names = secrets.retrieve.mock.calls.map((call) => call[0]);
    expect(names).toEqual([inferenceProviderConfigSecretName({})]);
    // A string userId never selects another user's config.
    const other = await resolveInference(
      { tier: 'good', userId: 'someone-else' },
      { resolver },
    );
    expect(other.target.apiKey).toBe(USER_KEY);
  });

  it('reads the ambient tenancy principal by default and reads secrets in its tenant', async () => {
    const secrets = fakeSecrets(() => undefined);
    let seenTenant: string | undefined;
    const retrieve = secrets.retrieve;
    const store: InferenceSecretStore = {
      ...secrets,
      retrieve: async (name) => {
        seenTenant = await currentTenant();
        if (name === inferenceProviderConfigSecretName({ userId: USER })) {
          return { value: JSON.stringify(userConfig) };
        }
        return retrieve(name);
      },
    };
    const resolver = createUserInferenceResolver({ secrets: store });
    const res = await withTenant({ tenantId: TENANT, userId: USER }, () =>
      resolveInference({ tier: 'good' }, { resolver }),
    );
    expect(res.target.apiKey).toBe(USER_KEY);
    expect(seenTenant).toBe(TENANT);
    // Outside any context there is no principal.
    const outside = await resolveInference({ tier: 'good' }, { resolver });
    expect(outside.via).toBe('default');
  });
});

describe('cache', () => {
  it('caches per (tenant, user), invalidates on write, and expires by TTL', async () => {
    let clock = 0;
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
      now: () => clock,
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
    });
    const model = async () =>
      (await resolveInference({ tier: 'good' }, { resolver })).target.model;

    expect(await model()).toBe('user/default-model');
    expect(await model()).toBe('user/default-model');
    // user + tenant read once, then served from cache
    expect(secrets.retrieve).toHaveBeenCalledTimes(2);

    await resolver.write('user', { ...userConfig, model: 'user/new-model' });
    expect(secrets.store).toHaveBeenCalledWith(
      inferenceProviderConfigSecretName({ userId: USER }),
      expect.any(String),
      expect.objectContaining({ category: 'inference.provider-config' }),
    );
    expect(await model()).toBe('user/new-model');
    expect(secrets.retrieve).toHaveBeenCalledTimes(4);

    // A write elsewhere is seen after invalidate() or the TTL.
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
      model: 'user/external',
    });
    expect(await model()).toBe('user/new-model');
    clock += 31_000;
    expect(await model()).toBe('user/external');

    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
      model: 'user/after-invalidate',
    });
    resolver.invalidate({ tenantId: TENANT });
    expect(await model()).toBe('user/after-invalidate');

    expect(await resolver.remove('user')).toBe(true);
    expect((await resolveInference({ tier: 'good' }, { resolver })).via).toBe(
      'default',
    );
  });

  it('refuses a user write without a user principal and an invalid config', async () => {
    const { resolver, principal } = setup({ principal: { tenantId: TENANT } });
    await expect(resolver.write('user', userConfig)).rejects.toThrow(/user id/);
    await expect(
      resolver.write('tenant', { provider: 'openai', apiKey: TENANT_KEY }),
    ).rejects.toThrow(InferenceProviderConfigError);
    // A provider-only binding would borrow the server's environment key.
    await expect(
      resolver.write('tenant', { provider: 'anthropic', model: 'x' }),
    ).rejects.toThrow(/baseUrl is required.*apiKey is required/);
    principal.current = undefined;
    await expect(resolver.write('tenant', tenantConfig)).rejects.toThrow(
      /tenant context/,
    );
  });
});

describe('hosted gateway key alias (#4759)', () => {
  const hosted = {
    source: 'hosted',
    mode: 'hosted',
    provider: 'litellm',
    baseUrl: 'https://llm.example.test/v1',
    apiKey: 'sk-hosted-key',
    gatewayKeyAlias: 'smrt-t-u-g0',
    tiers: {
      cheap: {
        provider: 'litellm',
        baseUrl: 'https://llm.example.test/v1',
        apiKey: 'sk-hosted-key',
        model: 'small',
      },
    },
  };

  it('tags every tier target with the alias and redacts the key, not the alias', () => {
    const config = parseInferenceProviderConfig(hosted);
    const targets = inferenceProviderTargets(config);
    expect(targets.cheap?.usageTags).toEqual({
      gatewayKeyAlias: 'smrt-t-u-g0',
    });
    expect(targets.best?.usageTags).toEqual({ gatewayKeyAlias: 'smrt-t-u-g0' });
    const redacted = redactInferenceProviderConfig(config);
    expect(redacted.gatewayKeyAlias).toBe('smrt-t-u-g0');
    expect(JSON.stringify(redacted)).not.toContain('sk-hosted-key');
  });

  it('refuses an alias outside a hosted config', () => {
    expect(() =>
      parseInferenceProviderConfig({ ...hosted, source: 'byo' }),
    ).toThrow(InferenceProviderConfigError);
    expect(() =>
      parseInferenceProviderConfig({ ...hosted, gatewayKeyAlias: '' }),
    ).toThrow(/gatewayKeyAlias/);
  });

  it('invalidates every live resolver for a writer outside them', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
    });
    const first = await resolver.resolveBindings();
    expect(first.user).toBeDefined();
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
      model: 'changed-model',
    });
    expect((await resolver.resolveBindings()).user?.model).toBe(
      first.user?.model,
    );
    invalidateUserInferenceResolvers({ tenantId: TENANT, userId: USER });
    expect((await resolver.resolveBindings()).user?.model).toBe(
      'changed-model',
    );
  });
});

describe('redaction and errors', () => {
  it('never returns a key in the redacted binding map', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
      tiers: { best: { preset: 'openrouter', model: 'x', apiKey: USER_KEY } },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({}), tenantConfig);

    const map = await resolver.resolveBindings({ redact: true });
    const serialized = JSON.stringify(map);
    expect(serialized).not.toContain(USER_KEY);
    expect(serialized).not.toContain(TENANT_KEY);
    expect(map.tiers.best).toMatchObject({
      layer: 'user',
      hasApiKey: true,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(map.tiers.best).not.toHaveProperty('apiKey');
    expect(map.user).toMatchObject({ hasApiKey: true });
    expect(map.tenant).toMatchObject({ hasApiKey: true });

    // Redaction is the default.
    expect(JSON.stringify(await resolver.resolveBindings())).not.toContain(
      USER_KEY,
    );
    const raw = await resolver.resolveBindings({ redact: false });
    expect(raw.tiers.good).toMatchObject({ apiKey: USER_KEY, layer: 'user' });
  });

  it('keeps credentials out of params and baseUrl, even in legacy rows', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    await expect(
      resolver.write('user', {
        ...userConfig,
        params: { temperature: 0.2, apiKey: 'sk-hidden' },
      }),
    ).rejects.toThrow(/params\.apiKey is not a supported generation option/);
    await expect(
      resolver.write('user', {
        ...userConfig,
        params: { stop: { Authorization: 'Bearer x' } },
      }),
    ).rejects.toThrow(/params\.stop must be a number or string/);
    await expect(
      resolver.write('user', {
        ...userConfig,
        baseUrl: 'https://user:sk-hidden@example.com/v1',
      }),
    ).rejects.toThrow(/baseUrl must be an http\(s\) URL without credentials/);
    await expect(
      resolver.write('user', {
        ...userConfig,
        baseUrl: 'https://example.com/v1?key=sk-hidden',
      }),
    ).rejects.toThrow(/without credentials, query or fragment/);

    // A row written before (or around) validation: parsing refuses it on
    // the call path, and the redaction helpers copy known fields only.
    const legacy = {
      ...userConfig,
      params: {
        temperature: 0.2,
        apiKey: 'sk-hidden',
        headers: { Authorization: 'Bearer sk-hidden' },
      },
    };
    const { redactInferenceProviderConfig, redactInferenceTarget } =
      await import('../provider-config.js');
    const view = JSON.stringify([
      redactInferenceProviderConfig(legacy as never),
      redactInferenceTarget({ ...legacy, extra: 'sk-hidden' } as never),
    ]);
    expect(view).not.toContain('sk-hidden');
    expect(view).not.toContain(USER_KEY);
    expect(view).toContain('"temperature":0.2');
    secrets.seed(
      TENANT,
      inferenceProviderConfigSecretName({ userId: USER }),
      legacy,
    );
    await expect(resolver.resolveBindings()).rejects.toThrow(
      InferenceProviderConfigError,
    );
  });

  it('fails closed on a corrupt stored config without echoing the key', async () => {
    const { secrets, resolver } = setup({ principal: { tenantId: TENANT } });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({}), {
      provider: 'openai',
      apiKey: TENANT_KEY,
    });
    const error = await resolveInference({ tier: 'good' }, { resolver }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InferenceProviderConfigError);
    expect(String((error as Error).message)).not.toContain(TENANT_KEY);
    expect((error as Error).message).toMatch(/baseUrl is required/);
  });
});

describe('registration', () => {
  it('sits behind the validating resolver in either import order', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
    });
    registerInference();
    registerUserInferenceResolver(resolver);
    registerInference(); // a later registration keeps the user resolver
    const active = getInferenceResolver();
    expect(active).not.toBe(resolver);

    const res = await resolveInference({ tier: 'good' }, { config: {} });
    expect(res.target.apiKey).toBe(USER_KEY);

    await expect(
      resolveInference(
        { tier: 'good' },
        { config: { tiers: { good: { alias: 'missing' } } } },
      ),
    ).rejects.toBeInstanceOf(InferenceConfigError);
  });

  it('feeds resolveInferenceTarget for raw getAI() sites with source tags', async () => {
    const { secrets, resolver } = setup({
      principal: { tenantId: TENANT, userId: USER },
    });
    secrets.seed(TENANT, inferenceProviderConfigSecretName({ userId: USER }), {
      ...userConfig,
    });
    registerUserInferenceResolver(resolver);
    const resolved = await resolveInferenceTarget({
      base: { provider: 'anthropic', model: 'site-model', apiKey: 'site-key' },
    });
    expect(resolved.bound).toBe(true);
    expect(resolved.source).toBe('byo');
    expect(resolved.options).toMatchObject({
      provider: 'openai',
      type: 'openai',
      model: 'user/default-model',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: USER_KEY,
    });
    expect(resolved.usageTags).toEqual({
      tierRequested: 'auto',
      tierResolved: 'good',
      source: 'byo',
    });
  });
});
