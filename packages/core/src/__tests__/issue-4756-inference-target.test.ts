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
    expect(resolved.usageTags).toEqual({
      tierRequested: 'auto',
      tierResolved: 'good',
    });
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
});
