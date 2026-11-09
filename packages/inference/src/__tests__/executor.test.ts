/**
 * Chain executor (#4752) against fake clients: advance order, retry-once,
 * partial-stream rule, ladder degradation and its floor, usage tags and the
 * zero-usage failure row.
 */
import {
  AuthenticationError,
  ModelNotFoundError,
  RateLimitError,
} from '@happyvertical/ai';
import {
  InferenceBindingError,
  type InferenceCallOptions,
  type InferenceConfig,
  type InferenceExecutionContext,
  type InferenceModelClient,
  type InferenceTarget,
  type InferenceTier,
  InferenceUnavailableError,
  type InferenceUsageRecord,
  resolveInferenceFromConfig,
} from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import { InferenceExhaustedError } from '../errors.js';
import { createChainClient } from '../executor.js';

type Behavior = (
  text: string,
  options: InferenceCallOptions,
) => Promise<string> | string;

interface Harness {
  client: InferenceModelClient;
  calls: Array<{ model: string; options: InferenceCallOptions }>;
  usage: InferenceUsageRecord[];
  sleeps: number[];
}

/** Models answer by name; `behaviors[model]` is a queue or a function. */
function harness(
  config: InferenceConfig,
  behaviors: Record<string, Behavior | Behavior[]>,
  extra: Partial<InferenceExecutionContext> & { tier?: InferenceTier } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const usage: InferenceUsageRecord[] = [];
  const sleeps: number[] = [];
  const tier = extra.tier ?? 'great';
  const context: InferenceExecutionContext = {
    request: { tier },
    resolution: resolveInferenceFromConfig({ tier }, config),
    config,
    clientFor: async (target: InferenceTarget) => ({
      message: async (text: string, options: InferenceCallOptions = {}) => {
        const model = String(options.model ?? target.model ?? 'default');
        calls.push({ model, options });
        const entry = behaviors[model];
        const behavior = Array.isArray(entry) ? entry.shift() : entry;
        if (!behavior) return `answer from ${model}`;
        return behavior(text, options);
      },
    }),
    resolveTier: async (next) =>
      resolveInferenceFromConfig({ tier: next }, config),
    recordUsage: async (record) => {
      usage.push(record);
    },
    ...extra,
  };
  return {
    client: createChainClient(context, {
      retryDelayMs: () => 7,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1000,
    }),
    calls,
    usage,
    sleeps,
  };
}

const fail =
  (error: unknown): Behavior =>
  () =>
    Promise.reject(error);

const chain = (...models: string[]): InferenceConfig => ({
  tiers: {
    great: {
      candidates: models.map((model) => ({ provider: 'openai', model })),
    },
  },
});

describe('chain executor', () => {
  it('answers from the first candidate with tierResolved and no substitutions', async () => {
    const h = harness(chain('a', 'b'), {});
    await expect(
      h.client.message('hi', { usageTags: { promptKey: 'k' } }),
    ).resolves.toBe('answer from a');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.options.usageTags).toEqual({
      promptKey: 'k',
      tierRequested: 'great',
      tierResolved: 'great',
    });
    expect(h.usage).toEqual([]);
  });

  it('advances immediately on quota, credential and missing-model, in order', async () => {
    const h = harness(chain('a', 'b', 'c', 'd'), {
      a: fail(
        new RateLimitError('openai', undefined, {
          cause: Object.assign(new Error('x'), { code: 'insufficient_quota' }),
        }),
      ),
      b: fail(new AuthenticationError('openai')),
      c: fail(new ModelNotFoundError('c', 'openai')),
    });
    await expect(h.client.message('hi')).resolves.toBe('answer from d');
    expect(h.calls.map((call) => call.model)).toEqual(['a', 'b', 'c', 'd']);
    expect(h.sleeps).toEqual([]);
    const tags = h.calls[3]?.options.usageTags as Record<string, string>;
    expect(JSON.parse(tags.substitutions as string)).toEqual([
      { from: 'openai/a', to: 'openai/b', reason: 'quota' },
      { from: 'openai/b', to: 'openai/c', reason: 'credential' },
      { from: 'openai/c', to: 'openai/d', reason: 'missing-model' },
    ]);
    expect(tags.tierResolved).toBe('great');
  });

  it('retries a transient failure once with jitter before advancing', async () => {
    const overloaded = Object.assign(new Error('x'), { status: 503 });
    const h = harness(chain('a', 'b'), {
      a: [fail(overloaded), () => 'second try'],
    });
    await expect(h.client.message('hi')).resolves.toBe('second try');
    expect(h.sleeps).toEqual([7]);
    expect(h.calls.map((call) => call.model)).toEqual(['a', 'a']);

    const h2 = harness(chain('a', 'b'), {
      a: [fail(overloaded), fail(overloaded)],
    });
    await expect(h2.client.message('hi')).resolves.toBe('answer from b');
    expect(h2.calls.map((call) => call.model)).toEqual(['a', 'a', 'b']);
    expect(
      JSON.parse(h2.calls[2]?.options.usageTags?.substitutions as string),
    ).toEqual([{ from: 'openai/a', to: 'openai/b', reason: 'transient' }]);
  });

  it('never extends streamed text: a partial ends the walk with the error', async () => {
    const h = harness(chain('a', 'b'), {
      a: (_text, options) => {
        (options.onProgress as (chunk: string) => void)('Hel');
        return Promise.reject(Object.assign(new Error('x'), { status: 503 }));
      },
    });
    const seen: string[] = [];
    const error = await h.client
      .message('hi', { onProgress: (chunk: string) => seen.push(chunk) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InferenceExhaustedError);
    expect((error as InferenceExhaustedError).reason).toBe('partial');
    expect((error as InferenceExhaustedError).partialText).toBe('Hel');
    expect(seen).toEqual(['Hel']);
    expect(h.calls.map((call) => call.model)).toEqual(['a']);
    expect(h.sleeps).toEqual([]);
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]?.tags).toMatchObject({
      outcome: 'partial',
      reason: 'transient',
    });
    expect(JSON.parse(h.usage[0]?.tags.substitutions as string)).toEqual([
      { from: 'openai/a', to: null, reason: 'partial' },
    ]);
  });

  it('returns the partial text with allowPartial', async () => {
    const h = harness(
      chain('a', 'b'),
      {
        a: (_text, options) => {
          (options.onProgress as (chunk: string) => void)('Hel');
          return Promise.reject(new AuthenticationError('openai'));
        },
      },
      { allowPartial: true },
    );
    await expect(
      h.client.message('hi', { onProgress: () => {} }),
    ).resolves.toBe('Hel');
    expect(h.calls).toHaveLength(1);
    expect(h.usage[0]?.tags.outcome).toBe('partial');
  });

  it('advances past a refusal finish reason without leaking it to the caller', async () => {
    const h = harness(chain('a', 'b'), {
      a: (_text, options) => {
        (options.onFinishReason as (reason: string) => void)('refusal');
        return 'I cannot help';
      },
      b: (_text, options) => {
        (options.onFinishReason as (reason: string) => void)('stop');
        return 'ok';
      },
    });
    const reasons: string[] = [];
    await expect(
      h.client.message('hi', {
        onFinishReason: (reason: string) => reasons.push(reason),
      }),
    ).resolves.toBe('ok');
    expect(reasons).toEqual(['stop']);
    expect(
      JSON.parse(h.calls[1]?.options.usageTags?.substitutions as string),
    ).toEqual([{ from: 'openai/a', to: 'openai/b', reason: 'refusal' }]);
  });

  it('degrades down the ladder, recording tierResolved and the substitution', async () => {
    const config: InferenceConfig = {
      tiers: {
        great: { candidates: [{ provider: 'openai', model: 'a' }] },
        good: { candidates: [{ provider: 'openai', model: 'b' }] },
      },
    };
    const h = harness(config, { a: fail(new AuthenticationError('openai')) });
    await expect(h.client.message('hi')).resolves.toBe('answer from b');
    const tags = h.calls[1]?.options.usageTags as Record<string, string>;
    expect(tags.tierRequested).toBe('great');
    expect(tags.tierResolved).toBe('good');
    expect(JSON.parse(tags.substitutions as string)).toEqual([
      { from: 'openai/a', to: 'openai/b', reason: 'credential' },
    ]);
  });

  it('walks to unbound lower tiers (the configured client) and skips repeats', async () => {
    const h = harness(
      { tiers: { best: { candidates: [{ provider: 'openai', model: 'a' }] } } },
      {
        a: fail(new AuthenticationError('openai')),
        default: fail(new AuthenticationError('openai')),
      },
      { tier: 'best' },
    );
    await expect(h.client.message('hi')).rejects.toBeInstanceOf(
      InferenceExhaustedError,
    );
    // great, good and cheap all resolve to the configured client: tried once.
    expect(h.calls.map((call) => call.model)).toEqual(['a', 'default']);
  });

  it('stops degrading at minimumTier and when degrade is false', async () => {
    const config: InferenceConfig = {
      tiers: {
        great: { candidates: [{ provider: 'openai', model: 'a' }] },
        good: { candidates: [{ provider: 'openai', model: 'b' }] },
      },
    };
    const auth = fail(new AuthenticationError('openai'));
    const floored = harness(config, { a: auth }, { minimumTier: 'great' });
    await expect(floored.client.message('hi')).rejects.toBeInstanceOf(
      InferenceExhaustedError,
    );
    expect(floored.calls.map((call) => call.model)).toEqual(['a']);

    const off = harness({ ...config, degrade: false }, { a: auth });
    await expect(off.client.message('hi')).rejects.toBeInstanceOf(
      InferenceExhaustedError,
    );
    expect(off.calls.map((call) => call.model)).toEqual(['a']);
  });

  it('ends the ladder at a tier that may not run (#4757), never the configured client', async () => {
    const config: InferenceConfig = {
      tiers: { great: { candidates: [{ provider: 'openai', model: 'a' }] } },
    };
    const h = harness(
      config,
      { a: fail(new AuthenticationError('openai')) },
      {
        resolveTier: async (next) => ({
          tierResolved: next,
          target: {},
          via: 'resolver',
          mode: 'byo',
          unavailable: 'unconfigured',
        }),
      },
    );
    await expect(h.client.message('hi')).rejects.toBeInstanceOf(
      InferenceExhaustedError,
    );
    // Only the bound candidate ran; the unavailable lower tiers' empty
    // targets never reached the configured client.
    expect(h.calls.map((call) => call.model)).toEqual(['a']);
    expect(h.usage).toHaveLength(1);
  });

  it('never walks up the ladder', async () => {
    const config: InferenceConfig = {
      tiers: {
        cheap: { candidates: [{ provider: 'openai', model: 'a' }] },
        best: { candidates: [{ provider: 'openai', model: 'z' }] },
      },
    };
    const h = harness(
      config,
      { a: fail(new AuthenticationError('openai')) },
      {
        tier: 'cheap',
      },
    );
    await expect(h.client.message('hi')).rejects.toBeInstanceOf(
      InferenceExhaustedError,
    );
    expect(h.calls.map((call) => call.model)).toEqual(['a']);
  });

  it('records one zero-usage failure row with the reason when everything fails', async () => {
    const h = harness(
      chain('a', 'b'),
      {
        a: fail(new AuthenticationError('openai')),
        b: fail(new ModelNotFoundError('b', 'openai')),
      },
      { minimumTier: 'great' },
    );
    const error = (await h.client
      .message('hi', { usageTags: { promptKey: 'k', tierRequested: 'auto' } })
      .catch((caught: unknown) => caught)) as InferenceExhaustedError;
    expect(error).toBeInstanceOf(InferenceExhaustedError);
    expect(error.code).toBe('INFERENCE_EXHAUSTED');
    expect(error.reason).toBe('missing-model');
    expect(h.usage).toEqual([
      {
        provider: 'openai',
        model: 'b',
        operation: 'message',
        duration: 0,
        tags: {
          promptKey: 'k',
          tierRequested: 'auto',
          outcome: 'failed',
          reason: 'missing-model',
          substitutions: JSON.stringify([
            { from: 'openai/a', to: 'openai/b', reason: 'credential' },
            { from: 'openai/b', to: null, reason: 'missing-model' },
          ]),
        },
      },
    ]);
  });

  it('skips a candidate whose key variable is unset, recording a credential substitution', async () => {
    const h = harness(
      {
        tiers: {
          great: {
            candidates: [
              {
                provider: 'openai',
                model: 'a',
                baseUrl: 'https://x.example/v1',
                apiKeyEnv: 'SMRT_TEST_4752_UNSET',
              },
              { provider: 'openai', model: 'b' },
            ],
          },
        },
      },
      {},
    );
    await expect(h.client.message('hi')).resolves.toBe('answer from b');
    expect(h.calls.map((call) => call.model)).toEqual(['b']);
    expect(
      JSON.parse(h.calls[0]?.options.usageTags?.substitutions as string),
    ).toEqual([{ from: 'openai/a', to: 'openai/b', reason: 'credential' }]);
  });

  it('rethrows a caller abort untouched and records nothing', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const h = harness(chain('a', 'b'), { a: fail(abort) });
    await expect(h.client.message('hi')).rejects.toBe(abort);
    expect(h.calls).toHaveLength(1);
    expect(h.usage).toEqual([]);
  });

  it("tags a step's own source over the chain's (#4760)", async () => {
    const h = harness(
      {
        tiers: {
          great: { candidates: [{ provider: 'openai', model: 'a' }] },
          good: { provider: 'openai', model: 'g', source: 'hosted' },
        },
      },
      { a: fail(new AuthenticationError('openai')) },
    );
    await expect(
      h.client.message('hi', { usageTags: { source: 'app' } }),
    ).resolves.toBe('answer from g');
    const sources = h.calls.map((call) => call.options.usageTags?.source);
    // The chain's own candidate keeps the chain's tag; the degraded hosted
    // binding meters as hosted.
    expect(sources).toEqual(['app', 'hosted']);
  });

  it("hands a hosted chain's source to its candidates on a ladder step (#4760)", async () => {
    const seen: Array<string | undefined> = [];
    const h = harness(
      {
        tiers: {
          great: { candidates: [{ provider: 'openai', model: 'a' }] },
          good: {
            candidates: [{ provider: 'openai', model: 'g' }],
            source: 'hosted',
          },
        },
      },
      { a: fail(new AuthenticationError('openai')) },
    );
    const answered = await h.client.message('hi', {
      usageTags: { source: 'app' },
    });
    expect(answered).toBe('answer from g');
    expect(h.calls.map((call) => call.options.usageTags?.source)).toEqual([
      'app',
      'hosted',
    ]);
    // The step target core gates in clientFor() carries the source too.
    const gated = harness(
      {
        tiers: {
          great: { candidates: [{ provider: 'openai', model: 'a' }] },
          good: {
            candidates: [{ provider: 'openai', model: 'g' }],
            source: 'hosted',
          },
        },
      },
      { a: fail(new AuthenticationError('openai')) },
      {
        clientFor: async (target: InferenceTarget) => {
          seen.push(target.source);
          if (target.source === 'hosted') {
            throw new InferenceUnavailableError({
              reason: 'entitlement',
              mode: 'hosted',
              entitlement: { policy: 'kill-switch', disabledBy: 'global' },
            });
          }
          throw new AuthenticationError('openai');
        },
      },
    );
    await expect(gated.client.message('hi')).rejects.toBeInstanceOf(
      InferenceUnavailableError,
    );
    expect(seen).toEqual([undefined, 'hosted']);
    expect(gated.usage).toEqual([]);
  });

  it('stops on a hosted-gate block and records nothing more (#4760)', async () => {
    const blocked = new InferenceUnavailableError({
      reason: 'entitlement',
      mode: 'hosted',
      entitlement: { policy: 'kill-switch', disabledBy: 'global' },
    });
    const h = harness(
      chain('a', 'b'),
      {},
      {
        clientFor: async () => {
          throw blocked;
        },
      },
    );
    await expect(h.client.message('hi')).rejects.toBe(blocked);
    // Core already wrote the `blocked` row; no `failed` row on top of it.
    expect(h.usage).toEqual([]);
  });

  it('rethrows an unclassified error and records the failure', async () => {
    const bug = new TypeError('bad input');
    const h = harness(chain('a', 'b'), { a: fail(bug) });
    await expect(h.client.message('hi')).rejects.toBe(bug);
    expect(h.calls).toHaveLength(1);
    expect(h.usage[0]?.tags).toMatchObject({
      outcome: 'failed',
      reason: 'unclassified',
    });
    expect(JSON.parse(h.usage[0]?.tags.substitutions as string)).toEqual([
      { from: 'openai/a', to: null, reason: 'unclassified' },
    ]);

    const after = harness(chain('a', 'b'), {
      a: fail(new AuthenticationError('openai')),
      b: fail(bug),
    });
    await expect(after.client.message('hi')).rejects.toBe(bug);
    expect(JSON.parse(after.usage[0]?.tags.substitutions as string)).toEqual([
      { from: 'openai/a', to: 'openai/b', reason: 'credential' },
      { from: 'openai/b', to: null, reason: 'unclassified' },
    ]);
  });

  it('sends each candidate its own model and params, caller options winning params', async () => {
    const h = harness(
      {
        tiers: {
          great: {
            candidates: [
              {
                provider: 'openai',
                model: 'a',
                params: { temperature: 0, maxTokens: 5 },
              },
            ],
          },
        },
      },
      {},
    );
    await h.client.message('hi', { model: 'caller-model', maxTokens: 9 });
    expect(h.calls[0]?.options).toMatchObject({
      model: 'a',
      temperature: 0,
      maxTokens: 9,
    });
  });

  it('stops the provider stream when the consumer breaks out', async () => {
    const config = chain('a');
    let returned = false;
    let produced = 0;
    let signal: AbortSignal | undefined;
    const client = createChainClient(
      {
        request: { tier: 'great' },
        resolution: resolveInferenceFromConfig({ tier: 'great' }, config),
        config,
        clientFor: async () => ({
          message: async () => '',
          stream: (_messages: unknown, options: { signal?: AbortSignal }) => {
            signal = options.signal;
            return {
              [Symbol.asyncIterator]() {
                return {
                  next: async () => {
                    produced++;
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    return { value: `c${produced}`, done: false };
                  },
                  return: async () => {
                    returned = true;
                    return { value: undefined, done: true };
                  },
                };
              },
            };
          },
        }),
        resolveTier: async (tier) =>
          resolveInferenceFromConfig({ tier }, config),
        recordUsage: async () => {},
      },
      { sleep: async () => {}, retryDelayMs: () => 0 },
    );
    const stream = (client.stream as (m: unknown) => AsyncIterable<string>)([]);
    for await (const chunk of stream) {
      expect(chunk).toBe('c1');
      break;
    }
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(returned).toBe(true));
    const after = produced;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(produced).toBe(after);
  });

  it('streams: advances before the first chunk, never after', async () => {
    const chunksOf = (...chunks: string[]) =>
      async function* () {
        for (const chunk of chunks) yield chunk;
      };
    const failing = (afterChunks: string[]) =>
      async function* () {
        for (const chunk of afterChunks) yield chunk;
        throw Object.assign(new Error('x'), { status: 503 });
      };
    const make = (behavior: Record<string, () => AsyncGenerator<string>>) => {
      const calls: string[] = [];
      const config = chain('a', 'b');
      const client = createChainClient(
        {
          request: { tier: 'great' },
          resolution: resolveInferenceFromConfig({ tier: 'great' }, config),
          config,
          clientFor: async (target) => ({
            message: async () => '',
            stream: (_messages: unknown, _options: unknown) => {
              calls.push(String(target.model));
              return (behavior[String(target.model)] ?? chunksOf('?'))();
            },
          }),
          resolveTier: async (tier) =>
            resolveInferenceFromConfig({ tier }, config),
          recordUsage: async () => {},
        },
        { sleep: async () => {}, retryDelayMs: () => 0 },
      );
      return { client, calls };
    };
    const collect = async (iterable: AsyncIterable<string>) => {
      const out: string[] = [];
      for await (const chunk of iterable) out.push(chunk);
      return out;
    };

    const before = make({ a: failing([]), b: chunksOf('o', 'k') });
    const stream = (
      before.client.stream as (m: unknown) => AsyncIterable<string>
    )([]);
    await expect(collect(stream)).resolves.toEqual(['o', 'k']);
    expect(before.calls).toEqual(['a', 'a', 'b']);

    const after = make({ a: failing(['Hel']), b: chunksOf('o', 'k') });
    const out: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of (
          after.client.stream as (m: unknown) => AsyncIterable<string>
        )([])) {
          out.push(chunk);
        }
      })(),
    ).rejects.toBeInstanceOf(InferenceExhaustedError);
    expect(out).toEqual(['Hel']);
    expect(after.calls).toEqual(['a']);
  });

  it('refuses an invalid chain config even without the validating resolver', () => {
    expect(() =>
      harness(
        {
          tiers: {
            great: {
              candidates: [
                { provider: 'anthropic', model: 'a', apiKeyEnv: 'SOME_KEY' },
              ],
            },
          },
        },
        {},
      ),
    ).toThrow(/brings its own key without a baseUrl/);
  });

  it('validates resolver-sourced chains, not only the config block', async () => {
    const h = harness(
      {},
      {},
      {
        resolution: {
          tierResolved: 'great',
          via: 'resolver',
          target: {
            candidates: [{ provider: 'openai', model: 'm', apiKey: 'sk-user' }],
          },
        },
      },
    );
    await expect(h.client.message('hi')).rejects.toThrow(
      /resolution\.great\.candidates\[0\] brings its own key without a baseUrl/,
    );
    expect(h.calls).toEqual([]);
  });

  it('validates a degraded tier resolved by a resolver', async () => {
    const config: InferenceConfig = {
      tiers: { great: { candidates: [{ provider: 'openai', model: 'a' }] } },
    };
    const h = harness(
      config,
      { a: fail(new AuthenticationError('openai')) },
      {
        resolveTier: async (tier) => ({
          tierResolved: tier,
          via: 'resolver',
          target: { alias: 'missing' },
        }),
      },
    );
    await expect(h.client.message('hi')).rejects.toThrow(
      /resolution\.good points at unknown alias "missing"/,
    );
  });

  it('advances past a candidate core refuses to bind', async () => {
    const config = chain('a', 'b');
    const calls: string[] = [];
    const client = createChainClient(
      {
        request: { tier: 'great' },
        resolution: resolveInferenceFromConfig({ tier: 'great' }, config),
        config,
        clientFor: async (target) => {
          if (target.model === 'a') {
            throw new InferenceBindingError('HAVE_AI_API_KEY is set');
          }
          return {
            message: async () => {
              calls.push(String(target.model));
              return 'ok';
            },
          };
        },
        resolveTier: async (tier) =>
          resolveInferenceFromConfig({ tier }, config),
        recordUsage: async () => {},
      },
      { sleep: async () => {} },
    );
    await expect(client.message('hi')).resolves.toBe('ok');
    expect(calls).toEqual(['b']);
  });

  it('tries the same route again with a different literal key', async () => {
    const keys: unknown[] = [];
    const h = harness(
      {},
      {},
      {
        resolution: {
          tierResolved: 'great',
          via: 'resolver',
          target: {
            candidates: [
              {
                provider: 'openai',
                model: 'm',
                baseUrl: 'https://x.example/v1',
                apiKey: 'sk-one',
              },
              {
                provider: 'openai',
                model: 'm',
                baseUrl: 'https://x.example/v1',
                apiKey: 'sk-two',
              },
            ],
          },
        },
        clientFor: async (target) => ({
          message: async () => {
            keys.push(target.apiKey);
            if (target.apiKey === 'sk-one')
              throw new AuthenticationError('openai');
            return 'second key answered';
          },
        }),
      },
    );
    await expect(h.client.message('hi')).resolves.toBe('second key answered');
    expect(keys).toEqual(['sk-one', 'sk-two']);
  });

  it('keeps a recordUsage failure from masking the call error', async () => {
    const h = harness(
      chain('a'),
      { a: fail(new AuthenticationError('openai')) },
      {
        minimumTier: 'great',
        recordUsage: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    );
    await expect(h.client.message('hi')).rejects.toBeInstanceOf(
      InferenceExhaustedError,
    );
  });
});
