/**
 * Calls of a run through smrt-inference (#5005; docs/content/ai-runs.md
 * sections 3, 6.3 and 6.4), on a real SmrtObject and SQLite:
 *
 * - `do()` hands its `runContext` to an alias chain's client, so the call
 *   that answers is a settled call of the run;
 * - a chain that never answered writes its zero-token row as a call of the
 *   run (own call id, no reservation);
 * - a fusion's gate is a reserved, run-tagged `gate` seat of the fusion run;
 * - alias seats reserve cost from the rate card, and a judge's estimate
 *   includes its prompt.
 */
import { AuthenticationError } from '@happyvertical/ai';
import {
  checkAiRunTotals,
  config,
  field,
  getAiRun,
  getTestDatabase,
  type InferenceConfig,
  openAiRun,
  SmrtObject,
  setInferenceExecutor,
  setInferenceResolver,
  smrt,
} from '@happyvertical/smrt-core';
import {
  clearPromptCache,
  definePrompt,
  PromptRegistry,
} from '@happyvertical/smrt-prompts';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InferenceExhaustedError, registerInference } from '../index.js';

@smrt()
class Issue5005RunCallNote extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

function rows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result;
  return ((result as { rows?: unknown[] })?.rows ?? []) as Array<
    Record<string, unknown>
  >;
}

describe('calls of a run through smrt-inference (#5005)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeEach(async () => {
    config.reset();
    setInferenceResolver(undefined);
    registerInference({ executor: { sleep: async () => {} } });
    PromptRegistry.clear();
    clearPromptCache();
    definePrompt({ key: 'notes.draft', template: 'Draft an answer.' });
    definePrompt({ key: 'notes.review', template: 'Review the draft.' });
    db = await getTestDatabase({
      classes: ['Issue5005RunCallNote', 'PromptOverride'],
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

  function note(
    inference: InferenceConfig,
    failing: Record<string, () => Error> = {},
    extra: Record<string, unknown> = {},
  ) {
    const calls: string[] = [];
    const sentText: Array<{ text: string; instructions: string }> = [];
    let instance: Issue5005RunCallNote;
    const ai = {
      embed: () => {},
      message: async (_text: string, options: Record<string, unknown>) => {
        const model = String(options.model ?? 'configured');
        calls.push(model);
        sentText.push({
          text: _text,
          instructions: String(
            (options.history as Array<{ content?: string }> | undefined)?.[0]
              ?.content ?? '',
          ),
        });
        const make = failing[model];
        if (make) throw make();
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
    instance = new Issue5005RunCallNote({
      ai,
      db,
      inference,
      ...extra,
    } as never);
    return { instance, calls, sentText };
  }

  const ALIAS: InferenceConfig = {
    aliases: {
      frontier: { candidates: [{ model: 'first' }, { model: 'second' }] },
    },
    tiers: { great: { alias: 'frontier' } },
  };

  it("hands do()'s run context to an alias chain: the answering call is a settled call of the run", async () => {
    const { instance, calls } = note(ALIAS);
    await instance.initialize();
    const run = await openAiRun(
      { db, usageTracking: true },
      { type: 'turn', budget: { maxTokens: 100_000 } },
    );
    await expect(
      instance.do('summarize', {
        tier: 'great',
        usageTags: { promptKey: 'notes.draft' },
        runContext: { runId: run.id, db },
      }),
    ).resolves.toBe('from first');
    expect(calls).toEqual(['first']);
    expect(await getAiRun(db, run.id)).toMatchObject({
      calls: 1,
      tokens: 10,
      reservedCalls: 0,
      reservedTokens: 0,
    });
    const usage = rows(
      await db.query(
        'SELECT id, run_id, call_id, prompt_key FROM _smrt_ai_usage',
      ),
    );
    expect(usage).toEqual([
      expect.objectContaining({
        run_id: run.id,
        prompt_key: 'notes.draft',
      }),
    ]);
    expect(usage[0]?.call_id).toBe(usage[0]?.id);
    expect((await checkAiRunTotals(db, run.id)).matches).toBe(true);
  });

  it('charges the zero-token row of a chain that never answered to the run', async () => {
    const auth = () => new AuthenticationError('openai');
    const { instance } = note(ALIAS, {
      first: auth,
      second: auth,
      configured: auth,
    });
    await instance.initialize();
    const run = await openAiRun(
      { db, usageTracking: true },
      { type: 'turn', budget: { maxCalls: 50 } },
    );
    await expect(
      instance.do('summarize', {
        tier: 'great',
        usageTags: { promptKey: 'notes.draft' },
        runContext: { runId: run.id, db },
      }),
    ).rejects.toBeInstanceOf(InferenceExhaustedError);
    const failure = rows(
      await db.query(
        `SELECT id, call_id, run_id, total_tokens FROM _smrt_ai_usage
          WHERE tags LIKE '%"outcome":"failed"%'`,
      ),
    );
    expect(failure).toHaveLength(1);
    expect(failure[0]).toMatchObject({ run_id: run.id, total_tokens: 0 });
    // Its own call id, written as an unreserved call event of the run.
    const events = rows(
      await db.query(
        `SELECT reservation, call_id FROM _smrt_ai_run_events
          WHERE run_id = $1 AND type = 'call' AND reservation = 'unreserved'`,
        run.id,
      ),
    );
    expect(events).toEqual([
      { reservation: 'unreserved', call_id: failure[0]?.id },
    ]);
    const totals = await getAiRun(db, run.id);
    expect(totals?.calls).toBe(1);
    expect(totals?.reservedCalls).toBe(0);
    expect((await checkAiRunTotals(db, run.id)).matches).toBe(true);
  });

  describe('a fusion with a gate', () => {
    const GATED: InferenceConfig = {
      aliases: {
        pricey: { candidates: [{ model: 'pricey-m' }] },
      },
      tiers: { best: { fusion: 'draft-review' } },
      fusions: {
        'draft-review': {
          mode: 'handoff',
          seats: [
            {
              name: 'drafter',
              prompt: 'notes.draft',
              target: { alias: 'pricey' },
            },
            {
              name: 'reviewer',
              prompt: 'notes.review',
              target: { alias: 'pricey' },
            },
          ],
          gate: {
            criteria: 'The draft already answers the request.',
            sufficientWhen: { choice: 'done', minConfidence: 0.5 },
          },
        },
      },
    };

    function decisions(choice: string) {
      return {
        getCapabilities: async () => ({ decisions: true }),
        decide: async () => ({
          model: 'judge',
          provenance: { provider: 'typesafe', model: 'judge' },
          usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
          answers: {
            gate: {
              type: 'choice',
              choice,
              confidence: 0.9,
              probabilities: { done: 0.9, continue: 0.1 },
            },
          },
        }),
      };
    }

    it('reserves the gate with the seats and settles it as a run-tagged call', async () => {
      const { instance } = note(GATED, {}, { decisions: decisions('done') });
      await instance.initialize();
      await expect(
        instance.do('Review this contract', { tier: 'best' }),
      ).resolves.toBe('from pricey-m');
      const [run] = rows(
        await db.query(`SELECT id FROM _smrt_ai_runs WHERE type = 'fusion'`),
      );
      const runId = String(run?.id);
      const gate = rows(
        await db.query(
          `SELECT run_id, call_id, id, total_tokens, tags FROM _smrt_ai_usage
            WHERE tags LIKE '%"seat":"gate"%'`,
        ),
      );
      expect(gate).toHaveLength(1);
      expect(gate[0]).toMatchObject({ run_id: runId, total_tokens: 5 });
      expect(gate[0]?.call_id).toBe(gate[0]?.id);
      const events = rows(
        await db.query(
          `SELECT name, reservation FROM _smrt_ai_run_events
            WHERE run_id = $1 AND type = 'call' ORDER BY seq`,
          runId,
        ),
      );
      // The reviewer was skipped, so its share was released; the drafter
      // and the gate are the calls charged.
      expect(events.map((event) => [event.name, event.reservation])).toEqual([
        ['drafter', 'settled'],
        ['reviewer', 'released'],
        ['gate', 'settled'],
      ]);
      const total = await getAiRun(db, runId);
      expect(total).toMatchObject({
        calls: 2,
        tokens: 15,
        reservedCalls: 0,
        reservedTokens: 0,
      });
      expect((await checkAiRunTotals(db, runId)).matches).toBe(true);
    });

    it("prices alias seats from the rate card and counts the judge's prompt", async () => {
      const { instance, sentText } = note(
        GATED,
        {},
        {
          decisions: decisions('continue'),
          usage: {
            costRates: { 'pricey-m': { input: 2, output: 8 } },
          },
        },
      );
      await instance.initialize();
      await instance.do('Review this contract', { tier: 'best' });
      const [run] = rows(
        await db.query(
          `SELECT id, status FROM _smrt_ai_runs WHERE type = 'fusion'`,
        ),
      );
      const events = rows(
        await db.query(
          `SELECT name, reserved_tokens, reserved_cost FROM _smrt_ai_run_events
            WHERE run_id = $1 AND type = 'call' ORDER BY seq`,
          String(run?.id),
        ),
      );
      // Reservations are returned at settlement; the sizes are asserted on
      // the held amounts the events recorded when they were made.
      const byName = new Map(events.map((event) => [event.name, event]));
      expect(byName.get('drafter')?.reserved_cost).toBeGreaterThan(0);
      expect(byName.get('reviewer')?.reserved_cost).toBeGreaterThan(0);
      // The reviewer sends the request, its instructions and the draft's
      // allowance: more than the drafter, which sends the request and its
      // own (shorter) instructions only.
      expect(Number(byName.get('reviewer')?.reserved_tokens)).toBeGreaterThan(
        Number(byName.get('drafter')?.reserved_tokens),
      );
      const first = sentText[0] as { text: string; instructions: string };
      expect(Number(byName.get('drafter')?.reserved_tokens)).toBe(
        Math.ceil((first.text.length + first.instructions.length) / 4) + 4096,
      );
    });

    it('neither releases the skipped seat nor finishes the fusion when the claim is taken over before it closes', async () => {
      let claimHeld = true;
      const gate = decisions('done');
      const { instance } = note(
        GATED,
        {},
        {
          decisions: {
            ...gate,
            // The claim is taken over while the gate decides.
            decide: async (...args: unknown[]) => {
              claimHeld = false;
              return (gate.decide as (...a: unknown[]) => unknown)(...args);
            },
          },
        },
      );
      await instance.initialize();
      const parent = await openAiRun(
        { db, usageTracking: true },
        { type: 'workflow', durable: true },
      );
      const error = await instance
        .do('Review this contract', {
          tier: 'best',
          runContext: { runId: parent.id, db, fence: async () => claimHeld },
        } as never)
        .catch((caught: unknown) => caught);
      expect((error as { code?: unknown }).code).toBe('AI_RUN_CLAIM_LOST');
      const [run] = rows(
        await db.query(`SELECT id FROM _smrt_ai_runs WHERE type = 'fusion'`),
      );
      const runId = String(run?.id);
      // The stale worker finished nothing and released nothing: the skipped
      // reviewer's share is still reserved for the new claim holder.
      expect(await getAiRun(db, runId)).toMatchObject({
        status: 'running',
        reservedCalls: 1,
      });
      expect(await getAiRun(db, parent.id)).toMatchObject({
        status: 'running',
      });
      const events = rows(
        await db.query(
          `SELECT name, reservation FROM _smrt_ai_run_events
            WHERE run_id = $1 AND type = 'call' ORDER BY seq`,
          runId,
        ),
      );
      expect(events.map((event) => [event.name, event.reservation])).toEqual([
        ['drafter', 'settled'],
        ['reviewer', 'reserved'],
        ['gate', 'settled'],
      ]);
    });
  });
});
