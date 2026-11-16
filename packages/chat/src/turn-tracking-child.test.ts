/**
 * A workflow step's chat turn as a CHILD run of the workflow run (#5005,
 * #4994): a `handoff` event in the parent, the parent's fence on the child's
 * calls, the step's prompt on its usage rows, the child's calls in the
 * parent's inclusive totals, and the parent's stop, budget and cancel
 * reaching the child. Real SQLite; a scripted model, no provider.
 */
import {
  AiRunStoppedError,
  cancelAiRun,
  createTrackedAiClient,
  getAiRun,
  getRunTrajectory,
  getTestDatabase,
  stopAiRun,
} from '@happyvertical/smrt-core';
import {
  definePrompt,
  PromptRegistry,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssistantTurnRun, chatClientForTracking } from './turn-tracking.js';

const STEP_PROMPT = 'test.chat.workflow-step';
let db: DatabaseInterface;

const model = {
  calls: 0,
  async chat() {
    model.calls++;
    return {
      content: '{"value":1}',
      model: 'scripted-model',
      finishReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
    };
  },
};

beforeEach(async () => {
  model.calls = 0;
  definePrompt({ key: STEP_PROMPT, template: 'Step {n}: propose.' });
  db = await getTestDatabase({ type: 'sqlite', classes: ['PromptOverride'] });
});
afterEach(async () => {
  PromptRegistry.clear();
  await (db as { close?: () => Promise<void> }).close?.();
});

async function stepTurn(budget?: Record<string, number>) {
  const tracked = createTrackedAiClient({
    db,
    tenantId: null,
    ai: chatClientForTracking(model),
    transcript: false,
  });
  const { run: parent, context } = await tracked.openRun({
    type: 'workflow',
    definitionKey: 'test.workflow',
    definitionVersion: '1',
    ownerId: 'owner',
    durable: true,
    checkpoint: { state: {} },
    ...(budget ? { budget } : {}),
  });
  const fence = async () => {};
  const prompt = await resolvePrompt(STEP_PROMPT, {
    tenantId: null,
    variables: { n: '1' },
  });
  const turn = await AssistantTurnRun.open({
    tracked,
    prompt,
    parent: {
      context: { ...context, fence, stepIndex: 0, stepName: 'Propose' },
      stepIndex: 0,
      name: 'Propose',
    },
  });
  const call = async () =>
    (await turn.client()).chat([{ role: 'user', content: 'go' }], {
      maxTokens: 50,
    } as never);
  return { parent, turn, fence, call };
}

describe('a workflow step turn as a child run', () => {
  it('records a handoff in the parent and rolls the child calls into its totals', async () => {
    const { parent, turn, fence, call } = await stepTurn();
    expect(turn.context.fence).toBe(fence);
    await call();
    await call();
    await turn.finish('done');

    const child = await getAiRun(db, turn.runId);
    expect(child).toMatchObject({
      type: 'turn',
      parentRunId: parent.id,
      status: 'done',
      calls: 2,
      tokens: 80,
    });
    expect(await getAiRun(db, parent.id)).toMatchObject({
      status: 'running',
      inclusiveCalls: 2,
      inclusiveTokens: 80,
    });
    const handoffs = ((await getRunTrajectory(db, parent.id))?.entries ?? [])
      .map((entry) => entry.event)
      .filter((event) => event?.type === 'handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      status: 'done',
      stepIndex: 0,
      name: 'Propose',
      childRunId: turn.runId,
    });
    const usage = (
      (await db.query(
        'SELECT prompt_key FROM _smrt_ai_usage WHERE run_id = ?',
        turn.runId,
      )) as { rows: Array<{ prompt_key: string }> }
    ).rows;
    expect(usage.map((row) => row.prompt_key)).toEqual([
      STEP_PROMPT,
      STEP_PROMPT,
    ]);
  });

  it('stops the child at the parent budget and after a parent stop', async () => {
    const limited = await stepTurn({ maxTokens: 60 });
    await limited.call();
    await expect(limited.call()).rejects.toBeInstanceOf(AiRunStoppedError);
    expect(model.calls).toBe(1);
    await limited.turn.finish('failed');
    // The child's stop reaches the parent as a stop with the limit's reason.
    expect(await getAiRun(db, limited.parent.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
    });

    const stopped = await stepTurn();
    await stopped.call();
    await stopAiRun(db, stopped.parent.id, { reason: 'interrupted' });
    await expect(stopped.call()).rejects.toBeInstanceOf(AiRunStoppedError);
    expect(model.calls).toBe(2);
    await stopped.turn.finish('failed');
    expect((await getAiRun(db, stopped.turn.runId))?.status).toBe('stopped');
  });

  it('is cancelled with the parent', async () => {
    const { parent, turn, call } = await stepTurn();
    await call();
    await cancelAiRun(db, parent.id);
    expect((await getAiRun(db, turn.runId))?.status).toBe('cancelled');
    await expect(call()).rejects.toBeInstanceOf(AiRunStoppedError);
    await turn.finish('failed');
    const handoff = ((await getRunTrajectory(db, parent.id))?.entries ?? [])
      .map((entry) => entry.event)
      .find((event) => event?.type === 'handoff');
    expect(handoff?.status).toBe('cancelled');
  });
});
