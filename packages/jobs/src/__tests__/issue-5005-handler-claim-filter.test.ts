/**
 * Handler claim filtering and the unclaimed deadline (#5005).
 *
 * A runner claims model jobs and only the handler jobs whose handler it has
 * registered; a handler job no runner claims is failed `handler-unclaimed`
 * once it has stayed `pending` past `handlerUnclaimedDeadlineMs`. The
 * registry is process-wide, so a second "process" without the handler is
 * modelled by a runner whose start-time snapshot is emptied before any work
 * is enqueued.
 */
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JobHandlerLimitError,
  jobHandlerTarget,
  listJobHandlers,
  MAX_JOB_HANDLERS,
  registerJobHandler,
  unregisterJobHandler,
} from '../job-handlers.js';
import {
  DEFAULT_HANDLER_UNCLAIMED_DEADLINE_MS,
  HANDLER_UNCLAIMED_SWEEP_LIMIT,
  TaskRunner,
  type TaskRunnerConfig,
} from '../runner.js';
import { type SmrtJob, SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';
import {
  terminalSnapshot,
  transitionTerminalJob,
} from '../terminal-outcome.js';
import { enablePgliteJobs } from '../worker-liveness.js';

let modelCalls = 0;

@smrt({ api: false, cli: false, mcp: false })
class Issue5005FilterProbe extends SmrtObject {
  async execute(): Promise<string> {
    modelCalls++;
    return 'model';
  }
}

const HANDLER = '@happyvertical/smrt-jobs:issue-5005-filter-probe';
const OTHER_HANDLER = '@happyvertical/smrt-jobs:issue-5005-filter-other';
let handlerCalls = 0;
registerJobHandler(HANDLER, async () => {
  handlerCalls++;
  return 'handler';
});

const HOUR = 60 * 60 * 1000;
const ENGINES = ['sqlite', 'pglite'] as const;
type Engine = (typeof ENGINES)[number];
const pgliteSkipped = (engine: Engine) =>
  engine === 'pglite' && !process.env.SMRT_TEST_PGLITE_MODULE;

let db: DatabaseInterface | undefined;
const runners: TaskRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  await (db as { close?: () => Promise<void> } | undefined)?.close?.();
  db = undefined;
  modelCalls = 0;
  handlerCalls = 0;
});

async function openDb(engine: Engine): Promise<DatabaseInterface> {
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
            'Issue5005FilterProbe',
          ],
        });
  if (engine === 'pglite') enablePgliteJobs(db);
  return db;
}

function modelType(): string {
  return (
    ObjectRegistry.getClass('Issue5005FilterProbe')?.qualifiedName ??
    Issue5005FilterProbe.name
  );
}

function enqueueModel(jobs: SmrtJobCollection, extra: { queue?: string } = {}) {
  return jobs.enqueueJob({
    objectType: modelType(),
    method: 'execute',
    maxAttempts: 1,
    ...extra,
  });
}

function enqueueHandler(
  jobs: SmrtJobCollection,
  handler = HANDLER,
  extra: { queue?: string; tenantId?: string | null } = {},
) {
  return jobs.enqueueHandlerJob({
    handler,
    payload: {},
    maxAttempts: 3,
    ...extra,
  });
}

function runnerOf(config: TaskRunnerConfig = {}): TaskRunner {
  const runner = new TaskRunner({
    concurrency: 2,
    pollInterval: 10,
    cancelPollInterval: 10,
    retention: false,
    ...config,
  });
  runners.push(runner);
  return runner;
}

/** Model a runner in a process that registered no handler. */
function withoutHandlers(runner: TaskRunner): TaskRunner {
  const internal = runner as unknown as {
    jobHandlers: ReadonlyMap<string, unknown>;
    handlerNames: readonly string[];
  };
  internal.jobHandlers = new Map();
  internal.handlerNames = [];
  return runner;
}

async function sweep(runner: TaskRunner): Promise<void> {
  const internal = runner as unknown as {
    lastUnclaimedSweepAt: number;
    sweepUnclaimedHandlerJobs(): Promise<void>;
  };
  internal.lastUnclaimedSweepAt = 0;
  await internal.sweepUnclaimedHandlerJobs();
}

async function backdate(
  database: DatabaseInterface,
  id: string,
  ms: number,
): Promise<void> {
  await database.query(
    'UPDATE _smrt_jobs SET run_at = ? WHERE id = ?',
    new Date(Date.now() - ms).toISOString(),
    id,
  );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition did not settle');
    await delay(10);
  }
}

async function statusOf(jobs: SmrtJobCollection, job: SmrtJob) {
  return (await jobs.get({ id: job.id as string }))?.status;
}

async function terminalEvents(database: DatabaseInterface, jobId: string) {
  const result = await database.query(
    "SELECT data FROM _smrt_job_events WHERE job_id = ? AND type = 'error'",
    jobId,
  );
  return result.rows;
}

describe('claim filter by registered handler (#5005)', () => {
  for (const engine of ENGINES) {
    it.skipIf(pgliteSkipped(engine))(
      `claims model jobs and only the named handler jobs (${engine})`,
      async () => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        const model = await enqueueModel(jobs);
        const mine = await enqueueHandler(jobs);
        const other = await enqueueHandler(jobs, OTHER_HANDLER);
        // `_` is a LIKE wildcard; names are matched literally.
        const lookalike = await enqueueHandler(
          jobs,
          '@happyvertical/smrtxjobs:issue-5005-filter-probe',
        );
        // SQLite LIKE is case-insensitive; the filter is not: this is a
        // (missing) model type, not a handler target.
        const caseVariant = await jobs.enqueueJob({
          objectType: `HANDLER:${HANDLER}`,
          method: 'handle',
          maxAttempts: 1,
        });

        const none = await jobs.claimReady({
          workerId: 'no-handlers',
          handlerNames: [],
          limit: 10,
        });
        expect(none.map((job) => job.id).sort()).toEqual(
          [model.id, caseVariant.id].sort(),
        );

        const named = await jobs.claimReady({
          workerId: 'named',
          handlerNames: [
            '@happyvertical/smrt_jobs:issue-5005-filter-probe',
            HANDLER,
          ],
          limit: 10,
        });
        expect(named.map((job) => job.id)).toEqual([mine.id]);

        // Unfiltered (a direct caller that names no handlers) takes the rest.
        const rest = await jobs.claimReady({ workerId: 'any', limit: 10 });
        expect(rest.map((job) => job.id).sort()).toEqual(
          [other.id, lookalike.id].sort(),
        );
      },
    );

    it.skipIf(pgliteSkipped(engine))(
      `does not let unclaimable handler jobs fill the claim window (${engine})`,
      async () => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        for (let i = 0; i < 5; i++) {
          const job = await enqueueHandler(jobs, OTHER_HANDLER);
          await backdate(database, job.id as string, 1000);
        }
        const model = await enqueueModel(jobs);
        const claimed = await jobs.claimReady({
          workerId: 'model-only',
          handlerNames: [HANDLER],
          limit: 1,
        });
        expect(claimed.map((job) => job.id)).toEqual([model.id]);
      },
    );

    it.skipIf(pgliteSkipped(engine))(
      `runs handler jobs only on runners that registered them in a mixed fleet (${engine})`,
      async () => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        const capable = runnerOf({ id: 'capable' });
        const incapable = runnerOf({ id: 'incapable' });
        await capable.initialize(database);
        await incapable.initialize(database);
        await incapable.start();
        withoutHandlers(incapable);
        await capable.start();
        expect(listJobHandlers()).toContain(HANDLER);

        const started: Record<string, string[]> = {
          capable: [],
          incapable: [],
        };
        capable.on('job:started', (job) =>
          started.capable.push(job.objectType),
        );
        incapable.on('job:started', (job) =>
          started.incapable.push(job.objectType),
        );
        const unregisteredFailures: string[] = [];
        incapable.on('job:failed', (_job, error) =>
          unregisteredFailures.push(error.message),
        );

        const handlerJobs: SmrtJob[] = [];
        const modelJobs: SmrtJob[] = [];
        for (let i = 0; i < 6; i++) {
          handlerJobs.push(await enqueueHandler(jobs));
          modelJobs.push(await enqueueModel(jobs));
        }
        await until(async () => {
          for (const job of [...handlerJobs, ...modelJobs]) {
            if ((await statusOf(jobs, job)) !== 'completed') return false;
          }
          return true;
        });
        expect(handlerCalls).toBe(6);
        expect(modelCalls).toBe(6);
        const handlerType = jobHandlerTarget(HANDLER).objectType;
        expect(started.capable.filter((t) => t === handlerType)).toHaveLength(
          6,
        );
        expect(started.incapable).not.toContain(handlerType);
        expect(unregisteredFailures).toEqual([]);
      },
    );

    it.skipIf(pgliteSkipped(engine))(
      `a runner with no handlers never claims a handler job (${engine})`,
      async () => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        const runner = runnerOf();
        await runner.initialize(database);
        await runner.start();
        withoutHandlers(runner);
        const handlerJob = await enqueueHandler(jobs);
        const model = await enqueueModel(jobs);
        await until(async () => (await statusOf(jobs, model)) === 'completed');
        await delay(100);
        expect(await jobs.get({ id: handlerJob.id as string })).toMatchObject({
          status: 'pending',
          attempts: 0,
        });
        expect(handlerCalls).toBe(0);

        // A capable runner picks it up later.
        await runner.stop();
        const capable = runnerOf();
        await capable.initialize(database);
        await capable.start();
        await until(
          async () => (await statusOf(jobs, handlerJob)) === 'completed',
        );
        expect(handlerCalls).toBe(1);
      },
    );
  }

  it('caps the registry and the claim filter at MAX_JOB_HANDLERS', async () => {
    const names: string[] = [];
    try {
      for (let i = listJobHandlers().length; i < MAX_JOB_HANDLERS; i++) {
        const name = `@happyvertical/smrt-jobs:issue-5005-cap-${i}`;
        registerJobHandler(name, async () => undefined);
        names.push(name);
      }
      expect(() =>
        registerJobHandler(
          '@happyvertical/smrt-jobs:issue-5005-cap-over',
          async () => undefined,
        ),
      ).toThrow(JobHandlerLimitError);
    } finally {
      for (const name of names) unregisterJobHandler(name);
    }
    const database = await openDb('sqlite');
    const jobs = await SmrtJobCollection.create({ db: database });
    const tooMany = Array.from(
      { length: MAX_JOB_HANDLERS + 1 },
      (_, i) => `@happyvertical/smrt-jobs:issue-5005-cap-${i}`,
    );
    await expect(
      jobs.claimReady({ workerId: 'w', handlerNames: tooMany }),
    ).rejects.toThrow(RangeError);
  });
});

describe('unclaimed handler deadline (#5005)', () => {
  it('validates handlerUnclaimedDeadlineMs and defaults it to 24 h', () => {
    expect(DEFAULT_HANDLER_UNCLAIMED_DEADLINE_MS).toBe(24 * HOUR);
    expect(() => new TaskRunner({ handlerUnclaimedDeadlineMs: 0 })).toThrow(
      RangeError,
    );
    expect(
      () => new TaskRunner({ handlerUnclaimedDeadlineMs: Number.NaN }),
    ).toThrow(RangeError);
    expect(
      () =>
        new TaskRunner({
          handlerUnclaimedDeadlineMs: Number.MAX_SAFE_INTEGER,
        }),
    ).toThrow(RangeError);
  });

  for (const engine of ENGINES) {
    it.skipIf(pgliteSkipped(engine))(
      `fails only pending handler jobs past the deadline (${engine})`,
      async () => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        const runner = runnerOf({ handlerUnclaimedDeadlineMs: HOUR });
        await runner.initialize(database);
        const failed: SmrtJob[] = [];
        runner.on('job:failed', (job) => failed.push(job));

        // Claimed (running) before it went overdue: never swept.
        const claimedJob = await enqueueHandler(jobs, OTHER_HANDLER);
        await jobs.claimReady({ workerId: 'holder', limit: 1 });
        await backdate(database, claimedJob.id as string, 2 * HOUR);
        const fresh = await enqueueHandler(jobs);
        await backdate(database, fresh.id as string, HOUR - 60_000);
        const overdue = await enqueueHandler(jobs);
        await backdate(database, overdue.id as string, 2 * HOUR);
        const overdueModel = await enqueueModel(jobs);
        await backdate(database, overdueModel.id as string, 2 * HOUR);
        const otherQueue = await enqueueHandler(jobs, HANDLER, {
          queue: 'elsewhere',
        });
        await backdate(database, otherQueue.id as string, 2 * HOUR);

        await sweep(runner);

        expect(await statusOf(jobs, fresh)).toBe('pending');
        expect(await statusOf(jobs, overdueModel)).toBe('pending');
        expect(await statusOf(jobs, claimedJob)).toBe('running');
        // Outside this runner's queues: another runner's to sweep.
        expect(await statusOf(jobs, otherQueue)).toBe('pending');
        const swept = await jobs.get({ id: overdue.id as string });
        expect(swept).toMatchObject({ status: 'failed', attempts: 0 });
        expect(swept?.lastError).toContain('Job handler not claimed');
        expect(failed.map((job) => job.id)).toEqual([overdue.id]);

        const events = await SmrtJobEventCollection.create({ db: database });
        expect(
          await events.getTerminalOutcome(overdue.id as string, {
            tenantId: null,
            attempts: 0,
            completedAt: swept?.completedAt?.toISOString(),
          }),
        ).toMatchObject({
          jobId: overdue.id,
          status: 'failed',
          failureKind: 'handler-unclaimed',
          ...jobHandlerTarget(HANDLER),
          attempts: 0,
        });

        // Idempotent: a second sweep writes nothing more.
        await sweep(runner);
        expect(
          await terminalEvents(database, overdue.id as string),
        ).toHaveLength(1);
        expect(failed).toHaveLength(1);
      },
    );

    it.skipIf(pgliteSkipped(engine))(
      `concurrent sweepers fail each job once (${engine})`,
      async () => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        const sweepers = [
          runnerOf({ handlerUnclaimedDeadlineMs: HOUR }),
          runnerOf({ handlerUnclaimedDeadlineMs: HOUR }),
        ];
        let failures = 0;
        for (const sweeper of sweepers) {
          await sweeper.initialize(database);
          sweeper.on('job:failed', () => failures++);
        }
        const overdue: SmrtJob[] = [];
        for (let i = 0; i < 4; i++) {
          const job = await enqueueHandler(jobs);
          await backdate(database, job.id as string, 2 * HOUR);
          overdue.push(job);
        }
        await Promise.all(sweepers.map(sweep));
        expect(failures).toBe(4);
        for (const job of overdue) {
          expect(await statusOf(jobs, job)).toBe('failed');
          expect(await terminalEvents(database, job.id as string)).toHaveLength(
            1,
          );
        }
      },
    );

    it.skipIf(pgliteSkipped(engine))(
      `a started runner sweeps on its poll (${engine})`,
      async () => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        const overdue = await enqueueHandler(jobs, OTHER_HANDLER);
        await backdate(database, overdue.id as string, 2 * HOUR);
        const runner = runnerOf({ handlerUnclaimedDeadlineMs: HOUR });
        await runner.initialize(database);
        await runner.start();
        await until(async () => (await statusOf(jobs, overdue)) === 'failed');
        expect((await jobs.get({ id: overdue.id as string }))?.attempts).toBe(
          0,
        );
      },
    );
  }

  it('keeps sweeping on the next poll after a full batch', async () => {
    const database = await openDb('sqlite');
    const jobs = await SmrtJobCollection.create({ db: database });
    const runner = runnerOf({ handlerUnclaimedDeadlineMs: HOUR });
    await runner.initialize(database);
    let failures = 0;
    runner.on('job:failed', () => failures++);
    for (let i = 0; i <= HANDLER_UNCLAIMED_SWEEP_LIMIT; i++) {
      const job = await enqueueHandler(jobs);
      await backdate(database, job.id as string, 2 * HOUR);
    }
    await sweep(runner);
    expect(failures).toBe(HANDLER_UNCLAIMED_SWEEP_LIMIT);
    // Not throttled: the throttle stays open after a full batch.
    await (
      runner as unknown as { sweepUnclaimedHandlerJobs(): Promise<void> }
    ).sweepUnclaimedHandlerJobs();
    expect(failures).toBe(HANDLER_UNCLAIMED_SWEEP_LIMIT + 1);
  });

  for (const engine of ENGINES) {
    it.skipIf(pgliteSkipped(engine))(
      `a manual retry restarts a swept job's deadline (${engine})`,
      async () => {
        const database = await openDb(engine);
        const jobs = await SmrtJobCollection.create({ db: database });
        const runner = runnerOf({ handlerUnclaimedDeadlineMs: HOUR });
        await runner.initialize(database);
        const model = await enqueueModel(jobs);
        await backdate(database, model.id as string, 2 * HOUR);
        const modelRunAt = (await jobs.get({ id: model.id as string }))?.runAt;
        const job = await enqueueHandler(jobs);
        await backdate(database, job.id as string, 2 * HOUR);
        await sweep(runner);
        const swept = await jobs.get({ id: job.id as string });
        expect(swept?.status).toBe('failed');
        await swept?.retry();
        await sweep(runner);
        expect(await statusOf(jobs, job)).toBe('pending');
        // A model job's run_at is left as it was.
        await (await jobs.get({ id: model.id as string }))?.retry();
        expect(
          (await jobs.get({ id: model.id as string }))?.runAt?.toISOString(),
        ).toBe(modelRunAt?.toISOString());
      },
    );
  }

  it('does not fail a job requeued past the deadline since it was read', async () => {
    const database = await openDb('sqlite');
    const jobs = await SmrtJobCollection.create({ db: database });
    const job = await enqueueHandler(jobs);
    const snapshot = terminalSnapshot(job);
    if (!snapshot) throw new Error('missing snapshot');
    const cutoff = new Date(Date.now() - HOUR).toISOString();
    expect(
      await transitionTerminalJob(database, {
        job: snapshot,
        status: 'failed',
        completedAt: new Date(),
        expectedStatuses: ['pending'],
        expectedRunAtAtOrBefore: cutoff,
        failureKind: 'handler-unclaimed',
      }),
    ).toBeNull();
    expect(await statusOf(jobs, job)).toBe('pending');
  });
});
