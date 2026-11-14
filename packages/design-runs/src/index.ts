import { createHash } from 'node:crypto';
import { stableStringify } from '@happyvertical/smrt-core/knowledge';
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
  assertAbandonedJobClaim,
  assertFailedJobDispatch,
  assertJobClaim,
  assertJobClaimForRelease,
  getJobClaim,
  isRunnerExecutionContext,
  type JobClaim,
  JobClaimLostError,
  JobHandle,
  SmrtJobCollection,
  SmrtJobEventCollection,
} from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Informational only; never used for job kinds, row identity or table names. */
export const PACKAGE_NAME = '@happyvertical/smrt-design-runs';
const target = '@happyvertical/smrt-inference:DesignRunRecord';

type AdmissionState = DesignRunState & {
  admissionDigest?: string;
  leaseClaim?: Readonly<JobClaim>;
};

/** A key reserves the original JSON request, even if later checks replace input. */
export class DesignRunKeyConflictError extends Error {
  constructor(readonly runId: string) {
    super('This design key was already used with a different request');
    this.name = 'DesignRunKeyConflictError';
  }
}

type Handler = Parameters<typeof installDesignRunExecutor>[1];
const routers = new WeakMap<
  DatabaseInterface,
  { handlers: Map<string, Handler>; dispose: () => void }
>();

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
  /** Host may cap or refuse effective totals on ordinary stopped/approval resume. */
  resumeBudget?(
    owner: DesignRunOwner,
    state: Readonly<DesignRunState>,
    proposed: Readonly<DesignRunBudget>,
  ): Promise<DesignRunBudget>;
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
  const snapshot = (state: DesignRunState) => {
    const visible = { ...state } as AdmissionState;
    delete visible.admissionDigest;
    delete visible.leaseClaim;
    return visible as DesignRunSnapshot<Input, Output>;
  };
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
  const store = (
    owner: DesignRunOwner,
    claim?: Readonly<JobClaim>,
    admissionDigest?: string,
  ) => {
    const native = createDesignRunStore({
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
    return {
      ...native,
      save(state: DesignRunState, expected: number | null) {
        // Enrich the exact checkpoint object so inference's in-memory state also
        // retains its host dispatch provenance after the successful CAS.
        const checkpoint = state as AdmissionState;
        if (expected === null) checkpoint.admissionDigest = admissionDigest;
        if (state.leaseRevision === undefined) delete checkpoint.leaseClaim;
        else if (claim && state.leaseRevision === state.revision)
          checkpoint.leaseClaim = claim;
        return native.save(checkpoint, expected);
      },
    };
  };
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
    admissionDigest?: string,
  ) =>
    createDesignRunDriver({
      ...options.configure(owner, input),
      definition: options.definition,
      store: store(owner, claim, admissionDigest),
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

  /** Runner handler; startup failures become owner-actionable checkpoints. */
  async function handler(
    record: DesignRunRecord,
    args: unknown,
    context: unknown,
  ) {
    if (!isRunnerExecutionContext(context))
      throw new Error('Design execution requires TaskRunner context');
    const claim = getJobClaim(context);
    const owner = { ownerId: record.ownerId, tenantId: record.tenantId };
    const id = String(record.id);
    if (
      claim.objectType !== target ||
      claim.method !== 'execute' ||
      claim.objectId !== id ||
      claim.tenantId !== owner.tenantId
    )
      throw new Error('Design job target changed');
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    controllers.set(id, controller);
    let began = false;
    try {
      if (
        !args ||
        typeof args !== 'object' ||
        (args as { kind?: unknown }).kind !== options.kind
      )
        throw new Error('Design job kind changed');
      await options.authorize(owner);
      await transaction((tx) => assertJobClaim(tx, claim));
      const state = await load(owner, id);
      const workflow = driver(owner, state.input as Input, claim);
      began = true;
      return snapshot(await workflow.run(id, owner.ownerId, controller.signal));
    } catch (error) {
      if (!began) {
        try {
          const state = await load(owner, id);
          if (['running', 'checking'].includes(state.status)) {
            await store(owner, claim).save(
              {
                ...state,
                revision: state.revision + 1,
                status: 'stopped',
                note: 'The job could not start. Fix its permissions or configuration, then resume.',
              },
              state.revision,
            );
          }
        } catch {
          /* Keep the original failure; owner reads can reconcile later. */
        }
      }
      throw error;
    } finally {
      if (controllers.get(id) === controller) controllers.delete(id);
      context.signal.removeEventListener('abort', abort);
    }
  }

  return {
    handler,
    /** Install before starting TaskRunner; dispose after stopping it. */
    install() {
      let router = routers.get(options.db);
      if (!router) {
        const handlers = new Map<string, Handler>();
        const dispose = installDesignRunExecutor(
          options.db,
          (record, args, context) => {
            const kind =
              args && typeof args === 'object'
                ? (args as { kind?: unknown }).kind
                : undefined;
            const selected =
              typeof kind === 'string' ? handlers.get(kind) : undefined;
            if (!selected)
              throw new Error(
                'No handler is installed for this design job kind',
              );
            return selected(record, args, context);
          },
        );
        router = { handlers, dispose };
        routers.set(options.db, router);
      }
      if (router.handlers.has(options.kind))
        throw new Error('This design job kind is already installed');
      router.handlers.set(options.kind, handler);
      const installed = router;
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        installed.handlers.delete(options.kind);
        if (!installed.handlers.size) {
          installed.dispose();
          routers.delete(options.db);
        }
      };
    },
    forOwner(ownerId: string, tenantId: string | null) {
      if (!ownerId) throw new Error('Design runs require an owner');
      const owner = { ownerId, tenantId };
      const authorized = async (id: string) => {
        await options.authorize(owner);
        let state = await load(owner, id);
        // A router/setup failure may precede this handler. Reconcile only a
        // lease-free checkpoint against its exact authoritative execution failure.
        if (
          ['running', 'checking'].includes(state.status) &&
          state.leaseRevision === undefined &&
          !(await activeJobs(owner, id)).length
        ) {
          const [job] = await (await jobs).list({
            where: {
              objectType: target,
              objectId: id,
              tenantId,
              method: 'execute',
              status: 'failed',
            },
            orderBy: 'updated_at DESC',
            limit: 1,
          });
          const events = await SmrtJobEventCollection.create({
            db: options.db,
          });
          const outcome = job?.completedAt
            ? await events.getTerminalOutcome(String(job.id), {
                tenantId,
                attempts: job.attempts,
                completedAt: job.completedAt.toISOString(),
              })
            : null;
          if (job && outcome?.failureKind === 'execution') {
            const recovery = createDesignRunStore({
              db: options.db,
              ...owner,
              enqueue: async () => {},
              authorizeWrite: async (tx) => {
                await assertFailedJobDispatch(tx, {
                  jobId: String(job.id),
                  tenantId,
                  attempt: job.attempts,
                  startedAt: job.startedAt?.toISOString() ?? '',
                  objectType: target,
                  objectId: id,
                  method: 'execute',
                });
                return !(await activeJobs(owner, id, tx)).length;
              },
            });
            await recovery.save(
              {
                ...state,
                revision: state.revision + 1,
                status: 'stopped',
                note: 'The job could not start. Fix its permissions or configuration, then resume.',
              },
              state.revision,
            );
            state = await load(owner, id);
          }
        }
        return state;
      };
      const pause = async (id: string) => {
        const state = await authorized(id);
        if (state.status === 'done' || state.status === 'failed')
          return snapshot(state);
        const result: DesignRunState = {
          ...state,
          revision: state.revision + 1,
          status: 'stopped',
          note: 'Stopped. You can resume this design run.',
        };
        if (!(await store(owner).save(result, state.revision)))
          throw new DesignRunConflictError();
        controllers.get(id)?.abort(new Error('Design run stopped'));
        for (const job of await activeJobs(owner, id)) {
          try {
            await job.cancel();
          } catch (error) {
            const current = await (await jobs).get({ id: String(job.id) });
            if (!current || ['pending', 'running'].includes(current.status))
              throw error;
          }
        }
        return snapshot(result);
      };
      const resume = async (id: string, budget?: Partial<DesignRunBudget>) => {
        let state = await authorized(id);
        if ((await activeJobs(owner, id)).length)
          throw new DesignRunConflictError(
            'The previous job is still settling',
          );
        if (state.status === 'stopped' && state.leaseRevision !== undefined) {
          const original = (state as AdmissionState).leaseClaim;
          if (original) {
            const abandoned = createDesignRunStore({
              db: options.db,
              ...owner,
              enqueue: async () => {},
              authorizeRelease: async (tx) => {
                try {
                  await assertAbandonedJobClaim(tx, original);
                  return true;
                } catch (error) {
                  if (error instanceof JobClaimLostError) return false;
                  throw error;
                }
              },
            });
            if (
              await abandoned.releaseLease?.(id, ownerId, state.leaseRevision)
            )
              state = await load(owner, id);
          }
        }
        if (
          ['running', 'checking'].includes(state.status) ||
          (state.status === 'stopped' && state.leaseRevision !== undefined)
        ) {
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
              method: 'execute',
            },
            orderBy: 'updated_at DESC',
            limit: 1,
          });
          // A startup failure did not acquire a new inference lease. Recovery
          // remains bound to the persisted dispatch that actually acquired it.
          const original = (state as AdmissionState).leaseClaim;
          const job = original
            ? await (await jobs).get({ id: original.jobId })
            : prior[0];
          const outcome = job?.completedAt
            ? await events.getTerminalOutcome(String(job.id), {
                tenantId,
                attempts: job.attempts,
                completedAt: job.completedAt.toISOString(),
              })
            : null;
          if (!job || outcome?.failureKind !== 'stale-recovery')
            throw new DesignRunConflictError(
              state.status === 'stopped'
                ? 'The previous pass is still stopping. Try again when it has stopped.'
                : 'TaskRunner has not recovered the previous job',
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
            await assertFailedJobDispatch(
              tx,
              original ?? {
                jobId: String(job.id),
                tenantId,
                attempt: job.attempts,
                startedAt: job.startedAt?.toISOString() ?? '',
                objectType: target,
                objectId: id,
                method: 'execute',
              },
            );
            if ((await activeJobs(owner, id, tx)).length)
              throw new DesignRunConflictError('The recovered job changed');
            await enqueue(tx, next, owner);
            return snapshot(next);
          });
        }
        const approvedBudget = options.resumeBudget
          ? await options.resumeBudget(
              owner,
              snapshot(state),
              Object.freeze({ ...state.budget, ...budget }),
            )
          : budget;
        return snapshot(
          await driver(owner, state.input as Input).resume(
            id,
            ownerId,
            approvedBudget,
          ),
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
          const admissionDigest = createHash('sha256')
            .update(
              stableStringify(
                JSON.parse(
                  JSON.stringify({
                    input: input.input,
                    resourceIds: input.resourceIds ?? [],
                    budget: input.budget,
                  }),
                ),
              ),
            )
            .digest('hex');
          const replay = (state: DesignRunState) => {
            if ((state as AdmissionState).admissionDigest !== admissionDigest)
              throw new DesignRunKeyConflictError(id);
            return snapshot(state);
          };
          const existing = await store(owner).load(id, ownerId);
          if (existing?.definition === options.definition)
            return replay(existing);
          if (existing) throw new Error('Design run definition changed');
          try {
            return snapshot(
              await driver(
                owner,
                input.input,
                undefined,
                admissionDigest,
              ).start({
                id,
                ownerId,
                input: input.input,
                resourceIds: input.resourceIds ?? [],
                budget: input.budget,
              }),
            );
          } catch (error) {
            if (!(error instanceof DesignRunConflictError)) throw error;
            return replay(await load(owner, id));
          }
        },
        get: async (id: string) => snapshot(await authorized(id)),
        stop: (id: string) => pause(id),
        /** Inference cancellation is currently resumable Stop (#4995). */
        cancel: (id: string) => pause(id),
        resume,
        /** Host must first durably record its approval/denial; check replays it. */
        async continueAfterApproval(id: string) {
          await options.authorize(owner);
          for (const job of await activeJobs(owner, id)) {
            if (job.status === 'running')
              await new JobHandle(String(job.id), await jobs).wait({
                timeout: 30_000,
                pollInterval: 25,
              });
          }
          const state = await authorized(id);
          if (state.status !== 'waiting-approval') return snapshot(state);
          try {
            return await resume(id);
          } catch (error) {
            if (error instanceof DesignRunConflictError) {
              const current = await authorized(id);
              if (current.status !== 'waiting-approval')
                return snapshot(current);
            }
            throw error;
          }
        },
      };
    },
  };
}
