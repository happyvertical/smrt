/**
 * The AI run lifecycle (#5005; docs/content/ai-runs.md sections 2, 6.3 and
 * 7): opening a run, the guarded transition table, steps, checkpoints,
 * resuming, retrying a failed workflow, events and trajectories, and the
 * explicit run context. Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { setTranscriptRedactor } from '../ai-transcripts';
import {
  AI_RUN_POLICY,
  AiRunCheckpointConflictError,
  AiRunNotFoundError,
  AiRunResumeRefusedError,
  AiRunStoppedError,
  AiRunTrackingDisabledError,
  AiRunTransitionError,
  appendAiRunEvent,
  cancelAiRun,
  finishAiRun,
  getAiRun,
  getRunTrajectory,
  isAiRunTransitionAllowed,
  openAiRun,
  readAiRunCheckpoint,
  recordAiEvaluation,
  reserveAiCall,
  restoreAiRunContext,
  resumeAiRun,
  saveAiRunCheckpoint,
  serializeAiRunContext,
  settleAiCall,
  startAiRunStep,
  stopAiRun,
  transitionAiRun,
  updateAiRun,
  waitAiRunApproval,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
  usageEvent,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  setTranscriptRedactor(undefined);
  await closeAiRunTestDatabases();
});

describe('the decided product rules (#5005)', () => {
  it('records the six decisions as the page states them', () => {
    expect(AI_RUN_POLICY).toEqual({
      cancel: 'final-with-interrupted',
      failedWorkflowRetry: 'from-last-accepted-step',
      uncostedUnderMaxCost: 'allow',
      approvalWait: 'durable-only',
      persistenceOff: 'required',
      unprotectedRows: 'prune-with-usage',
    });
  });

  it('allows exactly the moves of the transition table', () => {
    expect(isAiRunTransitionAllowed('running', 'waiting-approval', false)).toBe(
      false,
    );
    expect(isAiRunTransitionAllowed('running', 'waiting-approval', true)).toBe(
      true,
    );
    expect(isAiRunTransitionAllowed('stopped', 'running', false)).toBe(false);
    expect(isAiRunTransitionAllowed('stopped', 'cancelled', false)).toBe(false);
    expect(isAiRunTransitionAllowed('stopped', 'cancelled', true)).toBe(true);
    expect(isAiRunTransitionAllowed('waiting-approval', 'done', true)).toBe(
      false,
    );
    for (const final of ['cancelled', 'failed', 'done'] as const) {
      for (const to of ['running', 'stopped', 'done', 'failed'] as const) {
        expect(isAiRunTransitionAllowed(final, to, true)).toBe(false);
      }
    }
  });
});

describe.each(aiRunTestEngines)('AI run lifecycle on %s (#5005)', (engine) => {
  async function db(): Promise<DatabaseInterface> {
    return newAiRunTestDatabase(engine);
  }
  const store = (database: DatabaseInterface) => ({
    db: database,
    usageTracking: true,
  });

  it('refuses to open a run without usage tracking, before writing anything', async () => {
    const database = await db();
    await expect(
      openAiRun({ db: database, usageTracking: false }, { type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunTrackingDisabledError);
    await expect(
      openAiRun({ db: null, usageTracking: true }, { type: 'fusion' }),
    ).rejects.toBeInstanceOf(AiRunTrackingDisabledError);
    expect(
      rowsOf(await database.query('SELECT id FROM _smrt_ai_runs')),
    ).toEqual([]);
  });

  it('opens framework and namespaced run types, and refuses a bare custom type', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: '@happyvertical/smrt-agents:coding',
      definitionKey: 'fix-bug',
      definitionVersion: '3',
      ownerId: 'u1',
      experimentId: 'exp-1',
      datasetItem: 'item-7',
      tags: { model: 'gpt-4o' },
      budget: { maxCalls: 5, maxCost: 0.5 },
    });
    expect(run).toMatchObject({
      type: '@happyvertical/smrt-agents:coding',
      status: 'running',
      definitionKey: 'fix-bug',
      definitionVersion: '3',
      ownerId: 'u1',
      experimentId: 'exp-1',
      datasetItem: 'item-7',
      tags: { model: 'gpt-4o' },
      budget: { maxCalls: 5, maxCost: 0.5 },
      durable: false,
      retryOfRunId: null,
    });
    expect(run.activeSince).toBeInstanceOf(Date);
    await expect(
      openAiRun(store(database), { type: 'custom' }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      openAiRun(store(database), {
        type: 'turn',
        budget: { maxTokens: -1 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('guards every status change on the expected status', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    // The sweep set it failed underneath a slow process...
    await finishAiRun(database, run.id, {
      status: 'failed',
      stopReason: 'abandoned',
    });
    // ...so the slow process cannot write done over it.
    expect(await finishAiRun(database, run.id, { status: 'done' })).toBeNull();
    expect((await getAiRun(database, run.id))?.status).toBe('failed');
    // A final status goes nowhere.
    await expect(
      transitionAiRun(database, run.id, { from: 'failed', to: 'running' }),
    ).rejects.toBeInstanceOf(AiRunTransitionError);
    // A reason must fit its status.
    const other = await openAiRun(store(database), { type: 'turn' });
    await expect(
      transitionAiRun(database, other.id, {
        from: 'running',
        to: 'stopped',
        stopReason: 'error',
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('lets only a durable run wait for approval; a stop of a non-durable run is final', async () => {
    const database = await db();
    const turn = await openAiRun(store(database), { type: 'turn' });
    await expect(waitAiRunApproval(database, turn.id)).rejects.toBeInstanceOf(
      AiRunTransitionError,
    );
    const stopped = await stopAiRun(database, turn.id);
    expect(stopped).toMatchObject({
      status: 'stopped',
      stopReason: 'interrupted',
    });
    expect(stopped?.finishedAt).toBeInstanceOf(Date);
    expect(await cancelAiRun(database, turn.id)).toBeNull();
    await expect(resumeAiRun(database, turn.id)).rejects.toBeInstanceOf(
      AiRunResumeRefusedError,
    );

    const workflow = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
    });
    expect(workflow.durable).toBe(true);
    const waiting = await waitAiRunApproval(database, workflow.id);
    expect(waiting).toMatchObject({
      status: 'waiting-approval',
      activeSince: null,
    });
    const resumed = await resumeAiRun(database, workflow.id);
    expect(resumed.status).toBe('running');
  });

  it('interrupts resumably and cancels for good', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
    });
    const paused = await stopAiRun(database, run.id);
    expect(paused).toMatchObject({
      status: 'stopped',
      stopReason: 'interrupted',
      finishedAt: null,
    });
    expect((await resumeAiRun(database, run.id)).status).toBe('running');
    const cancelled = await cancelAiRun(database, run.id);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      stopReason: 'cancelled',
      stoppedByRunId: run.id,
    });
    expect(cancelled?.finishedAt).toBeInstanceOf(Date);
    await expect(resumeAiRun(database, run.id)).rejects.toBeInstanceOf(
      AiRunResumeRefusedError,
    );
    expect(await cancelAiRun(database, run.id)).toBeNull();
  });

  it('counts a step once per step index, also across stops and resumes', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      budget: { maxSteps: 2 },
    });
    const first = await startAiRunStep(database, run.id, { stepIndex: 0 });
    expect(first.counted).toBe(true);
    // Re-entered three times after stops: never counted again.
    for (let i = 0; i < 3; i++) {
      await stopAiRun(database, run.id);
      await resumeAiRun(database, run.id);
      const again = await startAiRunStep(database, run.id, { stepIndex: 0 });
      expect(again.counted).toBe(false);
      expect(again.stepInstanceId).not.toBe(first.stepInstanceId);
    }
    expect((await getAiRun(database, run.id))?.stepsUsed).toBe(1);
    expect(
      (await readAiRunCheckpoint(database, run.id))?.highestStepIndex,
    ).toBe(0);
    await startAiRunStep(database, run.id, { stepIndex: 1 });
    const refused = startAiRunStep(database, run.id, { stepIndex: 2 });
    await expect(refused).rejects.toBeInstanceOf(AiRunStoppedError);
    const stopped = await getAiRun(database, run.id);
    expect(stopped).toMatchObject({
      status: 'stopped',
      stopReason: 'max_steps',
      stoppedByRunId: run.id,
      stopDetail: {
        limit: 'maxSteps',
        runId: run.id,
        limitValue: 2,
        used: 2,
        requested: 1,
        room: 0,
      },
      stepsUsed: 2,
    });
    // A stopped run starts nothing.
    await expect(
      startAiRunStep(database, run.id, { stepIndex: 1 }),
    ).rejects.toMatchObject({ status: 'stopped', stopReason: 'max_steps' });
  });

  it('measures maxDurationMs as active time, not time stopped', async () => {
    const database = await db();
    let now = new Date('2026-11-14T10:00:00.000Z');
    const clock = { now: () => now };
    const run = await openAiRun(
      store(database),
      { type: 'workflow', durable: true, budget: { maxDurationMs: 1000 } },
      clock,
    );
    now = new Date(now.getTime() + 600);
    await stopAiRun(database, run.id, clock);
    // An hour stopped does not count.
    now = new Date(now.getTime() + 3_600_000);
    await resumeAiRun(database, run.id, clock);
    now = new Date(now.getTime() + 300);
    await startAiRunStep(database, run.id, { stepIndex: 0 }, clock);
    expect((await getAiRun(database, run.id))?.duration).toBe(900);
    now = new Date(now.getTime() + 200);
    await expect(
      startAiRunStep(database, run.id, { stepIndex: 1 }, clock),
    ).rejects.toMatchObject({ stopReason: 'max_duration' });
    const stopped = await getAiRun(database, run.id);
    expect(stopped?.stopDetail).toMatchObject({
      limit: 'maxDurationMs',
      limitValue: 1000,
      used: 1100,
    });
    expect(stopped?.stopDetail?.requested).toBeUndefined();
  });

  it('saves checkpoints compare-and-swap', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      definitionVersion: '1',
      checkpoint: { state: { step: 0 } },
    });
    expect((await readAiRunCheckpoint(database, run.id))?.state).toEqual({
      step: 0,
    });
    const revision = await saveAiRunCheckpoint(database, run.id, {
      expectedRevision: 0,
      state: { step: 1 },
    });
    expect(revision).toBe(1);
    await expect(
      saveAiRunCheckpoint(database, run.id, {
        expectedRevision: 0,
        state: { step: 9 },
      }),
    ).rejects.toBeInstanceOf(AiRunCheckpointConflictError);
    expect((await readAiRunCheckpoint(database, run.id))?.state).toEqual({
      step: 1,
    });
  });

  it('asserts the claim fence for the nearest durable run, and stops a stale worker', async () => {
    const database = await db();
    const root = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
    });
    const child = await openAiRun(store(database), {
      type: 'fusion',
      parentRunId: root.id,
    });
    const fenced: string[] = [];
    const live = async (_tx: DatabaseInterface, id: string) => {
      fenced.push(id);
    };
    await reserveAiCall(database, child.id, { inputChars: 4 }, { fence: live });
    expect(fenced).toEqual([root.id]);
    const lost = async () => {
      throw new Error('Job claim is no longer current');
    };
    await expect(
      reserveAiCall(database, child.id, { inputChars: 4 }, { fence: lost }),
    ).rejects.toMatchObject({ code: 'AI_RUN_CLAIM_LOST' });
    await expect(
      startAiRunStep(database, root.id, { stepIndex: 0, fence: lost }),
    ).rejects.toMatchObject({ code: 'AI_RUN_CLAIM_LOST' });
    expect((await getAiRun(database, child.id))?.reservedCalls).toBe(1);
  });

  it('resumes a budget stop only with that limit changed, never lowered or above the ceiling', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      budget: { maxSteps: 1 },
    });
    await startAiRunStep(database, run.id, { stepIndex: 0 });
    await expect(
      startAiRunStep(database, run.id, { stepIndex: 1 }),
    ).rejects.toBeInstanceOf(AiRunStoppedError);
    await expect(resumeAiRun(database, run.id)).rejects.toMatchObject({
      reason: 'budget_unchanged',
    });
    await expect(
      resumeAiRun(database, run.id, { budget: { maxCalls: 10 } }),
    ).rejects.toMatchObject({ reason: 'budget_unchanged' });
    await expect(
      resumeAiRun(database, run.id, { budget: { maxSteps: 0 } }),
    ).rejects.toMatchObject({ reason: 'budget_lowered' });
    await expect(
      resumeAiRun(database, run.id, {
        budget: { maxSteps: 9 },
        ceiling: { maxSteps: 5 },
      }),
    ).rejects.toMatchObject({ reason: 'above_ceiling' });
    const resumed = await resumeAiRun(database, run.id, {
      budget: { maxSteps: 3 },
      ceiling: { maxSteps: 5 },
    });
    expect(resumed).toMatchObject({
      status: 'running',
      stopReason: null,
      stopDetail: null,
      budget: { maxSteps: 3 },
    });
    expect(
      (await startAiRunStep(database, run.id, { stepIndex: 1 })).counted,
    ).toBe(true);
  });

  it('records definition_changed when the version does not accept the checkpoint', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      definitionVersion: '1',
    });
    await stopAiRun(database, run.id);
    await expect(
      resumeAiRun(database, run.id, { definitionVersion: '2' }),
    ).rejects.toMatchObject({ reason: 'definition_changed' });
    expect(await getAiRun(database, run.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'definition_changed',
    });
    const resumed = await resumeAiRun(database, run.id, {
      definitionVersion: '2',
      acceptsVersion: (saved) => saved === '1',
    });
    expect(resumed.status).toBe('running');
  });

  it('retries a failed workflow as a new run from its accepted steps', async () => {
    const database = await db();
    const failed = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      definitionKey: 'brief',
      definitionVersion: '1',
      budget: { maxSteps: 3 },
      checkpoint: { state: { accepted: [] } },
    });
    await startAiRunStep(database, failed.id, {
      stepIndex: 0,
      checkpoint: { expectedRevision: 0, state: { accepted: ['outline'] } },
    });
    await startAiRunStep(database, failed.id, { stepIndex: 1 });
    await finishAiRun(database, failed.id, {
      status: 'failed',
      stopReason: 'repairs_exhausted',
    });

    // A running run, another definition and another version are refused.
    const running = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      definitionKey: 'brief',
    });
    await expect(
      openAiRun(store(database), {
        type: 'workflow',
        definitionKey: 'brief',
        retryOfRunId: running.id,
      }),
    ).rejects.toMatchObject({ reason: 'not_retryable' });
    await expect(
      openAiRun(store(database), {
        type: 'workflow',
        definitionKey: 'other',
        definitionVersion: '1',
        retryOfRunId: failed.id,
      }),
    ).rejects.toMatchObject({ reason: 'not_retryable' });
    const before = rowsOf(
      await database.query('SELECT COUNT(*) AS n FROM _smrt_ai_runs'),
    )[0]?.n;
    await expect(
      openAiRun(store(database), {
        type: 'workflow',
        definitionKey: 'brief',
        definitionVersion: '2',
        retryOfRunId: failed.id,
      }),
    ).rejects.toMatchObject({ reason: 'definition_changed' });
    expect(
      rowsOf(await database.query('SELECT COUNT(*) AS n FROM _smrt_ai_runs'))[0]
        ?.n,
    ).toEqual(before);

    const retry = await openAiRun(store(database), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      retryOfRunId: failed.id,
      budget: { maxSteps: 1 },
      retry: {
        carry: (saved) => ({
          state: saved.state,
          highestStepIndex: 0,
        }),
      },
    });
    expect(retry).toMatchObject({
      retryOfRunId: failed.id,
      durable: true,
      stepsUsed: 0,
      tokens: 0,
    });
    expect((await readAiRunCheckpoint(database, retry.id))?.state).toEqual({
      accepted: ['outline'],
    });
    // The inherited step is not counted; the step it starts at is.
    expect(
      (await startAiRunStep(database, retry.id, { stepIndex: 1 })).counted,
    ).toBe(true);
    // The failed run keeps its checkpoint; it may be retried again.
    expect(await readAiRunCheckpoint(database, failed.id)).not.toBeNull();
    const second = await openAiRun(store(database), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      retryOfRunId: failed.id,
    });
    expect(second.retryOfRunId).toBe(failed.id);
  });

  it('updates descriptive fields without touching status or totals', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'fusion',
      mode: 'pair',
    });
    await updateAiRun(database, run.id, {
      seats: 3,
      degradedSeats: 1,
      details: { a: 1 },
      retain: true,
    });
    const row = rowsOf(
      await database.query(
        'SELECT seats, degraded_seats, details, retain, status FROM _smrt_ai_runs WHERE id = $1',
        run.id,
      ),
    )[0];
    expect(Number(row?.seats)).toBe(3);
    expect(Number(row?.degraded_seats)).toBe(1);
    expect(JSON.parse(String(row?.details))).toEqual({ a: 1 });
    expect(Number(row?.retain)).toBe(1);
    expect(row?.status).toBe('running');
  });

  it('allocates event seq atomically under concurrent appenders', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendAiRunEvent(database, run.id, {
          type: i % 2 ? 'action' : 'observation',
          name: `e${i}`,
        }),
      ),
    );
    expect(appended.map((event) => event.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    await expect(
      appendAiRunEvent(database, 'missing', { type: 'action' }),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
  });

  it('caps, redacts and references payloads', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    setTranscriptRedactor((messages) =>
      messages.map((message) => ({
        ...message,
        content: JSON.parse(
          JSON.stringify(message.content).replaceAll('Alice', '[NAME]'),
        ),
      })),
    );
    await appendAiRunEvent(
      database,
      run.id,
      {
        type: 'action',
        payload: { who: 'Alice', key: 'sk-abcdefghijklmnopqrstuvwxyz123456' },
      },
      { redact: (payload) => ({ ...(payload as object), host: true }) },
    );
    await appendAiRunEvent(
      database,
      run.id,
      { type: 'observation', payload: { text: 'x'.repeat(5000) } },
      { maxPayloadBytes: 1000 },
    );
    await appendAiRunEvent(database, run.id, {
      type: 'observation',
      payloadRef: 'chat-message:42',
    });
    const trajectory = await getRunTrajectory(database, run.id);
    const [redacted, capped, referenced] = trajectory?.entries ?? [];
    expect(JSON.stringify(redacted?.event?.payload)).not.toContain('Alice');
    expect(JSON.stringify(redacted?.event?.payload)).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz123456',
    );
    expect(redacted?.event?.payload).toMatchObject({ host: true });
    expect(capped?.event?.truncated).toBe(true);
    expect(JSON.stringify(capped?.event?.payload).length).toBeLessThan(1100);
    expect(capped?.event?.payload).toMatchObject({ truncated: true });
    expect(referenced?.event).toMatchObject({
      payloadRef: 'chat-message:42',
      payload: null,
    });
  });

  it('reads a trajectory: events in seq order, calls joined to usage and evaluations', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const reservation = await reserveAiCall(database, run.id, {
      inputChars: 40,
    });
    await settleAiCall(database, {
      runId: run.id,
      callId: reservation.callId,
      usage: usageEvent(30, 0.01, { promptKey: 'p', tierRequested: 'good' }),
    });
    const action = await appendAiRunEvent(database, run.id, {
      type: 'action',
      name: 'search',
    });
    await appendAiRunEvent(database, run.id, {
      type: 'check',
      parentEventId: reservation.eventId,
      status: 'passed',
    });
    await recordAiEvaluation(database, {
      callId: reservation.callId,
      metric: 'faithfulness',
      value: 0.9,
      evaluator: 'grader:faithfulness@2',
    });
    await recordAiEvaluation(database, {
      runId: run.id,
      metric: 'outcome',
      value: true,
      evaluator: 'human',
    });
    const trajectory = await getRunTrajectory(database, run.id);
    expect(trajectory?.entries.map((entry) => entry.event?.type)).toEqual([
      'call',
      'action',
      'check',
    ]);
    expect(trajectory?.entries[1]?.event?.id).toBe(action.id);
    expect(trajectory?.entries[0]?.usage).toMatchObject({
      callId: reservation.callId,
      totalTokens: 30,
      model: 'gpt-4o',
      promptKey: 'p',
      tierRequested: 'good',
    });
    expect(trajectory?.entries[0]?.evaluations[0]).toMatchObject({
      metric: 'faithfulness',
      evaluator: 'grader:faithfulness@2',
    });
    expect(trajectory?.evaluations[0]).toMatchObject({ metric: 'outcome' });

    // The same reader for the call: its run's trajectory.
    expect(
      (await getRunTrajectory(database, { callId: reservation.callId }))?.run
        ?.id,
    ).toBe(run.id);
    // A call on its own: one entry, no run.
    await database.query(
      `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration, call_id, entry_call_id, created_at)
       VALUES ('solo', 'openai', 'gpt-4o', 'message', 3, 'solo', 'solo', $1)`,
      new Date().toISOString(),
    );
    const solo = await getRunTrajectory(database, { callId: 'solo' });
    expect(solo?.run).toBeNull();
    expect(solo?.entries).toHaveLength(1);
    expect(solo?.entries[0]?.usage?.callId).toBe('solo');

    // Usage pruned: the call event comes back without it.
    await database.query(
      'DELETE FROM _smrt_ai_usage WHERE id = $1',
      reservation.callId,
    );
    expect(
      (await getRunTrajectory(database, run.id))?.entries[0]?.usage,
    ).toBeNull();

    // A pruned trajectory: the row and its counts, no events.
    await database.query(
      `UPDATE _smrt_ai_runs SET trajectory_pruned = 1, checks_passed = 4,
              approvals_refused = 1 WHERE id = $1`,
      run.id,
    );
    const pruned = await getRunTrajectory(database, run.id);
    expect(pruned?.entries).toEqual([]);
    expect(pruned?.pruned).toEqual({
      checksPassed: 4,
      checksFailed: 0,
      approvalsGiven: 0,
      approvalsRefused: 1,
    });
  });

  it('passes the run context explicitly and rebuilds it in a job on its own tenant', async () => {
    const database = await db();
    const run = await openAiRun(
      { db: database, usageTracking: true, tenantId: 't1' },
      { type: 'workflow', durable: true },
    );
    const payload = JSON.parse(
      JSON.stringify(
        serializeAiRunContext({
          runId: run.id,
          db: database,
          tenantId: 't1',
          stepIndex: 2,
          attempt: 1,
        }),
      ),
    );
    expect(payload).toEqual({
      v: 1,
      runId: run.id,
      tenantId: 't1',
      stepIndex: 2,
      attempt: 1,
    });
    const restored = await restoreAiRunContext(payload, {
      db: database,
      tenantId: 't1',
    });
    expect(restored).toMatchObject({ runId: run.id, stepIndex: 2, attempt: 1 });
    expect(restored.db).toBe(database);
    await expect(
      restoreAiRunContext(payload, { db: database, tenantId: 't2' }),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
    await expect(
      restoreAiRunContext({ runId: run.id }, { db: database }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
