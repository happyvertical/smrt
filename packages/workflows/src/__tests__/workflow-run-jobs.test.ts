/**
 * Workflow runs from background jobs (#5005; docs/content/ai-runs.md sections
 * 6.7 and 7): the named handler `@happyvertical/smrt-workflows:workflow-run`,
 * one handler job per run, claim fencing, lease renewal, crash recovery by a
 * second worker, resume, approval and retry. Real TaskRunner and SQLite; a
 * scripted model, no provider, no containers.
 */
import { randomUUID } from 'node:crypto';
import {
  AiRunClaimLostError,
  cancelAiRun,
  createTrackedAiClient,
  getAiRun,
  pruneAiRuns,
  pruneAiRunTrajectories,
  readAiRunCheckpoint,
  stopAiRun,
} from '@happyvertical/smrt-core';
import {
  JobHandlerRegistrationClosedError,
  listJobHandlers,
  SmrtJobCollection,
  SmrtJobEventCollection,
  SmrtWorkerCollection,
  TaskRunner,
  unregisterJobHandler,
  unregisterLiveWorker,
} from '@happyvertical/smrt-jobs';
import { clearPromptCache, PromptRegistry } from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowRunJobs,
  readWorkflowRunLease,
  registerWorkflowRunHandler,
  WORKFLOW_RUN_HANDLER,
  type WorkflowRunJobsOptions,
  WorkflowRunKeyConflictError,
  WorkflowRunKeyExpiredError,
  type WorkflowStep,
  workflowStopFence,
} from '../index.js';
import {
  closeWorkflowDbs,
  deferred,
  definePrompts,
  definitionOf,
  driverFor,
  scriptedModel,
  twoSteps,
  until,
  validate,
  workflowDb,
} from './harness.js';

const JOB_CLASSES = [
  'SmrtJob',
  'SmrtJobEvent',
  'SmrtWorker',
  'SmrtJobDedupeSlot',
];

type Input = { prompt: string };
const startInput = (key = 'request') => ({
  key,
  input: { prompt: 'Design it' },
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('workflow run jobs', () => {
  let db: DatabaseInterface;
  let jobs: SmrtJobCollection;
  let kit: ReturnType<typeof createWorkflowRunJobs<Input>>;
  let model: ReturnType<typeof scriptedModel>['model'];
  let calls: ReturnType<typeof scriptedModel>['calls'];
  let runners: TaskRunner[];
  let settled: (() => void)[];
  let configureHook: (() => void) | undefined;

  beforeEach(async () => {
    clearPromptCache();
    definePrompts();
    db = await workflowDb('sqlite', JOB_CLASSES);
    jobs = await SmrtJobCollection.create({ db });
    runners = [];
    settled = [];
    configureHook = undefined;
    ({ model, calls } = scriptedModel((_call, n) => ({
      output: { value: n + 1 },
    })));
  });
  afterEach(async () => {
    for (const settle of settled) settle();
    for (const runner of runners) await runner.stop();
    try {
      kit?.dispose();
    } catch {
      /* a test that left a runner running */
    }
    if (listJobHandlers().includes(WORKFLOW_RUN_HANDLER)) {
      unregisterJobHandler(WORKFLOW_RUN_HANDLER);
    }
    PromptRegistry.clear();
    await closeWorkflowDbs();
  });

  function install(
    steps: WorkflowStep[] = twoSteps,
    extra: Partial<WorkflowRunJobsOptions<Input>> = {},
    definitionExtra = {},
  ) {
    try {
      kit?.dispose();
    } catch {
      /* ignore */
    }
    kit = createWorkflowRunJobs<Input>({
      db,
      jobs,
      definition: definitionOf(steps, definitionExtra),
      configure: (owner) => {
        configureHook?.();
        return {
          ai: createTrackedAiClient({
            db,
            tenantId: owner.tenantId,
            ai: model as never,
          }),
          validate,
          leaseTtlMs: 30_000,
        };
      },
      ...extra,
    });
    return kit.forOwner('owner', null);
  }
  async function worker(
    config: ConstructorParameters<typeof TaskRunner>[0] = {},
  ) {
    const runner = new TaskRunner({
      claimFencing: true,
      concurrency: 1,
      pollInterval: 10,
      cancelPollInterval: 10,
      retention: false,
      ...config,
    });
    runners.push(runner);
    await runner.initialize(db);
    await runner.start();
    return runner;
  }
  async function end(id: string) {
    const bound = kit.forOwner('owner', null);
    await until(async () =>
      ['done', 'failed', 'stopped', 'waiting-approval', 'cancelled'].includes(
        (await bound.get(id)).status,
      ),
    );
    return bound.get(id);
  }
  async function jobSettled(id: string) {
    await until(
      async () =>
        (
          await jobs.list({
            where: { dedupeKey: id, status: ['pending', 'running'] },
          })
        ).length === 0,
    );
  }
  const jobsOf = (id: string) => jobs.list({ where: { dedupeKey: id } });
  async function expireWorker(workerId: string) {
    unregisterLiveWorker(workerId);
    await (await SmrtWorkerCollection.create({ db })).expireWorker(workerId);
  }

  it('README usage: starts, runs two steps on a handler job and completes it', async () => {
    const bound = install();
    const state = await bound.start(startInput());
    expect(state).toMatchObject({ status: 'running', outputs: [] });
    await worker();
    const done = await end(state.id);
    expect(done).toMatchObject({
      status: 'done',
      outputs: [{ value: 1 }, { value: 2 }],
      totals: { calls: 2 },
    });
    expect(done.input).toEqual({ prompt: 'Design it' });
    await jobSettled(state.id);
    const [job] = await jobsOf(state.id);
    expect(job).toMatchObject({
      status: 'completed',
      objectType: `handler:${WORKFLOW_RUN_HANDLER}`,
      objectId: null,
      args: { runId: state.id, definition: 'test:design' },
    });
    // The lease the worker held is its own, with the job in its holder.
    const checkpoint = await readAiRunCheckpoint(db, state.id);
    expect(readWorkflowRunLease(checkpoint ?? { lease: null })).toMatchObject({
      holder: expect.stringContaining(String(job.id)),
    });
  });

  it('admits one run and one job for concurrent starts and replays after completion', async () => {
    const bound = install();
    const [first, second] = await Promise.all([
      bound.start(startInput()),
      bound.start(startInput()),
    ]);
    expect(second.id).toBe(first.id);
    expect(await jobsOf(first.id)).toHaveLength(1);
    await worker();
    await end(first.id);
    await jobSettled(first.id);
    expect((await bound.start(startInput())).status).toBe('done');
    await expect(
      bound.start({ ...startInput(), input: { prompt: 'Different request' } }),
    ).rejects.toBeInstanceOf(WorkflowRunKeyConflictError);
    expect(await jobsOf(first.id)).toHaveLength(1);
  });

  it('refuses a key whose run retention removed, for the same and a changed request', async () => {
    const bound = install();
    const first = await bound.start(startInput('expiring'));
    await worker();
    await end(first.id);
    await jobSettled(first.id);
    await db.query(
      "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
      first.id,
    );
    // Two hours on: past the hour a call's charge can still change (#5516).
    const now = new Date(Date.now() + 2 * 60 * 60_000);
    await pruneAiRunTrajectories(db, { maxAgeMs: 0, now });
    await pruneAiRuns(db, { maxAgeMs: 0, now });
    expect(await getAiRun(db, first.id)).toBeNull();
    await expect(bound.start(startInput('expiring'))).rejects.toBeInstanceOf(
      WorkflowRunKeyExpiredError,
    );
    await expect(
      bound.start({
        ...startInput('expiring'),
        input: { prompt: 'Different request' },
      }),
    ).rejects.toBeInstanceOf(WorkflowRunKeyExpiredError);
    expect(await getAiRun(db, first.id)).toBeNull();
    // A new key starts a new run.
    expect((await bound.start(startInput('renewed'))).status).toBe('running');
  });

  it('admits the job again when a start crashed between the run and its job', async () => {
    const bound = install();
    const enqueue = vi
      .spyOn(jobs, 'enqueueHandlerJob')
      .mockRejectedValueOnce(new Error('Admission unavailable'));
    await expect(bound.start(startInput())).rejects.toThrow(
      'Admission unavailable',
    );
    enqueue.mockRestore();
    expect(await jobs.list()).toHaveLength(0);
    const again = await bound.start(startInput());
    expect(again.status).toBe('running');
    expect(await jobsOf(again.id)).toHaveLength(1);
    await worker();
    expect((await end(again.id)).status).toBe('done');
  });

  it('repairs invalid output once and fails after bounded repairs without retrying the job', async () => {
    ({ model, calls } = scriptedModel((_call, n) => ({
      output: n === 0 ? { wrong: true } : { value: n },
    })));
    const bound = install();
    const run = await bound.start({
      ...startInput(),
      budget: { repairRetries: 1 },
    });
    await worker();
    expect((await end(run.id)).status).toBe('done');
    expect(calls).toHaveLength(3);

    ({ model, calls } = scriptedModel(() => ({ output: {} })));
    await runners[0]?.stop();
    const failing = install();
    const bad = await failing.start({
      ...startInput('bad'),
      budget: { repairRetries: 1 },
    });
    await worker();
    expect(await end(bad.id)).toMatchObject({
      status: 'failed',
      stopReason: 'repairs_exhausted',
    });
    await jobSettled(bad.id);
    const [job] = await jobsOf(bad.id);
    expect(job).toMatchObject({ status: 'completed', attempts: 1 });
    await expect(failing.resume(bad.id)).rejects.toMatchObject({
      reason: 'not_resumable',
    });
  });

  it('stops at its budget and resumes with a raised one on a new job', async () => {
    ({ model, calls } = scriptedModel(() => ({
      output: { value: 1 },
      tokens: 30,
    })));
    const bound = install(
      twoSteps.map((step) => ({ ...step, expectedOutputTokens: 100 })),
    );
    const run = await bound.start({
      ...startInput(),
      budget: { maxTokens: 130 },
    });
    await worker();
    expect(await end(run.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
    });
    await jobSettled(run.id);
    await expect(bound.resume(run.id)).rejects.toMatchObject({
      reason: 'budget_unchanged',
    });
    expect(
      (await bound.resume(run.id, { maxTokens: 5000 })).budget.maxTokens,
    ).toBe(5000);
    expect(await end(run.id)).toMatchObject({
      status: 'done',
      totals: { calls: 2 },
    });
    expect(await jobsOf(run.id)).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it.each([
    'approve',
    'refuse',
  ])('parks at an approval durably and continues after %s on a new job', async (decision) => {
    const checks: (string | null)[] = [];
    const step: WorkflowStep = {
      ...(twoSteps[0] as WorkflowStep),
      check: (_output, context) => {
        checks.push(context.approval);
        return context.approval ? {} : { waitingApproval: true };
      },
    };
    const bound = install([step]);
    const run = await bound.start(startInput());
    await worker();
    expect((await end(run.id)).status).toBe('waiting-approval');
    await jobSettled(run.id);
    await bound.decide(run.id, { approved: decision === 'approve' });
    if (decision === 'approve') {
      expect((await end(run.id)).status).toBe('done');
      expect(checks).toEqual([null, 'approved']);
      expect(await jobsOf(run.id)).toHaveLength(2);
    } else {
      expect(await bound.get(run.id)).toMatchObject({
        status: 'failed',
        stopReason: 'check_failed',
      });
      expect(await jobsOf(run.id)).toHaveLength(1);
    }
    // The call was never repeated for the approval.
    expect(calls).toHaveLength(1);
  });

  it('continues once after a decision recorded elsewhere, however often it is asked', async () => {
    const step: WorkflowStep = {
      ...(twoSteps[0] as WorkflowStep),
      check: (_output, context) =>
        context.approval ? {} : { waitingApproval: true },
    };
    const bound = install([step]);
    const run = await bound.start(startInput());
    await worker();
    expect((await end(run.id)).status).toBe('waiting-approval');
    await jobSettled(run.id);
    // A host that records the decision itself, through the driver.
    await driverFor(db, model, definitionOf([step])).decide(run.id, 'owner', {
      approved: true,
    });
    const [a, b] = await Promise.all([
      bound.continueAfterApproval(run.id),
      bound.continueAfterApproval(run.id),
    ]);
    expect([a.status, b.status]).toContain('running');
    expect((await end(run.id)).status).toBe('done');
    expect((await bound.continueAfterApproval(run.id)).status).toBe('done');
    expect(await jobsOf(run.id)).toHaveLength(2);
  });

  it('waits for the job that is parking the run before admitting the continuation', async () => {
    const parked = deferred();
    const release = deferred();
    settled.push(release.resolve);
    const step: WorkflowStep = {
      ...(twoSteps[0] as WorkflowStep),
      check: (_output, context) =>
        context.approval ? {} : { waitingApproval: true },
    };
    const bound = install([step], {
      configure: (owner) => ({
        ai: createTrackedAiClient({
          db,
          tenantId: owner.tenantId,
          ai: model as never,
        }),
        validate,
        onProgress: async (progress) => {
          if (progress.status === 'waiting-approval') {
            parked.resolve();
            await release.promise;
          }
        },
      }),
    });
    const run = await bound.start(startInput());
    await worker();
    await parked.promise;
    expect((await jobsOf(run.id))[0]?.status).toBe('running');
    let returned = false;
    const deciding = bound.decide(run.id, { approved: true }).then((state) => {
      returned = true;
      return state;
    });
    await delay(60);
    expect(returned).toBe(false);
    release.resolve();
    await deciding;
    expect((await end(run.id)).status).toBe('done');
    expect(await jobsOf(run.id)).toHaveLength(2);
  });

  it('renews its lease while a step works', async () => {
    const gate = deferred();
    settled.push(gate.resolve);
    let began = false;
    const step: WorkflowStep = {
      name: 'Slow',
      promptKey: 'test.workflow.propose',
      schema: twoSteps[0]?.schema ?? {},
      execute: async () => {
        began = true;
        await gate.promise;
        return { value: 1 };
      },
    };
    const bound = install([step], {
      configure: (owner) => ({
        ai: createTrackedAiClient({
          db,
          tenantId: owner.tenantId,
          ai: model as never,
        }),
        validate,
        leaseTtlMs: 60,
      }),
    });
    const run = await bound.start(startInput());
    await worker();
    await until(() => began);
    const lease = async () =>
      readWorkflowRunLease(
        (await readAiRunCheckpoint(db, run.id)) ?? {
          lease: null,
        },
      );
    const first = await lease();
    expect(first?.holder).toBeTruthy();
    await until(async () => {
      const next = await lease();
      return Boolean(next && first && next.expiresAt > first.expiresAt);
    });
    gate.resolve();
    expect((await end(run.id)).status).toBe('done');
  });

  it('stop aborts an in-flight step and resumes on a new job; cancel is final', async () => {
    let signal: AbortSignal | undefined;
    const step: WorkflowStep = {
      name: 'Hangs',
      promptKey: 'test.workflow.propose',
      schema: twoSteps[0]?.schema ?? {},
      execute: async (context) => {
        if (!signal) {
          signal = context.signal;
          await new Promise((_resolve, reject) =>
            context.signal.addEventListener(
              'abort',
              () => reject(context.signal.reason),
              { once: true },
            ),
          );
        }
        return { value: 1 };
      },
    };
    const bound = install([step]);
    const run = await bound.start(startInput());
    await worker();
    await until(() => signal !== undefined);
    expect((await bound.stop(run.id)).status).toBe('stopped');
    await jobSettled(run.id);
    expect(signal?.aborted).toBe(true);
    await bound.resume(run.id);
    expect((await end(run.id)).status).toBe('done');
    expect(await jobsOf(run.id)).toHaveLength(2);

    signal = undefined;
    const second = await bound.start(startInput('second'));
    await until(() => signal !== undefined);
    expect((await bound.cancel(second.id)).status).toBe('cancelled');
    await jobSettled(second.id);
    await expect(bound.resume(second.id)).rejects.toMatchObject({
      reason: 'not_resumable',
    });
  });

  it('forwards a job cancellation to the step and leaves the run resumable', async () => {
    let signal: AbortSignal | undefined;
    const step: WorkflowStep = {
      name: 'Hangs',
      promptKey: 'test.workflow.propose',
      schema: twoSteps[0]?.schema ?? {},
      execute: async (context) => {
        if (!signal) {
          signal = context.signal;
          await new Promise((_resolve, reject) =>
            context.signal.addEventListener(
              'abort',
              () => reject(context.signal.reason),
              { once: true },
            ),
          );
        }
        return { value: 1 };
      },
    };
    const bound = install([step]);
    const run = await bound.start(startInput());
    await worker();
    await until(() => signal !== undefined);
    const [job] = await jobsOf(run.id);
    await job?.cancel();
    await until(() => signal?.aborted === true);
    await until(async () => (await bound.get(run.id)).status === 'stopped');
    await bound.resume(run.id);
    expect((await end(run.id)).status).toBe('done');
  });

  it('refuses a worker whose claim was taken over before it writes', async () => {
    const external = deferred();
    settled.push(external.resolve);
    let began = false;
    const step: WorkflowStep = {
      name: 'Slow',
      promptKey: 'test.workflow.propose',
      schema: twoSteps[0]?.schema ?? {},
      execute: async () => {
        began = true;
        await external.promise;
        return { value: 7 };
      },
    };
    const bound = install([step]);
    const run = await bound.start(startInput());
    await worker();
    await until(() => began);
    const before = await bound.get(run.id);
    const [replaced] = await jobsOf(run.id);
    if (!replaced) throw new Error('missing job');
    replaced.workerId = 'replacement';
    await replaced.save();
    external.resolve();
    await until(async () => runners[0]?.activeJobCount() === 0);
    expect((await bound.get(run.id)).revision).toBe(before.revision);
    expect((await bound.get(run.id)).outputs).toEqual([]);
    // The stale worker's error was the claim, and it closed nothing.
    expect((await getAiRun(db, run.id))?.status).toBe('running');
  });

  it('recovers a crashed worker on a second worker and repeats only the step in flight', async () => {
    const external = deferred();
    settled.push(external.resolve);
    let interrupted = false;
    const executed: string[] = [];
    const steps: WorkflowStep[] = ['One', 'Two'].map((name) => ({
      name,
      promptKey: 'test.workflow.propose',
      schema: twoSteps[0]?.schema ?? {},
      execute: async () => {
        executed.push(name);
        if (name === 'Two' && !interrupted) {
          interrupted = true;
          await external.promise;
        }
        return { value: executed.length };
      },
    }));
    const bound = install(steps);
    const run = await bound.start(startInput());
    const old = await worker({ shutdownTimeout: 1, leaseTickMs: 10000 });
    await until(() => interrupted);
    expect((await bound.get(run.id)).outputs).toHaveLength(1);
    await expect(bound.resume(run.id)).rejects.toThrow('still settling');
    const [prior] = await jobsOf(run.id);
    if (!prior) throw new Error('missing job');
    await old.stop();
    await expireWorker(prior.workerId as string);
    await worker();
    await until(
      async () =>
        (await jobs.get({ id: prior.id as string }))?.status === 'failed',
    );
    const events = await SmrtJobEventCollection.create({ db });
    expect(
      (await events.listTerminalOutcomes({ tenantId: null })).outcomes.some(
        (event) =>
          event.jobId === prior.id && event.failureKind === 'stale-recovery',
      ),
    ).toBe(true);
    // A crash is not an end for the run: it stays running until recovered.
    expect((await bound.get(run.id)).status).toBe('running');
    await expect(bound.resume(run.id, { maxTokens: 500 })).rejects.toThrow(
      'Recover the job first',
    );
    const admission = vi
      .spyOn(jobs, 'enqueueHandlerJob')
      .mockRejectedValueOnce(new Error('Recovery admission failed'));
    await expect(bound.resume(run.id)).rejects.toThrow(
      'Recovery admission failed',
    );
    admission.mockRestore();
    expect(await jobsOf(run.id)).toHaveLength(1);
    await bound.resume(run.id);
    expect((await end(run.id)).status).toBe('done');
    expect(executed).toEqual(['One', 'Two', 'Two']);
    const done = await bound.get(run.id);
    external.resolve();
    await until(() => old.activeJobCount() === 0);
    expect(await bound.get(run.id)).toEqual(done);
  });

  it('does not recover a failed job that shows no crash', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    const [job] = await jobsOf(run.id);
    if (!job) throw new Error('missing job');
    job.status = 'failed';
    await job.save();
    // No terminal event proves a crash: nothing to recover.
    await expect(bound.resume(run.id)).rejects.toThrow();
    expect((await getAiRun(db, run.id))?.status).toBe('running');
  });

  it('fails a run whose job fails on a runner without claim fencing', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    await worker({ claimFencing: false });
    await jobSettled(run.id);
    expect(await bound.get(run.id)).toMatchObject({
      status: 'failed',
      stopReason: 'error',
    });
    expect(calls).toHaveLength(0);
  });

  it('cancels the run of a job cancelled before any worker claimed it', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    const [job] = await jobsOf(run.id);
    await job?.cancel();
    expect(await bound.get(run.id)).toMatchObject({
      status: 'cancelled',
      stopReason: 'cancelled',
    });
    await worker();
    await delay(60);
    expect(calls).toHaveLength(0);
  });

  it('does no work for a job whose run row is cancelled', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    await cancelAiRun(db, run.id);
    await worker();
    await jobSettled(run.id);
    const [job] = await jobsOf(run.id);
    expect(job?.status).toBe('completed');
    expect(calls).toHaveLength(0);
    expect((await bound.get(run.id)).status).toBe('cancelled');
  });

  it('leaves a pending job pending until a worker runs', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    await delay(80);
    expect((await jobsOf(run.id))[0]?.status).toBe('pending');
    expect((await bound.get(run.id)).status).toBe('running');
  });

  it('retries a failed run from its last accepted step on a new job', async () => {
    let rejectSecond = true;
    const steps: WorkflowStep[] = [
      twoSteps[0] as WorkflowStep,
      {
        ...(twoSteps[1] as WorkflowStep),
        check: () => (rejectSecond ? { failure: 'No.' } : {}),
      },
    ];
    const bound = install(steps);
    const run = await bound.start(startInput());
    await worker();
    expect(await end(run.id)).toMatchObject({
      status: 'failed',
      stopReason: 'check_failed',
    });
    await jobSettled(run.id);
    rejectSecond = false;
    const before = calls.length;
    const retried = await bound.retry(run.id);
    expect(retried).toMatchObject({
      retryOfRunId: run.id,
      step: { index: 2 },
    });
    expect(await jobsOf(retried.id)).toHaveLength(1);
    expect(await end(retried.id)).toMatchObject({ status: 'done' });
    // Only the failed step ran again.
    expect(calls.length - before).toBe(1);
  });

  it('lets the host refuse or cap resumed budgets before any write', async () => {
    ({ model, calls } = scriptedModel(() => ({
      output: { value: 1 },
      tokens: 30,
    })));
    let denied = true;
    const policy = vi.fn<
      NonNullable<WorkflowRunJobsOptions<Input>['resumeBudget']>
    >(async (_owner, _state, proposed) => {
      if (denied) throw new Error('Budget policy refused');
      return {
        ...proposed,
        maxTokens: Math.min(proposed.maxTokens ?? 0, 4000),
      };
    });
    const bound = install(
      twoSteps.map((step) => ({ ...step, expectedOutputTokens: 100 })),
      { resumeBudget: policy },
    );
    const run = await bound.start({
      ...startInput(),
      budget: { maxTokens: 130 },
    });
    await worker();
    expect((await end(run.id)).status).toBe('stopped');
    await jobSettled(run.id);
    await expect(bound.resume(run.id, { maxTokens: 9000 })).rejects.toThrow(
      'Budget policy refused',
    );
    expect(await jobsOf(run.id)).toHaveLength(1);
    denied = false;
    expect(
      (await bound.resume(run.id, { maxTokens: 9000 })).budget.maxTokens,
    ).toBe(4000);
    expect(policy.mock.calls[1]?.[0]).toEqual({
      ownerId: 'owner',
      tenantId: null,
    });
    expect((await end(run.id)).status).toBe('done');
  });

  it('scopes admission and reads to owners and tenants', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    await expect(kit.forOwner('other', null).get(run.id)).rejects.toThrow(
      'not found',
    );
    await expect(
      kit.forOwner('owner', randomUUID()).get(run.id),
    ).rejects.toThrow('not found');
    const tenantId = randomUUID();
    const scoped = await kit.forOwner('owner', tenantId).start(startInput());
    expect(scoped.id).not.toBe(run.id);
    expect(await jobs.list()).toHaveLength(2);
    await worker();
    expect(
      (await kit.forOwner('owner', tenantId).get(scoped.id)).tenantId,
    ).toBe(tenantId);
    await until(
      async () =>
        (await kit.forOwner('owner', tenantId).get(scoped.id)).status ===
        'done',
    );
  });

  it('rejects unauthorized work and invalid keys before any write', async () => {
    const denied = install(twoSteps, {
      authorize: async () => {
        throw new Error('Denied');
      },
    });
    await expect(denied.start(startInput())).rejects.toThrow('Denied');
    expect(await jobs.list()).toHaveLength(0);
    const allowed = install();
    await expect(allowed.start(startInput(' '))).rejects.toThrow('key');
  });

  it('parks a startup failure as stopped and resumes after the configuration is repaired', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    configureHook = () => {
      throw new Error('Private configuration failure');
    };
    await worker();
    await jobSettled(run.id);
    const stopped = await bound.get(run.id);
    expect(stopped.status).toBe('stopped');
    expect(JSON.stringify(stopped)).not.toContain('Private');
    // Stop and read never need the host configuration.
    expect((await bound.stop(run.id)).status).toBe('stopped');
    configureHook = undefined;
    await bound.resume(run.id);
    expect((await end(run.id)).status).toBe('done');
  });

  it('a stale worker whose stop lands while the owner resumes never stops the resumed run', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    // The old worker holds the run's first job.
    const workerId = `stale-${randomUUID()}`;
    const [claimed] = await jobs.claimReady({
      workerId,
      limit: 1,
      claimFencing: true,
    });
    if (!claimed) throw new Error('no job claimed');
    const claim = {
      jobId: String(claimed.id),
      workerId,
      attempt: claimed.attempts,
      startedAt: claimed.startedAt?.toISOString() as string,
      tenantId: null,
      objectType: claimed.objectType,
      objectId: claimed.objectId,
      method: claimed.method,
    };
    // The owner stops the run: its job is cancelled, and the old worker has
    // not seen the abort yet.
    expect((await bound.stop(run.id)).status).toBe('stopped');
    // The owner resumes. The old worker's stop (its own job is `cancelled`,
    // which its stop fence accepts) is fired the moment the new job is
    // being admitted: before the fix the run was already `running` with no
    // other job, and the stop won.
    const enqueue = jobs.enqueueHandlerJob.bind(jobs);
    let stale: Promise<unknown> | undefined;
    const spy = vi
      .spyOn(jobs, 'enqueueHandlerJob')
      .mockImplementation(async (...args) => {
        stale ??= stopAiRun(db, run.id, {
          reason: 'interrupted',
          fence: workflowStopFence(claim),
        }).then(
          () => 'stopped',
          (error: unknown) => error,
        );
        // Give a stop that can run now the time to land; one that waits on
        // the resume's transaction does not hold the resume.
        await Promise.race([stale, delay(200)]);
        return enqueue(...args);
      });
    try {
      await bound.resume(run.id);
    } finally {
      spy.mockRestore();
    }
    expect(await stale).toBeInstanceOf(AiRunClaimLostError);
    expect(await getAiRun(db, run.id)).toMatchObject({
      status: 'running',
      stopReason: null,
    });
    const active = (await jobsOf(run.id)).filter(
      (job) => job.status === 'pending',
    );
    expect(active).toHaveLength(1);
  });

  it('stops a run whose job no worker claimed before the deadline and resumes it', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    const [job] = await jobsOf(run.id);
    await db.query(
      'UPDATE _smrt_jobs SET run_at = ? WHERE id = ?',
      new Date(Date.now() - 60_000).toISOString(),
      job?.id,
    );
    // A runner sweeps only handlers it did not register itself, so the
    // sweep comes from a worker in a process with no workflow handler: take
    // the handler out of the registry before that runner snapshots it.
    kit.dispose();
    expect(listJobHandlers()).not.toContain(WORKFLOW_RUN_HANDLER);
    const runner = new TaskRunner({
      claimFencing: true,
      concurrency: 1,
      pollInterval: 10,
      cancelPollInterval: 10,
      retention: false,
      handlerUnclaimedDeadlineMs: 1_000,
    });
    runners.push(runner);
    await runner.initialize(db);
    await runner.start();
    await jobSettled(run.id);
    // Stop it before the resume, so it can never sweep the resumed job.
    await runner.stop();
    runners.splice(runners.indexOf(runner), 1);
    expect((await jobsOf(run.id))[0]).toMatchObject({
      status: 'failed',
      attempts: 0,
    });
    const served = install();
    expect(await served.get(run.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'interrupted',
    });
    expect(calls).toHaveLength(0);
    await served.resume(run.id);
    // A worker that registered the handler now runs the resumed job.
    await worker();
    await until(async () => (await served.get(run.id)).status === 'done');
    expect(await jobsOf(run.id)).toHaveLength(2);
  });

  it('a job whose run belongs to another definition does no work', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    const [job] = await jobsOf(run.id);
    if (!job) throw new Error('missing job');
    job.args = { runId: run.id, definition: 'someone:else' };
    await job.save();
    await worker();
    await jobSettled(run.id);
    expect((await jobs.get({ id: job.id as string }))?.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  describe('handler registration', () => {
    it('registers the named handler at creation and unregisters it at dispose', () => {
      expect(listJobHandlers()).not.toContain(WORKFLOW_RUN_HANDLER);
      install();
      expect(listJobHandlers()).toContain(WORKFLOW_RUN_HANDLER);
      kit.dispose();
      expect(listJobHandlers()).not.toContain(WORKFLOW_RUN_HANDLER);
    });

    it('serves two definitions through one handler and refuses a duplicate key', async () => {
      const first = install();
      const second = createWorkflowRunJobs<Input>({
        db,
        jobs,
        definition: {
          ...definitionOf([twoSteps[0] as WorkflowStep]),
          key: 'test:second',
        },
        configure: (owner) => ({
          ai: createTrackedAiClient({
            db,
            tenantId: owner.tenantId,
            ai: model as never,
          }),
          validate,
        }),
      });
      try {
        expect(() => install()).not.toThrow();
        const a = await first.start(startInput());
        const b = await second.forOwner('owner', null).start(startInput());
        expect(a.id).not.toBe(b.id);
      } finally {
        second.dispose();
      }
    });

    it('throws a late registration once a runner runs, and a repeat before it is harmless', async () => {
      install();
      registerWorkflowRunHandler();
      registerWorkflowRunHandler();
      await worker();
      expect(() => registerWorkflowRunHandler()).toThrow(
        JobHandlerRegistrationClosedError,
      );
      expect(() =>
        createWorkflowRunJobs<Input>({
          db,
          jobs,
          definition: {
            ...definitionOf(),
            key: 'test:late',
          },
          configure: () => {
            throw new Error('not reached');
          },
        }),
      ).toThrow(JobHandlerRegistrationClosedError);
      // The failed creation left nothing behind: the key is free.
      await runners[0]?.stop();
      const late = createWorkflowRunJobs<Input>({
        db,
        jobs,
        definition: { ...definitionOf(), key: 'test:late' },
        configure: () => {
          throw new Error('not reached');
        },
      });
      late.dispose();
    });

    it('leaves a run job pending on a runner without the handler for one that has it', async () => {
      const bound = install();
      const run = await bound.start(startInput());
      kit.dispose();
      expect(listJobHandlers()).not.toContain(WORKFLOW_RUN_HANDLER);
      const bare = await worker();
      await delay(100);
      // The claim filter keeps the job away from a runner that cannot run it.
      expect((await jobsOf(run.id))[0]).toMatchObject({
        status: 'pending',
        attempts: 0,
      });
      expect(calls).toHaveLength(0);
      await bare.stop();
      install();
      await worker();
      expect((await end(run.id)).status).toBe('done');
      expect(await jobsOf(run.id)).toHaveLength(1);
    });

    it('stops a run whose job a runner without the handler failed, then resumes it', async () => {
      const bound = install();
      const run = await bound.start(startInput());
      kit.dispose();
      expect(listJobHandlers()).not.toContain(WORKFLOW_RUN_HANDLER);
      // The backstop: a claim made without the handler filter.
      const bare = new TaskRunner({
        claimFencing: true,
        concurrency: 1,
        pollInterval: 10,
        cancelPollInterval: 10,
        retention: false,
      });
      runners.push(bare);
      await bare.initialize(db);
      const internal = bare as unknown as { collection: SmrtJobCollection };
      const claimReady = internal.collection.claimReady.bind(
        internal.collection,
      );
      internal.collection.claimReady = ({ handlerNames: _names, ...options }) =>
        claimReady(options);
      await bare.start();
      await jobSettled(run.id);
      const [job] = await jobsOf(run.id);
      expect(job?.status).toBe('failed');
      expect(calls).toHaveLength(0);
      await bare.stop();
      const again = install();
      // Reading reconciles: the handler was missing, the run is resumable.
      expect((await again.get(run.id)).status).toBe('stopped');
      await again.resume(run.id);
      await worker();
      expect((await end(run.id)).status).toBe('done');
    });
  });
});
