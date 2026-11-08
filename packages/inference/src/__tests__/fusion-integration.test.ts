/**
 * Fusions end to end (#4753) through a real SmrtObject on SQLite:
 * `do(..., { tier: 'best' })` runs a `{ fusion }` tier with no caller
 * change, seats resolve their instructions through smrt-prompts (an app
 * override stored in the instance database wins), every seat's
 * `_smrt_ai_usage` row carries `run_id` plus `fusionKey` / `seat` tags, the
 * run lands in `_smrt_ai_runs`, and `reportAiRuns()` totals it.
 */
import {
  config,
  field,
  getTestDatabase,
  type InferenceConfig,
  listAiRuns,
  reportAiRuns,
  reportAiUsage,
  SmrtObject,
  setInferenceExecutor,
  setInferenceResolver,
  smrt,
} from '@happyvertical/smrt-core';
import {
  clearPromptCache,
  definePrompt,
  PromptOverrideCollection,
  PromptRegistry,
} from '@happyvertical/smrt-prompts';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InferenceFusionError, registerInference } from '../index.js';

@smrt()
class Issue4753Note extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

const FUSION_CONFIG: InferenceConfig = {
  tiers: {
    best: { fusion: 'review-pair' },
    cheap: { model: 'cheap-m' },
    great: { model: 'great-m' },
  },
  fusions: {
    'review-pair': {
      mode: 'pair',
      description: 'Skeptic and advocate, then a synthesis',
      seats: [
        { name: 'skeptic', prompt: 'notes.skeptic', target: 'cheap' },
        { name: 'advocate', prompt: 'notes.advocate', target: 'great' },
        { name: 'synthesis', prompt: 'notes.synthesis', target: 'great' },
      ],
    },
  },
};

function rows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result;
  return ((result as { rows?: unknown[] })?.rows ?? []) as Array<
    Record<string, unknown>
  >;
}

describe('fusions through a SmrtObject (#4753)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeEach(async () => {
    config.reset();
    setInferenceResolver(undefined);
    registerInference({ executor: { sleep: async () => {} } });
    PromptRegistry.clear();
    clearPromptCache();
    definePrompt({
      key: 'notes.skeptic',
      template: 'Find the weak points.',
      editable: { template: true },
    });
    definePrompt({ key: 'notes.advocate', template: 'Find the strengths.' });
    definePrompt({ key: 'notes.synthesis', template: 'Merge the reviews.' });
    db = await getTestDatabase({
      classes: ['Issue4753Note', 'PromptOverride'],
    });
  });

  afterEach(async () => {
    clearPromptCache();
    PromptRegistry.clear();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  afterAll(() => {
    setInferenceResolver(undefined);
    setInferenceExecutor(undefined);
  });

  async function note(failing: string[] = []) {
    const calls: Array<{ model: string; options: Record<string, unknown> }> =
      [];
    let instance: Issue4753Note;
    const ai = {
      embed: () => {},
      message: async (_text: string, options: Record<string, unknown>) => {
        const model = String(options.model ?? 'configured');
        calls.push({ model, options });
        if (failing.includes(model)) {
          throw Object.assign(new Error('denied'), {
            name: 'AuthenticationError',
          });
        }
        // An injected client has no SDK usage hook: report like one.
        await (
          instance as unknown as {
            recordAiUsageEvent(event: unknown, config: unknown): Promise<void>;
          }
        ).recordAiUsageEvent(
          {
            provider: 'openai',
            model,
            operation: 'message',
            usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
            tags: options.usageTags,
          },
          {},
        );
        return `from ${model}`;
      },
    };
    instance = new Issue4753Note({
      ai,
      db,
      inference: FUSION_CONFIG,
    } as never);
    await instance.initialize();
    return { instance, calls };
  }

  it('runs a fusion tier with no caller change and records the run', async () => {
    const overrides = await PromptOverrideCollection.create({ db });
    await overrides.setTemplateOverride(
      'notes.skeptic',
      'app',
      '__app__',
      'App skeptic instructions.',
    );
    clearPromptCache();

    const { instance, calls } = await note();
    await expect(
      instance.do('Review this contract', {
        tier: 'best',
        usageTags: { promptKey: 'notes.review' },
      }),
    ).resolves.toBe('from great-m');
    expect(calls).toHaveLength(3);
    const skeptic = calls.find((c) => c.model === 'cheap-m');
    expect(skeptic?.options.history).toEqual([
      { role: 'system', content: 'App skeptic instructions.' },
    ]);
    expect(skeptic?.options.usageTags).toMatchObject({
      promptKey: 'notes.skeptic',
      promptLayer: 'app',
    });

    const usage = rows(
      await db.query(
        'SELECT prompt_key, run_id, tier_resolved, tags FROM _smrt_ai_usage ORDER BY prompt_key',
      ),
    );
    expect(usage).toHaveLength(3);
    const runId = usage[0]?.run_id;
    expect(typeof runId).toBe('string');
    expect(usage.map((row) => row.run_id)).toEqual([runId, runId, runId]);
    expect(usage.map((row) => row.prompt_key)).toEqual([
      'notes.advocate',
      'notes.skeptic',
      'notes.synthesis',
    ]);
    expect(
      usage.map((row) => JSON.parse(String(row.tags)).seat).sort(),
    ).toEqual(['advocate', 'skeptic', 'synthesis']);
    for (const row of usage) {
      expect(JSON.parse(String(row.tags)).fusionKey).toBe('review-pair');
    }

    const runs = await listAiRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      fusionKey: 'review-pair',
      mode: 'pair',
      promptKey: 'notes.review',
      className: 'Issue4753Note',
      seats: 3,
      degradedSeats: 0,
      status: 'ok',
    });
    const seats = runs[0]?.details.seats as Array<Record<string, unknown>>;
    expect(seats.map((seat) => seat.persona)).toEqual([
      'skeptic',
      'advocate',
      'synthesis',
    ]);
    expect(seats[0]?.usage).toMatchObject({ totalTokens: 10 });

    const report = await reportAiRuns(db);
    expect(report.buckets).toEqual([
      expect.objectContaining({ fusionKey: 'review-pair', runs: 1, ok: 1 }),
    ]);
    const byFusion = await reportAiUsage(db, { by: ['fusion'] });
    expect(byFusion.buckets[0]).toMatchObject({
      key: { fusion: 'review-pair' },
      calls: 3,
    });
  });

  it('keeps a failed run when every seat died', async () => {
    const { instance } = await note(['cheap-m', 'great-m', 'configured']);
    await expect(
      instance.do('Review this contract', { tier: 'best' }),
    ).rejects.toBeInstanceOf(InferenceFusionError);
    const runs = await listAiRuns(db, { status: 'failed' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ seats: 2, degradedSeats: 2 });
  });
});
