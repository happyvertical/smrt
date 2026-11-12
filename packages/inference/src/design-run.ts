import type { WorkRunMetadata } from './work-profiles.js';

/** Host-facing progress; names are plain text supplied by the host. */
export interface DesignRunProgress {
  runId: string;
  pass: { index: number; count: number; name: string };
  status:
    | 'running'
    | 'checking'
    | 'waiting-approval'
    | 'stopped'
    | 'failed'
    | 'done';
  note?: string;
}

/** Persisted per-run allowances. A resume raises totals, never resets usage. */
export interface DesignRunBudget {
  maxTokens: number;
  maxDurationMs: number;
  maxCallTokens: number;
  callTimeoutMs: number;
  repairRetries: number;
  toolResultChars: number;
}

/** Durable host record. Resource contents and credentials never belong here. */
export interface DesignRunState {
  id: string;
  ownerId: string;
  revision: number;
  definition: string;
  resourceIds: string[];
  budget: DesignRunBudget;
  tokens: number;
  durationMs: number;
  passIndex: number;
  iteration: number;
  repair: number;
  phase: 'model' | 'check';
  status: DesignRunProgress['status'];
  note?: string;
  input: unknown;
  outputs: unknown[];
  attempts: WorkRunMetadata[];
  invalidOutput?: unknown;
  validationErrors?: string[];
  leaseUntil?: number;
  /** CAS revision that acquired this execution lease; retained through Stop. */
  leaseRevision?: number;
}

/**
 * Owner-scoped durable storage. save is an atomic compare-and-swap; null means
 * insert only. Hosts schedule run() through SmrtJob/TaskRunner, never HTTP
 * request/disconnect lifetimes. Loading and saving must enforce owner identity.
 */
export interface DesignRunStore {
  load(runId: string, ownerId: string): Promise<DesignRunState | null>;
  /** Worker-only release after the original execute/check promise truly settles. */
  releaseLease?(
    runId: string,
    ownerId: string,
    leaseRevision: number,
  ): Promise<boolean>;
  save(
    state: DesignRunState,
    expectedRevision: number | null,
  ): Promise<boolean>;
}

/** Mechanical checks run after a validated model pass, including on replay. */
export interface DesignPassCheck {
  input?: unknown;
  repeat?: boolean;
  waitingApproval?: boolean;
  note?: string;
}

/** A host-owned pass; model output cannot change this definition or policy. */
export interface DesignPass {
  name: string;
  schema: Record<string, unknown>;
  maxRepeats?: number;
  check?: (
    output: unknown,
    state: Readonly<DesignRunState>,
    context: { signal: AbortSignal },
  ) => Promise<DesignPassCheck>;
}

/** Provider-independent invocation, including CLI turns. */
export interface DesignPassRequest {
  runId: string;
  pass: DesignRunProgress['pass'];
  schema: Record<string, unknown>;
  input: unknown;
  outputs: readonly unknown[];
  resourceIds: readonly string[];
  repair?: { output: unknown; errors: readonly string[] };
  maxTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
  /** Summary first; drill down with opaque host cursors. */
  readResource(
    resourceId: string,
    cursor?: string,
  ): Promise<{ data: unknown; nextCursor?: string }>;
}

/** Shared engine-neutral result; the adapter reports actual engine/model usage. */
export interface DesignPassResult {
  output: unknown;
  metadata: WorkRunMetadata;
}

/** Host wiring. A full JSON Schema validator is mandatory, including for CLIs. */
export interface DesignRunDriverOptions {
  store: DesignRunStore;
  /** Versioned host definition, pinned on every persisted run. */
  definition: string;
  passes: readonly DesignPass[];
  validate(schema: Record<string, unknown>, output: unknown): readonly string[];
  executePass(request: DesignPassRequest): Promise<DesignPassResult>;
  readResource(
    ownerId: string,
    resourceId: string,
    cursor: string | undefined,
    maxChars: number,
  ): Promise<{ data: unknown; nextCursor?: string }>;
  onProgress?(event: DesignRunProgress): void | Promise<void>;
  now?: () => number;
  /** Live TaskRunner claim proof permits recovery of a crashed pass lease. */
  ownsExecution?: () => Promise<boolean>;
}

/** A stale worker may not overwrite Stop, resume, or another worker's checkpoint. */
class DesignRunPausedError extends Error {}

export class DesignRunConflictError extends Error {
  constructor(message = 'Design run changed; reload its current status') {
    super(message);
  }
}

/**
 * Shared durable pass executor. It owns no queue, authority, approval or data
 * mutation. The host schedules it on existing jobs and supplies policy-bound
 * tools. Checks must be deterministic/idempotent because recovery replays them.
 */
export function createDesignRunDriver(options: DesignRunDriverOptions) {
  const validateBudget = (budget: DesignRunBudget) => {
    for (const key of [
      'maxTokens',
      'maxDurationMs',
      'maxCallTokens',
      'callTimeoutMs',
      'repairRetries',
      'toolResultChars',
    ] as const) {
      const value = budget[key];
      if (
        !Number.isSafeInteger(value) ||
        value < (key === 'repairRetries' ? 0 : 1)
      )
        throw new Error(`Invalid design budget: ${key}`);
    }
  };
  const now = options.now ?? Date.now;
  if (!options.passes.length) throw new Error('A design run needs passes');

  const load = async (id: string, ownerId: string) => {
    const state = await options.store.load(id, ownerId);
    if (!state || state.ownerId !== ownerId)
      throw new Error('Design run not found');
    if (state.definition !== options.definition)
      throw new Error('Design run definition changed');
    return state;
  };
  const emit = async (state: DesignRunState) => {
    // A disconnected event stream never interrupts durable work.
    try {
      await options.onProgress?.({
        runId: state.id,
        pass: {
          index: Math.min(state.passIndex + 1, options.passes.length),
          count: options.passes.length,
          name: options.passes[
            Math.min(state.passIndex, options.passes.length - 1)
          ].name,
        },
        status: state.status,
        ...(state.note ? { note: state.note } : {}),
      });
    } catch {
      /* durable state is authoritative */
    }
  };
  const save = async (
    state: DesignRunState,
    expected: number | null = state.revision,
  ) => {
    const next = { ...state, revision: expected === null ? 0 : expected + 1 };
    if (!(await options.store.save(next, expected)))
      throw new DesignRunConflictError();
    Object.assign(state, next);
    await emit(state);
  };
  const stop = async (id: string, ownerId: string) => {
    const state = await load(id, ownerId);
    if (state.status === 'done' || state.status === 'failed') return state;
    state.status = 'stopped';
    state.note = 'Stopped. You can resume this design run.';
    await save(state);
    return state;
  };

  return {
    /** Create durable state before enqueueing the owner-bound job. */
    async start(input: {
      id: string;
      ownerId: string;
      resourceIds: string[];
      input?: unknown;
      budget: DesignRunBudget;
    }) {
      validateBudget(input.budget);
      const state: DesignRunState = {
        ...input,
        definition: options.definition,
        input: input.input ?? null,
        revision: 0,
        tokens: 0,
        durationMs: 0,
        passIndex: 0,
        iteration: 0,
        repair: 0,
        phase: 'model',
        status: 'running',
        outputs: [],
        attempts: [],
      };
      await save(state, null);
      return state;
    },
    status: load,
    stop,
    /** Cancellation is resumable Stop; job cancellation is the host's responsibility. */
    cancel: stop,
    async resume(
      id: string,
      ownerId: string,
      budget?: Partial<DesignRunBudget>,
    ) {
      const state = await load(id, ownerId);
      if (state.status === 'done' || state.status === 'failed')
        throw new Error('Design run has ended');
      if (state.leaseRevision !== undefined || (state.leaseUntil ?? 0) > now())
        throw new DesignRunConflictError(
          'The previous pass is still stopping. Try again when it has stopped.',
        );
      if (budget) {
        const raised = { ...state.budget, ...budget };
        validateBudget(raised);
        state.budget = raised;
      }
      state.status = 'running';
      state.note = undefined;
      await save(state);
      return state;
    },
    /** Run only from an exclusively owned durable job, with its cancellation signal. */
    async run(id: string, ownerId: string, signal?: AbortSignal) {
      const state = await load(id, ownerId);
      if (
        state.status === 'done' ||
        state.status === 'failed' ||
        state.status === 'stopped' ||
        state.status === 'waiting-approval'
      )
        return state;
      if (
        (state.leaseRevision !== undefined ||
          (state.leaseUntil ?? 0) > now()) &&
        !(await options.ownsExecution?.())
      )
        throw new DesignRunConflictError();
      let active: { revision: number; settled: boolean } | undefined;
      let abandoned = false;
      const releaseSettled = async (lease = active) => {
        if (!lease?.settled) return;
        try {
          await options.store.releaseLease?.(id, ownerId, lease.revision);
        } catch {
          /* state and live job ownership remain authoritative */
        }
      };
      const track = <T>(promise: Promise<T>): Promise<T> => {
        const lease = {
          revision: state.leaseRevision ?? state.revision,
          settled: false,
        };
        active = lease;
        const settled = () => {
          lease.settled = true;
          if (abandoned) void releaseSettled(lease);
        };
        void promise.then(settled, settled);
        return promise;
      };
      const clearSettledLease = () => {
        if (!active || active.settled) {
          state.leaseUntil = undefined;
          state.leaseRevision = undefined;
        }
      };
      try {
        while (state.passIndex < options.passes.length) {
          if (signal?.aborted) {
            state.status = 'stopped';
            state.note = 'Stopped. You can resume this design run.';
            break;
          }
          if (
            state.tokens >= state.budget.maxTokens ||
            state.durationMs >= state.budget.maxDurationMs
          ) {
            state.status = 'stopped';
            state.note =
              'This design run reached its budget. Raise the budget to resume.';
            break;
          }
          const pass = options.passes[state.passIndex];
          if (state.phase === 'check') {
            state.status = 'checking';
            const allowance = Math.min(
              state.budget.callTimeoutMs,
              state.budget.maxDurationMs - state.durationMs,
            );
            state.leaseUntil = now() + allowance;
            state.leaseRevision = state.revision + 1;
            state.durationMs += allowance;
            await save(state);
            const began = now();
            const controller = new AbortController();
            const abort = () => controller.abort(signal?.reason);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const timer = setTimeout(
              () =>
                controller.abort(
                  new DesignRunPausedError(
                    'Design check reached its time budget. Resume to try again.',
                  ),
                ),
              allowance,
            );
            let check: DesignPassCheck | undefined;
            try {
              check = await Promise.race([
                track(
                  Promise.resolve(
                    pass.check?.(state.outputs[state.passIndex], state, {
                      signal: controller.signal,
                    }),
                  ),
                ),
                new Promise<never>((_resolve, reject) => {
                  if (controller.signal.aborted)
                    reject(controller.signal.reason);
                  else
                    controller.signal.addEventListener(
                      'abort',
                      () => reject(controller.signal.reason),
                      { once: true },
                    );
                }),
              ]);
            } finally {
              clearTimeout(timer);
              signal?.removeEventListener('abort', abort);
            }
            state.durationMs += Math.max(0, now() - began) - allowance;
            clearSettledLease();
            if (check?.input !== undefined) state.input = check.input;
            if (check?.repeat) {
              if (state.iteration >= (pass.maxRepeats ?? 0))
                throw new Error(
                  'Design checks still failed after the allowed revisions',
                );
              state.iteration++;
            } else {
              state.passIndex++;
              state.iteration = 0;
            }
            state.phase = 'model';
            state.repair = 0;
            if (check?.waitingApproval) {
              state.status = 'waiting-approval';
              state.note = check.note ?? 'Waiting for your approval.';
              await save(state);
              return state;
            }
            await save(state);
            continue;
          }
          const tokens = Math.min(
            state.budget.maxCallTokens,
            state.budget.maxTokens - state.tokens,
          );
          const timeoutMs = Math.min(
            state.budget.callTimeoutMs,
            state.budget.maxDurationMs - state.durationMs,
          );
          if (tokens <= 0 || timeoutMs <= 0) {
            state.status = 'stopped';
            state.note =
              'This design run reached its budget. Raise the budget to resume.';
            break;
          }
          // Reserve before external work: crash/unknown usage conservatively keeps
          // the full allowance, so restart cannot erase previously spent budgets.
          state.tokens += tokens;
          state.durationMs += timeoutMs;
          state.status = 'running';
          state.leaseUntil = now() + timeoutMs;
          state.leaseRevision = state.revision + 1;
          await save(state);
          const began = now();
          const controller = new AbortController();
          const abort = () => controller.abort(signal?.reason);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          const timer = setTimeout(
            () =>
              controller.abort(
                new DesignRunPausedError(
                  'Design pass reached its time budget. Resume to try again.',
                ),
              ),
            timeoutMs,
          );
          try {
            const execution = track(
              options.executePass({
                runId: id,
                pass: {
                  index: state.passIndex + 1,
                  count: options.passes.length,
                  name: pass.name,
                },
                schema: pass.schema,
                input: state.input,
                outputs: state.outputs,
                resourceIds: state.resourceIds,
                maxTokens: tokens,
                timeoutMs,
                signal: controller.signal,
                ...(state.validationErrors
                  ? {
                      repair: {
                        output: state.invalidOutput,
                        errors: state.validationErrors,
                      },
                    }
                  : {}),
                async readResource(resourceId, cursor) {
                  controller.signal.throwIfAborted();
                  if (!state.resourceIds.includes(resourceId))
                    throw new Error('Design resource not found');
                  const page = await options.readResource(
                    ownerId,
                    resourceId,
                    cursor,
                    state.budget.toolResultChars,
                  );
                  if (
                    JSON.stringify(page).length > state.budget.toolResultChars
                  )
                    throw new Error(
                      'Design resource page exceeds the result budget',
                    );
                  return page;
                },
              }),
            );
            const result = await Promise.race([
              execution,
              new Promise<never>((_resolve, reject) => {
                if (controller.signal.aborted) reject(controller.signal.reason);
                else
                  controller.signal.addEventListener(
                    'abort',
                    () => reject(controller.signal.reason),
                    { once: true },
                  );
              }),
            ]);
            if (controller.signal.aborted) {
              state.status = 'stopped';
              state.note = 'Stopped. You can resume this design run.';
              break;
            }
            const used = result.metadata.tokens;
            if (used !== undefined && (!Number.isSafeInteger(used) || used < 0))
              throw new Error('Invalid design usage');
            state.tokens += (used ?? tokens) - tokens;
            state.durationMs += Math.max(0, now() - began) - timeoutMs;
            state.attempts.push(result.metadata);
            const errors = [...options.validate(pass.schema, result.output)];
            if (errors.length) {
              state.invalidOutput = result.output;
              state.validationErrors = errors;
              if (state.repair >= state.budget.repairRetries)
                throw new Error(
                  'Design output did not match the required schema',
                );
              state.repair++;
            } else {
              state.outputs[state.passIndex] = result.output;
              state.invalidOutput = undefined;
              state.validationErrors = undefined;
              state.phase = 'check';
            }
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            clearSettledLease();
          }
          await save(state);
        }
        if (state.passIndex >= options.passes.length) {
          state.status = 'done';
          state.note = undefined;
        }
        clearSettledLease();
        await save(state);
        return state;
      } catch (error) {
        if (error instanceof DesignRunConflictError) throw error;
        state.status =
          signal?.aborted || error instanceof DesignRunPausedError
            ? 'stopped'
            : 'failed';
        state.note =
          error instanceof DesignRunPausedError
            ? error.message
            : signal?.aborted
              ? 'Stopped. You can resume this design run.'
              : 'The design run failed. Review its inputs before starting again.';
        clearSettledLease();
        await save(state);
        return state;
      } finally {
        abandoned = true;
        await releaseSettled();
      }
    },
  };
}
