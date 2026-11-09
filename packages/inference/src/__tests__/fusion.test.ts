/**
 * Fusion interpreter (#4753) against fake clients: each mode's fixed call
 * count, seat failure paths, the all-dead error, the gate skip and its
 * record, JSON recovery, seat tags and the run record, and load-time
 * rejection of unregistered prompt keys and malformed definitions.
 */
import { AuthenticationError } from '@happyvertical/ai';
import {
  type DecisionRequest,
  type DecisionResult,
  type InferenceCallOptions,
  type InferenceConfig,
  type InferenceExecutionContext,
  type InferenceFusionDefinition,
  type InferenceRunRecord,
  type InferenceTarget,
  type InferenceTier,
  type InferenceUsageObservation,
  type InferenceUsageRecord,
  resolveInferenceFromConfig,
} from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findInferenceConfigIssues,
  validateInferenceConfig,
} from '../config.js';
import { InferenceConfigError, InferenceFusionError } from '../errors.js';
import {
  clearFusions,
  createChainExecutor,
  createFusionClient,
  defineFusion,
  type FusionRunResult,
  setFusionPromptResolver,
} from '../fusion.js';

type Behavior = (text: string, options: InferenceCallOptions) => string;

const PROMPTS = ['p.skeptic', 'p.advocate', 'p.merge', 'p.draft', 'p.review'];

function registerPrompts(keys: string[]): void {
  (
    globalThis as { __smrtPromptRegistry?: Map<string, unknown> }
  ).__smrtPromptRegistry = new Map(keys.map((key) => [key, { key }]));
}

interface Harness {
  call(text?: string, options?: InferenceCallOptions): Promise<string>;
  calls: Array<{ model: string; text: string; options: InferenceCallOptions }>;
  usage: InferenceUsageRecord[];
  runs: InferenceRunRecord[];
  decisions: Array<{ request: DecisionRequest; tags?: Record<string, string> }>;
  resolveTierCalls: Array<{ tier: InferenceTier; promptKey?: string }>;
  result(): FusionRunResult | undefined;
}

function harness(
  fusion: InferenceFusionDefinition,
  behaviors: Record<string, Behavior> = {},
  extra: Partial<InferenceExecutionContext> & {
    config?: InferenceConfig;
  } = {},
): Harness {
  const config: InferenceConfig = extra.config ?? {
    tiers: {
      best: { fusion: 'review' },
      cheap: { model: 'cheap-m' },
      good: { model: 'good-m' },
      great: { model: 'great-m' },
    },
    fusions: { review: fusion },
  };
  const calls: Harness['calls'] = [];
  const usage: InferenceUsageRecord[] = [];
  const runs: InferenceRunRecord[] = [];
  const decisions: Harness['decisions'] = [];
  const resolveTierCalls: Harness['resolveTierCalls'] = [];
  const listeners = new Map<
    string,
    (event: InferenceUsageObservation) => void
  >();
  let last: FusionRunResult | undefined;
  const context: InferenceExecutionContext = {
    request: { tier: 'best', promptKey: 'entry.prompt', tenantId: 't1' },
    resolution: resolveInferenceFromConfig({ tier: 'best' }, config),
    config,
    clientFor: async (target: InferenceTarget) => ({
      message: async (text: string, options: InferenceCallOptions = {}) => {
        const model = String(options.model ?? target.model ?? 'default');
        calls.push({ model, text, options });
        const behavior = behaviors[model];
        const answer = behavior ? behavior(text, options) : `from ${model}`;
        const tags = options.usageTags ?? {};
        listeners.get(tags.runId ?? '')?.({
          provider: 'openai',
          model,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          estimatedCost: 0.001,
          duration: 3,
          tags,
        });
        return answer;
      },
    }),
    resolveTier: async (tier, overrides) => {
      resolveTierCalls.push({ tier, promptKey: overrides?.promptKey });
      return resolveInferenceFromConfig({ tier }, config);
    },
    recordUsage: async (record) => {
      usage.push(record);
    },
    recordRun: async (record) => {
      runs.push(record);
    },
    observeUsage: (runId, listener) => {
      listeners.set(runId, listener);
      return () => listeners.delete(runId);
    },
    ...extra,
  };
  return {
    call: (text = 'the contract', options = {}) =>
      createFusionClient(context, {
        sleep: async () => {},
        now: () => 1000,
      }).message(text, {
        ...options,
        onFusionResult: (result: FusionRunResult) => {
          last = result;
        },
      }),
    calls,
    usage,
    runs,
    decisions,
    resolveTierCalls,
    result: () => last,
  };
}

const fail = (): Behavior => () => {
  throw new AuthenticationError('openai');
};

const PAIR: InferenceFusionDefinition = {
  mode: 'pair',
  seats: [
    { name: 'skeptic', prompt: 'p.skeptic', target: 'cheap' },
    {
      name: 'advocate',
      prompt: 'p.advocate',
      target: { provider: 'openai', model: 'gpt-x' },
    },
    { name: 'merge', prompt: 'p.merge', target: 'great' },
  ],
};

const HANDOFF: InferenceFusionDefinition = {
  mode: 'handoff',
  seats: [
    { name: 'drafter', prompt: 'p.draft', target: 'cheap' },
    { name: 'reviewer', prompt: 'p.review', target: 'great' },
  ],
};

function decider(
  answer: { choice: string; confidence: number },
  log: Harness['decisions'],
): InferenceExecutionContext['decide'] {
  return async (request, options) => {
    log.push({ request, tags: options?.usageTags });
    return {
      model: 'judge',
      provenance: { provider: 'typesafe', model: 'judge' },
      answers: {
        gate: {
          type: 'choice',
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: {},
        },
      },
    } as DecisionResult;
  };
}

describe('fusions', () => {
  beforeEach(() => {
    registerPrompts(PROMPTS);
    setFusionPromptResolver(async (key) => ({
      instructions: `instructions for ${key}`,
      usageTags: { promptKey: key, promptLayer: 'default', templateHash: 'h' },
    }));
  });
  afterEach(() => {
    setFusionPromptResolver(undefined);
    clearFusions();
  });

  it('runs single with exactly one call, seat tags and an ok run row', async () => {
    const h = harness({
      mode: 'single',
      seats: [{ prompt: 'p.draft', target: 'good' }],
    });
    await expect(
      h.call('x', { usageTags: { promptKey: 'entry.prompt', custom: 'c' } }),
    ).resolves.toBe('from good-m');
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call?.options.history).toEqual([
      { role: 'system', content: 'instructions for p.draft' },
    ]);
    const tags = call?.options.usageTags ?? {};
    expect(tags).toMatchObject({
      custom: 'c',
      promptKey: 'p.draft',
      promptLayer: 'default',
      fusionKey: 'review',
      seat: 'p.draft',
      tierRequested: 'good',
      tierResolved: 'good',
    });
    expect(tags.runId).toMatch(/[0-9a-f-]{36}/);
    expect(h.resolveTierCalls).toEqual([
      { tier: 'good', promptKey: 'p.draft' },
    ]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      id: tags.runId,
      fusionKey: 'review',
      mode: 'single',
      promptKey: 'entry.prompt',
      seats: 1,
      degradedSeats: 0,
      status: 'ok',
    });
    expect(h.runs[0]?.details).toEqual({
      seats: [
        {
          persona: 'p.draft',
          prompt: 'p.draft',
          status: 'ok',
          target: 'tier:good',
          model: 'default/good-m',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            estimatedCost: 0.001,
          },
          durationMs: 0,
        },
      ],
    });
  });

  it('runs pair with exactly three calls and labels both outputs for the merge seat', async () => {
    const h = harness(PAIR);
    await expect(h.call()).resolves.toBe('from great-m');
    expect(
      h.calls
        .map((c) => c.model)
        .slice(0, 2)
        .sort(),
    ).toEqual(['cheap-m', 'gpt-x']);
    expect(h.calls[2]?.model).toBe('great-m');
    const merge = h.calls[2]?.text ?? '';
    expect(merge).toContain('the contract');
    expect(merge).toContain('seat "skeptic" (default/cheap-m)');
    expect(merge).toContain('from cheap-m');
    expect(merge).toContain('seat "advocate" (openai/gpt-x)');
    expect(merge).toContain('from gpt-x');
    expect(h.calls.map((c) => c.options.usageTags?.seat).sort()).toEqual([
      'advocate',
      'merge',
      'skeptic',
    ]);
    expect(new Set(h.calls.map((c) => c.options.usageTags?.runId)).size).toBe(
      1,
    );
    expect(h.runs[0]).toMatchObject({ seats: 3, status: 'ok', mode: 'pair' });
  });

  it('runs handoff with exactly two calls and hands the draft over', async () => {
    const h = harness(HANDOFF);
    await expect(h.call()).resolves.toBe('from great-m');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.text).toContain('Draft from seat "drafter"');
    expect(h.calls[1]?.text).toContain('from cheap-m');
    expect(h.runs[0]).toMatchObject({ seats: 2, status: 'ok' });
  });

  it('sends caller generation options to the final seat only', async () => {
    const h = harness(HANDOFF);
    await h.call('x', { responseFormat: { type: 'json_object' }, timeout: 9 });
    expect(h.calls[0]?.options).not.toHaveProperty('responseFormat');
    expect(h.calls[0]?.options.timeout).toBe(9);
    expect(h.calls[1]?.options.responseFormat).toEqual({ type: 'json_object' });
  });

  it('tells the merge seat which seat failed and why, and records degraded', async () => {
    const h = harness(PAIR, { 'cheap-m': fail() });
    await expect(h.call()).resolves.toBe('from great-m');
    expect(
      h.calls
        .map((c) => c.model)
        .slice(0, 2)
        .sort(),
    ).toEqual(['cheap-m', 'gpt-x']);
    expect(h.calls[2]?.model).toBe('great-m');
    const merge = h.calls[2]?.text ?? '';
    expect(merge).toMatch(
      /seat "skeptic" \(tier:cheap\) FAILED \(credential\)/,
    );
    expect(merge).toContain('from gpt-x');
    expect(h.runs[0]).toMatchObject({
      status: 'degraded',
      seats: 3,
      degradedSeats: 1,
    });
    const seats = (h.runs[0]?.details.seats ?? []) as Array<
      Record<string, unknown>
    >;
    expect(seats[0]).toMatchObject({
      persona: 'skeptic',
      status: 'failed',
      failure: { reason: 'credential' },
    });
    // The dead seat's own zero-token row carries the run tags.
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]?.tags).toMatchObject({
      fusionKey: 'review',
      seat: 'skeptic',
      outcome: 'failed',
    });
    expect(h.result()?.seats[0]?.failure?.reason).toBe('credential');
  });

  it('treats a seat setup failure (prompt read) as a dead seat, not a dead run', async () => {
    setFusionPromptResolver(async (key) => {
      if (key === 'p.skeptic') throw new Error('override read failed');
      return { instructions: `instructions for ${key}` };
    });
    const h = harness(PAIR);
    await expect(h.call()).resolves.toBe('from great-m');
    expect(h.calls.map((c) => c.model).sort()).toEqual(['gpt-x', 'great-m']);
    expect(h.calls.find((c) => c.model === 'great-m')?.text).toMatch(
      /seat "skeptic" \(tier:cheap\) FAILED \(unclassified\): override read failed/,
    );
    expect(h.runs[0]).toMatchObject({
      status: 'degraded',
      seats: 3,
      degradedSeats: 1,
    });
  });

  it('kills a seat whose tier may not run (#4757) without calling the configured client', async () => {
    const config: InferenceConfig = {
      tiers: { cheap: { model: 'cheap-m' }, great: { model: 'great-m' } },
    };
    const h = harness(
      HANDOFF,
      {},
      {
        resolveTier: async (tier) =>
          tier === 'cheap'
            ? {
                tierResolved: 'cheap',
                target: {},
                via: 'resolver',
                mode: 'byo',
                unavailable: 'unconfigured',
              }
            : resolveInferenceFromConfig({ tier }, config),
      },
    );
    await expect(h.call()).resolves.toBe('from great-m');
    // The drafter seat died before any client was built: one call, no
    // `default` (configured client) call.
    expect(h.calls.map((c) => c.model)).toEqual(['great-m']);
    expect(h.result()?.seats[0]?.status).toBe('failed');
  });

  it('treats a seat tier resolver failure as a dead seat', async () => {
    const h = harness(
      HANDOFF,
      {},
      {
        resolveTier: async (tier) => {
          if (tier === 'cheap') throw new Error('resolver down');
          return resolveInferenceFromConfig(
            { tier },
            {
              tiers: {
                cheap: { model: 'cheap-m' },
                great: { model: 'great-m' },
              },
            },
          );
        },
      },
    );
    await expect(h.call()).resolves.toBe('from great-m');
    expect(h.calls).toHaveLength(1);
    expect(h.result()?.seats[0]?.failure).toMatchObject({
      reason: 'unclassified',
      message: 'resolver down',
    });
    expect(h.runs[0]?.status).toBe('degraded');
  });

  it('settles both pair seats before a config error ends the run', async () => {
    const h = harness({
      ...PAIR,
      seats: [
        { name: 'skeptic', prompt: 'p.skeptic', target: 'best' },
        PAIR.seats[1],
        PAIR.seats[2],
      ] as InferenceFusionDefinition['seats'],
    });
    await expect(h.call()).rejects.toBeInstanceOf(InferenceConfigError);
    expect(h.calls.map((c) => c.model)).toEqual(['gpt-x']);
    expect(h.runs[0]?.status).toBe('failed');
    expect(
      ((h.runs[0]?.details.seats ?? []) as Array<{ status: string }>).map(
        (s) => s.status,
      ),
    ).toEqual(['failed', 'ok', 'not-run']);
  });

  it('throws when every seat died and keeps the run as failed', async () => {
    const h = harness(PAIR, { 'cheap-m': fail(), 'gpt-x': fail() });
    const error = await h.call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InferenceFusionError);
    expect((error as InferenceFusionError).code).toBe(
      'INFERENCE_FUSION_FAILED',
    );
    // The merge seat has nothing to merge and is never called.
    expect(h.calls.map((c) => c.model).sort()).toEqual(['cheap-m', 'gpt-x']);
    expect(h.runs[0]).toMatchObject({
      status: 'failed',
      seats: 2,
      degradedSeats: 2,
    });
    expect(
      ((h.runs[0]?.details.seats ?? []) as Array<{ status: string }>).map(
        (s) => s.status,
      ),
    ).toEqual(['failed', 'failed', 'not-run']);
    expect((error as InferenceFusionError).result.seats[2]?.status).toBe(
      'not-run',
    );
  });

  it('throws for a dead single seat, never an empty answer', async () => {
    const h = harness(
      { mode: 'single', seats: [{ prompt: 'p.draft', target: 'cheap' }] },
      { 'cheap-m': fail() },
    );
    await expect(h.call()).rejects.toBeInstanceOf(InferenceFusionError);
    expect(h.runs[0]?.status).toBe('failed');
  });

  it('answers with the draft when the handoff answer seat dies, recorded degraded', async () => {
    const h = harness(
      HANDOFF,
      { 'great-m': fail() },
      {
        config: {
          degrade: false,
          tiers: {
            best: { fusion: 'review' },
            cheap: { model: 'cheap-m' },
            great: { model: 'great-m' },
          },
          fusions: { review: HANDOFF },
        },
      },
    );
    await expect(h.call()).resolves.toBe('from cheap-m');
    expect(h.runs[0]).toMatchObject({ status: 'degraded', degradedSeats: 1 });
  });

  it('applies the ladder per seat and counts a substituted seat as degraded', async () => {
    const h = harness(HANDOFF, { 'great-m': fail() });
    // great is spent; the seat walks down to good, recorded as a substitution.
    await expect(h.call()).resolves.toBe('from good-m');
    expect(h.calls.map((c) => c.model)).toEqual([
      'cheap-m',
      'great-m',
      'good-m',
    ]);
    expect(h.calls[2]?.options.usageTags).toMatchObject({
      seat: 'reviewer',
      tierRequested: 'great',
      tierResolved: 'good',
    });
    expect(h.resolveTierCalls).toContainEqual({
      tier: 'good',
      promptKey: 'p.review',
    });
    expect(h.runs[0]).toMatchObject({ status: 'degraded', degradedSeats: 1 });
    const reviewer = (
      (h.runs[0]?.details.seats ?? []) as Array<Record<string, unknown>>
    )[1];
    expect(reviewer?.substitutions).toEqual([
      { from: 'default/great-m', to: 'default/good-m', reason: 'credential' },
    ]);
  });

  it('tells the answer seat when the draft seat died', async () => {
    const h = harness(HANDOFF, { 'cheap-m': fail() });
    await expect(h.call()).resolves.toBe('from great-m');
    expect(h.calls[1]?.text).toMatch(/Draft from seat "drafter".*FAILED/);
  });

  it('skips the remaining stage when the gate is sufficient, recorded as skipped', async () => {
    const decisions: Harness['decisions'] = [];
    const h = harness(
      {
        ...HANDOFF,
        gate: {
          criteria: 'The draft answers every question.',
          sufficientWhen: { choice: 'done', minConfidence: 0.8 },
        },
      },
      {},
      { decide: decider({ choice: 'done', confidence: 0.9 }, decisions) },
    );
    await expect(h.call()).resolves.toBe('from cheap-m');
    expect(h.calls).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    const question = decisions[0]?.request.questions.gate as {
      type: string;
      instructions: string;
      criteria: Record<string, unknown>;
    };
    expect(question.type).toBe('choice');
    expect(question.instructions).toBe('The draft answers every question.');
    expect(Object.keys(question.criteria)).toEqual(['done', 'continue']);
    expect(decisions[0]?.tags).toMatchObject({
      fusionKey: 'review',
      seat: 'gate',
    });
    expect(h.runs[0]).toMatchObject({ status: 'ok', seats: 1 });
    expect(h.runs[0]?.details).toMatchObject({
      seats: [{ status: 'ok' }, { persona: 'reviewer', status: 'skipped' }],
      gate: {
        status: 'sufficient',
        choice: 'done',
        confidence: 0.9,
        model: 'typesafe/judge',
      },
    });
  });

  it('runs the remaining stage when the gate is not confident enough', async () => {
    const decisions: Harness['decisions'] = [];
    const h = harness(
      {
        ...PAIR,
        gate: {
          criteria: 'Both agree.',
          sufficientWhen: { choice: 'agree', minConfidence: 0.8 },
        },
      },
      {},
      { decide: decider({ choice: 'agree', confidence: 0.5 }, decisions) },
    );
    await expect(h.call()).resolves.toBe('from great-m');
    expect(h.calls).toHaveLength(3);
    expect(h.result()?.gate?.status).toBe('insufficient');
  });

  it('runs the remaining stage when no decision client is configured', async () => {
    const h = harness(
      {
        ...HANDOFF,
        gate: {
          criteria: 'Good enough.',
          sufficientWhen: { choice: 'yes', minConfidence: 0.5 },
        },
      },
      {},
      { decide: async () => undefined },
    );
    await expect(h.call()).resolves.toBe('from great-m');
    expect(h.calls).toHaveLength(2);
    expect(h.runs[0]?.details.gate).toEqual({ status: 'unavailable' });
  });

  it('keeps unparsable JSON as raw text and hands it on', async () => {
    const h = harness(
      {
        mode: 'handoff',
        seats: [
          {
            name: 'drafter',
            prompt: 'p.draft',
            target: 'cheap',
            output: 'json',
          },
          { name: 'reviewer', prompt: 'p.review', target: 'great' },
        ],
      },
      { 'cheap-m': () => 'not { json' },
    );
    await expect(h.call()).resolves.toBe('from great-m');
    expect(h.calls[0]?.options.responseFormat).toEqual({ type: 'json_object' });
    const drafter = h.result()?.seats[0];
    expect(drafter?.raw).toBe('not { json');
    expect(drafter?.json).toBeUndefined();
    expect(drafter?.parseError).toBeTruthy();
    expect(h.calls[1]?.text).toContain('not { json');
    expect(h.calls[1]?.text).toContain('did not parse');
    expect(
      ((h.runs[0]?.details.seats ?? []) as Array<{ json?: string }>)[0]?.json,
    ).toBe('unparsed');
  });

  it('parses a JSON seat', async () => {
    const h = harness(
      {
        mode: 'single',
        seats: [{ prompt: 'p.draft', target: 'cheap', output: 'json' }],
      },
      { 'cheap-m': () => '{"ok":true}' },
    );
    await expect(h.call()).resolves.toBe('{"ok":true}');
    expect(h.result()?.seats[0]?.json).toEqual({ ok: true });
  });

  it('runs a JSON seat in text on a model without JSON mode (#4758)', async () => {
    const h = harness(
      {
        mode: 'single',
        seats: [{ prompt: 'p.draft', target: 'cheap', output: 'json' }],
      },
      { 'cheap-m': () => 'draft in prose' },
      {
        capabilitiesFor: async () => ({
          json: false,
          tools: false,
          vision: false,
          source: 'assumed',
        }),
      },
    );
    await expect(h.call()).resolves.toBe('draft in prose');
    // Not skipped as missing-capability: the seat runs without JSON mode and
    // keeps its text on the raw recovery path.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.options).not.toHaveProperty('responseFormat');
    expect(h.calls[0]?.options).not.toHaveProperty('capabilityFallback');
    expect(h.calls[0]?.options.usageTags?.capabilityFallback).toBe('json→text');
    expect(h.result()?.seats[0]?.raw).toBe('draft in prose');
  });

  it('refuses a tier seat that resolves to another fusion', async () => {
    const h = harness({
      mode: 'single',
      seats: [{ prompt: 'p.draft', target: 'best' }],
    });
    await expect(h.call()).rejects.toThrow(/never runs a fusion/);
    expect(h.runs[0]?.status).toBe('failed');
  });

  it('only runs message()', async () => {
    const h = harness(HANDOFF);
    await h.call();
    const client = createChainExecutor().createClient({
      request: { tier: 'best' },
      resolution: {
        tierResolved: 'best',
        target: { fusion: 'review' },
        via: 'config',
      },
      config: { fusions: { review: HANDOFF } },
      clientFor: async () => ({ message: async () => '' }),
      resolveTier: async () => ({
        tierResolved: 'cheap',
        target: {},
        via: 'default',
      }),
      recordUsage: async () => {},
    });
    expect(() => (client.chat as () => unknown)()).toThrow(/message\(\)/);
  });
});

describe('fusion definitions', () => {
  beforeEach(() => registerPrompts(PROMPTS));
  afterEach(() => clearFusions());

  it('rejects an unregistered prompt key at define time, by path', () => {
    expect(() =>
      defineFusion({
        key: 'x',
        mode: 'single',
        seats: [{ prompt: 'nope.prompt', target: 'good' }],
      }),
    ).toThrow(/fusions\.x\.seats\[0\]\.prompt names prompt "nope\.prompt"/);
  });

  it('rejects an unregistered prompt key in config as a load error', () => {
    const config: InferenceConfig = {
      fusions: {
        review: {
          ...PAIR,
          seats: [
            PAIR.seats[0],
            { ...PAIR.seats[1], prompt: 'missing' },
            PAIR.seats[2],
          ] as InferenceFusionDefinition['seats'],
        },
      },
    };
    let error: unknown;
    try {
      validateInferenceConfig(config);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InferenceConfigError);
    expect((error as InferenceConfigError).issues).toEqual([
      expect.objectContaining({
        path: 'inference.fusions.review.seats[1].prompt',
        code: 'fusion-prompt-unknown',
      }),
    ]);
    // The structural check (the doctor's) does not need the app's prompts.
    expect(findInferenceConfigIssues(config)).toEqual([]);
  });

  it('names every structural offender by path', () => {
    const issues = findInferenceConfigIssues({
      tiers: { best: { fusion: 'ghost' } },
      aliases: {},
      fusions: {
        a: { mode: 'pair', seats: [PAIR.seats[0] as never] },
        b: {
          mode: 'single',
          seats: [{ prompt: 'p.draft', target: { fusion: 'a' } }],
          gate: {
            criteria: 'x',
            sufficientWhen: { choice: 'y', minConfidence: 1 },
          },
        },
        c: {
          mode: 'handoff',
          seats: [
            { prompt: 'p.draft', target: 'turbo' as never },
            { prompt: 'p.draft', target: { alias: 'nope' } },
          ],
          gate: {
            criteria: '',
            sufficientWhen: { choice: 'continue', minConfidence: 2 },
          },
        },
      },
    });
    expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['inference.tiers.best', 'fusion-unknown'],
      ['inference.fusions.a.seats', 'fusion-invalid'],
      ['inference.fusions.b.seats[0].target', 'fusion-nested'],
      ['inference.fusions.b.gate', 'fusion-invalid'],
      ['inference.fusions.c.seats[0].target', 'fusion-invalid'],
      ['inference.fusions.c.seats[1].name', 'fusion-invalid'],
      ['inference.fusions.c.seats[1].target', 'alias-unknown'],
      ['inference.fusions.c.gate.criteria', 'fusion-invalid'],
      ['inference.fusions.c.gate.sufficientWhen.choice', 'fusion-invalid'],
      [
        'inference.fusions.c.gate.sufficientWhen.minConfidence',
        'fusion-invalid',
      ],
    ]);
  });

  it('reserves the gate seat name', () => {
    expect(() =>
      defineFusion({
        key: 'g',
        mode: 'single',
        seats: [{ name: 'gate', prompt: 'p.draft', target: 'good' }],
      }),
    ).toThrow(/fusions\.g\.seats\[0\]\.name "gate" is reserved/);
  });

  it('registers code fusions; config wins over a registered one', async () => {
    defineFusion({ key: 'review', ...HANDOFF });
    expect(() => defineFusion({ key: 'review', ...HANDOFF })).not.toThrow();
    expect(() => defineFusion({ key: 'review', ...PAIR })).toThrow(
      /already defined/,
    );
    expect(
      findInferenceConfigIssues({ tiers: { best: { fusion: 'review' } } }),
    ).toEqual([]);
  });
});
