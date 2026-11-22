/**
 * Scenarios run on PostgreSQL engines (PGlite in-process, and a real server
 * in the optional lane): the core path of a workflow run on that dialect.
 */
import { getAiRun, getRunTrajectory } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import {
  createRunCheckpointStore,
  RunConflictError,
  type WorkflowStep,
} from '../index.js';
import {
  definitionOf,
  driverFor,
  rowsOf,
  scriptedModel,
  twoSteps,
} from './harness.js';

export function workflowScenarios(database: () => Promise<DatabaseInterface>) {
  it('runs, checks, stops at its budget and resumes with a raised one', async () => {
    const db = await database();
    const { model } = scriptedModel((_call, n) => ({
      output: { value: n + 1 },
      tokens: 30,
    }));
    const steps = twoSteps.map((step, index) => ({
      ...step,
      expectedOutputTokens: 100,
      ...(index === 0 ? { check: () => ({ note: 'ok' }) } : {}),
    })) as WorkflowStep[];
    const driver = driverFor(db, model, definitionOf(steps));
    const run = await driver.start({
      ownerId: 'owner',
      budget: { maxTokens: 130 },
    });
    expect(await driver.run(run.id, 'owner')).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
      totals: { calls: 1, stepsUsed: 2 },
    });
    await driver.resume(run.id, 'owner', { budget: { maxTokens: 1000 } });
    expect(await driver.run(run.id, 'owner')).toMatchObject({
      status: 'done',
      outputs: [{ value: 1 }, { value: 2 }],
      totals: { calls: 2, tokens: 60, stepsUsed: 2 },
    });
    const usage = rowsOf(
      await db.query(
        'SELECT step_index, attempt, prompt_key FROM _smrt_ai_usage WHERE run_id = $1 ORDER BY step_index',
        run.id,
      ),
    );
    expect(
      usage.map((row) => [
        Number(row.step_index),
        Number(row.attempt),
        row.prompt_key,
      ]),
    ).toEqual([
      [0, 1, 'test.workflow.propose'],
      [1, 1, 'test.workflow.refine'],
    ]);
    const events = (
      (await getRunTrajectory(db, run.id, { allowCrossTenant: true }))
        ?.entries ?? []
    ).map((entry) => entry.event?.type);
    expect(events).toEqual(['call', 'check', 'call', 'check']);
  });

  it('waits for approval and finishes once approved', async () => {
    const db = await database();
    const { model } = scriptedModel(() => ({ output: { value: 1 } }));
    const step: WorkflowStep = {
      ...(twoSteps[0] as WorkflowStep),
      check: (_output, context) =>
        context.approval === 'approved' ? {} : { waitingApproval: true },
    };
    const driver = driverFor(db, model, definitionOf([step]));
    const run = await driver.start({ ownerId: 'owner' });
    expect((await driver.run(run.id, 'owner')).status).toBe('waiting-approval');
    await driver.decide(run.id, 'owner', { approved: true });
    expect((await driver.run(run.id, 'owner')).status).toBe('done');
    expect(await getAiRun(db, run.id)).toMatchObject({
      status: 'done',
      calls: 1,
    });
  });

  it('lets one of two concurrent checkpoint saves win', async () => {
    const db = await database();
    const { model } = scriptedModel(() => ({ output: { value: 1 } }));
    const run = await driverFor(db, model).start({ ownerId: 'owner' });
    const store = createRunCheckpointStore({ db, ownerId: 'owner' });
    const loaded = await store.load(run.id);
    if (!loaded) throw new Error('missing run');
    const results = await Promise.allSettled(
      [1, 2].map((repairs) =>
        store.save(run.id, {
          expectedRevision: loaded.checkpoint.revision,
          state: { ...loaded.state, repairs },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const lost = results.find((result) => result.status === 'rejected');
    expect(lost?.status === 'rejected' && lost.reason).toBeInstanceOf(
      RunConflictError,
    );
  });
}
