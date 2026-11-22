/**
 * Run readers over the #5005 model (docs/content/ai-runs.md sections 4, 5
 * and 8): listAiRuns / reportAiRuns for every run type and status, with
 * check and approval counts from events or saved on a pruned run; and
 * compareAiPromptRuns with repair rate per step instance, check pass rate
 * and approval rate attributed through the judged call or fusion run.
 * Legacy rows (status ok, no step columns) read as before. Real SQLite and
 * DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAiRunEvent,
  compareAiPromptRuns,
  finishAiRun,
  listAiRuns,
  openAiRun,
  pruneAiRunTrajectories,
  reportAiRuns,
  reserveAiCall,
  settleAiCall,
  stopAiRun,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
  usageEvent,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

describe.each(aiRunTestEngines)('AI run readers on %s (#5005)', (engine) => {
  const store = (db: DatabaseInterface) => ({ db, usageTracking: true });

  /** One call of `runId`, settled with the given tags; returns its event id. */
  async function call(
    db: DatabaseInterface,
    runId: string,
    tags: Record<string, string>,
    tokens = 10,
  ): Promise<string> {
    const held = await reserveAiCall(db, runId, { inputTokens: 1 });
    await settleAiCall(db, {
      runId,
      callId: held.callId,
      usage: usageEvent(tokens, 0.01, { promptKey: 'brief', ...tags }),
    });
    return held.eventId;
  }

  it('lists and reports runs of every type and status, counting checks and approvals', async () => {
    const db = await newAiRunTestDatabase(engine);
    const workflow = await openAiRun(store(db), {
      type: 'workflow',
      definitionKey: 'brief',
      durable: true,
    });
    const judged = await call(db, workflow.id, {});
    await appendAiRunEvent(db, workflow.id, {
      type: 'check',
      status: 'passed',
      parentEventId: judged,
    });
    const request = await appendAiRunEvent(db, workflow.id, {
      type: 'approval',
      status: 'requested',
      parentEventId: judged,
    });
    await appendAiRunEvent(db, workflow.id, {
      type: 'approval',
      status: 'approved',
      parentEventId: request.id,
    });
    await stopAiRun(db, workflow.id);
    const turn = await openAiRun(store(db), { type: 'turn' });
    await appendAiRunEvent(db, turn.id, { type: 'check', status: 'failed' });
    await appendAiRunEvent(db, turn.id, {
      type: 'approval',
      status: 'refused',
      parentEventId: 'gone',
    });
    await finishAiRun(db, turn.id, { status: 'done' });
    // A pruned run reports the counts saved on its row.
    await pruneAiRunTrajectories(db, {
      maxAgeMs: 0,
      now: new Date(Date.now() + 1000),
    });
    const custom = await openAiRun(store(db), {
      type: '@acme/agents:coding',
    });
    // A legacy fusion row, written before the run model.
    await db.query(
      `INSERT INTO _smrt_ai_runs (id, type, definition_key, mode, status,
         degraded, seats, degraded_seats, duration, created_at)
       VALUES ('legacy', 'fusion', 'review', 'pair', 'ok', 0, 3, 0, 40, $1)`,
      new Date('2026-01-01T00:00:00Z').toISOString(),
    );

    const listed = await listAiRuns(db, { allowCrossTenant: true });
    expect(listed.map((run) => [run.id, run.type, run.status])).toEqual(
      expect.arrayContaining([
        [workflow.id, 'workflow', 'stopped'],
        [turn.id, 'turn', 'done'],
        [custom.id, '@acme/agents:coding', 'running'],
        ['legacy', 'fusion', 'done'],
      ]),
    );
    expect(
      (await listAiRuns(db, { allowCrossTenant: true, status: 'stopped' })).map(
        (run) => run.id,
      ),
    ).toEqual([workflow.id]);
    expect(
      (await listAiRuns(db, { allowCrossTenant: true, type: 'workflow' }))[0],
    ).toMatchObject({
      definitionKey: 'brief',
      calls: 1,
      tokens: 10,
      inclusiveTokens: 10,
      trajectoryPruned: false,
    });
    expect(
      (
        await listAiRuns(db, {
          allowCrossTenant: true,
          status: 'ok',
          type: 'fusion',
        })
      ).map((run) => run.id),
    ).toEqual(['legacy']);

    const report = await reportAiRuns(db, { allowCrossTenant: true });
    expect(report.totals).toMatchObject({
      runs: 4,
      running: 1,
      stopped: 1,
      done: 2,
      calls: 1,
      tokens: 10,
      checksPassed: 1,
      checksFailed: 1,
      approvalsGiven: 1,
      approvalsRefused: 1,
      checkPassRate: 0.5,
      approvalRate: 0.5,
    });
    const turnBucket = report.buckets.find((bucket) => bucket.type === 'turn');
    expect(turnBucket).toMatchObject({
      definitionKey: null,
      checksFailed: 1,
      approvalsRefused: 1,
      approvalRate: 0,
    });
    expect(
      (await reportAiRuns(db, { allowCrossTenant: true, type: 'fusion' }))
        .totals,
    ).toMatchObject({
      runs: 1,
      ok: 1,
      done: 1,
      seats: 3,
    });
  });

  it('compares repair, check and approval rates per template version', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), {
      type: 'workflow',
      definitionKey: 'brief',
    });
    // h1: step s1 needed a repair; step s2 passed first time.
    await call(db, run.id, {
      templateHash: 'h1',
      stepInstanceId: 's1',
      attempt: '1',
    });
    const repaired = await call(db, run.id, {
      templateHash: 'h1',
      stepInstanceId: 's1',
      attempt: '2',
    });
    const first = await call(db, run.id, {
      templateHash: 'h1',
      stepInstanceId: 's2',
      attempt: '1',
    });
    await appendAiRunEvent(db, run.id, {
      type: 'check',
      status: 'passed',
      parentEventId: repaired,
    });
    await appendAiRunEvent(db, run.id, {
      type: 'check',
      status: 'failed',
      parentEventId: first,
    });
    const request = await appendAiRunEvent(db, run.id, {
      type: 'approval',
      status: 'requested',
      parentEventId: first,
    });
    // The decision recorded in the next run still attributes through it.
    const next = await openAiRun(store(db), { type: 'turn' });
    await appendAiRunEvent(db, next.id, {
      type: 'approval',
      status: 'approved',
      parentEventId: request.id,
    });
    // h2: a fusion that answered the prompt, judged through its handoff.
    const fusion = await openAiRun(store(db), {
      type: 'fusion',
      parentRunId: run.id,
      promptKey: 'brief',
      templateHash: 'h2',
      handoff: { callId: 'entry-1' },
    });
    await finishAiRun(db, fusion.id, { status: 'done' });
    const handoffId = String(
      rowsOf(
        await db.query(
          `SELECT id FROM _smrt_ai_run_events
            WHERE run_id = $1 AND type = 'handoff'`,
          run.id,
        ),
      )[0]?.id,
    );
    await appendAiRunEvent(db, run.id, {
      type: 'check',
      status: 'passed',
      parentEventId: handoffId,
    });
    // A legacy row: no step columns, template only as a tag.
    await db.query(
      `INSERT INTO _smrt_ai_usage (id, provider, model, operation,
         prompt_tokens, completion_tokens, total_tokens, duration, prompt_key,
         tags, created_at)
       VALUES ('legacy-1', 'openai', 'gpt-4o', 'message', 1, 1, 2, 3, 'brief',
               $1, $2)`,
      JSON.stringify({ promptKey: 'brief', templateHash: 'h1' }),
      new Date().toISOString(),
    );

    const comparison = await compareAiPromptRuns(db, {
      promptKey: 'brief',
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
      tenantId: null,
    });
    expect(comparison.a).toMatchObject({
      calls: 4,
      steps: 2,
      repairedSteps: 1,
      repairRate: 0.5,
      checksPassed: 1,
      checksFailed: 1,
      checkPassRate: 0.5,
      approvalsGiven: 1,
      approvalsRefused: 0,
      approvalRate: 1,
    });
    expect(comparison.a.latencyMs.p95).not.toBeNull();
    expect(comparison.b).toMatchObject({
      calls: 0,
      steps: 0,
      repairRate: null,
      checksPassed: 1,
      checkPassRate: 1,
      approvalRate: null,
    });
  });
});
