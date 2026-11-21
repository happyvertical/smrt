/**
 * AI run retention (#5005; docs/content/ai-runs.md sections 2 and 8): the
 * trajectory period and sampling, counts saved before events go, protected
 * runs, a child never before its parent, a failed run's checkpoint, run rows
 * with their usage rows by the usage age limit, approval counting, and
 * evaluations that outlive their target. Real SQLite and DuckDB (PGlite in
 * its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aiRunApprovalRate,
  appendAiRunEvent,
  cancelAiRun,
  countAiRunEvents,
  finishAiRun,
  getAiRun,
  getRunTrajectory,
  isAiRunTrajectorySampled,
  listAiEvaluations,
  openAiRun,
  pruneAiRuns,
  pruneAiRunTrajectories,
  readAiRunCheckpoint,
  recordAiEvaluation,
  reserveAiCall,
  runRetentionSweep,
  settleAiCall,
  startAiRunStep,
  stopAiRun,
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

const DAY = 86_400_000;
const NOW = new Date('2026-11-14T12:00:00Z');

afterEach(async () => {
  await closeAiRunTestDatabases();
});

describe.each(aiRunTestEngines)('AI run retention on %s (#5005)', (engine) => {
  const store = (db: DatabaseInterface) => ({ db, usageTracking: true });

  async function finishedAt(
    db: DatabaseInterface,
    id: string,
    daysAgo: number,
  ) {
    await db.query(
      'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
      new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
      id,
    );
  }

  async function eventCount(db: DatabaseInterface, id: string) {
    return Number(
      rowsOf(
        await db.query(
          'SELECT COUNT(*) AS n FROM _smrt_ai_run_events WHERE run_id = $1',
          id,
        ),
      )[0]?.n,
    );
  }

  it('validates check, approval and handoff statuses', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'turn' });
    await expect(
      appendAiRunEvent(db, run.id, { type: 'approval', status: 'ok' }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      appendAiRunEvent(db, run.id, { type: 'check', status: 'pass' }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      appendAiRunEvent(db, run.id, { type: 'handoff', status: 'ok' }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('counts a decision once in the run that recorded it, and a request only as requested', async () => {
    const db = await newAiRunTestDatabase(engine);
    // Turn 1 asks and ends done with the approval pending.
    const turn1 = await openAiRun(store(db), { type: 'turn' });
    const call = await reserveAiCall(db, turn1.id, { inputTokens: 5 });
    await settleAiCall(db, {
      runId: turn1.id,
      callId: call.callId,
      usage: usageEvent(9),
    });
    const request = await appendAiRunEvent(db, turn1.id, {
      type: 'approval',
      status: 'requested',
      parentEventId: call.eventId,
    });
    await finishAiRun(db, turn1.id, { status: 'done' });
    // Turn 2 records the decision, pointing back across runs.
    const turn2 = await openAiRun(store(db), { type: 'turn' });
    await appendAiRunEvent(db, turn2.id, {
      type: 'approval',
      status: 'approved',
      parentEventId: request.id,
    });
    // A decision whose request no longer resolves still counts in its run.
    await appendAiRunEvent(db, turn2.id, {
      type: 'approval',
      status: 'refused',
      parentEventId: 'gone-request',
    });
    await appendAiRunEvent(db, turn2.id, { type: 'check', status: 'passed' });
    await appendAiRunEvent(db, turn2.id, { type: 'check', status: 'failed' });
    await finishAiRun(db, turn2.id, { status: 'done' });

    const asked = await countAiRunEvents(db, turn1.id);
    expect(asked).toMatchObject({
      approvalsRequested: 1,
      approvalsGiven: 0,
      approvalsRefused: 0,
    });
    expect(aiRunApprovalRate(asked)).toBeNull();
    const decided = await countAiRunEvents(db, turn2.id);
    expect(decided).toMatchObject({
      approvalsRequested: 0,
      approvalsGiven: 1,
      approvalsRefused: 1,
      checksPassed: 1,
      checksFailed: 1,
    });
    expect(aiRunApprovalRate(decided)).toBe(0.5);

    // The counts are saved on the row before the events are deleted.
    await finishedAt(db, turn1.id, 31);
    await finishedAt(db, turn2.id, 31);
    expect(
      await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW }),
    ).toEqual({ pruned: 2 });
    expect(await getAiRun(db, turn2.id)).toMatchObject({
      trajectoryPruned: true,
      checksPassed: 1,
      checksFailed: 1,
      approvalsGiven: 1,
      approvalsRefused: 1,
    });
    expect(await getAiRun(db, turn1.id)).toMatchObject({
      approvalsGiven: 0,
      approvalsRefused: 0,
    });
    expect(await eventCount(db, turn2.id)).toBe(0);
    const trajectory = await getRunTrajectory(db, turn2.id, {
      allowCrossTenant: true,
    });
    expect(trajectory?.entries).toEqual([]);
    expect(trajectory?.pruned).toEqual({
      checksPassed: 1,
      checksFailed: 1,
      approvalsGiven: 1,
      approvalsRefused: 1,
    });
    expect(await countAiRunEvents(db, turn2.id)).toMatchObject({
      approvalsGiven: 1,
      approvalsRefused: 1,
    });
  });

  it('keeps protected runs, prunes finished ones after the period, and never before', async () => {
    const db = await newAiRunTestDatabase(engine);
    const running = await openAiRun(store(db), { type: 'turn' });
    const waiting = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    await waitAiRunApproval(db, waiting.id);
    const resumable = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    await stopAiRun(db, resumable.id);
    const experiment = await openAiRun(store(db), {
      type: 'turn',
      experimentId: 'exp-1',
    });
    const retained = await openAiRun(store(db), { type: 'turn' });
    await updateAiRun(db, retained.id, { retain: true });
    for (const run of [experiment, retained]) {
      await finishAiRun(db, run.id, { status: 'done' });
    }
    const stoppedFusion = await openAiRun(store(db), { type: 'fusion' });
    await stopAiRun(db, stoppedFusion.id);
    const cancelled = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    await cancelAiRun(db, cancelled.id);
    const failed = await openAiRun(store(db), { type: 'turn' });
    await finishAiRun(db, failed.id, { status: 'failed' });
    const done = await openAiRun(store(db), { type: 'turn' });
    await finishAiRun(db, done.id, { status: 'done' });
    const recent = await openAiRun(store(db), { type: 'turn' });
    await finishAiRun(db, recent.id, { status: 'done' });
    const all = [
      running,
      waiting,
      resumable,
      experiment,
      retained,
      stoppedFusion,
      cancelled,
      failed,
      done,
      recent,
    ];
    for (const run of all) {
      await appendAiRunEvent(db, run.id, { type: 'action', name: 'x' });
      await finishedAt(db, run.id, run === recent ? 29 : 31);
    }
    // Protection does not depend on a finished_at someone wrote.
    const dry = await pruneAiRunTrajectories(db, {
      maxAgeMs: 30 * DAY,
      now: NOW,
      dryRun: true,
    });
    expect(dry).toEqual({ pruned: 4 });
    expect(await eventCount(db, done.id)).toBe(1);
    expect(
      await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW }),
    ).toEqual({ pruned: 4 });
    for (const run of [stoppedFusion, cancelled, failed, done]) {
      expect((await getAiRun(db, run.id))?.trajectoryPruned).toBe(true);
      expect(await eventCount(db, run.id)).toBe(0);
    }
    for (const run of [
      running,
      waiting,
      resumable,
      experiment,
      retained,
      recent,
    ]) {
      expect((await getAiRun(db, run.id))?.trajectoryPruned).toBe(false);
      expect(await eventCount(db, run.id)).toBe(1);
    }
  });

  it('never prunes a child before its parent, and a protected parent protects its children', async () => {
    const db = await newAiRunTestDatabase(engine);
    const workflow = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const fusion = await openAiRun(store(db), {
      type: 'fusion',
      parentRunId: workflow.id,
    });
    await stopAiRun(db, fusion.id);
    await stopAiRun(db, workflow.id);
    await finishedAt(db, fusion.id, 200);
    await appendAiRunEvent(db, fusion.id, { type: 'action', name: 'seat' });
    // The workflow is a durable stopped run: it and its finished child stay.
    expect(
      await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW }),
    ).toEqual({ pruned: 0 });
    expect(await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW })).toEqual({
      pruned: 0,
    });
    // Cancelled now: still inside the period, so the child waits too.
    await cancelAiRun(db, workflow.id);
    expect(
      await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW }),
    ).toEqual({ pruned: 0 });
    // Past the period, both go in one sweep, the parent first.
    await finishedAt(db, workflow.id, 31);
    expect(
      await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW }),
    ).toEqual({ pruned: 2 });
    // Rows: the child's waits for its parent's, then goes in the same sweep.
    await finishedAt(db, workflow.id, 91);
    expect(await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW })).toEqual({
      pruned: 2,
    });
    expect(await getAiRun(db, fusion.id)).toBeNull();
  });

  it('keeps a failed run checkpoint while its row is kept, so it can still be retried', async () => {
    const db = await newAiRunTestDatabase(engine);
    const failed = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      definitionKey: 'brief',
    });
    await startAiRunStep(db, failed.id, { stepIndex: 0 });
    await finishAiRun(db, failed.id, { status: 'failed' });
    const done = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    await finishAiRun(db, done.id, { status: 'done' });
    await finishedAt(db, failed.id, 31);
    await finishedAt(db, done.id, 31);
    await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW });
    expect(await readAiRunCheckpoint(db, failed.id)).not.toBeNull();
    expect(await readAiRunCheckpoint(db, done.id)).toBeNull();
    const retry = await openAiRun(store(db), {
      type: 'workflow',
      definitionKey: 'brief',
      retryOfRunId: failed.id,
    });
    expect(retry.retryOfRunId).toBe(failed.id);
    await finishAiRun(db, retry.id, { status: 'done' });

    await finishedAt(db, failed.id, 91);
    await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW });
    expect(await getAiRun(db, failed.id)).toBeNull();
    expect(await readAiRunCheckpoint(db, failed.id)).toBeNull();
    await expect(
      openAiRun(store(db), {
        type: 'workflow',
        definitionKey: 'brief',
        retryOfRunId: failed.id,
      }),
    ).rejects.toMatchObject({ reason: 'retry_source_pruned' });
  });

  it('prunes a run row with its usage rows by the usage age, never while its trajectory is kept', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'turn' });
    const call = await reserveAiCall(db, run.id, { inputTokens: 5 });
    await settleAiCall(db, {
      runId: run.id,
      callId: call.callId,
      usage: usageEvent(10),
    });
    await finishAiRun(db, run.id, { status: 'done' });
    await finishedAt(db, run.id, 120);
    // A trajectory period longer than the usage limit holds the row.
    await pruneAiRunTrajectories(db, { maxAgeMs: 150 * DAY, now: NOW });
    expect(await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW })).toEqual({
      pruned: 0,
    });
    // Not before the usage age limit, counted from finished_at.
    await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW });
    expect(await pruneAiRuns(db, { maxAgeMs: 200 * DAY, now: NOW })).toEqual({
      pruned: 0,
    });
    const evaluation = await recordAiEvaluation(db, {
      runId: run.id,
      label: 'good',
      evaluator: 'human',
    });
    await recordAiEvaluation(db, {
      callId: call.callId,
      label: 'fine',
      evaluator: 'app',
    });
    expect(
      (
        await listAiEvaluations(db, { allowCrossTenant: true, runId: run.id })
      )[0]?.target,
    ).toMatchObject({ kind: 'run', id: run.id, status: 'done' });
    expect(await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW })).toEqual({
      pruned: 1,
    });
    expect(
      rowsOf(
        await db.query(
          'SELECT id FROM _smrt_ai_usage WHERE run_id = $1',
          run.id,
        ),
      ),
    ).toEqual([]);
    // Evaluations are never swept; their target reads back empty.
    const evaluations = await listAiEvaluations(db, { allowCrossTenant: true });
    expect(evaluations).toHaveLength(2);
    for (const read of evaluations) expect(read.target).toBeNull();
    expect(evaluations.find((read) => read.id === evaluation.id)?.runId).toBe(
      run.id,
    );
  });

  it('keeps a run with a call still reserved, and samples once per run', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'turn' });
    await reserveAiCall(db, run.id, { inputTokens: 5 });
    await cancelAiRun(db, run.id);
    await finishedAt(db, run.id, 31);
    expect(
      await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW }),
    ).toEqual({ pruned: 0 });

    // Sampling at 0: a finished run loses its trajectory at once.
    const quick = await openAiRun(store(db), { type: 'turn' });
    await appendAiRunEvent(db, quick.id, { type: 'action', name: 'x' });
    await finishAiRun(db, quick.id, { status: 'done' });
    await finishedAt(db, quick.id, 0.001);
    expect(
      await pruneAiRunTrajectories(db, {
        maxAgeMs: 30 * DAY,
        sampleRate: 0,
        now: NOW,
      }),
    ).toEqual({ pruned: 1 });
    expect(isAiRunTrajectorySampled('run-a', 1)).toBe(true);
    expect(isAiRunTrajectorySampled('run-a', 0)).toBe(false);
    const ids = Array.from({ length: 400 }, (_, i) => `run-${i}`);
    const kept = ids.filter((id) => isAiRunTrajectorySampled(id, 0.25));
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.length).toBeLessThan(150);
    expect(ids.filter((id) => isAiRunTrajectorySampled(id, 0.25))).toEqual(
      kept,
    );
  });

  it('prunes trajectories and rows from the retention sweep defaults', async () => {
    const db = await newAiRunTestDatabase(engine);
    const old = await openAiRun(store(db), { type: 'turn' });
    await appendAiRunEvent(db, old.id, { type: 'check', status: 'passed' });
    await finishAiRun(db, old.id, { status: 'done' });
    await db.query(
      'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
      new Date(Date.now() - 40 * DAY).toISOString(),
      old.id,
    );
    const sweep = await runRetentionSweep(db, {
      changes: false,
      contexts: false,
      dispatch: false,
      runOnceClaims: false,
    });
    expect(sweep.tasks.find((task) => task.task === 'ai-runs')).toMatchObject({
      pruned: 1,
      details: { trajectories: 1, runs: 0 },
    });
    expect((await getAiRun(db, old.id))?.checksPassed).toBe(1);
    await db.query(
      'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
      new Date(Date.now() - 100 * DAY).toISOString(),
      old.id,
    );
    const second = await runRetentionSweep(db, {
      changes: false,
      contexts: false,
      dispatch: false,
      runOnceClaims: false,
    });
    expect(second.tasks.find((task) => task.task === 'ai-runs')).toMatchObject({
      details: { runs: 1 },
    });
    expect(await getAiRun(db, old.id)).toBeNull();
  });
});
