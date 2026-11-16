import { createHash } from 'node:crypto';
import {
  type AiRunBudget,
  cancelAiRun,
  createTrackedAiClient,
  finishAiRun,
  getAiRun,
  stopAiRun,
} from '@happyvertical/smrt-core';
import {
  assertFailedJobDispatch,
  assertJobClaim,
  getJobClaim,
  isRunnerExecutionContext,
  type JobClaim,
  JobClaimLostError,
  type JobExecutionContext,
  JobHandle,
  jobHandlerTarget,
  listJobHandlers,
  registerJobHandler,
  SmrtJobCollection,
  SmrtJobEventCollection,
  unregisterJobHandler,
} from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  createRunCheckpointStore,
  RunConflictError,
  WorkflowRunNotFoundError,
} from './checkpoint-store.js';
import { workflowClaimFence } from './claim-fence.js';
import {
  createWorkflowRunDriver,
  type WorkflowRunDriverOptions,
} from './driver.js';
import {
  WORKFLOW_RUN_TYPE,
  type WorkflowDefinition,
  type WorkflowRunState,
} from './types.js';

/** The named job handler every workflow run's job targets. */
export const WORKFLOW_RUN_HANDLER =
  '@happyvertical/smrt-workflows:workflow-run';

/** The payload of a workflow run job: the run id and the definition's key. */
export interface WorkflowRunJobPayload {
  runId: string;
  definition: string;
}

/** The authenticated owner and tenant of a run; never taken from a payload. */
export interface WorkflowRunOwner {
  ownerId: string;
  tenantId: string | null;
}

/** A start key was already used with a different request. */
export class WorkflowRunKeyConflictError extends Error {
  constructor(readonly runId: string) {
    super('This workflow key was already used with a different request');
    this.name = 'WorkflowRunKeyConflictError';
  }
}

/** A workflow run job could not be dispatched. Never retried. */
export class WorkflowRunJobError extends Error {
  /** Read by the job runner's retry hints: never retried. */
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunJobError';
  }
}

/** Host wiring of the job bridge for one workflow definition. */
export interface WorkflowRunJobsOptions<Input> {
  db: DatabaseInterface;
  /** The job collection to enqueue on (default: one over `db`). */
  jobs?: SmrtJobCollection;
  definition: WorkflowDefinition;
  /** The queue the run's jobs go to (default `default`). */
  queue?: string;
  /** The host's permission check; runs on every operation and every job. */
  authorize?(owner: WorkflowRunOwner): Promise<void>;
  /**
   * Cap or refuse the effective budget on an ordinary resume; runs before any
   * write. Return the budget to resume with, or throw.
   */
  resumeBudget?(
    owner: WorkflowRunOwner,
    state: Readonly<WorkflowRunState>,
    proposed: Readonly<AiRunBudget>,
  ): Promise<AiRunBudget>;
  /**
   * Rebuild the driver's wiring (tracked client, validator, callbacks) for a
   * run's owner and input. Called again after a restart: never keep process
   * state a job needs in a closure. The `ai` client must be the owner's
   * tenant on `db`.
   */
  configure(
    owner: WorkflowRunOwner,
    input: Input,
  ): Omit<WorkflowRunDriverOptions, 'definition'>;
}

/** Input of `start`. A key makes the start idempotent. */
export interface StartWorkflowRunJob<Input> {
  /** Scopes idempotency to this definition, owner and tenant. */
  key: string;
  input?: Input;
  inputRef?: string | null;
  budget?: AiRunBudget;
  tags?: Record<string, unknown>;
}

interface JobsHost {
  execute(
    payload: WorkflowRunJobPayload,
    context: JobExecutionContext,
  ): Promise<{ runId: string; status: string }>;
}

/** Definition key -> the host that serves it. Process-local, filled at creation. */
const hosts = new Map<string, JobsHost>();

function readPayload(payload: unknown): WorkflowRunJobPayload {
  const value = payload as Partial<WorkflowRunJobPayload> | null;
  if (
    !value ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    typeof value.definition !== 'string' ||
    !value.definition
  ) {
    throw new WorkflowRunJobError('A workflow run job needs a run id');
  }
  return { runId: value.runId, definition: value.definition };
}

async function workflowRunHandler(
  payload: Record<string, unknown>,
  context: JobExecutionContext,
) {
  if (!isRunnerExecutionContext(context)) {
    throw new WorkflowRunJobError('Workflow runs need TaskRunner context');
  }
  const job = readPayload(payload);
  const host = hosts.get(job.definition);
  if (!host) {
    // Create a host for every definition a runner consumes (see mixed fleets).
    throw new WorkflowRunJobError(
      'No workflow definition is registered for this job',
    );
  }
  return host.execute(job, context);
}

/**
 * Register the named job handler for workflow runs in this process. Call it
 * (or create a `createWorkflowRunJobs` host, which calls it) at startup,
 * before any `TaskRunner.start()`: registering while a runner runs throws
 * `JobHandlerRegistrationClosedError`. Calling it again is harmless before a
 * runner starts and throws after, so a late host fails loudly.
 */
export function registerWorkflowRunHandler(): void {
  // Unregistering throws while a runner runs, before changing anything.
  if (listJobHandlers().includes(WORKFLOW_RUN_HANDLER)) {
    unregisterJobHandler(WORKFLOW_RUN_HANDLER);
  }
  registerJobHandler(WORKFLOW_RUN_HANDLER, workflowRunHandler);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

const ACTIVE = ['pending', 'running'];

/**
 * Run durable workflow runs from background jobs (#5005). It registers the
 * `@happyvertical/smrt-workflows:workflow-run` handler (see
 * {@link registerWorkflowRunHandler}), admits one handler job per run with
 * `enqueueHandlerJob`, and works the run inside it with claim fencing and a
 * lease renewed while it works. Create every host at startup, before any
 * runner starts: creation throws once one is running. It creates no schema.
 *
 * Steps, checks and prompts must be safe to repeat: a run recovered after a
 * crash repeats the step that was in flight.
 */
export function createWorkflowRunJobs<Input = unknown>(
  options: WorkflowRunJobsOptions<Input>,
) {
  const { db, definition } = options;
  const key = definition.key;
  if (hosts.has(key)) {
    throw new Error(`Workflow jobs already exist for definition ${key}`);
  }
  const target = jobHandlerTarget(WORKFLOW_RUN_HANDLER).objectType;
  const queue = options.queue ?? 'default';
  const jobsReady = options.jobs
    ? Promise.resolve(options.jobs)
    : SmrtJobCollection.create({ db });
  const controllers = new Map<string, AbortController>();

  const transaction = async <T>(
    operation: (tx: DatabaseInterface) => Promise<T>,
  ) => {
    if (!db.transaction) throw new Error('Workflow jobs require transactions');
    return db.transaction(operation);
  };

  const sameOwner = (
    owner: WorkflowRunOwner,
    driver: Omit<WorkflowRunDriverOptions, 'definition'>,
  ) => {
    if (driver.ai.db !== db || (driver.ai.tenantId ?? null) !== owner.tenantId)
      throw new Error('configure must return the owner’s tenant client on db');
  };
  const driverFor = (owner: WorkflowRunOwner, input: Input) => {
    const configured = options.configure(owner, input);
    sameOwner(owner, configured);
    return createWorkflowRunDriver({ ...configured, definition });
  };
  /** A driver for reads and stops: needs no host configuration. */
  const lightDriver = (owner: WorkflowRunOwner) =>
    createWorkflowRunDriver({
      ai: createTrackedAiClient({ db, tenantId: owner.tenantId }),
      definition,
      validate: () => [],
    });

  const jobsOf = async (
    owner: WorkflowRunOwner,
    runId: string,
    tx?: DatabaseInterface,
    status?: string[],
  ) => {
    const collection = tx
      ? await SmrtJobCollection.create({ db: tx })
      : await jobsReady;
    return collection.list({
      where: {
        objectType: target,
        dedupeKey: runId,
        tenantId: owner.tenantId,
        ...(status ? { status } : {}),
      },
      orderBy: 'updated_at DESC',
    });
  };

  const enqueue = async (
    owner: WorkflowRunOwner,
    runId: string,
    budget: AiRunBudget,
    tx?: DatabaseInterface,
  ) => {
    const payload: WorkflowRunJobPayload = { runId, definition: key };
    await (await jobsReady).enqueueHandlerJob(
      {
        handler: WORKFLOW_RUN_HANDLER,
        payload: payload as unknown as Record<string, unknown>,
        tenantId: owner.tenantId,
        dedupeKey: runId,
        queue,
        maxAttempts: 1,
        ...(budget.maxDurationMs !== undefined
          ? { timeout: budget.maxDurationMs, timeoutBehavior: 'warn' as const }
          : {}),
      },
      tx ? { transaction: tx } : {},
    );
  };

  const outcomeOf = async (
    owner: WorkflowRunOwner,
    job: Awaited<ReturnType<typeof jobsOf>>[number],
  ) => {
    if (!job.completedAt) return null;
    const events = await SmrtJobEventCollection.create({ db });
    return events.getTerminalOutcome(String(job.id), {
      tenantId: owner.tenantId,
      attempts: job.attempts,
      completedAt: job.completedAt.toISOString(),
    });
  };

  const dispatchOf = (job: Awaited<ReturnType<typeof jobsOf>>[number]) => ({
    jobId: String(job.id),
    workerId: job.workerId ?? '',
    tenantId: job.tenantId ?? null,
    attempt: job.attempts,
    startedAt: job.startedAt?.toISOString() ?? '',
    objectType: job.objectType,
    objectId: job.objectId ?? null,
    method: job.method,
  });

  /** Stop a run that cannot run on this worker, only while the claim is live. */
  const park = async (runId: string, claim: Readonly<JobClaim>) => {
    try {
      await transaction((tx) => assertJobClaim(tx, claim));
      await stopAiRun(db, runId, { reason: 'interrupted' });
    } catch {
      /* The original failure is the one to surface. */
    }
  };

  /**
   * A run whose job ended for good while it is still `running` is closed to
   * match (page section 6.7): a failed job fails the run, a cancelled job
   * cancels it. A crashed worker (stale recovery) leaves it recoverable, and
   * a job no worker with the handler took (`handler-unregistered`,
   * `handler-unclaimed`) leaves it stopped and resumable.
   */
  const reconcile = async (owner: WorkflowRunOwner, runId: string) => {
    const run = await getAiRun(db, runId);
    if (run?.status !== 'running') return;
    if ((await jobsOf(owner, runId, undefined, ACTIVE)).length) return;
    const [job] = await jobsOf(owner, runId);
    if (!job) return;
    if (job.status === 'cancelled') {
      await cancelAiRun(db, runId);
      return;
    }
    if (job.status !== 'failed') return;
    const outcome = await outcomeOf(owner, job);
    if (!outcome || outcome.failureKind === 'stale-recovery') return;
    if ((await jobsOf(owner, runId, undefined, ACTIVE)).length) return;
    // The job never ran here: no worker had the handler (#5005).
    if (
      outcome.failureKind === 'handler-unregistered' ||
      outcome.failureKind === 'handler-unclaimed'
    ) {
      await stopAiRun(db, runId, { reason: 'interrupted' }).catch(() => null);
      return;
    }
    await finishAiRun(db, runId, { status: 'failed', stopReason: 'error' });
  };

  const execute: JobsHost['execute'] = async (payload, context) => {
    const claim = getJobClaim(context);
    const runId = payload.runId;
    const run = await getAiRun(db, runId);
    if (
      !run ||
      run.type !== WORKFLOW_RUN_TYPE ||
      run.definitionKey !== key ||
      !run.ownerId
    ) {
      throw new WorkflowRunJobError('Workflow run not found');
    }
    const owner: WorkflowRunOwner = {
      ownerId: run.ownerId,
      tenantId: run.tenantId ?? null,
    };
    if (
      claim.objectType !== target ||
      claim.method !== 'handle' ||
      claim.objectId !== null ||
      claim.tenantId !== owner.tenantId
    ) {
      throw new WorkflowRunJobError('Workflow job target changed');
    }
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    controllers.set(runId, controller);
    let began = false;
    try {
      await options.authorize?.(owner);
      await transaction((tx) => assertJobClaim(tx, claim));
      const loaded = await createRunCheckpointStore({
        db,
        ownerId: owner.ownerId,
        tenantId: owner.tenantId,
      }).load(runId);
      if (!loaded) throw new WorkflowRunNotFoundError(runId);
      const driver = driverFor(owner, loaded.state.input as Input);
      began = true;
      const state = await driver.run(runId, owner.ownerId, {
        signal: controller.signal,
        fence: workflowClaimFence(claim),
        holder: `${claim.workerId}:${claim.jobId}`,
      });
      return { runId, status: state.status };
    } catch (error) {
      if (!began && !(error instanceof JobClaimLostError)) {
        await park(runId, claim);
      }
      throw error;
    } finally {
      if (controllers.get(runId) === controller) controllers.delete(runId);
      context.signal.removeEventListener('abort', abort);
    }
  };

  // Register last: nothing above has a side effect, so a late creation (a
  // runner already running) throws here and leaves no host behind.
  registerWorkflowRunHandler();
  hosts.set(key, { execute });

  return {
    /** The registered handler's name. */
    handler: WORKFLOW_RUN_HANDLER,
    /**
     * Forget this definition. When it was the last, unregister the handler:
     * stop every runner first, or this throws and the handler stays.
     */
    dispose() {
      hosts.delete(key);
      if (!hosts.size && listJobHandlers().includes(WORKFLOW_RUN_HANDLER)) {
        unregisterJobHandler(WORKFLOW_RUN_HANDLER);
      }
    },
    /** Operations of one authenticated owner and tenant. */
    forOwner(ownerId: string, tenantId: string | null) {
      if (!ownerId) throw new Error('Workflow runs require an owner');
      const owner: WorkflowRunOwner = { ownerId, tenantId };
      const light = lightDriver(owner);
      const authorized = async (id: string) => {
        await options.authorize?.(owner);
        await light.get(id, ownerId);
        await reconcile(owner, id);
        return light.get(id, ownerId);
      };
      const cancelActive = async (id: string) => {
        controllers.get(id)?.abort(new Error('Workflow run stopped'));
        for (const job of await jobsOf(owner, id, undefined, ACTIVE)) {
          try {
            await job.cancel();
          } catch (error) {
            const current = await (await jobsReady).get({ id: String(job.id) });
            if (!current || ACTIVE.includes(current.status)) throw error;
          }
        }
      };
      /** Wait for a job that is still parking the run before admitting more. */
      const settleActive = async (id: string) => {
        for (const job of await jobsOf(owner, id, undefined, ACTIVE)) {
          if (job.status === 'running') {
            await new JobHandle(String(job.id), await jobsReady).wait({
              timeout: 30_000,
              pollInterval: 25,
            });
          }
        }
      };
      /** Enqueue a job for a `running` run that has none live. */
      const admit = async (id: string, budget: AiRunBudget) => {
        await transaction(async (tx) => {
          const [latest] = await jobsOf(owner, id, tx);
          if (latest?.status === 'failed') {
            await assertFailedJobDispatch(tx, dispatchOf(latest));
          }
          if ((await jobsOf(owner, id, tx, ACTIVE)).length) {
            throw new RunConflictError('The recovered job changed');
          }
          await enqueue(owner, id, budget, tx);
        });
      };
      /** Crash recovery: only an authoritative stale recovery is replaced. */
      const recover = async (state: WorkflowRunState) => {
        const [latest] = await jobsOf(owner, state.id);
        if (latest) {
          const outcome =
            latest.status === 'failed' ? await outcomeOf(owner, latest) : null;
          if (outcome?.failureKind !== 'stale-recovery') {
            throw new RunConflictError(
              'The previous job has not ended in a recoverable way',
            );
          }
        }
        await admit(state.id, state.budget);
        return light.get(state.id, ownerId);
      };
      const resume = async (id: string, budget?: AiRunBudget) => {
        const state = await authorized(id);
        if ((await jobsOf(owner, id, undefined, ACTIVE)).length) {
          throw new RunConflictError('The previous job is still settling');
        }
        if (state.status === 'waiting-approval') {
          throw new RunConflictError(
            'This workflow run is waiting for approval: decide it first',
          );
        }
        if (state.status === 'running') {
          if (budget) {
            throw new RunConflictError(
              'Recover the job first; raise its budget after a budget stop',
            );
          }
          return recover(state);
        }
        const approved = options.resumeBudget
          ? await options.resumeBudget(
              owner,
              state,
              Object.freeze({ ...state.budget, ...budget }),
            )
          : budget;
        const resumed = await driverFor(owner, state.input as Input).resume(
          id,
          ownerId,
          approved ? { budget: approved } : {},
        );
        try {
          await enqueue(owner, id, resumed.budget);
        } catch (error) {
          await stopAiRun(db, id, { reason: 'interrupted' }).catch(() => null);
          throw error;
        }
        return resumed;
      };
      const continueAfterApproval = async (id: string) => {
        await options.authorize?.(owner);
        await settleActive(id);
        const state = await authorized(id);
        if (state.status !== 'running') return state;
        const [latest] = await jobsOf(owner, id);
        if (latest?.status !== 'completed') return state;
        try {
          await admit(id, state.budget);
        } catch (error) {
          if (!(error instanceof RunConflictError)) throw error;
        }
        return light.get(id, ownerId);
      };
      return {
        /**
         * Open the run and admit its job. The same key and request returns the
         * same run (and admits a job again if a crash lost it); the same key
         * with another request throws `WorkflowRunKeyConflictError`.
         */
        async start(input: StartWorkflowRunJob<Input>) {
          await options.authorize?.(owner);
          if (!input.key.trim() || input.key.length > 512) {
            throw new Error(
              'Workflow key must be nonblank and at most 512 characters',
            );
          }
          const hash = createHash('sha256')
            .update(JSON.stringify([key, ownerId, tenantId, input.key]))
            .digest('hex');
          const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          const digest = createHash('sha256')
            .update(
              JSON.stringify(
                canonical(
                  JSON.parse(
                    JSON.stringify({
                      input: input.input ?? null,
                      inputRef: input.inputRef ?? null,
                      budget: input.budget ?? null,
                      tags: input.tags ?? null,
                    }),
                  ),
                ),
              ),
            )
            .digest('hex');
          const store = createRunCheckpointStore({
            db,
            ownerId,
            tenantId,
          });
          const replay = async () => {
            const loaded = await store.load(id);
            if (!loaded) return null;
            if (loaded.run.definitionKey !== key) {
              throw new Error('Workflow run definition changed');
            }
            if (loaded.run.tags.workflowAdmission !== digest) {
              throw new WorkflowRunKeyConflictError(id);
            }
            if (
              loaded.run.status === 'running' &&
              !(await jobsOf(owner, id)).length
            ) {
              await enqueue(owner, id, loaded.run.budget);
            }
            return light.get(id, ownerId);
          };
          const existing = await replay();
          if (existing) return existing;
          let started: WorkflowRunState;
          try {
            started = await driverFor(owner, input.input as Input).start({
              id,
              ownerId,
              ...(input.inputRef
                ? { inputRef: input.inputRef }
                : { input: input.input }),
              ...(input.budget ? { budget: input.budget } : {}),
              tags: { ...input.tags, workflowAdmission: digest },
            });
          } catch (error) {
            const raced = await replay();
            if (raced) return raced;
            throw error;
          }
          await enqueue(owner, id, started.budget);
          return started;
        },
        get: authorized,
        /** Pause the run (resumable) and cancel its job. */
        async stop(id: string) {
          await authorized(id);
          const state = await light.stop(id, ownerId);
          await cancelActive(id);
          return state;
        },
        /** End the run for good and cancel its job. */
        async cancel(id: string) {
          await authorized(id);
          const state = await light.cancel(id, ownerId);
          await cancelActive(id);
          return state;
        },
        resume,
        /**
         * Record a person's decision on the approval the run waits for. An
         * approval admits a new job that re-runs the step's check.
         */
        async decide(
          id: string,
          decision: { approved: boolean; note?: string },
        ) {
          await options.authorize?.(owner);
          await settleActive(id);
          await authorized(id);
          const decided = await light.decide(id, ownerId, decision);
          if (decision.approved) return continueAfterApproval(id);
          return decided;
        },
        /** After a decision was recorded elsewhere: admit the job that continues. */
        continueAfterApproval,
        /** Retry a failed run from its last accepted step as a new run with a job. */
        async retry(
          id: string,
          retryOptions: { id?: string; budget?: AiRunBudget } = {},
        ) {
          const state = await authorized(id);
          const retried = await driverFor(owner, state.input as Input).retry(
            id,
            ownerId,
            retryOptions,
          );
          await enqueue(owner, retried.id, retried.budget);
          return retried;
        },
      };
    },
  };
}

/** The jobs of workflow runs. */
export type WorkflowRunJobs<Input = unknown> = ReturnType<
  typeof createWorkflowRunJobs<Input>
>;
