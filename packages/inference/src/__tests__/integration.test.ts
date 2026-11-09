/**
 * End to end through a real SmrtObject (#4752): importing the package
 * registers into core's seam, `do({ tier })` walks an alias chain on core's
 * clients, the answering call carries the substitution tags, and an
 * exhausted call lands one zero-usage row in the usage pipeline.
 */
import { AuthenticationError, RateLimitError } from '@happyvertical/ai';
import {
  config,
  field,
  getInferenceExecutor,
  type InferenceConfig,
  SmrtObject,
  setInferenceExecutor,
  setInferenceResolver,
  smrt,
} from '@happyvertical/smrt-core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InferenceExhaustedError,
  isInferenceRegistered,
  registerInference,
} from '../index.js';

@smrt()
class Issue4752Note extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

const quota = () =>
  new RateLimitError('openai', undefined, {
    cause: Object.assign(new Error('x'), { code: 'insufficient_quota' }),
  });

function injectedClient(failing: Record<string, () => Error>) {
  return {
    embed: () => {},
    message: vi.fn(async (_text: string, options: Record<string, unknown>) => {
      const model = String(options.model ?? 'configured');
      const make = failing[model];
      if (make) throw make();
      return `from ${model}`;
    }),
  };
}

function note(
  inference: InferenceConfig,
  ai: ReturnType<typeof injectedClient>,
  events: unknown[],
) {
  return new Issue4752Note({
    ai,
    inference,
    usage: {
      handlers: [
        {
          handle: async (event: unknown) => {
            events.push(event);
          },
        },
      ],
    },
  } as never);
}

const FRONTIER: InferenceConfig = {
  aliases: {
    frontier: { candidates: [{ model: 'first' }, { model: 'second' }] },
  },
  tiers: { great: { alias: 'frontier' } },
};

describe('smrt-inference registered into core', () => {
  beforeEach(() => {
    config.reset();
    setInferenceResolver(undefined);
    registerInference({ executor: { sleep: async () => {} } });
  });
  afterAll(() => {
    setInferenceResolver(undefined);
    setInferenceExecutor(undefined);
  });

  it('registers on import', () => {
    expect(isInferenceRegistered()).toBe(true);
    expect(getInferenceExecutor()?.kinds).toEqual([
      'alias',
      'candidates',
      'fusion',
    ]);
  });

  it('walks an alias on quota and tags the answering call', async () => {
    const ai = injectedClient({ first: quota });
    const events: unknown[] = [];
    const result = await note(FRONTIER, ai, events).do('summarize', {
      tier: 'great',
      usageTags: { promptKey: 'notes.summarize' },
    });
    expect(result).toBe('from second');
    expect(ai.message).toHaveBeenCalledTimes(2);
    const options = ai.message.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(options.tier).toBeUndefined();
    expect(options.usageTags).toEqual({
      promptKey: 'notes.summarize',
      tierRequested: 'great',
      tierResolved: 'great',
      substitutions: JSON.stringify([
        { from: 'default/first', to: 'default/second', reason: 'quota' },
      ]),
    });
    expect(events).toEqual([]);
  });

  it('records a zero-usage failure row when the chain is exhausted', async () => {
    const ai = injectedClient({
      first: () => new AuthenticationError('openai'),
      second: () => new AuthenticationError('openai'),
      configured: () => new AuthenticationError('openai'),
    });
    const events: Array<Record<string, unknown>> = [];
    await expect(
      note(FRONTIER, ai, events).do('summarize', { tier: 'great' }),
    ).rejects.toBeInstanceOf(InferenceExhaustedError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'unknown',
      model: 'unknown',
      className: 'Issue4752Note',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      tags: { tierRequested: 'great', outcome: 'failed', reason: 'credential' },
    });
    // Nothing answered: no tierResolved, so tier_resolved stays NULL.
    expect(events[0]?.tags).not.toHaveProperty('tierResolved');
    const trail = JSON.parse(
      (events[0] as { tags: Record<string, string> }).tags.substitutions,
    );
    // great's alias, then the unbound good/cheap tiers (the configured client).
    expect(trail.map((step: { from: string }) => step.from)).toEqual([
      'default/first',
      'default/second',
      'default',
    ]);
  });

  it('honors minimumTier from the call and strips it before the provider', async () => {
    const ai = injectedClient({
      first: () => new AuthenticationError('openai'),
      second: () => new AuthenticationError('openai'),
    });
    await expect(
      note(FRONTIER, ai, []).do('x', {
        tier: 'great',
        minimumTier: 'great',
        allowPartial: true,
      }),
    ).rejects.toBeInstanceOf(InferenceExhaustedError);
    expect(ai.message).toHaveBeenCalledTimes(2);
    for (const [, options] of ai.message.mock.calls) {
      expect(options).not.toHaveProperty('minimumTier');
      expect(options).not.toHaveProperty('allowPartial');
    }
  });

  it('leaves single-target tiers and untiered calls unchanged', async () => {
    const ai = injectedClient({});
    const instance = note({ tiers: { cheap: { model: 'mini' } } }, ai, []);
    await expect(instance.do('x', { tier: 'cheap' })).resolves.toBe(
      'from mini',
    );
    await expect(instance.do('x')).resolves.toBe('from configured');
    expect(ai.message.mock.calls[1]?.[1]).not.toHaveProperty('usageTags');
  });

  it('names the offender when an alias is unknown', async () => {
    const ai = injectedClient({});
    await expect(
      note({ tiers: { great: { alias: 'nope' } } }, ai, []).do('x', {
        tier: 'great',
      }),
    ).rejects.toThrow(/inference\.tiers\.great points at unknown alias "nope"/);
    expect(ai.message).not.toHaveBeenCalled();
  });
});
