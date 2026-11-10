/**
 * The executor seam and chain config members (#4752): `alias`/`candidates`
 * kinds, `aliases`/`degrade` merging, the refusal to run a chain without an
 * executor, and what core hands a registered executor.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { field } from '../decorators';
import {
  assertInferenceConfig,
  getInferenceExecutor,
  INFERENCE_TARGET_UNBOUND,
  type InferenceExecutionContext,
  inferenceExecutorFor,
  inferenceTargetKind,
  mergeInferenceConfigs,
  setInferenceExecutor,
  setInferenceResolver,
} from '../inference.js';
import {
  INFERENCE_PRESET_IDS,
  isInferencePresetId,
  resolveInferencePreset,
} from '../inference-presets.js';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

@smrt()
class Issue4752SeamNote extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

describe('inference chain config', () => {
  it('reads the kind from kind, alias or candidates', () => {
    expect(inferenceTargetKind({})).toBe('single');
    expect(inferenceTargetKind({ provider: 'openai' })).toBe('single');
    expect(inferenceTargetKind({ alias: 'frontier' })).toBe('alias');
    expect(inferenceTargetKind({ candidates: [] })).toBe('candidates');
    expect(inferenceTargetKind({ kind: 'fusion' as never })).toBe('fusion');
  });

  it('merges aliases whole per name and degrade by the highest layer', () => {
    const merged = mergeInferenceConfigs(
      {
        aliases: {
          a: { candidates: [{ provider: 'openai', model: 'x' }] },
          b: { candidates: [{ provider: 'openai', model: 'y' }] },
        },
        degrade: true,
      },
      {
        aliases: { a: { candidates: [{ provider: 'anthropic', model: 'z' }] } },
        degrade: false,
      },
    );
    expect(merged?.aliases).toEqual({
      a: { candidates: [{ provider: 'anthropic', model: 'z' }] },
      b: { candidates: [{ provider: 'openai', model: 'y' }] },
    });
    expect(merged?.degrade).toBe(false);
  });

  it('rejects malformed alias and degrade members', () => {
    expect(() => assertInferenceConfig({ degrade: 'no' } as never)).toThrow(
      'inference.degrade must be a boolean',
    );
    expect(() =>
      assertInferenceConfig({ aliases: { a: 'x' } } as never),
    ).toThrow('inference.aliases.a must be an object');
  });

  it('keeps the preset table browser-safe and unchanged', () => {
    expect(INFERENCE_PRESET_IDS).toEqual([
      'openrouter',
      'lemonade',
      'llama.cpp',
      'lm-studio',
    ]);
    expect(isInferencePresetId('lemonade')).toBe(true);
    expect(isInferencePresetId('toString')).toBe(false);
    expect(resolveInferencePreset('lemonade', { model: 'q' })).toEqual({
      type: 'openai',
      baseUrl: 'http://127.0.0.1:13305/v1',
      defaultModel: 'q',
      apiKey: 'smrt-local',
    });
  });
});

describe('inference executor seam', () => {
  beforeEach(() => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    setInferenceExecutor(undefined);
  });
  afterEach(() => {
    setInferenceExecutor(undefined);
    config.reset();
  });

  it('validates registration', () => {
    expect(() => setInferenceExecutor({} as never)).toThrow(
      'must declare kinds and implement createClient()',
    );
    expect(getInferenceExecutor()).toBeUndefined();
  });

  it('refuses a chain target with no executor instead of using the configured client', async () => {
    expect(inferenceExecutorFor({ provider: 'openai' })).toBeUndefined();
    expect(() => inferenceExecutorFor({ alias: 'frontier' })).toThrow(
      'Inference target kind "alias" needs a registered executor',
    );
    const injected = { embed: () => {}, message: vi.fn(async () => 'x') };
    const note = new Issue4752SeamNote({
      ai: injected,
      inference: { tiers: { great: { alias: 'frontier' } } },
    } as never);
    await expect(note.do('x', { tier: 'great' })).rejects.toThrow(
      'needs a registered executor',
    );
    expect(injected.message).not.toHaveBeenCalled();
  });

  it('hands the executor the resolution, floor and seams, and strips chain options', async () => {
    const contexts: InferenceExecutionContext[] = [];
    const chainMessage = vi.fn(async () => 'from chain');
    setInferenceExecutor({
      kinds: ['candidates'],
      createClient: (context) => {
        contexts.push(context);
        return { message: chainMessage };
      },
    });
    const events: Array<Record<string, unknown>> = [];
    const injected = { embed: () => {}, message: vi.fn(async () => 'plain') };
    const note = new Issue4752SeamNote({
      ai: injected,
      inference: {
        tiers: {
          great: { candidates: [{ model: 'a' }] },
          good: { model: 'mid' },
        },
      },
      usage: {
        handlers: [
          {
            handle: async (event: Record<string, unknown>) => {
              events.push(event);
            },
          },
        ],
      },
    } as never);

    await expect(
      note.do('x', {
        tier: 'great',
        minimumTier: 'good',
        allowPartial: true,
        promptKey: 'k',
        usageTags: { feature: 'f' },
      }),
    ).resolves.toBe('from chain');

    const [context] = contexts;
    expect(context?.request).toEqual({
      className: 'Issue4752SeamNote',
      tier: 'great',
      promptKey: 'k',
    });
    expect(context?.resolution).toMatchObject({
      tierResolved: 'great',
      via: 'config',
    });
    expect(context?.minimumTier).toBe('good');
    expect(context?.allowPartial).toBe(true);
    const options = (chainMessage.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    for (const key of ['tier', 'minimumTier', 'allowPartial', 'promptKey']) {
      expect(options).not.toHaveProperty(key);
    }
    expect(options.usageTags).toEqual({
      feature: 'f',
      tierRequested: 'great',
      tierResolved: 'great',
    });

    // Seams: a single target binds through core; another tier resolves.
    expect(await context?.clientFor({ model: 'a' })).toBe(injected);
    await expect(context?.resolveTier('good')).resolves.toMatchObject({
      tierResolved: 'good',
      target: { model: 'mid' },
    });
    await expect(
      context?.clientFor({ candidates: [] } as never),
    ).rejects.toThrow('cannot be bound to one client');
    // Pair-rule refusals are typed, so an executor classifies them by code.
    await expect(
      context?.clientFor({ baseUrl: 'https://other.example/v1' }),
    ).rejects.toMatchObject({
      name: 'InferenceBindingError',
      code: INFERENCE_TARGET_UNBOUND,
    });

    // The failure row goes through the instance's usage handlers.
    await context?.recordUsage({
      operation: 'message',
      model: 'a',
      duration: 12,
      tags: { outcome: 'failed', reason: 'quota' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'unknown',
      model: 'a',
      operation: 'message',
      duration: 12,
      className: 'Issue4752SeamNote',
      tags: { outcome: 'failed', reason: 'quota' },
    });
    expect(injected.message).not.toHaveBeenCalled();
  });

  it('runs fusion targets through the executor with the run seams (#4753)', async () => {
    expect(inferenceTargetKind({ fusion: 'review' })).toBe('fusion');
    expect(() => inferenceExecutorFor({ fusion: 'review' })).toThrow(
      'Inference target kind "fusion" needs a registered executor',
    );
    const contexts: InferenceExecutionContext[] = [];
    setInferenceExecutor({
      kinds: ['fusion'],
      createClient: (context) => {
        contexts.push(context);
        return { message: async () => 'fused' };
      },
    });
    const decide = vi.fn(async (_request: unknown, _options?: object) => ({
      provenance: { provider: 'typesafe', model: 'judge' },
      answers: {
        gate: {
          type: 'choice',
          choice: 'done',
          probabilities: { done: 0.9, continue: 0.1 },
          confidence: 0.9,
        },
      },
    }));
    const events: Array<Record<string, unknown>> = [];
    const injected = { embed: () => {}, message: vi.fn(async () => 'plain') };
    const note = new Issue4752SeamNote({
      ai: injected,
      decisions: { getCapabilities: async () => ({ decisions: true }), decide },
      inference: {
        tiers: { best: { fusion: 'review' }, cheap: { model: 'c' } },
      },
      usage: {
        handlers: [
          {
            handle: async (event: Record<string, unknown>) => {
              events.push(event);
            },
          },
        ],
      },
    } as never);
    await expect(
      note.do('x', { tier: 'best', promptKey: 'entry' }),
    ).resolves.toBe('fused');
    const [context] = contexts;
    expect(context?.resolution.target).toEqual({ fusion: 'review' });

    // A seat resolves its tier with its own prompt key.
    const resolverSeen: unknown[] = [];
    setInferenceResolver({
      resolve: (request) => {
        resolverSeen.push(request);
        return undefined;
      },
    });
    await context?.resolveTier('cheap', { promptKey: 'seat.prompt' });
    expect(resolverSeen[0]).toMatchObject({
      tier: 'cheap',
      promptKey: 'seat.prompt',
      className: 'Issue4752SeamNote',
    });

    // #4800: the fusion lookup asks the resolver first (with the instance's
    // request), then the merged `inference.fusions`, else undefined.
    await expect(context?.lookupFusion?.('review')).resolves.toBeUndefined();
    const stored = {
      mode: 'single' as const,
      seats: [{ prompt: 'stored.prompt', target: 'cheap' as const }],
    };
    const lookupSeen: unknown[] = [];
    setInferenceResolver({
      resolve: () => undefined,
      lookupFusion: (key, request) => {
        lookupSeen.push({ key, request });
        return key === 'review' ? stored : undefined;
      },
    });
    await expect(context?.lookupFusion?.('review')).resolves.toEqual({
      definition: stored,
      source: 'resolver',
    });
    expect(lookupSeen[0]).toMatchObject({
      key: 'review',
      request: { tier: 'best', className: 'Issue4752SeamNote' },
    });
    setInferenceResolver({
      resolve: () => undefined,
      lookupFusion: () => ({ seats: 'no' }) as never,
    });
    await expect(context?.lookupFusion?.('review')).rejects.toThrow(
      'invalid definition for fusion "review"',
    );
    setInferenceResolver(undefined);
    config({
      inference: { fusions: { review: stored } },
    } as never);
    await expect(context?.lookupFusion?.('review')).resolves.toEqual({
      definition: stored,
      source: 'config',
    });
    config.reset();

    // The gate decision goes through the decision client and records usage
    // with the run tags.
    const result = await context?.decide?.(
      {
        state: {},
        questions: {
          gate: {
            type: 'choice',
            instructions: 'ok?',
            criteria: { done: 'y', continue: 'n' },
          },
        },
      },
      { usageTags: { runId: 'r1', fusionKey: 'review', seat: 'gate' } },
    );
    expect(result?.answers.gate).toMatchObject({ choice: 'done' });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      provider: 'typesafe',
      model: 'judge',
      operation: 'decision',
      tags: {
        runId: 'r1',
        fusionKey: 'review',
        seat: 'gate',
        operation: 'decision',
      },
    });

    // Usage observers see only their run's events, until unsubscribed.
    const seen: string[] = [];
    const stop = context?.observeUsage?.('r1', (event) => {
      seen.push(`${event.model}:${event.tags.seat}:${event.totalTokens}`);
    });
    await context?.recordUsage({
      operation: 'message',
      model: 'm',
      tags: { runId: 'r1', seat: 'skeptic' },
    });
    await context?.recordUsage({
      operation: 'message',
      model: 'm',
      tags: { runId: 'other', seat: 'x' },
    });
    stop?.();
    await context?.recordUsage({
      operation: 'message',
      model: 'm',
      tags: { runId: 'r1', seat: 'late' },
    });
    expect(seen).toEqual(['m:skeptic:0']);

    // No database: recordRun is a quiet no-op.
    await expect(
      context?.recordRun?.({
        id: 'r1',
        fusionKey: 'review',
        mode: 'pair',
        seats: 3,
        degradedSeats: 0,
        status: 'ok',
        duration: 5,
        details: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('merges fusions whole per key and rejects malformed ones', () => {
    const merged = mergeInferenceConfigs(
      {
        fusions: {
          a: { mode: 'single', seats: [{ prompt: 'p', target: 'cheap' }] },
          b: { mode: 'single', seats: [{ prompt: 'q', target: 'cheap' }] },
        },
      },
      {
        fusions: {
          a: { mode: 'single', seats: [{ prompt: 'r', target: 'best' }] },
        },
      },
    );
    expect(merged?.fusions).toEqual({
      a: { mode: 'single', seats: [{ prompt: 'r', target: 'best' }] },
      b: { mode: 'single', seats: [{ prompt: 'q', target: 'cheap' }] },
    });
    expect(() => assertInferenceConfig({ fusions: [] } as never)).toThrow(
      'inference.fusions must be an object',
    );
    expect(() =>
      assertInferenceConfig({ fusions: { a: 'x' } } as never),
    ).toThrow('inference.fusions.a must be an object');
  });

  it('strips minimumTier and allowPartial from untiered calls', async () => {
    const injected = { embed: () => {}, message: vi.fn(async () => 'plain') };
    const note = new Issue4752SeamNote({ ai: injected } as never);
    await note.do('x', { minimumTier: 'good', allowPartial: true });
    const options = (injected.message.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(options).not.toHaveProperty('minimumTier');
    expect(options).not.toHaveProperty('allowPartial');
  });
});
