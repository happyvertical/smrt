/**
 * Named job handlers (#5005): a job targets a model method or a handler
 * registered under a namespaced name. The registry, the enqueue API, the
 * registration-before-claim mechanism, and a parity suite that runs the same
 * runner scenario for a model target and a handler target.
 */
import { randomUUID } from 'node:crypto';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAbandonedJobClaim,
  assertFailedJobDispatch,
  assertJobClaim,
  assertJobClaimForRelease,
  type JobClaim,
  JobClaimLostError,
} from '../job-claim.js';
import {
  isJobHandlerTarget,
  JOB_HANDLER_METHOD,
  type JobHandler,
  JobHandlerAlreadyRegisteredError,
  JobHandlerNameError,
  JobHandlerRegistrationClosedError,
  jobHandlerName,
  jobHandlerTarget,
  listJobHandlers,
  registerJobHandler,
  unregisterJobHandler,
} from '../job-handlers.js';
import type { JobExecutionContext } from '../logger-extension.js';
import {
  getJobClaim,
  isRunnerExecutionContext,
  JobCancelledError,
  JobTimeoutError,
  TaskRunner,
  type TaskRunnerConfig,
} from '../runner.js';
import { createScheduleRunner } from '../schedule-runner.js';
import { type SmrtJob, SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';
import { enablePgliteJobs } from '../worker-liveness.js';

type Behaviour = (
  payload: Record<string, unknown>,
  context: JobExecutionContext,
) => Promise<unknown>;

let behaviour: Behaviour = async () => 'ok';
let invocations = 0;

@smrt({ api: false, cli: false, mcp: false })
class Issue5005ParityProbe extends SmrtObject {
  async execute(
    args: Record<string, unknown>,
    context: JobExecutionContext,
  ): Promise<unknown> {
    invocations++;
    return behaviour(args, context);
  }
}

const HANDLER = '@happyvertical/smrt-jobs:issue-5005-parity-probe';
registerJobHandler(HANDLER, async (payload, context) => {
  invocations++;
  return behaviour(payload, context);
});

type Target = 'model' | 'handler';
const TARGETS: Target[] = ['model', 'handler'];

function modelType(): string {
  return (
    ObjectRegistry.getClass('Issue5005ParityProbe')?.qualifiedName ??
    Issue5005ParityProbe.name
  );
}

function targetOf(target: Target): { objectType: string; method: string } {
  return target === 'model'
    ? { objectType: modelType(), method: 'execute' }
    : jobHandlerTarget(HANDLER);
}

async function enqueue(
  jobs: SmrtJobCollection,
  target: Target,
  extra: {
    payload?: Record<string, unknown>;
    queue?: string;
    maxAttempts?: number;
    timeout?: number;
    retryStrategy?: SmrtJob['retryStrategy'];
  } = {},
): Promise<SmrtJob> {
  const { payload = {}, ...options } = extra;
  return target === 'model'
    ? jobs.enqueueJob({ ...targetOf('model'), args: payload, ...options })
    : jobs.enqueueHandlerJob({ handler: HANDLER, payload, ...options });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition did not settle');
    await delay(10);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const IMMEDIATE_RETRY: SmrtJob['retryStrategy'] = {
  type: 'linear',
  config: { delay: 1 },
};

let db: DatabaseInterface | undefined;
const runners: TaskRunner[] = [];

async function openDb(
  engine: 'sqlite' | 'pglite' = 'sqlite',
): Promise<DatabaseInterface> {
  db =
    engine === 'sqlite'
      ? await getTestDatabase({ type: 'sqlite', url: ':memory:' })
      : await getTestDatabase({
          type: 'pglite',
          classes: [
            'SmrtJob',
            'SmrtJobEvent',
            'SmrtJobDedupeSlot',
            'SmrtWorker',
            'Issue5005ParityProbe',
          ],
        });
  if (engine === 'pglite') enablePgliteJobs(db);
  return db;
}

async function startRunner(
  database: DatabaseInterface,
  config: TaskRunnerConfig = {},
): Promise<TaskRunner> {
  const runner = new TaskRunner({
    concurrency: 1,
    pollInterval: 10,
    cancelPollInterval: 10,
    retention: false,
    ...config,
  });
  runners.push(runner);
  await runner.initialize(database);
  await runner.start();
  return runner;
}

async function statusOf(jobs: SmrtJobCollection, id: string) {
  return (await jobs.get({ id }))?.status;
}

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  await (db as { close?: () => Promise<void> } | undefined)?.close?.();
  db = undefined;
  behaviour = async () => 'ok';
  invocations = 0;
});

describe('job handler registry (#5005)', () => {
  it('registers, lists and unregisters namespaced handlers', () => {
    const name = '@happyvertical/smrt-jobs:issue-5005-registry';
    const handler: JobHandler = async () => undefined;
    registerJobHandler(name, handler);
    expect(listJobHandlers()).toContain(name);
    expect(() => registerJobHandler(name, handler)).toThrow(
      JobHandlerAlreadyRegisteredError,
    );
    expect(unregisterJobHandler(name)).toBe(true);
    expect(unregisterJobHandler(name)).toBe(false);
    expect(listJobHandlers()).not.toContain(name);
    registerJobHandler('plain-package:issue-5005.step-two', handler);
    expect(unregisterJobHandler('plain-package:issue-5005.step-two')).toBe(
      true,
    );
  });

  it.each([
    '',
    'workflow-run',
    'WorkflowRun',
    '@happyvertical/smrt-workflows:WorkflowRun',
    '@happyvertical/smrt-workflows:',
    ':workflow-run',
    'handler:@happyvertical/smrt-workflows:workflow-run',
    '@happyvertical/smrt-workflows:workflow run',
    `@happyvertical/smrt-workflows:${'a'.repeat(200)}`,
  ])('rejects the handler name %j', (name) => {
    expect(() => registerJobHandler(name, async () => undefined)).toThrow(
      JobHandlerNameError,
    );
    expect(() => jobHandlerTarget(name)).toThrow(JobHandlerNameError);
  });

  it('rejects a handler that is not a function', () => {
    expect(() =>
      registerJobHandler(
        '@happyvertical/smrt-jobs:issue-5005-not-a-function',
        'nope' as unknown as JobHandler,
      ),
    ).toThrow(TypeError);
  });

  it('stores a reserved target that never resolves to a model class', () => {
    const target = jobHandlerTarget(HANDLER);
    expect(target).toEqual({
      objectType: `handler:${HANDLER}`,
      method: JOB_HANDLER_METHOD,
    });
    expect(isJobHandlerTarget(target.objectType)).toBe(true);
    expect(jobHandlerName(target.objectType)).toBe(HANDLER);
    expect(isJobHandlerTarget(modelType())).toBe(false);
    expect(jobHandlerName(modelType())).toBeNull();
    // A qualified-looking name is looked up by its tail; the reserved
    // form is not a qualified name, so it never reaches that fallback.
    expect(
      ObjectRegistry.getClass(
        'handler:@some/other-package:Issue5005ParityProbe',
      ),
    ).toBeUndefined();
    expect(ObjectRegistry.getClass(target.objectType)).toBeUndefined();
  });
});

describe('enqueueing a handler job (#5005)', () => {
  it('writes the canonical handler row and dedupes like any job', async () => {
    const jobs = await SmrtJobCollection.create({ db: await openDb() });
    const job = await jobs.enqueueHandlerJob({
      handler: '@happyvertical/smrt-jobs:issue-5005-unregistered-here',
      payload: { runId: 'r1' },
      queue: 'handlers',
      dedupeKey: 'r1',
      priority: 70,
    });
    const row = (
      await (db as DatabaseInterface).query(
        'SELECT object_type, object_id, method, args, queue, priority FROM _smrt_jobs WHERE id = ?',
        job.id,
      )
    ).rows[0];
    expect(row).toMatchObject({
      object_type:
        'handler:@happyvertical/smrt-jobs:issue-5005-unregistered-here',
      object_id: null,
      method: 'handle',
      queue: 'handlers',
      priority: 70,
    });
    expect(
      typeof row.args === 'string' ? JSON.parse(row.args) : row.args,
    ).toEqual({ runId: 'r1' });
    const again = await jobs.enqueueHandlerJob({
      handler: '@happyvertical/smrt-jobs:issue-5005-unregistered-here',
      payload: { runId: 'r1' },
      queue: 'handlers',
      dedupeKey: 'r1',
    });
    expect(again.id).toBe(job.id);
  });

  it.each([
    [{ payload: { _mcpTask: { invocationArgs: [] } } }, 'reserved _mcpTask'],
    [{ payload: { _agentConfig: {} } }, 'reserved _agentConfig'],
    [{ payload: { _scheduleId: 's' } }, 'reserved _scheduleId'],
    [{ handler: 'NotNamespaced' }, 'Invalid job handler name'],
  ])('refuses %j', async (patch, message) => {
    const jobs = await SmrtJobCollection.create({ db: await openDb() });
    await expect(
      jobs.enqueueHandlerJob({ handler: HANDLER, ...patch }),
    ).rejects.toThrow(message);
  });

  it.each([
    [{ method: 'run' }, "method must be 'handle'"],
    [{ objectId: randomUUID() }, 'cannot have an objectId'],
    [{ taskId: randomUUID() }, 'cannot be an MCP task'],
    [{ args: [] as unknown as Record<string, unknown> }, 'JSON object'],
    [{ objectType: 'handler:Bad' }, 'Invalid job handler name'],
  ])('refuses a non-canonical handler row %j through enqueueJob', async (patch, message) => {
    const jobs = await SmrtJobCollection.create({ db: await openDb() });
    await expect(
      jobs.enqueueJob({ ...jobHandlerTarget(HANDLER), ...patch }),
    ).rejects.toThrow(message);
  });
});

describe('registration before claim (#5005)', () => {
  const LATE = '@happyvertical/smrt-jobs:issue-5005-late';

  it('closes registration while a runner runs and reopens it after stop', async () => {
    const database = await openDb();
    const unstarted = new TaskRunner({ retention: false });
    await expect(unstarted.start()).rejects.toThrow('not initialized');
    // A start that failed before claiming leaves registration open.
    registerJobHandler(LATE, async () => 'late');
    expect(unregisterJobHandler(LATE)).toBe(true);

    const runner = await startRunner(database);
    expect(() => registerJobHandler(LATE, async () => 'late')).toThrow(
      JobHandlerRegistrationClosedError,
    );
    expect(() => registerJobHandler(LATE, async () => 'late')).toThrow(LATE);
    expect(() => unregisterJobHandler(HANDLER)).toThrow(
      JobHandlerRegistrationClosedError,
    );

    // A second runner keeps it closed until both have stopped.
    const second = await startRunner(database, { queues: ['other'] });
    await runner.stop();
    expect(() => registerJobHandler(LATE, async () => 'late')).toThrow(
      JobHandlerRegistrationClosedError,
    );
    await second.stop();
    registerJobHandler(LATE, async () => 'late');
    expect(unregisterJobHandler(LATE)).toBe(true);
  });

  it('dispatches from the snapshot taken at start', async () => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    const name = '@happyvertical/smrt-jobs:issue-5005-snapshot';
    registerJobHandler(name, async () => 'from-snapshot');
    try {
      const results: unknown[] = [];
      const runner = await startRunner(database);
      runner.on('job:completed', (_job, result) => results.push(result));
      const job = await jobs.enqueueHandlerJob({ handler: name });
      await until(
        async () => (await statusOf(jobs, job.id as string)) === 'completed',
      );
      expect(results).toEqual([{ result: 'from-snapshot' }]);
      await runner.stop();
    } finally {
      unregisterJobHandler(name);
    }
  });
});

describe('model and handler targets behave alike (#5005 parity)', () => {
  for (const engine of ['sqlite', 'pglite'] as const) {
    it
      .skipIf(engine === 'pglite' && !process.env.SMRT_TEST_PGLITE_MODULE)
      .each(TARGETS)(
      `completes a %s job with a fenced claim end to end (${engine})`,
      async (target) => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        let claim: Readonly<JobClaim> | undefined;
        let context: JobExecutionContext | undefined;
        behaviour = async (payload, ctx) => {
          context = ctx;
          claim = getJobClaim(ctx);
          await database.transaction?.((tx) =>
            assertJobClaim(tx, claim as JobClaim),
          );
          await ctx.progress({ stage: 'working', progress: 50 });
          return { echoed: payload.value };
        };
        const job = await enqueue(jobs, target, {
          payload: { value: 7 },
          queue: `done-${target}`,
        });
        const completed: unknown[] = [];
        const runner = await startRunner(database, {
          claimFencing: true,
          queues: [`done-${target}`],
        });
        runner.on('job:completed', (_job, result) => completed.push(result));
        await until(
          async () => (await statusOf(jobs, job.id as string)) === 'completed',
        );
        expect(invocations).toBe(1);
        expect(completed).toEqual([{ result: { echoed: 7 } }]);
        expect(isRunnerExecutionContext(context)).toBe(true);
        const { objectType, method } = targetOf(target);
        expect(context?.job).toMatchObject({
          jobId: job.id,
          attempt: 1,
          objectType,
          method,
          tenantId: null,
        });
        expect(context?.job.handler).toBe(
          target === 'handler' ? HANDLER : undefined,
        );
        expect(claim).toMatchObject({
          jobId: job.id,
          attempt: 1,
          objectType,
          objectId: null,
          method,
        });
        await database.transaction?.((tx) =>
          assertJobClaimForRelease(tx, claim as JobClaim),
        );
        const events = await SmrtJobEventCollection.create({ db: database });
        expect(
          await events.getTerminalOutcome(job.id as string, { tenantId: null }),
        ).toMatchObject({
          status: 'completed',
          objectType,
          method,
          attempts: 1,
        });
        expect(
          (await events.listByJob(job.id as string, { tenantId: null })).map(
            (e) => e.stage,
          ),
        ).toContain('working');
      },
    );
  }

  it.each(
    TARGETS,
  )('runs a tenant %s job in its tenant, claim and outcome', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    const tenantId = '22222222-2222-4222-8222-222222222222';
    const seen: Record<string, unknown> = {};
    behaviour = async (_payload, ctx) => {
      seen.ambient = getTenantId();
      seen.context = ctx.job.tenantId;
      seen.claim = getJobClaim(ctx).tenantId;
      return 'ok';
    };
    const job =
      target === 'model'
        ? await jobs.enqueueJob({ ...targetOf('model'), tenantId })
        : await jobs.enqueueHandlerJob({ handler: HANDLER, tenantId });
    await startRunner(database, { claimFencing: true });
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'completed',
    );
    expect(seen).toEqual({
      ambient: tenantId,
      context: tenantId,
      claim: tenantId,
    });
    const events = await SmrtJobEventCollection.create({ db: database });
    expect(
      await events.getTerminalOutcome(job.id as string, { tenantId }),
    ).toMatchObject({ status: 'completed', tenantId });
    expect(
      await events.getTerminalOutcome(job.id as string, { tenantId: null }),
    ).toBeNull();
  });

  it.each(
    TARGETS,
  )('refuses a claim proof to a %s job on an unfenced runner', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    behaviour = async (_payload, ctx) => getJobClaim(ctx);
    const job = await enqueue(jobs, target, { maxAttempts: 1 });
    await startRunner(database);
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'failed',
    );
    expect((await jobs.get({ id: job.id as string }))?.lastError).toContain(
      'claimFencing: true',
    );
  });

  it.each(
    TARGETS,
  )('retries a failing %s job, then fails it as execution', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    behaviour = async () => {
      throw new Error('boom');
    };
    const job = await enqueue(jobs, target, {
      maxAttempts: 2,
      retryStrategy: IMMEDIATE_RETRY,
    });
    const retries: number[] = [];
    const runner = await startRunner(database);
    runner.on('job:retrying', (retried) => retries.push(retried.attempts));
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'failed',
    );
    expect(retries).toEqual([1]);
    expect(invocations).toBe(2);
    const failed = await jobs.get({ id: job.id as string });
    expect(failed).toMatchObject({ attempts: 2, lastError: 'boom' });
    const events = await SmrtJobEventCollection.create({ db: database });
    expect(
      await events.getTerminalOutcome(job.id as string, { tenantId: null }),
    ).toMatchObject({
      status: 'failed',
      failureKind: 'execution',
      attempts: 2,
    });
  });

  it.each(TARGETS)('honours retryable: false from a %s job', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    behaviour = async () => {
      throw Object.assign(new Error('permanent'), { retryable: false });
    };
    const job = await enqueue(jobs, target, { maxAttempts: 3 });
    await startRunner(database);
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'failed',
    );
    expect(invocations).toBe(1);
    expect(await jobs.get({ id: job.id as string })).toMatchObject({
      attempts: 1,
    });
  });

  it.each(
    TARGETS,
  )('times out a %s job terminally and aborts its signal', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    let reason: unknown;
    behaviour = async (_payload, ctx) => {
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      reason = ctx.signal.reason;
      return 'late';
    };
    const job = await enqueue(jobs, target, { timeout: 50, maxAttempts: 3 });
    await startRunner(database);
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'failed',
    );
    await until(() => reason !== undefined);
    expect(reason).toBeInstanceOf(JobTimeoutError);
    const events = await SmrtJobEventCollection.create({ db: database });
    expect(
      await events.getTerminalOutcome(job.id as string, { tenantId: null }),
    ).toMatchObject({ status: 'failed', failureKind: 'timeout', attempts: 1 });
  });

  it.each(
    TARGETS,
  )('cancels a running %s job and drops its completion', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    const entered = deferred();
    let reason: unknown;
    behaviour = async (_payload, ctx) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      reason = ctx.signal.reason;
      return 'finished anyway';
    };
    const job = await enqueue(jobs, target);
    const completed: string[] = [];
    const runner = await startRunner(database, { claimFencing: true });
    runner.on('job:completed', (done) => completed.push(done.id as string));
    await entered.promise;
    await (await jobs.get({ id: job.id as string }))?.cancel();
    await until(() => reason !== undefined);
    expect(reason).toBeInstanceOf(JobCancelledError);
    await until(() => runner.activeJobCount() === 0);
    expect(await statusOf(jobs, job.id as string)).toBe('cancelled');
    expect(completed).toEqual([]);
  });

  it.each(
    TARGETS,
  )('refuses a %s job whose fenced claim was lost mid-run', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    const entered = deferred();
    const proceed = deferred();
    let lost: unknown;
    behaviour = async (_payload, ctx) => {
      const claim = getJobClaim(ctx);
      entered.resolve();
      await proceed.promise;
      try {
        await database.transaction?.((tx) => assertJobClaim(tx, claim));
      } catch (error) {
        lost = error;
      }
      return 'stale write';
    };
    const job = await enqueue(jobs, target);
    const completed: string[] = [];
    const runner = await startRunner(database, { claimFencing: true });
    runner.on('job:completed', (done) => completed.push(done.id as string));
    await entered.promise;
    // A peer took the job over: new worker, new attempt, new dispatch.
    await database.query(
      `UPDATE _smrt_jobs SET worker_id = 'peer-incarnation', attempts = attempts + 1,
         started_at = ? WHERE id = ?`,
      new Date(Date.now() + 1000).toISOString(),
      job.id,
    );
    proceed.resolve();
    await until(() => runner.activeJobCount() === 0);
    expect(lost).toBeInstanceOf(JobClaimLostError);
    expect(completed).toEqual([]);
    expect(await jobs.get({ id: job.id as string })).toMatchObject({
      status: 'running',
      workerId: 'peer-incarnation',
      attempts: 2,
    });
  });

  for (const claimFencing of [true, false]) {
    it.each(
      TARGETS,
    )(`recovers an abandoned %s job (claimFencing: ${claimFencing})`, async (target) => {
      const database = await openDb();
      const jobs = await SmrtJobCollection.create({ db: database });
      const job = await enqueue(jobs, target, { queue: 'abandoned' });
      const [claimed] = await jobs.claimReady({
        workerId: 'dead-incarnation',
        queues: ['abandoned'],
        claimFencing: true,
        limit: 1,
      });
      const claim: JobClaim = {
        jobId: claimed.id as string,
        workerId: 'dead-incarnation',
        attempt: claimed.attempts,
        startedAt: claimed.startedAt?.toISOString() as string,
        tenantId: null,
        ...targetOf(target),
        objectId: null,
      };
      await startRunner(database, { claimFencing, queues: ['abandoned'] });
      await until(
        async () => (await statusOf(jobs, job.id as string)) === 'failed',
      );
      expect(invocations).toBe(0);
      const recovered = await jobs.get({ id: job.id as string });
      expect(recovered?.workerId).toBe(
        claimFencing ? 'dead-incarnation' : null,
      );
      const events = await SmrtJobEventCollection.create({ db: database });
      expect(
        await events.getTerminalOutcome(job.id as string, {
          tenantId: null,
        }),
      ).toMatchObject({
        status: 'failed',
        failureKind: 'stale-recovery',
        ...targetOf(target),
      });
      const dispatch = database.transaction?.((tx) =>
        assertFailedJobDispatch(tx, claim),
      );
      const abandoned = database.transaction?.((tx) =>
        assertAbandonedJobClaim(tx, claim),
      );
      if (claimFencing) {
        await dispatch;
        await abandoned;
      } else {
        // Unfenced recovery clears the worker key: no exact proof remains.
        await expect(dispatch).rejects.toBeInstanceOf(JobClaimLostError);
        await expect(abandoned).rejects.toBeInstanceOf(JobClaimLostError);
      }
    });
  }

  it.each(
    TARGETS,
  )('keeps the worker lease renewed while a %s job outlives its TTL', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    const leases: number[] = [];
    behaviour = async (_payload, ctx) => {
      const { workerId } = getJobClaim(ctx);
      for (let i = 0; i < 4; i++) {
        const row = (
          await database.query(
            'SELECT lease_expires_at FROM _smrt_workers WHERE worker_id = ?',
            workerId,
          )
        ).rows[0];
        leases.push(new Date(String(row?.lease_expires_at)).getTime());
        await delay(120);
      }
      return 'done';
    };
    const job = await enqueue(jobs, target, { queue: 'lease' });
    const leaseConfig = { leaseTtlMs: 150, leaseTickMs: 50 };
    await startRunner(database, {
      claimFencing: true,
      queues: ['lease'],
      ...leaseConfig,
    });
    // A peer sweeping the same queue must not recover the live job.
    await startRunner(database, { queues: ['lease'], ...leaseConfig });
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'completed',
    );
    expect(leases).toHaveLength(4);
    expect(leases[3]).toBeGreaterThan(leases[0]);
  });

  it.each(
    TARGETS,
  )('checks MCP task authority before running a %s job', async (target) => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    // A forged row: written directly, bypassing enqueue validation.
    const job = await jobs.create({
      ...targetOf(target),
      args: { _mcpTask: { invocationArgs: [{}], authorizationRequired: true } },
      taskOwnerId: 'owner-1',
      maxAttempts: 1,
    });
    const asked: string[] = [];
    await startRunner(database, {
      authorizeMcpTask: async (authority) => {
        asked.push(authority.objectType);
        return false;
      },
    });
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'failed',
    );
    expect(asked).toEqual([targetOf(target).objectType]);
    expect(invocations).toBe(0);
    expect((await jobs.get({ id: job.id as string }))?.lastError).toBe(
      'MCP task authorization denied',
    );
  });

  it('fails a handler row carrying MCP task columns, without running it', async () => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    const job = await jobs.create({
      ...targetOf('handler'),
      taskId: randomUUID(),
      maxAttempts: 3,
    });
    await startRunner(database);
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'failed',
    );
    expect(invocations).toBe(0);
    expect(await jobs.get({ id: job.id as string })).toMatchObject({
      attempts: 1,
      lastError: `Handler job handler:${HANDLER} cannot be an MCP task`,
    });
  });

  it('fails an authorized MCP task row that names a handler, without running it', async () => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    const job = await jobs.create({
      ...targetOf('handler'),
      args: { _mcpTask: { invocationArgs: [{}], authorizationRequired: true } },
      taskOwnerId: 'owner-1',
      maxAttempts: 3,
    });
    await startRunner(database, { authorizeMcpTask: async () => true });
    await until(
      async () => (await statusOf(jobs, job.id as string)) === 'failed',
    );
    expect(invocations).toBe(0);
    expect(await jobs.get({ id: job.id as string })).toMatchObject({
      attempts: 1,
      lastError: `Handler job handler:${HANDLER} cannot be an MCP task`,
    });
  });
});

describe('schedules and handlers (#5005)', () => {
  it('moves a schedule that names a handler to error without enqueueing', async () => {
    const database = await openDb();
    const jobs = await SmrtJobCollection.create({ db: database });
    await database.query(`
      CREATE TABLE IF NOT EXISTS _smrt_agent_schedules (
        id TEXT PRIMARY KEY, agent_type TEXT, agent_id TEXT, tenant_id TEXT,
        agent_config TEXT, cron TEXT, timezone TEXT DEFAULT 'UTC', method TEXT,
        method_args TEXT, timeout INTEGER, enabled BOOLEAN DEFAULT TRUE,
        status TEXT DEFAULT 'active', next_run TEXT,
        running_count INTEGER DEFAULT 0, max_concurrent INTEGER DEFAULT 1,
        last_run TEXT, last_status TEXT, last_error TEXT,
        run_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0
      )`);
    const { objectType, method } = jobHandlerTarget(HANDLER);
    const row = {
      id: 'sched-handler',
      agent_type: objectType,
      agent_id: null,
      tenant_id: null,
      agent_config: null,
      cron: '0 0 * * *',
      method,
      method_args: null,
      timeout: null,
    };
    await database.query(
      `INSERT INTO _smrt_agent_schedules
         (id, agent_type, agent_id, tenant_id, cron, method, next_run,
          enabled, status, running_count, max_concurrent)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, TRUE, 'active', 0, 1)`,
      row.id,
      row.agent_type,
      row.cron,
      row.method,
      '2026-06-22T00:00:00.000Z',
    );
    const scheduler = createScheduleRunner();
    await scheduler.initialize(database);
    await (
      scheduler as unknown as {
        triggerSchedule(schedule: typeof row): Promise<void>;
      }
    ).triggerSchedule(row);
    const stored = (
      await database.query(
        'SELECT status, last_error FROM _smrt_agent_schedules WHERE id = ?',
        row.id,
      )
    ).rows[0];
    expect(stored).toMatchObject({ status: 'error' });
    expect(String(stored.last_error)).toContain(
      'Schedules cannot target a job handler',
    );
    expect(await jobs.list({})).toEqual([]);
  });
});
