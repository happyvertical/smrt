/**
 * #4756: `resolveInferenceTarget()` binds a registered resolver's target onto
 * a raw `getAI()` site's options under core's pair rules, and the `source`
 * tag reaches the usage pipeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import {
  InferenceBindingError,
  type InferenceResolver,
  inferenceUsageTags,
  setInferenceResolver,
} from '../inference.js';
import {
  bindInferenceTarget,
  resolveInferenceTarget,
} from '../inference-target.js';

const resolverFor = (target: Record<string, unknown>): InferenceResolver => ({
  resolve: (request) => ({
    tierResolved: request.tier === 'auto' ? 'good' : request.tier,
    target,
    via: 'resolver',
  }),
});

const BASE = { provider: 'anthropic', model: 'site-model', apiKey: 'site-key' };

describe('#4756 resolveInferenceTarget', () => {
  beforeEach(() => {
    config.reset();
    setInferenceResolver(undefined);
  });
  afterEach(() => {
    config.reset();
    setInferenceResolver(undefined);
  });

  it('keeps the base options when the tier is unbound', async () => {
    const resolved = await resolveInferenceTarget({ base: BASE });
    expect(resolved.bound).toBe(false);
    expect(resolved.options).toEqual(BASE);
    expect(resolved.usageTags).toEqual({ source: 'app' });
    expect(resolved.source).toBe('app');
  });

  it('binds a registered target over the base, dropping the base key', async () => {
    setInferenceResolver(
      resolverFor({
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'smrt-local',
        model: 'local-model',
        source: 'local',
      }),
    );
    const resolved = await resolveInferenceTarget({
      base: { ...BASE, temperature: 0.2 },
      tier: 'cheap',
    });
    expect(resolved).toMatchObject({ bound: true, source: 'local' });
    expect(resolved.options).toEqual({
      provider: 'openai',
      type: 'openai',
      model: 'local-model',
      defaultModel: 'local-model',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'smrt-local',
      temperature: 0.2,
    });
    expect(resolved.usageTags).toEqual({
      tierRequested: 'cheap',
      tierResolved: 'cheap',
      source: 'local',
    });
  });

  it('refuses an unbound endpoint/key pair before any client is built', async () => {
    setInferenceResolver(
      resolverFor({ provider: 'openai', baseUrl: 'https://x.example/v1' }),
    );
    await expect(resolveInferenceTarget({ base: BASE })).rejects.toThrow(
      InferenceBindingError,
    );
    expect(() =>
      bindInferenceTarget(BASE, { provider: 'openai', apiKey: 'k' }, 'Site'),
    ).toThrow(/must name its baseUrl/);
  });

  it('keeps explicit site options against app bindings when appBindings is false', async () => {
    setInferenceResolver(
      resolverFor({ provider: 'openai', model: 'app-model', source: 'app' }),
    );
    const kept = await resolveInferenceTarget({
      base: BASE,
      appBindings: false,
    });
    expect(kept).toMatchObject({ bound: false, options: BASE });
    const applied = await resolveInferenceTarget({ base: BASE });
    expect(applied.bound).toBe(true);

    setInferenceResolver(
      resolverFor({
        provider: 'openai',
        model: 'user-model',
        baseUrl: 'https://u.example/v1',
        apiKey: 'sk-u',
        source: 'byo',
      }),
    );
    const user = await resolveInferenceTarget({
      base: BASE,
      appBindings: false,
    });
    expect(user).toMatchObject({ bound: true, source: 'byo' });
  });

  it('forwards tenant, userId: null and promptKey to the resolver', async () => {
    const seen: unknown[] = [];
    setInferenceResolver({
      resolve: (request) => {
        seen.push(request);
        return undefined;
      },
    });
    await resolveInferenceTarget({
      base: BASE,
      tenantId: 'tenant-a',
      userId: null,
      promptKey: 'k.one',
      className: 'Site',
    });
    expect(seen[0]).toEqual({
      tier: 'auto',
      tenantId: 'tenant-a',
      userId: null,
      className: 'Site',
      promptKey: 'k.one',
    });
  });

  it('leaves a chain target to getAiClient(tier) and keeps the base', async () => {
    setInferenceResolver(resolverFor({ alias: 'frontier', source: 'app' }));
    const resolved = await resolveInferenceTarget({ base: BASE });
    expect(resolved.bound).toBe(false);
    expect(resolved.options).toEqual(BASE);
  });

  it('attaches the usage recorder with the resolution tags and keeps the caller callback', async () => {
    const handler = { handle: vi.fn().mockResolvedValue(undefined) };
    config({ usage: { handlers: [handler] } });
    setInferenceResolver(
      resolverFor({
        provider: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-user',
        model: 'user-model',
        source: 'byo',
      }),
    );
    const callerOnUsage = vi.fn();
    const resolved = await resolveInferenceTarget({
      base: { ...BASE, onUsage: callerOnUsage },
      className: 'SiteRoute',
      usage: { tenantId: 'tenant-a', tags: { feature: 'site' } },
    });
    const onUsage = resolved.options?.onUsage as (e: unknown) => Promise<void>;
    await onUsage({
      provider: 'openai',
      model: 'user-model',
      operation: 'chat',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    expect(callerOnUsage).toHaveBeenCalledTimes(1);
    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0][0];
    expect(event).toMatchObject({
      className: 'SiteRoute',
      tenantId: 'tenant-a',
      tags: {
        tierRequested: 'auto',
        tierResolved: 'good',
        source: 'byo',
        feature: 'site',
      },
    });
    expect(JSON.stringify(event)).not.toContain('sk-user');
  });

  it('adds source to the tier usage tags only when the target names one', () => {
    expect(
      inferenceUsageTags('auto', {
        tierResolved: 'good',
        target: { source: 'hosted' },
        via: 'resolver',
      }),
    ).toEqual({
      tierRequested: 'auto',
      tierResolved: 'good',
      source: 'hosted',
    });
    expect(
      inferenceUsageTags('good', {
        tierResolved: 'good',
        target: { source: 'bogus' as never },
        via: 'resolver',
      }),
    ).toEqual({ tierRequested: 'good', tierResolved: 'good' });
  });

  it('adds the target usageTags under the tier keys (#4759)', () => {
    expect(
      inferenceUsageTags('good', {
        tierResolved: 'good',
        target: {
          source: 'hosted',
          usageTags: {
            gatewayKeyAlias: 'smrt-hosted-alias',
            source: 'byo',
            tierResolved: 'best',
            bogus: 3 as never,
          },
        },
        via: 'resolver',
      }),
    ).toEqual({
      gatewayKeyAlias: 'smrt-hosted-alias',
      tierRequested: 'good',
      tierResolved: 'good',
      source: 'hosted',
    });
  });

  it('never treats usageTags as client identity', () => {
    const bound = bindInferenceTarget(
      BASE,
      {
        provider: 'openai',
        baseUrl: 'https://gw.example.test/v1',
        apiKey: 'gw-key',
        usageTags: { gatewayKeyAlias: 'alias-1' },
      },
      'test',
    );
    expect(JSON.stringify(bound)).not.toContain('alias-1');
  });
});
