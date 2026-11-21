import {
  AiRunClaimLostError,
  AiRunStoppedError,
  createTrackedAiClient,
  getAiRun,
  getRunTrajectory,
  getTestDatabase,
} from '@happyvertical/smrt-core';
import { definePrompt, resolvePrompt } from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chatClientForTracking } from './turn-tracking.js';
import { runWorkflowStepTurn } from './workflow-step-turn.js';

let db: DatabaseInterface;
beforeEach(async () => {
  db = await getTestDatabase({ type: 'sqlite', classes: ['PromptOverride'] });
});
afterEach(async () => {
  await (db as { close?: () => Promise<void> }).close?.();
});

async function setup(budget = {}) {
  definePrompt({
    key: 'test.workflow.plan',
    template: 'Return {"tables":[]}.',
    ai: { profile: 'best' },
  });
  const ai = {
    chat: async () => ({
      content: '{"tables":[]}',
      finishReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    }),
  };
  const tracked = createTrackedAiClient({
    db,
    tenantId: null,
    ai: chatClientForTracking(ai),
    transcript: false,
  });
  const { run, context } = await tracked.openRun({
    type: 'workflow',
    definitionKey: 'test.workflow',
    ownerId: 'owner',
    budget,
  });
  return {
    run,
    options: {
      ai,
      principal: {
        runAsUserId: 'owner',
        tenantId: null,
        allowedTools: ['app.apply'],
      },
      tracking: {
        tracked,
        prompt: await resolvePrompt('test.workflow.plan', { tenantId: null }),
        parent: { context, stepIndex: 0, name: 'Plan' },
      },
      maxTokens: 100,
    },
  };
}

it.each([
  'api',
  'claude-code',
  'codex',
  'chatgpt',
] as const)('records a tool-free %s child turn and rolls its usage into the workflow', async (engine) => {
  const { run, options } = await setup();
  const external = engine === 'claude-code' || engine === 'codex';
  const unknown = engine === 'codex' || engine === 'chatgpt';
  const ai = unknown
    ? { chat: async () => ({ content: '{"tables":[]}', finishReason: 'stop' }) }
    : options.ai;
  const tracked = createTrackedAiClient({
    db,
    tenantId: null,
    ai: chatClientForTracking(ai),
    ...(engine !== 'api'
      ? { label: { provider: engine, model: 'bound' } }
      : {}),
    transcript: false,
  });
  expect(
    await runWorkflowStepTurn({
      ...options,
      ai,
      tracking: { ...options.tracking, tracked },
      selection: { engine, tier: 'best', model: 'bound' },
      ...(external
        ? {
            turnDriver: {
              async run(context, callbacks) {
                expect(context.tools).toEqual([]);
                expect(context.extraTools).toEqual([]);
                expect(context.principal.allowedTools).toEqual([]);
                expect(context.systemPrompt).toContain('Return');
                callbacks.done({
                  text: '{"tables":[]}',
                  execution: {
                    engine,
                    model: 'observed',
                    durationMs: 1,
                    toolCalls: 0,
                    ...(!unknown
                      ? { tokens: 30, inputTokens: 20, outputTokens: 10 }
                      : {}),
                  },
                });
              },
            },
          }
        : {}),
    }),
  ).toBe('{"tables":[]}');
  const handoff = (
    await getRunTrajectory(db, run.id, { allowCrossTenant: true })
  )?.entries
    .map(({ event }) => event)
    .find((event) => event?.type === 'handoff');
  expect(handoff).toMatchObject({ status: 'done', name: 'Plan', stepIndex: 0 });
  const childId = handoff!.childRunId!;
  expect(await getAiRun(db, childId)).toMatchObject({
    parentRunId: run.id,
    type: 'turn',
    status: 'done',
    calls: 1,
    ...(unknown ? { uncostedCalls: 1 } : { tokens: 30 }),
  });
  const events = (
    await getRunTrajectory(db, childId, { allowCrossTenant: true })
  )?.entries.map(({ event }) => event);
  expect(events?.filter((event) => event?.type === 'call')).toHaveLength(1);
  expect(events?.some((event) => event?.type === 'action')).toBe(false);
  const rows = (
    await db.query(
      'SELECT provider, prompt_key, prompt_tokens, completion_tokens FROM _smrt_ai_usage WHERE run_id = ?',
      childId,
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    prompt_key: 'test.workflow.plan',
    ...(engine !== 'api' ? { provider: engine } : {}),
    prompt_tokens: unknown ? null : 20,
    completion_tokens: unknown ? null : 10,
  });
  expect(await getAiRun(db, run.id)).toMatchObject({ inclusiveCalls: 1 });
});

it('propagates parent budget stops before starting an external engine', async () => {
  const { run, options } = await setup({ maxCalls: 0 });
  let started = false;
  await expect(
    runWorkflowStepTurn({
      ...options,
      selection: { engine: 'codex', tier: 'best' },
      turnDriver: {
        async run() {
          started = true;
        },
      },
    }),
  ).rejects.toBeInstanceOf(AiRunStoppedError);
  expect(started).toBe(false);
  expect(await getAiRun(db, run.id)).toMatchObject({
    status: 'stopped',
    stopReason: 'max_calls',
  });
});

it.each([
  'false',
  'throw',
  'job',
])('propagates a %s claim loss instead of synthetic plan JSON', async (mode) => {
  const { run, options } = await setup();
  options.tracking.parent.context.fence = async () => {
    if (mode === 'false') return false;
    if (mode === 'job')
      throw Object.assign(new Error(), { name: 'JobClaimLostError' });
    throw new AiRunClaimLostError(run.id);
  };
  await expect(runWorkflowStepTurn(options)).rejects.toBeInstanceOf(
    AiRunClaimLostError,
  );
});
