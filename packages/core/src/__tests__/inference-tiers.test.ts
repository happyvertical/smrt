/**
 * Inference tier vocabulary, config precedence, and the resolver seam (#4750).
 */
import { clearRuntimeConfig, setConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  compareInferenceTiers,
  DEFAULT_INFERENCE_TIER,
  getInferenceConfig,
  getInferenceResolver,
  INFERENCE_TIERS,
  type InferenceResolver,
  isInferenceTier,
  isInferenceTierRequest,
  mergeInferenceConfigs,
  resolveInference,
  resolveInferenceFromConfig,
  setInferenceResolver,
} from '../inference.js';

const ENV_KEYS = [
  'SMRT_INFERENCE_DEFAULT_TIER',
  'SMRT_INFERENCE_CHEAP_PROVIDER',
  'SMRT_INFERENCE_CHEAP_MODEL',
];

describe('inference tiers', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
  });

  it('orders the tiers cheapest first and excludes fast', () => {
    expect(INFERENCE_TIERS).toEqual(['cheap', 'good', 'great', 'best']);
    expect(compareInferenceTiers('cheap', 'good')).toBeLessThan(0);
    expect(compareInferenceTiers('best', 'great')).toBeGreaterThan(0);
    expect(compareInferenceTiers('great', 'great')).toBe(0);
    expect(isInferenceTier('fast')).toBe(false);
    expect(isInferenceTier('auto')).toBe(false);
    expect(isInferenceTierRequest('auto')).toBe(true);
    expect(isInferenceTierRequest('best')).toBe(true);
    expect(DEFAULT_INFERENCE_TIER).toBe('good');
  });

  it('resolves every tier to the configured client with no config', async () => {
    expect(getInferenceConfig()).toBeUndefined();
    for (const tier of INFERENCE_TIERS) {
      expect(await resolveInference({ tier })).toEqual({
        tierResolved: tier,
        target: {},
        via: 'default',
      });
    }
  });

  it('resolves auto to defaultTier, else good, without a model call', async () => {
    expect((await resolveInference({ tier: 'auto' })).tierResolved).toBe(
      'good',
    );
    config({ inference: { defaultTier: 'cheap' } });
    expect((await resolveInference({ tier: 'auto' })).tierResolved).toBe(
      'cheap',
    );
  });

  it('returns a bound target with via config', () => {
    const resolution = resolveInferenceFromConfig(
      { tier: 'best' },
      { tiers: { best: { provider: 'anthropic', model: 'big' } } },
    );
    expect(resolution).toEqual({
      tierResolved: 'best',
      target: { provider: 'anthropic', model: 'big' },
      via: 'config',
    });
  });

  it('rejects unknown tiers and invalid config', async () => {
    await expect(resolveInference({ tier: 'fast' as never })).rejects.toThrow(
      /Unknown inference tier "fast"/,
    );
    expect(() =>
      resolveInferenceFromConfig(
        { tier: 'auto' },
        { defaultTier: 'auto' as never },
      ),
    ).toThrow(/defaultTier/);
    expect(() =>
      resolveInferenceFromConfig(
        { tier: 'good' },
        { tiers: { fast: {} } as never },
      ),
    ).toThrow(/unknown tier "fast"/);
  });

  it('layers smrt.config < config() < env, replacing targets whole', () => {
    // Runtime module overrides reach the same `smrt` module config a loaded
    // smrt.config `smrt` block does.
    setConfig({
      modules: {
        smrt: {
          inference: {
            defaultTier: 'great',
            tiers: {
              cheap: { provider: 'openai', model: 'mini', apiKey: 'sk-file' },
              best: { provider: 'anthropic', model: 'opus' },
            },
          },
        },
      },
    } as never);
    config({ inference: { tiers: { cheap: { model: 'nano' } } } });
    expect(getInferenceConfig()).toEqual({
      defaultTier: 'great',
      tiers: {
        // config() replaced the whole target: the file key did not survive.
        cheap: { model: 'nano' },
        best: { provider: 'anthropic', model: 'opus' },
      },
    });

    process.env.SMRT_INFERENCE_DEFAULT_TIER = 'best';
    process.env.SMRT_INFERENCE_CHEAP_PROVIDER = 'gemini';
    process.env.SMRT_INFERENCE_CHEAP_MODEL = 'flash';
    expect(getInferenceConfig()).toMatchObject({
      defaultTier: 'best',
      tiers: { cheap: { provider: 'gemini', model: 'flash' } },
    });
  });

  it('merges instance layers above process layers', () => {
    expect(
      mergeInferenceConfigs(
        { defaultTier: 'cheap', tiers: { good: { model: 'a' } } },
        undefined,
        { tiers: { good: { model: 'b' } } },
      ),
    ).toEqual({ defaultTier: 'cheap', tiers: { good: { model: 'b' } } });
  });

  it('routes through a registered resolver with full request context', async () => {
    const seen: unknown[] = [];
    const resolver: InferenceResolver = {
      resolve(request, context) {
        seen.push(request);
        if (request.userId === 'u1') {
          return {
            tierResolved: request.tier === 'auto' ? 'great' : request.tier,
            target: { provider: 'openai', model: `user-${request.tier}` },
            via: 'resolver',
          };
        }
        return context.resolveFromConfig(request);
      },
    };
    setInferenceResolver(resolver);
    expect(getInferenceResolver()).toBe(resolver);

    const request = {
      tier: 'cheap' as const,
      latency: 'interactive' as const,
      tenantId: 't1',
      userId: 'u1',
      className: 'Doc',
      promptKey: 'docs.summarize',
    };
    expect(await resolveInference(request)).toEqual({
      tierResolved: 'cheap',
      target: { provider: 'openai', model: 'user-cheap' },
      via: 'resolver',
    });
    expect(seen[0]).toEqual(request);
    expect((await resolveInference({ tier: 'cheap' })).via).toBe('default');
  });

  it('falls back to config when the resolver defers', async () => {
    setInferenceResolver({ resolve: () => undefined });
    config({ inference: { tiers: { good: { model: 'm' } } } });
    expect(await resolveInference({ tier: 'auto' })).toEqual({
      tierResolved: 'good',
      target: { model: 'm' },
      via: 'config',
    });
  });

  it('rejects malformed resolvers, resolutions, and silent substitutions', async () => {
    expect(() => setInferenceResolver({} as never)).toThrow(/resolve\(\)/);
    setInferenceResolver({ resolve: () => ({ tierResolved: 'x' }) as never });
    await expect(resolveInference({ tier: 'good' })).rejects.toThrow(
      /invalid resolution/,
    );
    setInferenceResolver({
      resolve: () => ({ tierResolved: 'cheap', target: {}, via: 'resolver' }),
    });
    await expect(resolveInference({ tier: 'best' })).rejects.toThrow(
      /a resolver must not substitute tiers/,
    );
    // `auto` may resolve to any tier.
    expect((await resolveInference({ tier: 'auto' })).tierResolved).toBe(
      'cheap',
    );
  });

  it('restores the built-in resolver when unregistered', async () => {
    setInferenceResolver({
      resolve: () => ({ tierResolved: 'best', target: {}, via: 'resolver' }),
    });
    setInferenceResolver(undefined);
    expect((await resolveInference({ tier: 'auto' })).via).toBe('default');
  });
});
