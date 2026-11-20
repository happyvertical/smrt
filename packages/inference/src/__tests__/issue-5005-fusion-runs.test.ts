/**
 * Fusion runs opened at the start (#5005; docs/content/ai-runs.md sections
 * 3, 6.2 and 6.3) through a real SmrtObject on SQLite: the `fusion` run row
 * exists, `running`, before the first seat is sent, with every seat and the
 * judge reserved together; each seat is a settled `call` event of the run
 * with its usage row; a fusion inside a run is a child run with a `handoff`
 * event; a joint reservation that does not fit sends nothing and reaches
 * the parent as a stop; and a fusion does not run untracked.
 */
import {
  AiRunClaimLostError,
  AiRunStoppedError,
  AiRunTrackingDisabledError,
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
import { registerInference } from '../index.js';

@smrt()
class Issue5005FusionNote extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  async client() {
    return this.getAiClient('best', { runTracking: true });
  }
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

describe('fusion runs opened at the start (#5005)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let failWith: (model: string) => Error | undefined = () => undefined;

  beforeEach(async () => {
    failWith = () => undefined;
    config.reset();
    setInferenceResolver(undefined);
    registerInference({ executor: { sleep: async () => {} } });
    PromptRegistry.clear();
    clearPromptCache();
    definePrompt({ key: 'notes.skeptic', template: 'Find the weak points.' });
    definePrompt({ key: 'notes.advocate', template: 'Find the strengths.' });
    definePrompt({ key: 'notes.synthesis', template: 'Merge the reviews.' });
    db = await getTestDatabase({
      classes: ['Issue5005FusionNote', 'PromptOverride'],
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

  async function note(usage?: Record<string, unknown>) {
    const calls: Array<{ model: string; options: Record<string, unknown> }> =
      [];
    const seenAtFirstCall: Array<Record<string, unknown>> = [];
    let instance: Issue5005FusionNote;
    const ai = {
      embed: () => {},
      message: async (_text: string, options: Record<string, unknown>) => {
        const model = String(options.model ?? 'configured');
        const failure = failWith(model);
        if (failure) throw failure;
        if (calls.length === 0) {
          seenAtFirstCall.push(
            ...rows(
              await db.query(
                `SELECT status, reserved_calls, reserved_tokens
                   FROM _smrt_ai_runs WHERE type = 'fusion'`,
              ),
            ),
          );
        }
        calls.push({ model, options });
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
    instance = new Issue5005FusionNote({
      ai,
      db,
      inference: FUSION_CONFIG,
      ...(usage ? { usage } : {}),
    } as never);
    await instance.initialize();
    return { instance, calls, seenAtFirstCall };
  }

  it('opens the run before the first seat, reserves the panel and judge together, and closes it done', async () => {
    const { instance, calls, seenAtFirstCall } = await note();
    await expect(
      instance.do('Review this contract', {
        tier: 'best',
        usageTags: { promptKey: 'notes.review', templateHash: 'h1' },
      }),
    ).resolves.toBe('from great-m');
    expect(calls).toHaveLength(3);
    // Written at the start, with all three seats' room held at once.
    expect(seenAtFirstCall).toHaveLength(1);
    expect(seenAtFirstCall[0]).toMatchObject({ status: 'running' });
    expect(Number(seenAtFirstCall[0]?.reserved_calls)).toBe(3);

    const [run] = rows(
      await db.query(`SELECT id FROM _smrt_ai_runs WHERE type = 'fusion'`),
    );
    const runId = String(run?.id);
    expect(await getAiRun(db, runId)).toMatchObject({
      type: 'fusion',
      definitionKey: 'review-pair',
      promptKey: 'notes.review',
      templateHash: 'h1',
      status: 'done',
      calls: 3,
      tokens: 30,
      reservedCalls: 0,
      reservedTokens: 0,
    });
    const events = rows(
      await db.query(
        `SELECT type, name, reservation, call_id FROM _smrt_ai_run_events
          WHERE run_id = $1 ORDER BY seq`,
        runId,
      ),
    );
    expect(events.map((event) => [event.type, event.reservation])).toEqual([
      ['call', 'settled'],
      ['call', 'settled'],
      ['call', 'settled'],
    ]);
    const usage = rows(
      await db.query(
        'SELECT id, call_id, entry_call_id, run_id FROM _smrt_ai_usage',
      ),
    );
    expect(usage).toHaveLength(3);
    const entry = usage[0]?.entry_call_id;
    for (const row of usage) {
      expect(row.run_id).toBe(runId);
      expect(row.call_id).toBe(row.id);
      expect(row.entry_call_id).toBe(entry);
    }
    expect(new Set(usage.map((row) => row.id))).toEqual(
      new Set(events.map((event) => event.call_id)),
    );
    expect((await checkAiRunTotals(db, runId)).matches).toBe(true);
  });

  it('runs a fusion inside a run as a child run with a handoff event', async () => {
    const { instance } = await note();
    const parent = await openAiRun(
      { db, usageTracking: true },
      { type: 'workflow', durable: true, budget: { maxTokens: 100_000 } },
    );
    const client = await instance.client();
    await client.message('Review', {
      runContext: { runId: parent.id, db },
    } as never);
    const [child] = rows(
      await db.query(
        `SELECT id, parent_run_id, status FROM _smrt_ai_runs WHERE type = 'fusion'`,
      ),
    );
    expect(child).toMatchObject({ parent_run_id: parent.id, status: 'done' });
    const handoff = rows(
      await db.query(
        `SELECT type, status, child_run_id, call_id, reservation
           FROM _smrt_ai_run_events WHERE run_id = $1`,
        parent.id,
      ),
    );
    expect(handoff).toHaveLength(1);
    expect(handoff[0]).toMatchObject({
      type: 'handoff',
      status: 'done',
      child_run_id: child?.id,
      reservation: null,
    });
    expect(typeof handoff[0]?.call_id).toBe('string');
    // Charged once: the parent's inclusive totals only.
    expect(await getAiRun(db, parent.id)).toMatchObject({
      calls: 0,
      tokens: 0,
      inclusiveCalls: 3,
      inclusiveTokens: 30,
      reservedTokens: 0,
    });
  });

  it('sends no seat when the joint reservation does not fit, and stops the parent', async () => {
    const { instance, calls } = await note();
    const parent = await openAiRun(
      { db, usageTracking: true },
      { type: 'workflow', durable: true, budget: { maxTokens: 9000 } },
    );
    const client = await instance.client();
    const error = await client
      .message('Review', { runContext: { runId: parent.id, db } } as never)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiRunStoppedError);
    expect(error).toMatchObject({
      runId: parent.id,
      status: 'stopped',
      stopReason: 'max_tokens',
      stoppedByRunId: parent.id,
    });
    expect(calls).toHaveLength(0);
    const [child] = rows(
      await db.query(`SELECT id FROM _smrt_ai_runs WHERE type = 'fusion'`),
    );
    const fusion = await getAiRun(db, String(child?.id));
    expect(fusion).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
      stoppedByRunId: parent.id,
      calls: 0,
    });
    expect(fusion?.finishedAt).toBeInstanceOf(Date);
    // Each seat sends the request and its prompt's instructions: the panel
    // (E + 4096 each) and the judge (E, 240 characters of framing, both
    // allowances and its own 4096).
    const request = 'Review'.length;
    const tokens = (chars: number) => Math.ceil(chars / 4);
    expect(fusion?.stopDetail).toMatchObject({
      limit: 'maxTokens',
      runId: parent.id,
      requested:
        tokens(request + 'Find the weak points.'.length) +
        4096 +
        (tokens(request + 'Find the strengths.'.length) + 4096) +
        (tokens(request + 'Merge the reviews.'.length + 240) + 2 * 4096 + 4096),
    });
    expect(await getAiRun(db, parent.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
      stopDetail: fusion?.stopDetail,
    });
    const handoff = rows(
      await db.query(
        `SELECT status FROM _smrt_ai_run_events WHERE run_id = $1`,
        parent.id,
      ),
    );
    expect(handoff).toEqual([{ status: 'stopped' }]);
    expect(rows(await db.query('SELECT id FROM _smrt_ai_usage'))).toHaveLength(
      0,
    );
  });

  it('leaves a held reservation and the fusion run alone when its worker loses the claim mid-fusion', async () => {
    const { instance, calls } = await note();
    const parent = await openAiRun(
      { db, usageTracking: true },
      { type: 'workflow', durable: true, budget: { maxTokens: 100_000 } },
    );
    const client = await instance.client();
    const error = await client
      .message('Review', {
        runContext: {
          runId: parent.id,
          db,
          // The claim is taken over once the first seat has been sent.
          fence: async () => calls.length === 0,
        },
      } as never)
      .catch((caught: unknown) => caught);
    expect((error as { code?: unknown }).code).toBe('AI_RUN_CLAIM_LOST');
    expect(error).not.toBeInstanceOf(AiRunStoppedError);
    // Not every seat was sent: the stale worker sent nothing after the loss.
    expect(calls.length).toBeLessThan(3);
    const [child] = rows(
      await db.query(`SELECT id FROM _smrt_ai_runs WHERE type = 'fusion'`),
    );
    const fusionId = String(child?.id);
    // The stale worker neither stopped the fusion nor its parent, and the
    // unsent seats' reservations are still held for the new claim holder.
    expect(await getAiRun(db, fusionId)).toMatchObject({ status: 'running' });
    expect(await getAiRun(db, parent.id)).toMatchObject({ status: 'running' });
    const reserved = rows(
      await db.query(
        `SELECT call_id FROM _smrt_ai_run_events
          WHERE run_id = $1 AND type = 'call' AND reservation = 'reserved'`,
        fusionId,
      ),
    );
    expect(reserved.length).toBe(3 - calls.length);
    expect((await getAiRun(db, fusionId))?.reservedCalls).toBe(
      3 - calls.length,
    );
  });

  it.each([
    [
      'the first seat aborts and the second loses the claim',
      'cheap-m',
      'great-m',
    ],
    [
      'the first seat loses the claim and the second aborts',
      'great-m',
      'cheap-m',
    ],
  ])('reports a lost claim over another seat failure in a pair: %s', async (_case, abortModel, lostModel) => {
    const { instance } = await note();
    const parent = await openAiRun(
      { db, usageTracking: true },
      { type: 'workflow', durable: true, budget: { maxTokens: 100_000 } },
    );
    // A seat's provider call fails with the error this returns for its model.
    failWith = (model) => {
      if (model === abortModel) {
        return Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      if (model === lostModel) return new AiRunClaimLostError(parent.id);
      return undefined;
    };
    const client = await instance.client();
    const error = await client
      .message('Review', {
        runContext: { runId: parent.id, db, fence: async () => true },
      } as never)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiRunClaimLostError);
    const [child] = rows(
      await db.query(`SELECT id FROM _smrt_ai_runs WHERE type = 'fusion'`),
    );
    const fusionId = String(child?.id);
    // Not recorded, closed or finished by the stale worker: the judge's
    // share is still reserved.
    expect(await getAiRun(db, fusionId)).toMatchObject({ status: 'running' });
    const judge = rows(
      await db.query(
        `SELECT reservation FROM _smrt_ai_run_events
          WHERE run_id = $1 AND type = 'call' AND name = 'synthesis'`,
        fusionId,
      ),
    );
    expect(judge).toEqual([{ reservation: 'reserved' }]);
  });

  it('does not run a fusion while usage persistence is off', async () => {
    const { instance, calls } = await note({ persist: false });
    await expect(
      instance.do('Review', { tier: 'best' }),
    ).rejects.toBeInstanceOf(AiRunTrackingDisabledError);
    expect(calls).toHaveLength(0);
    expect(rows(await db.query('SELECT id FROM _smrt_ai_runs'))).toHaveLength(
      0,
    );
  });
});
