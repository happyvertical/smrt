/**
 * Claim fencing (#5005; docs/content/ai-runs.md section 7): a workflow run
 * worked from a background job asserts the job's claim in every checkpoint
 * save, step start and reservation. A worker whose claim was taken over is
 * refused before it writes; what it already spent is still settled. Real
 * jobs rows and claims on SQLite; no runner and no job target are needed.
 */
import { randomUUID } from 'node:crypto';
import {
  AiRunClaimLostError,
  getAiRun,
  openAiRun,
  readAiRunCheckpoint,
  withAiRunTransaction,
} from '@happyvertical/smrt-core';
import { type JobClaim, SmrtJobCollection } from '@happyvertical/smrt-jobs';
import { clearPromptCache, PromptRegistry } from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workflowClaimFence, workflowStopFence } from '../index.js';
import {
  closeWorkflowDbs,
  deferred,
  definePrompts,
  definitionOf,
  driverFor,
  scriptedModel,
  twoSteps,
  until,
  workflowDb,
} from './harness.js';

const JOB_CLASSES = [
  'SmrtJob',
  'SmrtJobEvent',
  'SmrtWorker',
  'SmrtJobDedupeSlot',
];

beforeEach(() => {
  clearPromptCache();
  definePrompts();
});
afterEach(async () => {
  PromptRegistry.clear();
  await closeWorkflowDbs();
});

async function claimFor(
  jobs: SmrtJobCollection,
  runId: string,
  workerId: string,
): Promise<JobClaim> {
  await jobs.enqueueJob({
    objectType: 'WorkflowRunFencingProbe',
    objectId: runId,
    method: 'execute',
    maxAttempts: 1,
    dedupeKey: runId,
  });
  const [job] = await jobs.claimReady({
    workerId,
    limit: 1,
    claimFencing: true,
  });
  if (!job) throw new Error('no job claimed');
  return {
    jobId: job.id as string,
    workerId,
    attempt: job.attempts,
    startedAt: job.startedAt?.toISOString() as string,
    tenantId: null,
    objectType: job.objectType,
    objectId: job.objectId,
    method: job.method,
  };
}

describe('workflow runs with claim fencing', () => {
  it('works under its live claim', async () => {
    const db = await workflowDb('sqlite', JOB_CLASSES);
    const jobs = await SmrtJobCollection.create({ db });
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const driver = driverFor(db, model);
    const run = await driver.start({ ownerId: 'owner' });
    const claim = await claimFor(jobs, run.id, `worker-${randomUUID()}`);
    expect(
      await driver.run(run.id, 'owner', { fence: workflowClaimFence(claim) }),
    ).toMatchObject({ status: 'done', totals: { calls: 2 } });
  });

  it('refuses a worker whose claim was taken over, before it writes, and still settles its call', async () => {
    const db = await workflowDb('sqlite', JOB_CLASSES);
    const jobs = await SmrtJobCollection.create({ db });
    const gate = deferred();
    const { model } = scriptedModel(async () => {
      await gate.promise;
      return { output: { value: 1 }, tokens: 20 };
    });
    const driver = driverFor(db, model);
    const run = await driver.start({ ownerId: 'owner' });
    const claim = await claimFor(jobs, run.id, `worker-${randomUUID()}`);
    const working = driver.run(run.id, 'owner', {
      fence: workflowClaimFence(claim),
    });
    await until(async () => (await getAiRun(db, run.id))?.reservedCalls === 1);
    const revision = (await readAiRunCheckpoint(db, run.id))?.revision;

    // Another worker takes the job over: the claim is gone.
    const [job] = await jobs.list({ where: { id: claim.jobId } });
    if (!job) throw new Error('missing job');
    job.workerId = 'replacement-worker';
    await job.save();

    gate.resolve();
    await expect(working).rejects.toBeInstanceOf(AiRunClaimLostError);
    // The stale worker wrote no checkpoint, and the call it made is charged.
    expect((await readAiRunCheckpoint(db, run.id))?.revision).toBe(revision);
    expect(await getAiRun(db, run.id)).toMatchObject({
      status: 'running',
      calls: 1,
      tokens: 20,
      reservedCalls: 0,
    });
  });
});

async function takeOver(jobs: SmrtJobCollection, claim: JobClaim) {
  const [job] = await jobs.list({ where: { id: claim.jobId } });
  if (!job) throw new Error('missing job');
  job.workerId = 'replacement-worker';
  await job.save();
}

async function recover(
  jobs: SmrtJobCollection,
  claim: JobClaim,
  runId: string,
) {
  const [job] = await jobs.list({ where: { id: claim.jobId } });
  if (!job) throw new Error('missing job');
  job.status = 'failed';
  await job.save();
  await jobs.enqueueJob({
    objectType: 'WorkflowRunFencingProbe',
    objectId: runId,
    method: 'execute',
    maxAttempts: 1,
    dedupeKey: runId,
  });
}

describe.each([
  'sqlite',
  'pglite',
] as const)('a stale worker after takeover on %s', (engine) => {
  /**
   * Start a fenced run whose first call waits on `gate`, take the claim over
   * while it waits, then let the call end with `answer`.
   */
  async function staleRun(
    answer: (signal: AbortSignal | undefined) => Promise<unknown>,
    options: {
      stopFence?: boolean;
      abort?: boolean;
      /** Take over as stale recovery does: fail the row, admit a new job. */
      recovered?: boolean;
    } = {},
  ) {
    const db = await workflowDb(engine, JOB_CLASSES);
    const jobs = await SmrtJobCollection.create({ db });
    const gate = deferred();
    const { model } = scriptedModel(async (call) => {
      await gate.promise;
      return {
        output: await answer(call.options.signal as AbortSignal | undefined),
      };
    });
    const driver = driverFor(db, model, definitionOf(twoSteps));
    const run = await driver.start({
      ownerId: 'owner',
      budget: { repairRetries: 0 },
    });
    const claim = await claimFor(jobs, run.id, `worker-${randomUUID()}`);
    const controller = new AbortController();
    const working = driver.run(run.id, 'owner', {
      signal: controller.signal,
      fence: workflowClaimFence(claim),
      ...(options.stopFence ? { stopFence: workflowStopFence(claim) } : {}),
    });
    await until(async () => (await getAiRun(db, run.id))?.reservedCalls === 1);
    if (options.recovered) await recover(jobs, claim, run.id);
    else await takeOver(jobs, claim);
    if (options.abort) controller.abort(new Error('job timed out'));
    gate.resolve();
    await expect(working).rejects.toBeInstanceOf(AiRunClaimLostError);
    return getAiRun(db, run.id);
  }

  it('locks a nested durable run root first in its stop fence', async () => {
    const db = await workflowDb(engine, JOB_CLASSES);
    const jobs = await SmrtJobCollection.create({ db });
    const store = { db, usageTracking: true };
    const root = await openAiRun(store, { type: 'turn' });
    const durable = await openAiRun(store, {
      type: 'workflow',
      durable: true,
      parentRunId: root.id,
    });
    const claim = await claimFor(jobs, durable.id, `worker-${randomUUID()}`);
    // The run rows each statement touches, in order (the lock-free chain
    // read excepted): a settle on the chain locks the root first, so the
    // fence must too, or the two wait on each other on PostgreSQL.
    const touched: string[] = [];
    await withAiRunTransaction(db, async (tx) => {
      const recording = new Proxy(tx.db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'query') {
            return (sql: string, ...params: unknown[]) => {
              if (
                /_smrt_ai_runs\b/.test(sql) &&
                !/parent_run_id FROM/.test(sql)
              ) {
                touched.push(String(params[0]));
              }
              return target.query(sql, ...params);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DatabaseInterface;
      await workflowStopFence(claim)(recording, durable.id);
    });
    expect(touched).toEqual([root.id, durable.id, durable.id]);
  });

  it('cannot fail the run when its output stays invalid', async () => {
    expect(await staleRun(async () => ({ wrong: true }))).toMatchObject({
      status: 'running',
      stopReason: null,
    });
  });

  it('cannot fail the run when its call throws', async () => {
    expect(
      await staleRun(async () => {
        throw new Error('provider down');
      }),
    ).toMatchObject({ status: 'running', stopReason: null });
  });

  it('cannot stop the run when its signal aborts', async () => {
    const aborted = async (signal: AbortSignal | undefined) => {
      throw signal?.reason ?? new Error('aborted');
    };
    expect(await staleRun(aborted, { abort: true })).toMatchObject({
      status: 'running',
      stopReason: null,
    });
    expect(
      await staleRun(aborted, { abort: true, stopFence: true }),
    ).toMatchObject({ status: 'running', stopReason: null });
    // Stale recovery keeps the worker on its failed row; the newer job of the
    // run is what the stop fence refuses on.
    expect(
      await staleRun(aborted, {
        abort: true,
        stopFence: true,
        recovered: true,
      }),
    ).toMatchObject({ status: 'running', stopReason: null });
  });
});

describe('host effect assertion in a workflow check', () => {
  it('allows a held claim and rejects a taken-over claim before another effect', async () => {
    const db = await workflowDb('sqlite', JOB_CLASSES);
    const jobs = await SmrtJobCollection.create({ db });
    const { model } = scriptedModel(() => ({ output: { value: 1 } }));
    const gate = deferred();
    const entered = deferred();
    let effects = 0;
    const driver = driverFor(
      db,
      model,
      definitionOf([
        {
          ...twoSteps[0],
          check: async (_output, context) => {
            await context.assertActive();
            effects++;
            entered.resolve();
            await gate.promise;
            await context.assertActive();
            effects++;
            return {};
          },
        },
      ]),
    );
    const run = await driver.start({ ownerId: 'owner' });
    const claim = await claimFor(jobs, run.id, `worker-${randomUUID()}`);
    const working = driver.run(run.id, 'owner', {
      fence: workflowClaimFence(claim),
    });
    await entered.promise;
    await takeOver(jobs, claim);
    gate.resolve();
    await expect(working).rejects.toBeInstanceOf(AiRunClaimLostError);
    expect(effects).toBe(1);
    expect((await getAiRun(db, run.id))?.status).toBe('running');
  });
});
it('checks the active duration budget before a long check applies a host effect', async () => {
  const db = await workflowDb('sqlite', JOB_CLASSES);
  const { model } = scriptedModel(() => ({ output: { value: 1 } }));
  let effects = 0;
  const driver = driverFor(
    db,
    model,
    definitionOf([
      {
        ...twoSteps[0],
        check: async (_output, context) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          await context.assertActive();
          effects++;
          return {};
        },
      },
    ]),
  );
  const run = await driver.start({
    ownerId: 'owner',
    budget: { maxDurationMs: 100 },
  });
  const result = await driver.run(run.id, 'owner');
  expect(result.status).toBe('stopped');
  expect(result.stopReason).toBe('max_duration');
  expect(effects).toBe(0);
});
