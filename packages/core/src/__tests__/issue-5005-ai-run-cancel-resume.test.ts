/**
 * Cancel reaches every descendant at once, the `ai-runs` sweep repairs the
 * ones left under a final or missing ancestor, and a resume or retry is
 * refused with the page's typed reasons (#5005; docs/content/ai-runs.md
 * sections 2, 6.7 and 7). Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelAiRun,
  finishAiRun,
  getAiRun,
  openAiRun,
  resumeAiRun,
  startAiRunStep,
  stopAiRun,
  sweepAiRuns,
  waitAiRunApproval,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

describe.each(
  aiRunTestEngines,
)('AI run cancel and resume on %s (#5005)', (engine) => {
  const store = (db: DatabaseInterface) => ({ db, usageTracking: true });

  it('cancels the run and every descendant that is not final, in one call', async () => {
    const db = await newAiRunTestDatabase(engine);
    const root = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const durable = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: root.id,
    });
    const waiting = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: durable.id,
    });
    await waitAiRunApproval(db, waiting.id);
    await stopAiRun(db, durable.id);
    const fusion = await openAiRun(store(db), {
      type: 'fusion',
      parentRunId: root.id,
    });
    const stoppedFusion = await openAiRun(store(db), {
      type: 'fusion',
      parentRunId: root.id,
    });
    await stopAiRun(db, stoppedFusion.id);
    const done = await openAiRun(store(db), {
      type: 'turn',
      parentRunId: root.id,
    });
    await finishAiRun(db, done.id, { status: 'done' });

    const cancelled = await cancelAiRun(db, root.id);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      stopReason: 'cancelled',
      stoppedByRunId: root.id,
    });
    for (const id of [durable.id, waiting.id, fusion.id]) {
      const row = await getAiRun(db, id);
      expect(row).toMatchObject({
        status: 'cancelled',
        stopReason: 'cancelled',
        stoppedByRunId: root.id,
        stopDetail: null,
      });
      expect(row?.finishedAt).toBeInstanceOf(Date);
    }
    // Already final: left as they were.
    expect(await getAiRun(db, stoppedFusion.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'interrupted',
      stoppedByRunId: stoppedFusion.id,
    });
    expect((await getAiRun(db, done.id))?.status).toBe('done');
    // A cancelled run, and its cancelled descendants, never resume.
    await expect(resumeAiRun(db, durable.id)).rejects.toMatchObject({
      reason: 'not_resumable',
    });
  });

  it('refuses a resume under a final or missing ancestor, writing nothing', async () => {
    const db = await newAiRunTestDatabase(engine);
    const root = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const child = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: root.id,
    });
    const waiting = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: root.id,
    });
    await waitAiRunApproval(db, waiting.id);
    await stopAiRun(db, child.id);
    await finishAiRun(db, root.id, { status: 'done' });

    await expect(resumeAiRun(db, child.id)).rejects.toMatchObject({
      reason: 'ancestor_final',
    });
    await expect(resumeAiRun(db, waiting.id)).rejects.toMatchObject({
      reason: 'ancestor_final',
    });
    expect((await getAiRun(db, child.id))?.status).toBe('stopped');
    expect((await getAiRun(db, waiting.id))?.status).toBe('waiting-approval');

    const orphanRoot = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const orphan = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: orphanRoot.id,
    });
    await stopAiRun(db, orphan.id);
    await db.query(
      'DELETE FROM _smrt_ai_run_checkpoints WHERE run_id = $1',
      orphanRoot.id,
    );
    await db.query('DELETE FROM _smrt_ai_runs WHERE id = $1', orphanRoot.id);
    await expect(resumeAiRun(db, orphan.id)).rejects.toMatchObject({
      reason: 'ancestor_missing',
    });
    expect((await getAiRun(db, orphan.id))?.status).toBe('stopped');

    // A stopped durable ancestor still stands: the resume goes ahead.
    const pausedRoot = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const underPaused = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: pausedRoot.id,
    });
    await stopAiRun(db, underPaused.id);
    await stopAiRun(db, pausedRoot.id);
    expect((await resumeAiRun(db, underPaused.id)).status).toBe('running');
  });

  it('sweeps descendants left under a cancelled, final or missing ancestor to cancelled', async () => {
    const db = await newAiRunTestDatabase(engine);
    // Left behind under a cancelled root (written around the cancel).
    const root = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const running = await openAiRun(store(db), {
      type: 'fusion',
      parentRunId: root.id,
    });
    const middle = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: root.id,
    });
    const deep = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: middle.id,
    });
    await waitAiRunApproval(db, deep.id);
    await waitAiRunApproval(db, middle.id);
    await db.query(
      `UPDATE _smrt_ai_runs SET status = 'cancelled', stop_reason = 'cancelled'
        WHERE id = $1`,
      root.id,
    );

    // A durable stopped run under a done parent.
    const doneParent = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const stoppedChild = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: doneParent.id,
    });
    await stopAiRun(db, stoppedChild.id);
    await finishAiRun(db, doneParent.id, { status: 'done' });
    // A running run under a done parent is left: it notices at its next
    // reservation.
    const doneParent2 = await openAiRun(store(db), { type: 'workflow' });
    const runningUnderDone = await openAiRun(store(db), {
      type: 'fusion',
      parentRunId: doneParent2.id,
    });
    await finishAiRun(db, doneParent2.id, { status: 'done' });

    // A waiting run whose parent's row is gone.
    const goneParent = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const orphan = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      parentRunId: goneParent.id,
    });
    await waitAiRunApproval(db, orphan.id);
    await db.query(
      'DELETE FROM _smrt_ai_run_checkpoints WHERE run_id = $1',
      goneParent.id,
    );
    await db.query('DELETE FROM _smrt_ai_runs WHERE id = $1', goneParent.id);

    const result = await sweepAiRuns(db);
    expect(new Set(result.cancelledRuns)).toEqual(
      new Set([running.id, middle.id, deep.id, stoppedChild.id, orphan.id]),
    );
    expect(await getAiRun(db, running.id)).toMatchObject({
      status: 'cancelled',
      stoppedByRunId: root.id,
    });
    expect(await getAiRun(db, middle.id)).toMatchObject({
      status: 'cancelled',
      stoppedByRunId: root.id,
    });
    // The nearest cancelled ancestor of the deep run is the repaired middle.
    expect((await getAiRun(db, deep.id))?.stoppedByRunId).toBe(middle.id);
    expect(await getAiRun(db, stoppedChild.id)).toMatchObject({
      status: 'cancelled',
      stopReason: 'cancelled',
      stoppedByRunId: doneParent.id,
      stopDetail: null,
    });
    expect(await getAiRun(db, orphan.id)).toMatchObject({
      status: 'cancelled',
      stoppedByRunId: orphan.id,
    });
    expect((await getAiRun(db, orphan.id))?.finishedAt).toBeInstanceOf(Date);
    expect((await getAiRun(db, runningUnderDone.id))?.status).toBe('running');
    // A second sweep finds nothing left to repair.
    expect((await sweepAiRuns(db)).cancelledRuns).toEqual([]);
  });

  it('refuses a retry whose failed run or checkpoint was pruned with retry_source_pruned', async () => {
    const db = await newAiRunTestDatabase(engine);
    const failed = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
      definitionKey: 'brief',
    });
    await startAiRunStep(db, failed.id, { stepIndex: 0 });
    await finishAiRun(db, failed.id, { status: 'failed' });
    await db.query(
      'DELETE FROM _smrt_ai_run_checkpoints WHERE run_id = $1',
      failed.id,
    );
    await expect(
      openAiRun(store(db), {
        type: 'workflow',
        definitionKey: 'brief',
        retryOfRunId: failed.id,
      }),
    ).rejects.toMatchObject({ reason: 'retry_source_pruned' });
    await db.query('DELETE FROM _smrt_ai_runs WHERE id = $1', failed.id);
    await expect(
      openAiRun(store(db), {
        type: 'workflow',
        definitionKey: 'brief',
        retryOfRunId: failed.id,
      }),
    ).rejects.toMatchObject({ reason: 'retry_source_pruned' });
  });
});
