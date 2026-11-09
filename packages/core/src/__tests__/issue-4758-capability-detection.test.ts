/**
 * Capability detection (#4758): the resolution order of the capability
 * table, the JSON→text verdict fallback for is()/evaluate() (on the existing
 * is() fixtures), required-tool refusal, optional-tool drop, context
 * truncation, and unchanged requests for untiered calls and for models that
 * report (or are assumed to have) every capability.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config.js';
import { field } from '../decorators';
import {
  type InferenceExecutionContext,
  setInferenceExecutor,
  setInferenceResolver,
} from '../inference.js';
import {
  AI_UNAVAILABLE,
  InferenceUnavailableError,
} from '../inference-availability.js';
import {
  ASSUMED_INFERENCE_CAPABILITIES,
  detectInferenceCapabilities,
  inferenceCapabilitiesFromSdk,
  parseInferenceTextVerdict,
  resolveInferenceCapabilities,
} from '../inference-capabilities.js';
import { resolveInferenceTarget } from '../inference-target.js';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

@smrt()
class Issue4758Note extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

const TOOL = {
  type: 'function' as const,
  function: { name: 'lookup', description: 'x', parameters: {} },
};

/** SDK answer for a small text-only model on the provider's own endpoint. */
const TEXT_ONLY_SDK = {
  chat: true,
  functions: false,
  vision: false,
  maxContextLength: 0,
  supportedOperations: ['chat'],
};

interface FakeClient {
  message: ReturnType<typeof vi.fn>;
  getCapabilities?: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
}

let replies: string[] = [];
let clients: FakeClient[] = [];

function lastCall(): { prompt: string; options: Record<string, any> } {
  for (const client of [...clients].reverse()) {
    const call = client.message.mock.calls.at(-1);
    if (call) return { prompt: call[0], options: call[1] ?? {} };
  }
  throw new Error('no call');
}

function note(name = 'n') {
  const object = new Issue4758Note({
    ai: { provider: 'openai', apiKey: 'sk-base', model: 'big-model' },
  } as never);
  object.name = name;
  return object;
}

describe('capability table resolution order', () => {
  it('takes each field from the highest layer that states it', () => {
    expect(
      resolveInferenceCapabilities({
        provider: { tools: true },
        preset: { json: false, tools: false },
        probe: { maxContext: 8192, json: true },
        heuristic: { vision: false, maxContext: 2048, json: true },
      }),
    ).toEqual({
      json: false,
      tools: true,
      vision: false,
      maxContext: 8192,
      source: 'provider',
    });
    expect(
      resolveInferenceCapabilities({
        preset: { json: false },
        heuristic: { tools: false },
      }),
    ).toEqual({ json: false, tools: false, vision: true, source: 'preset' });
    expect(
      resolveInferenceCapabilities({ probe: { maxContext: 4096 } }).source,
    ).toBe('probe');
    // A heuristic switches features off but is reported as assumed.
    expect(
      resolveInferenceCapabilities({ heuristic: { json: false } }),
    ).toEqual({ json: false, tools: true, vision: true, source: 'assumed' });
    expect(resolveInferenceCapabilities()).toEqual(
      ASSUMED_INFERENCE_CAPABILITIES,
    );
  });

  it('maps an SDK answer and ignores it on a custom endpoint', () => {
    expect(
      inferenceCapabilitiesFromSdk({
        functions: true,
        vision: false,
        maxContextLength: 131072,
        supportedOperations: ['chat', 'json_object'],
      }),
    ).toEqual({ tools: true, vision: false, maxContext: 131072, json: true });
    expect(
      detectInferenceCapabilities(
        { provider: 'openai', model: 'gpt-x' },
        TEXT_ONLY_SDK,
      ),
    ).toMatchObject({
      tools: false,
      vision: false,
      json: true,
      source: 'provider',
    });
    // On a preset's server the SDK's vendor table is not an answer.
    expect(
      detectInferenceCapabilities(
        {
          provider: 'openai',
          model: 'qwen',
          baseUrl: 'http://127.0.0.1:1234/v1/',
        },
        TEXT_ONLY_SDK,
      ),
    ).toEqual({ json: false, tools: true, vision: true, source: 'preset' });
    expect(
      detectInferenceCapabilities({
        provider: 'webllm',
        model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      }),
    ).toEqual({ json: false, tools: false, vision: false, source: 'assumed' });
    expect(
      detectInferenceCapabilities({ provider: 'anthropic', model: 'claude' }),
    ).toEqual(ASSUMED_INFERENCE_CAPABILITIES);
  });

  it('puts static capabilities on resolveInferenceTarget results', async () => {
    const resolved = await resolveInferenceTarget({
      tier: 'cheap',
      base: { provider: 'openai', model: 'tinyllama-1.1b', apiKey: 'k' },
    });
    expect(resolved.capabilities).toMatchObject({
      json: false,
      tools: false,
      maxContext: 2048,
    });
  });
});

describe('text verdict parse', () => {
  it('reads the existing is() fixtures and leading yes/no words', () => {
    expect(parseInferenceTextVerdict(JSON.stringify({ result: true }))).toBe(
      true,
    );
    expect(parseInferenceTextVerdict('{"result": false}')).toBe(false);
    expect(parseInferenceTextVerdict('Yes, it does.')).toBe(true);
    expect(parseInferenceTextVerdict('**No**')).toBe(false);
    expect(parseInferenceTextVerdict('true')).toBe(true);
    expect(
      parseInferenceTextVerdict('Sure: {"result": true} is my answer'),
    ).toBe(true);
    expect(parseInferenceTextVerdict('totally not json')).toBeUndefined();
    expect(
      parseInferenceTextVerdict(JSON.stringify({ result: 'maybe' })),
    ).toBeUndefined();
  });
});

describe('object operations against a text-only model', () => {
  beforeEach(() => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    replies = [];
    clients = [];
    getAIMock.mockReset();
    getAIMock.mockImplementation(
      async (options: Record<string, unknown>): Promise<FakeClient> => {
        const model = String(options.model ?? '');
        const client: FakeClient = {
          options,
          message: vi.fn(async () => replies.shift() ?? 'ok'),
          ...(model.startsWith('tiny') || model === 'no-tools'
            ? { getCapabilities: vi.fn(async () => TEXT_ONLY_SDK) }
            : {}),
        };
        clients.push(client);
        return client;
      },
    );
    config({
      inference: {
        tiers: {
          // Heuristic: no JSON, no tools, 2048-token context.
          cheap: { model: 'tinyllama-1.1b-chat' },
          // Provider answer: no tools; JSON and context not reported.
          good: { model: 'no-tools' },
          // No getCapabilities(): assumed, today's behavior.
          great: { model: 'other-model' },
        },
      },
    });
  });
  afterEach(() => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    vi.restoreAllMocks();
  });

  it('is() asks for a text verdict and parses the existing fixtures', async () => {
    for (const [reply, expected] of [
      [JSON.stringify({ result: true }), true],
      [JSON.stringify({ result: false }), false],
      ['Yes', true],
      ['no.', false],
    ] as const) {
      replies.push(reply);
      expect(await note().is('is it good?', { tier: 'cheap' })).toBe(expected);
      const { prompt, options } = lastCall();
      expect(prompt).toContain('Answer with the single word yes or no.');
      expect(options).not.toHaveProperty('responseFormat');
      expect(options.usageTags).toMatchObject({
        capabilityFallback: 'json→text',
        tierResolved: 'cheap',
      });
    }
    replies.push('totally not json');
    await expect(note().is('check', { tier: 'cheap' })).rejects.toThrow(
      /Unexpected answer/,
    );
  });

  it('strips a JSON responseFormat from caller options and target params on the text path', async () => {
    replies.push('yes');
    await note().is('ok?', {
      tier: 'cheap',
      responseFormat: { type: 'json_object' },
    } as never);
    expect(lastCall().options).not.toHaveProperty('responseFormat');

    replies.push('done');
    await note().do('x', {
      tier: 'cheap',
      responseFormat: { type: 'json_object' },
    } as never);
    expect(lastCall().options).not.toHaveProperty('responseFormat');
    expect(lastCall().options.usageTags.capabilityFallback).toBe('json→text');

    config({
      inference: {
        tiers: {
          cheap: {
            model: 'tinyllama-1.1b-chat',
            params: { responseFormat: { type: 'json_object' } },
          },
        },
      },
    });
    replies.push('no');
    await expect(note().is('ok?', { tier: 'cheap' })).resolves.toBe(false);
    expect(lastCall().options).not.toHaveProperty('responseFormat');
  });

  it('detects capabilities for the model the call runs, not the bound one', async () => {
    // `great` is bound to a capable model; the caller overrides it with a
    // small local one.
    replies.push('yes');
    await expect(
      note().is('ok?', { tier: 'great', model: 'tinyllama-1.1b-chat' }),
    ).resolves.toBe(true);
    expect(lastCall().options.model).toBe('tinyllama-1.1b-chat');
    expect(lastCall().options).not.toHaveProperty('responseFormat');

    replies.push('yes');
    await expect(
      note().evaluate('ok?', {
        tier: 'great',
        generativeModel: 'tinyllama-1.1b-chat',
      }),
    ).resolves.toEqual({ result: true, route: 'generative' });
    expect(lastCall().options).not.toHaveProperty('responseFormat');

    // The bound client's SDK answer (no tools) does not describe an
    // override: required tools stay on for the overriding model.
    const object = note();
    vi.spyOn(object, 'getAvailableTools').mockReturnValue([TOOL] as never);
    await object.do('x', { tier: 'good', model: 'other-model' });
    expect(lastCall().options.tools).toEqual([TOOL]);
    expect(lastCall().options.usageTags).not.toHaveProperty(
      'capabilityFallback',
    );

    // And the reverse: a capable override on the small binding keeps JSON.
    replies.push('{"result": true}');
    await note().is('ok?', { tier: 'cheap', model: 'other-model' });
    expect(lastCall().options.responseFormat).toEqual({ type: 'json_object' });
  });

  it("evaluate()'s generative path falls back the same way", async () => {
    replies.push('yes');
    await expect(
      note().evaluate('is it good?', { tier: 'cheap' }),
    ).resolves.toEqual({ result: true, route: 'generative' });
    expect(lastCall().options).not.toHaveProperty('responseFormat');
    expect(lastCall().options.usageTags.capabilityFallback).toBe('json→text');
  });

  it('refuses required tools with a typed capability error and no call', async () => {
    const object = note();
    vi.spyOn(object, 'getAvailableTools').mockReturnValue([TOOL] as never);
    const error = await object
      .do('look it up', { tier: 'good' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InferenceUnavailableError);
    expect(error).toMatchObject({
      code: AI_UNAVAILABLE,
      reason: 'capability',
      details: { capability: 'tools', source: 'provider' },
    });
    for (const client of clients) expect(client.message).not.toHaveBeenCalled();
    await expect(object.describe({ tier: 'good' })).rejects.toBeInstanceOf(
      InferenceUnavailableError,
    );
  });

  it('drops optional tools with a tag', async () => {
    const object = note();
    vi.spyOn(object, 'getAvailableTools').mockReturnValue([TOOL] as never);
    await object.do('look it up', { tier: 'good', toolUse: 'optional' });
    const { options } = lastCall();
    expect(options.tools).toBeUndefined();
    expect(options).not.toHaveProperty('toolUse');
    expect(options.usageTags.capabilityFallback).toBe('tools→none');
    // JSON was not reported by the SDK, so is() keeps JSON mode.
    replies.push('{"result": true}');
    await object.is('ok?', { tier: 'good', toolUse: 'optional' });
    expect(lastCall().options.responseFormat).toEqual({ type: 'json_object' });
    expect(lastCall().options.usageTags.capabilityFallback).toBe('tools→none');
  });

  it('truncates oversized object data to the known context with a tag', async () => {
    const object = note('x'.repeat(20000));
    await object.do('summarize', { tier: 'cheap' });
    const { prompt, options } = lastCall();
    expect(prompt.length).toBeLessThanOrEqual(2048 * 3);
    expect(prompt).toContain('[truncated: object data exceeded');
    expect(prompt).toContain('summarize');
    expect(options.usageTags.truncated).toBe('true');

    await expect(
      note().do('y'.repeat(20000), { tier: 'cheap', includeData: false }),
    ).rejects.toMatchObject({
      reason: 'capability',
      details: { capability: 'context', maxContext: 2048 },
    });
  });

  it('leaves untiered calls and assumed-capable models unchanged', async () => {
    const untiered = note('x'.repeat(20000));
    vi.spyOn(untiered, 'getAvailableTools').mockReturnValue([TOOL] as never);
    replies.push('{"result": true}');
    await untiered.is('ok?');
    let { options } = lastCall();
    expect(options.responseFormat).toEqual({ type: 'json_object' });
    expect(options.tools).toEqual([TOOL]);
    expect(options.usageTags).toBeUndefined();

    replies.push('{"result": true}');
    const assumed = note();
    vi.spyOn(assumed, 'getAvailableTools').mockReturnValue([TOOL] as never);
    await assumed.is('ok?', { tier: 'great' });
    ({ options } = lastCall());
    expect(options.responseFormat).toEqual({ type: 'json_object' });
    expect(options.tools).toEqual([TOOL]);
    expect(options.usageTags).toEqual({
      tierRequested: 'great',
      tierResolved: 'great',
    });
  });

  it('hands chain targets the permitted fallbacks and a capability detector', async () => {
    let captured: InferenceExecutionContext | undefined;
    const sent: Array<Record<string, any>> = [];
    setInferenceExecutor({
      kinds: ['alias'],
      createClient: (context) => {
        captured = context;
        return {
          message: async (_text: string, options: Record<string, any> = {}) => {
            sent.push(options);
            return 'yes';
          },
        };
      },
    });
    try {
      config({
        inference: {
          tiers: { best: { alias: 'local' } },
          aliases: {
            local: { candidates: [{ provider: 'openai', model: 'a' }] },
          },
        },
      });
      const object = note();
      vi.spyOn(object, 'getAvailableTools').mockReturnValue([TOOL] as never);
      // A chain may answer in text: the verdict parse accepts it.
      await expect(
        object.is('ok?', { tier: 'best', toolUse: 'optional' }),
      ).resolves.toBe(true);
      expect(sent[0]?.responseFormat).toEqual({ type: 'json_object' });
      expect(sent[0]?.capabilityFallback).toEqual({
        json: 'text',
        tools: 'drop',
      });
      await object.do('x', { tier: 'best' });
      expect(sent[1]).not.toHaveProperty('capabilityFallback');
      await expect(
        captured?.capabilitiesFor?.({ model: 'tinyllama-1.1b-chat' }),
      ).resolves.toMatchObject({
        json: false,
        tools: false,
        source: 'provider',
      });
    } finally {
      setInferenceExecutor(undefined);
    }
  });
});
