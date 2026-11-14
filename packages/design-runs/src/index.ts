import { createHash } from 'node:crypto';
import {
  createDesignRunDriver,
  createDesignRunStore,
  type DesignRunBudget,
  DesignRunConflictError,
  type DesignRunDriverOptions,
  type DesignRunRecord,
  type DesignRunState,
  installDesignRunExecutor,
} from '@happyvertical/smrt-inference/server';
import {
  assertJobClaim,
  assertJobClaimForRelease,
  getJobClaim,
  isRunnerExecutionContext,
  type JobClaim,
  JobClaimLostError,
  SmrtJobCollection,
  SmrtJobEventCollection,
} from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Informational only; never used for job kinds, row identity or table names. */
export const PACKAGE_NAME = '@happyvertical/smrt-design-runs';
const target = '@happyvertical/smrt-inference:DesignRunRecord';

/** Authenticated host binding, never populated from untrusted job arguments. */
export interface DesignRunOwner {
  ownerId: string;
  tenantId: string | null;
}

/** Driver inputs and outputs retain host types; schema validation remains mandatory. */
export type DesignRunSnapshot<Input, Output> = Omit<
  DesignRunState,
  'input' | 'outputs'
> & {
  input: Input;
  outputs: Output[];
};

/** Host-owned configuration and permission checks for the durable job bridge. */
export interface DesignRunJobsOptions<Input> {
  db: DatabaseInterface;
  jobs?: SmrtJobCollection;
  /** Host-selected durable routing key, independent of this package's name. */
  kind: string;
  definition: string;
  queue?: string;
  authorize(owner: DesignRunOwner): Promise<void>;
  /** Reconstructed after restart from durable input, never process-local closures. */
  configure(
    owner: DesignRunOwner,
    input: Input,
  ): Omit<DesignRunDriverOptions, 'store' | 'definition' | 'ownsExecution'>;
}

/** Idempotency keys are scoped to host kind, owner and tenant. */
export interface StartDesignRun<Input> {
  key: string;
  input: Input;
  resourceIds?: string[];
  budget: DesignRunBudget;
}

/**
 * Compose inference checkpoints with existing jobs; creates no schema or runner.
 * Register handler via installDesignRunExecutor, or call install once per DB.
 */
export function createDesignRunJobs<Input = unknown, Output = unknown>(
  options: DesignRunJobsOptions<Input>,
) {
  if (!options.kind.trim() || !options.definition.trim())
    throw new Error('Design jobs require a host kind and definition');
  const jobs = options.jobs
    ? Promise.resolve(options.jobs)
    : SmrtJobCollection.create({ db: options.db });
  const controllers = new Map<string, AbortController>();
  const snapshot = (state: DesignRunState) =>
    state as DesignRunSnapshot<Input, Output>;
  const transaction = async <T>(
    operation: (tx: DatabaseInterface) => Promise<T>,
  ) => {
    if (!options.db.transaction)
      throw new Error('Design jobs require transactions');
    return options.db.transaction(operation);
  };
  const enqueue = async (
    tx: DatabaseInterface,
    state: Readonly<DesignRunState>,
    owner: DesignRunOwner,
  ) => {
    await (await jobs).enqueueJob(
      {
        objectType: target,
        objectId: state.id,
        method: 'execute',
        args: { kind: options.kind },
        tenantId: owner.tenantId,
        dedupeKey: state.id,
        queue: options.queue ?? 'default',
        maxAttempts: 1,
        timeout: state.budget.maxDurationMs,
        timeoutBehavior: 'warn',
      },
      { transaction: tx },
    );
  };
  const proof = async (
    tx: DatabaseInterface,
    claim: Readonly<JobClaim>,
    release = false,
  ) => {
    try {
      await (release ? assertJobClaimForRelease : assertJobClaim)(tx, claim);
      return true;
    } catch (error) {
      if (error instanceof JobClaimLostError) return false;
      throw error;
    }
  };
  const store = (owner: DesignRunOwner, claim?: Readonly<JobClaim>) =>
    createDesignRunStore({
      db: options.db,
      ...owner,
      enqueue: (tx, state) => enqueue(tx, state, owner),
      ...(claim
        ? {
            authorizeWrite: (tx: DatabaseInterface) => proof(tx, claim),
            authorizeRelease: (tx: DatabaseInterface) => proof(tx, claim, true),
          }
        : {}),
    });
  const load = async (owner: DesignRunOwner, id: string) => {
    const state = await store(owner).load(id, owner.ownerId);
    if (!state || state.definition !== options.definition)
      throw new Error('Design run not found');
    return state;
  };
  const driver = (
    owner: DesignRunOwner,
    input: Input,
    claim?: Readonly<JobClaim>,
  ) =>
    createDesignRunDriver({
      ...options.configure(owner, input),
      definition: options.definition,
      store: store(owner, claim),
      ...(claim
        ? { ownsExecution: () => transaction((tx) => proof(tx, claim)) }
        : {}),
    });
  const activeJobs = async (
    owner: DesignRunOwner,
    id: string,
    db = options.db,
  ) => {
    const collection = await SmrtJobCollection.create({ db });
    return collection.list({
      where: {
        objectType: target,
        objectId: id,
        tenantId: owner.tenantId,
        status: ['pending', 'running'],
      },
    });
  };

  /** Runner handler; hosts with several kinds route their one DB executor here. */
  async function handler(
    record: DesignRunRecord,
    args: unknown,
    context: unknown,
  ) {
    if (!isRunnerExecutionContext(context))
      throw new Error('Design execution requires TaskRunner context');
    const claim = getJobClaim(context);
    const owner = { ownerId: record.ownerId, tenantId: record.tenantId };
    if (
      !args ||
      typeof args !== 'object' ||
      (args as { kind?: unknown }).kind !== options.kind ||
      claim.objectType !== target ||
      claim.method !== 'execute' ||
      claim.objectId !== record.id ||
      claim.tenantId !== owner.tenantId
    )
      throw new Error('Design job target changed');
    await options.authorize(owner);
    await transaction((tx) => assertJobClaim(tx, claim));
    const state = await load(owner, String(record.id));
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    controllers.set(state.id, controller);
    try {
      return await driver(owner, state.input as Input, claim).run(
        state.id,
        owner.ownerId,
        controller.signal,
      );
    } finally {
      if (controllers.get(state.id) === controller)
        controllers.delete(state.id);
      context.signal.removeEventListener('abort', abort);
    }
  }

  return {
    handler,
    /** Install before starting TaskRunner; dispose after stopping it. */
    install: () => installDesignRunExecutor(options.db, handler),
    forOwner(ownerId: string, tenantId: string | null) {
      if (!ownerId) throw new Error('Design runs require an owner');
      const owner = { ownerId, tenantId };
      const authorized = async (id: string) => {
        await options.authorize(owner);
        return load(owner, id);
      };
      const pause = async (id: string, cancel: boolean) => {
        const state = await authorized(id);
        const workflow = driver(owner, state.input as Input);
        const result = await (cancel ? workflow.cancel : workflow.stop)(
          id,
          ownerId,
        );
        if (!['done', 'failed'].includes(result.status)) {
          controllers.get(id)?.abort(new Error('Design run stopped'));
          for (const job of await activeJobs(owner, id)) {
            try {
              await job.cancel();
            } catch (error) {
              // A concurrent terminal write is already settled. Other errors matter.
              const current = await (await jobs).get({ id: String(job.id) });
              if (!current || ['pending', 'running'].includes(current.status))
                throw error;
            }
          }
        }
        return snapshot(result);
      };
      const resume = async (id: string, budget?: Partial<DesignRunBudget>) => {
        const state = await authorized(id);
        if ((await activeJobs(owner, id)).length)
          throw new DesignRunConflictError(
            'The previous job is still settling',
          );
        if (['running', 'checking'].includes(state.status)) {
          if (budget)
            throw new DesignRunConflictError(
              'Recover the job first; raise its budget after a budget stop',
            );
          // TaskRunner recovery fails the orphan. Only that authoritative outcome
          // permits replacing its retained inference lease; never clear it here.
          const events = await SmrtJobEventCollection.create({
            db: options.db,
          });
          const prior = await (await jobs).list({
            where: {
              objectType: target,
              objectId: id,
              tenantId,
              status: 'failed',
            },
            orderBy: 'updated_at DESC',
            limit: 1,
          });
          const job = prior[0];
          const outcomes = await events.listTerminalOutcomes({
            tenantId,
            objectTypes: [target],
            limit: 1000,
          });
          if (
            !job ||
            !outcomes.outcomes.some(
              (event) =>
                event.jobId === job.id &&
                event.attempts === job.attempts &&
                event.failureKind === 'stale-recovery',
            )
          )
            throw new DesignRunConflictError(
              'TaskRunner has not recovered the previous job',
            );
          return transaction(async (tx) => {
            const recoveryStore = createDesignRunStore({
              db: tx,
              ...owner,
              enqueue: async () => {},
            });
            const next = {
              ...state,
              revision: state.revision + 1,
              status: 'running' as const,
            };
            if (!(await recoveryStore.save(next, state.revision)))
              throw new DesignRunConflictError();
            const current = await (
              await SmrtJobCollection.create({ db: tx })
            ).get({ id: String(job.id) });
            if (
              current?.status !== 'failed' ||
              current.attempts !== job.attempts ||
              (await activeJobs(owner, id, tx)).length
            )
              throw new DesignRunConflictError('The recovered job changed');
            await enqueue(tx, next, owner);
            return snapshot(next);
          });
        }
        return snapshot(
          await driver(owner, state.input as Input).resume(id, ownerId, budget),
        );
      };
      return {
        async start(input: StartDesignRun<Input>) {
          await options.authorize(owner);
          if (!input.key.trim() || input.key.length > 512)
            throw new Error(
              'Design key must be nonblank and at most 512 characters',
            );
          const hash = createHash('sha256')
            .update(
              JSON.stringify([options.kind, ownerId, tenantId, input.key]),
            )
            .digest('hex');
          const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          const existing = await store(owner).load(id, ownerId);
          if (existing?.definition === options.definition)
            return snapshot(existing);
          if (existing) throw new Error('Design run definition changed');
          try {
            return snapshot(
              await driver(owner, input.input).start({
                id,
                ownerId,
                input: input.input,
                resourceIds: input.resourceIds ?? [],
                budget: input.budget,
              }),
            );
          } catch (error) {
            if (!(error instanceof DesignRunConflictError)) throw error;
            return snapshot(await load(owner, id));
          }
        },
        get: async (id: string) => snapshot(await authorized(id)),
        stop: (id: string) => pause(id, false),
        /** Inference cancellation is currently resumable Stop (#4995). */
        cancel: (id: string) => pause(id, true),
        resume,
        /** Host must first durably record its approval/denial; check replays it. */
        async continueAfterApproval(id: string) {
          const state = await authorized(id);
          if (state.status !== 'waiting-approval')
            throw new DesignRunConflictError(
              'Design run is not waiting for approval',
            );
          return resume(id);
        },
      };
    },
  };
}
