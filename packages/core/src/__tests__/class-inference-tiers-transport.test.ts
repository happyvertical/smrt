/**
 * Tier endpoint/key ownership through the real `getAI()` factory and the real
 * provider SDK, with the HTTP transport intercepted (#4750 review): the SDK's
 * own environment fallbacks (`HAVE_AI_*`, `OPENAI_*`) must never redirect a
 * tier credential or supply one to a tier endpoint.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtClass } from '../class.js';
import { config } from '../config.js';
import { setInferenceResolver } from '../inference.js';

class TransportProbe extends SmrtClass {
  async client(...args: Parameters<SmrtClass['getAiClient']>) {
    return this.getAiClient(...args);
  }
}

const ENV = {
  HAVE_AI_BASE_URL: 'https://have-ai-env.example/v1',
  HAVE_AI_API_KEY: 'sk-have-ai-env',
  OPENAI_BASE_URL: 'https://openai-env.example/v1',
  OPENAI_API_KEY: 'sk-openai-env',
};

interface Captured {
  url: string;
  authorization: string | null;
}

function completion(): Response {
  return new Response(
    JSON.stringify({
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 0,
      model: 'tier-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('tier client transport ownership (real SDK)', () => {
  const saved: Record<string, string | undefined> = {};
  let captured: Captured[];

  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    captured = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        captured.push({
          url: request.url,
          authorization: request.headers.get('authorization'),
        });
        return completion();
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of Object.keys(ENV)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
  });

  it('sends a bound tier key only to its own endpoint despite SDK env fallbacks', async () => {
    const probe = new TransportProbe({
      ai: { provider: 'openai', apiKey: 'sk-base', model: 'base-model' },
      inference: {
        tiers: {
          best: {
            provider: 'openai',
            model: 'tier-model',
            baseUrl: 'https://tier.example/v1',
            apiKey: 'sk-tier',
          },
        },
      },
    } as never);
    const client = await probe.client('best');
    await client.message('hi');
    expect(captured).toHaveLength(1);
    expect(captured[0].url.startsWith('https://tier.example/v1/')).toBe(true);
    expect(captured[0].authorization).toBe('Bearer sk-tier');
  });

  it('never builds a client for an unbound key or endpoint', async () => {
    const probe = new TransportProbe({
      ai: { provider: 'openai', apiKey: 'sk-base', model: 'base-model' },
      inference: {
        tiers: {
          cheap: { baseUrl: 'https://tier.example/v1', model: 'm' },
          good: { apiKey: 'sk-user', model: 'm' },
          great: { provider: 'anthropic', model: 'm' },
        },
      },
    } as never);
    for (const tier of ['cheap', 'good', 'great'] as const) {
      await expect(probe.client(tier)).rejects.toThrow(/inference target/);
    }
    expect(captured).toHaveLength(0);
  });
});
