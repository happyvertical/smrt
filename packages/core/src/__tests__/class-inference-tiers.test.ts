/**
 * Tier clients on SmrtClass/SmrtObject (#4750): unconfigured parity, per-target
 * caching, provider ownership, per-call tier options and usage tags.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { SmrtClass } from '../class.js';
import { config } from '../config.js';
import { field } from '../decorators';
import { setInferenceResolver } from '../inference.js';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

class TierProbe extends SmrtClass {
  async client(...args: Parameters<SmrtClass['getAiClient']>) {
    return this.getAiClient(...args);
  }
  async prepare(options: Record<string, unknown>) {
    return this.prepareAiOperation(options);
  }
}

@smrt()
class Issue4750Note extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

interface FakeClient {
  embed: () => void;
  message: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
}

const ENV_KEYS = [
  'SMRT_AI_PROVIDER',
  'SMRT_AI_API_KEY',
  'SMRT_AI_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'HAVE_AI_BASE_URL',
  'HAVE_AI_API_KEY',
  'SMRT_INFERENCE_DEFAULT_TIER',
];

/** The default generation client, read through the protected accessor. */
async function clientOf(target: SmrtObject): Promise<FakeClient> {
  const accessor = target as unknown as {
    getOptionalAiClient(): Promise<unknown>;
  };
  return (await accessor.getOptionalAiClient()) as FakeClient;
}

const BASE_AI = { provider: 'openai', apiKey: 'sk-base', model: 'base-model' };

describe('SmrtClass inference tiers', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    getAIMock.mockReset();
    getAIMock.mockImplementation(
      async (options: Record<string, unknown>): Promise<FakeClient> => ({
        embed: () => {},
        message: vi.fn(async () => '{"result": true}'),
        options,
      }),
    );
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

  it('returns the configured client for every tier when unconfigured', async () => {
    const probe = new TierProbe({ ai: BASE_AI } as never);
    const base = await probe.client();
    for (const tier of ['cheap', 'good', 'great', 'best', 'auto'] as const) {
      expect(await probe.client(tier)).toBe(base);
    }
    expect(getAIMock).toHaveBeenCalledTimes(1);
  });

  it('prepareAiOperation() is available to non-object classes (collections, #4755)', async () => {
    const probe = new TierProbe({
      ai: BASE_AI,
      inference: { tiers: { cheap: { model: 'mini' } } },
    } as never);
    const plain = await probe.prepare({ temperature: 0.2 });
    expect(plain.ai).toBe(await probe.client());
    expect(plain.aiOptions).toEqual({ temperature: 0.2 });

    const tiered = await probe.prepare({
      tier: 'cheap',
      latency: 'background',
      promptKey: 'probe.prompt',
      usageTags: { promptKey: 'probe.prompt' },
    });
    expect(tiered.aiOptions).toEqual({
      model: 'mini',
      usageTags: {
        promptKey: 'probe.prompt',
        tierRequested: 'cheap',
        tierResolved: 'cheap',
      },
    });
  });

  it('keeps an injected client for unbound tiers and model-only targets', async () => {
    const injected = { embed: () => {}, message: vi.fn() };
    const probe = new TierProbe({
      ai: injected,
      inference: { tiers: { cheap: { model: 'mini' } } },
    } as never);
    expect(await probe.client('best')).toBe(injected);
    expect(await probe.client('cheap')).toBe(injected);
    expect(getAIMock).not.toHaveBeenCalled();
  });

  it('builds and caches one client per resolved provider/model/baseUrl', async () => {
    config({
      inference: {
        tiers: {
          cheap: { model: 'mini' },
          good: { model: 'mini' },
          great: { model: 'base-model' },
          best: { model: 'big' },
        },
      },
    });
    const probe = new TierProbe({ ai: BASE_AI } as never);
    const base = (await probe.client()) as unknown as FakeClient;
    const cheap = (await probe.client('cheap')) as unknown as FakeClient;
    expect(await probe.client('good')).toBe(cheap);
    expect(await probe.client('cheap')).toBe(cheap);
    // A target equal to the configured identity reuses the default client.
    expect(await probe.client('great')).toBe(base);
    const best = (await probe.client('best')) as unknown as FakeClient;
    expect(best).not.toBe(cheap);
    expect(getAIMock).toHaveBeenCalledTimes(3);
    // Same provider: the configured key and provider are inherited.
    expect(cheap.options).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-base',
      model: 'mini',
      defaultModel: 'mini',
    });
  });

  it('never sends the configured key to a different provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
    const probe = new TierProbe({
      ai: BASE_AI,
      inference: { tiers: { best: { provider: 'anthropic', model: 'opus' } } },
    } as never);
    const best = (await probe.client('best')) as unknown as FakeClient;
    expect(best.options).toMatchObject({
      provider: 'anthropic',
      type: 'anthropic',
      apiKey: 'sk-anthropic',
      model: 'opus',
    });
    expect(JSON.stringify(best.options)).not.toContain('sk-base');
  });

  it('never sends the configured key to a target endpoint (same provider)', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-openai';
    const probe = new TierProbe({
      ai: BASE_AI,
      inference: {
        tiers: {
          cheap: { baseUrl: 'https://vllm.example/v1', model: 'local' },
          good: { provider: 'openai', baseUrl: 'https://router.example/v1' },
          great: {
            baseUrl: 'https://router.example/v1',
            apiKey: 'sk-router',
          },
        },
      },
    } as never);
    await probe.client();
    getAIMock.mockClear();
    // The SDK would fill an unset key from OPENAI_API_KEY: fail closed first.
    for (const tier of ['cheap', 'good'] as const) {
      await expect(probe.client(tier)).rejects.toThrow(
        /must carry its own apiKey/,
      );
    }
    expect(getAIMock).not.toHaveBeenCalled();
    const great = (await probe.client('great')) as unknown as FakeClient;
    expect(great.options).toMatchObject({ apiKey: 'sk-router' });
  });

  it('sends a target key only with its own explicit endpoint', async () => {
    const probe = new TierProbe({
      ai: { ...BASE_AI, baseUrl: 'https://proxy.internal/v1' },
      inference: {
        tiers: {
          best: { apiKey: 'sk-user', model: 'byo' },
          great: { apiKey: 'sk-user', baseUrl: 'https://api.openai.com/v1' },
        },
      },
    } as never);
    await probe.client();
    getAIMock.mockClear();
    // getAI()/the provider SDK would fill an unset endpoint from HAVE_AI_* or
    // OPENAI_BASE_URL: a key without its endpoint fails closed first.
    await expect(probe.client('best')).rejects.toThrow(/must name its baseUrl/);
    expect(getAIMock).not.toHaveBeenCalled();
    const great = (await probe.client('great')) as unknown as FakeClient;
    expect(great.options).toMatchObject({
      apiKey: 'sk-user',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('refuses SDK-wide HAVE_AI_* fallbacks for another provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
    for (const name of ['HAVE_AI_BASE_URL', 'HAVE_AI_API_KEY']) {
      process.env[name] = 'operator-value';
      try {
        const probe = new TierProbe({
          ai: BASE_AI,
          inference: { tiers: { best: { provider: 'anthropic' } } },
        } as never);
        await expect(probe.client('best')).rejects.toThrow(name);
      } finally {
        delete process.env[name];
      }
    }
  });

  it('keeps a target on the configured endpoint with the configured key', async () => {
    const probe = new TierProbe({
      ai: { ...BASE_AI, baseUrl: 'https://proxy.internal/v1' },
      inference: {
        tiers: { cheap: { baseUrl: 'https://proxy.internal/v1', model: 'm' } },
      },
    } as never);
    const cheap = (await probe.client('cheap')) as unknown as FakeClient;
    expect(cheap.options).toMatchObject({
      apiKey: 'sk-base',
      baseUrl: 'https://proxy.internal/v1',
      model: 'm',
    });
  });

  it('separates cached clients by credential', async () => {
    let key = 'sk-u1';
    setInferenceResolver({
      resolve: (request) => ({
        tierResolved: request.tier === 'auto' ? 'good' : request.tier,
        target: {
          provider: 'openai',
          model: 'byo',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: key,
        },
        via: 'resolver',
      }),
    });
    const probe = new TierProbe({ ai: BASE_AI } as never);
    const first = await probe.client('good');
    key = 'sk-u2';
    const second = await probe.client('good');
    expect(second).not.toBe(first);
    key = 'sk-u1';
    expect(await probe.client('good')).toBe(first);
  });

  it('does not cache a failed client build', async () => {
    const probe = new TierProbe({
      ai: BASE_AI,
      inference: { tiers: { cheap: { model: 'mini' } } },
    } as never);
    await probe.client();
    getAIMock.mockRejectedValueOnce(new Error('boom'));
    await expect(probe.client('cheap')).rejects.toThrow('boom');
    await expect(probe.client('cheap')).resolves.toBeDefined();
  });

  it('do() and describe() leave options untouched without a tier', async () => {
    const note = new Issue4750Note({ ai: BASE_AI } as never);
    note.name = 'n';
    await note.do('x', { temperature: 0.2 });
    await note.describe({ usageTags: { feature: 'f' } });
    const client = await clientOf(note);
    expect(client.message.mock.calls[0][1]).toEqual({
      temperature: 0.2,
      tools: undefined,
    });
    expect(client.message.mock.calls[1][1]).toEqual({
      usageTags: { feature: 'f' },
      tools: undefined,
    });
  });

  it('do() routes a tier, tags auto → tier, and applies target defaults', async () => {
    config({
      inference: {
        defaultTier: 'cheap',
        tiers: {
          cheap: { model: 'mini', params: { temperature: 0.1, maxTokens: 9 } },
        },
      },
    });
    const note = new Issue4750Note({ ai: BASE_AI } as never);
    await note.do('x', {
      tier: 'auto',
      latency: 'interactive',
      maxTokens: 50,
      usageTags: { feature: 'f', tierResolved: 'spoofed' },
    });
    const cheap = getAIMock.mock.results[1].value as Promise<FakeClient>;
    const options = (await cheap).message.mock.calls[0][1];
    expect(options).toEqual({
      temperature: 0.1,
      maxTokens: 50,
      model: 'mini',
      usageTags: { feature: 'f', tierRequested: 'auto', tierResolved: 'cheap' },
      tools: undefined,
    });
    expect(options).not.toHaveProperty('tier');
    expect(options).not.toHaveProperty('latency');
  });

  it('tags the unconfigured tier path on the configured client', async () => {
    const note = new Issue4750Note({ ai: BASE_AI } as never);
    expect(await note.is('ok', { tier: 'best' })).toBe(true);
    const client = await clientOf(note);
    expect(client.message.mock.calls[0][1]).toMatchObject({
      usageTags: { tierRequested: 'best', tierResolved: 'best' },
    });
    expect(getAIMock).toHaveBeenCalledTimes(1);
  });

  it('passes class, tenant-free context and latency to an instance resolver', async () => {
    const resolve = vi.fn((_request: Record<string, unknown>) => undefined);
    const note = new Issue4750Note({
      ai: BASE_AI,
      inference: { resolve },
    } as never);
    await note.describe({
      tier: 'great',
      latency: 'background',
      promptKey: 'notes.describe',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toMatchObject({
      tier: 'great',
      latency: 'background',
      className: 'Issue4750Note',
      promptKey: 'notes.describe',
    });
    const client = await clientOf(note);
    expect(client.message.mock.calls[0][1]).not.toHaveProperty('promptKey');
  });

  it('evaluate() keeps decisions separate and tiers its generative route', async () => {
    const decide = vi.fn(async (_request: unknown, _options?: object) => ({
      provenance: { provider: 'typesafe', model: 'd1' },
      answers: { result: { type: 'predicate', probability: 0.9 } },
    }));
    const note = new Issue4750Note({
      ai: BASE_AI,
      decisions: {
        getCapabilities: async () => ({ decisions: true }),
        decide,
      },
    } as never);
    const decided = await note.evaluate('ok', { tier: 'best' });
    expect(decided.route).toBe('decision');
    expect(decide.mock.calls[0][1]).not.toHaveProperty('tier');
    // Only the default generation client was built, and it was not called.
    expect(getAIMock).toHaveBeenCalledTimes(1);
    const unused = await clientOf(note);
    expect(unused.message).not.toHaveBeenCalled();

    const plain = new Issue4750Note({ ai: BASE_AI } as never);
    const generated = await plain.evaluate('ok', { tier: 'cheap' });
    expect(generated.route).toBe('generative');
    const client = await clientOf(plain);
    expect(client.message.mock.calls[0][1]).toMatchObject({
      usageTags: { tierRequested: 'cheap', tierResolved: 'cheap' },
    });
  });
});
