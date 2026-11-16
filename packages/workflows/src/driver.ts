import {
  AiCallLimitError,
  type AiRunBudget,
  type AiRunCheckpoint,
  type AiRunClaimFence,
  AiRunClaimLostError,
  type AiRunContext,
  AiRunResumeRefusedError,
  AiRunStoppedError,
  type AiRunStopReason,
  appendAiRunEvent,
  cancelAiRun,
  finishAiRun,
  getAiRun,
  getRunTrajectory,
  reconcileAiRunOnClaim,
  resumeAiRun,
  startAiRunStep,
  stopAiRun,
  type TrackedAiClient,
  waitAiRunApproval,
  withAiRunTransaction,
} from '@happyvertical/smrt-core';
import {
  promptMessageOptions,
  resolvePrompt,
  trackedPromptCall,
} from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  createRunCheckpointStore,
  isWorkflowCheckpointState,
  type LoadedWorkflowRun,
  type RunCheckpointStore,
  RunConflictError,
  WorkflowRunNotFoundError,
} from './checkpoint-store.js';
import {
  type RunProgress,
  WORKFLOW_RUN_TYPE,
  WORKFLOW_STATE_VERSION,
  type WorkflowCheckpointState,
  type WorkflowDefinition,
  type WorkflowRunState,
  type WorkflowStep,
  type WorkflowStepCheck,
  type WorkflowStepContext,
} from './types.js';

/** A step's output could not be read as the step's JSON (a repairable attempt). */
export class WorkflowOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowOutputError';
  }
}

/** Host wiring of one workflow definition. */
export interface WorkflowRunDriverOptions {
  /**
   * Core's tracked client of the runs' tenant and database
   * (`createTrackedAiClient`): runs open through it, and every step call is
   * sent on it with the run's context.
   */
  ai: TrackedAiClient;
  definition: WorkflowDefinition;
  /** The host's full JSON Schema validator (Ajv or equal); errors, or none. */
  validate(schema: Record<string, unknown>, output: unknown): readonly string[];
  /** Resolve input passed by reference (`inputRef`). */
  readInput?(
    ref: string,
    scope: { ownerId: string; tenantId: string | null },
  ): Promise<unknown>;
  /** Progress for the host's event stream; its failures never stop work. */
  onProgress?(progress: RunProgress): void | Promise<void>;
  /** The app's ceiling on a budget raised at resume. */
  ceiling?: AiRunBudget;
  /** Lease length while a worker holds a run (default 30 s). */
  leaseTtlMs?: number;
  now?: () => Date;
}

/** Input of `start`. */
export interface StartWorkflowRun {
  /** The authenticated owner. */
  ownerId: string;
  /** Minted when absent. */
  id?: string;
  /** Small input, kept in the checkpoint. */
  input?: unknown;
  /** A pointer at large input the host stores; resolved with `readInput`. */
  inputRef?: string | null;
  budget?: AiRunBudget;
  tags?: Record<string, unknown>;
  experimentId?: string | null;
  datasetItem?: string | null;
  parentRunId?: string | null;
}

/** Options of `run`. */
export interface WorkflowRunOptions {
  /** Cooperative stop: the job's signal. Aborting stops with `interrupted`. */
  signal?: AbortSignal;
  /**
   * Claim fencing: asserts, in every checkpoint save, step start,
   * reservation, event and status change, that this worker still holds the
   * run's job claim. A worker whose claim was taken over changes nothing: the
   * run rejects with `AiRunClaimLostError` and leaves the run to the worker
   * that holds it now.
   */
  fence?: AiRunClaimFence;
  /**
   * The fence of the stop this worker writes when its signal aborts (default
   * `fence`). The job behind that signal may already be settled (cancelled,
   * timed out), so this one accepts this worker's own attempt in any state
   * and refuses only a claim another worker took over
   * (`workflowStopFence(claim)`).
   */
  stopFence?: AiRunClaimFence;
  /** Who holds the run while it works; written to and renewed on the lease. */
  holder?: string;
}

/** A lease as stored in the checkpoint's `lease` column. */
export interface WorkflowRunLease {
  holder: string;
  expiresAt: string;
}

/** Read a checkpoint's lease; null when absent or not one of ours. */
export function readWorkflowRunLease(
  checkpoint: Pick<AiRunCheckpoint, 'lease'>,
): WorkflowRunLease | null {
  if (!checkpoint.lease) return null;
  try {
    const parsed = JSON.parse(checkpoint.lease) as Partial<WorkflowRunLease>;
    return typeof parsed.holder === 'string' &&
      typeof parsed.expiresAt === 'string'
      ? { holder: parsed.holder, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

/** The first state of a run. */
export function initialWorkflowState(
  input: unknown,
  inputRef: string | null,
): WorkflowCheckpointState {
  return {
    v: WORKFLOW_STATE_VERSION,
    stepIndex: 0,
    phase: 'call',
    repairs: 0,
    repeats: 0,
    input: input ?? null,
    inputRef,
    outputs: [],
    pending: null,
    invalid: null,
    approval: null,
  };
}

function parseOutput(raw: unknown): unknown {
  let value = raw;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { content?: unknown }).content === 'string'
  ) {
    value = (value as { content: string }).content;
  }
  if (typeof value !== 'string') return value;
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkflowOutputError('The step output is not valid JSON');
  }
}

function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => undefined);
    return next;
  };
}

/**
 * The workflow run driver: a host's ordered steps run as one durable
 * `workflow` run (docs/content/ai-runs.md). Each step's call resolves its
 * registered prompt and goes out on the tracked client inside the run, so it
 * is reserved against the budget, recorded as a `call` event and a usage row
 * carrying the step, attempt and template hash, and settled. Invalid output
 * is repaired up to `repairRetries`; accepted output goes to the host check
 * (a `check` event) and may pause for approval (`approval` events). A budget
 * limit stops the run resumable; a child run's stop stops it the same way,
 * never as a repair. It owns no queue: a host runs it from a background job
 * with claim fencing, and the job's signal stops it.
 */
export function createWorkflowRunDriver(options: WorkflowRunDriverOptions) {
  const { ai, definition } = options;
  const steps = definition.steps;
  if (!steps.length) throw new Error('A workflow needs steps');
  if (!definition.key.trim() || !definition.version.trim()) {
    throw new Error('A workflow definition needs a key and a version');
  }
  const db = ai.db;
  const tenantId = ai.tenantId ?? null;
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const active = new Map<string, AbortController>();

  const acceptsVersion = (version: string | null) =>
    version === definition.version ||
    Boolean(definition.olderCheckpoints?.accepts(version));

  const storeFor = (ownerId: string, fence?: AiRunClaimFence) =>
    createRunCheckpointStore({
      db,
      ownerId,
      tenantId,
      ...(fence ? { fence } : {}),
    });

  const mustLoad = async (store: RunCheckpointStore, runId: string) => {
    const loaded = await store.load(runId);
    if (!loaded || loaded.run.definitionKey !== definition.key) {
      throw new WorkflowRunNotFoundError(runId);
    }
    return loaded;
  };

  const stepInfo = (index: number) => {
    const at = Math.min(index, steps.length - 1);
    return {
      index: Math.min(index + 1, steps.length),
      count: steps.length,
      name: (steps[at] as WorkflowStep).name,
    };
  };

  const snapshot = (loaded: LoadedWorkflowRun): WorkflowRunState => {
    const { run, checkpoint, state } = loaded;
    return {
      id: run.id,
      ownerId: run.ownerId,
      tenantId: run.tenantId,
      definitionKey: run.definitionKey,
      definitionVersion: checkpoint.definitionVersion,
      status: run.status,
      stopReason: run.stopReason,
      stoppedByRunId: run.stoppedByRunId,
      stopDetail: run.stopDetail,
      retryOfRunId: run.retryOfRunId,
      budget: run.budget,
      revision: checkpoint.revision,
      step: stepInfo(state.stepIndex),
      phase: state.phase,
      input: state.input,
      inputRef: state.inputRef,
      outputs: [...state.outputs],
      pending: state.pending?.output ?? null,
      totals: {
        tokens: run.tokens,
        calls: run.calls,
        costUsed: run.costUsed,
        stepsUsed: run.stepsUsed,
        inclusiveTokens: run.inclusiveTokens,
        inclusiveCalls: run.inclusiveCalls,
        inclusiveCost: run.inclusiveCost,
      },
    };
  };

  const emit = async (state: WorkflowRunState) => {
    try {
      await options.onProgress?.({
        runId: state.id,
        step: state.step,
        status: state.status,
        stopReason: state.stopReason,
        phase: state.phase,
      });
    } catch {
      /* the durable state is authoritative */
    }
  };

  const current = async (store: RunCheckpointStore, runId: string) => {
    const state = snapshot(await mustLoad(store, runId));
    await emit(state);
    return state;
  };

  /** The `call` or `handoff` event an attempt's output came from. */
  const judgedEvent = async (
    runId: string,
    afterSeq: number,
    stepIndex: number,
  ): Promise<string | null> => {
    const trajectory = await getRunTrajectory(db, runId);
    const candidates = (trajectory?.entries ?? [])
      .map((entry) => entry.event)
      .filter(
        (event): event is NonNullable<typeof event> =>
          Boolean(event) &&
          (event?.seq ?? 0) > afterSeq &&
          (event?.type === 'call' || event?.type === 'handoff') &&
          (event?.stepIndex === null || event?.stepIndex === stepIndex),
      );
    return candidates[candidates.length - 1]?.id ?? null;
  };

  const lastSeq = async (runId: string) => {
    const trajectory = await getRunTrajectory(db, runId);
    return (trajectory?.entries ?? []).reduce(
      (max, entry) => Math.max(max, entry.event?.seq ?? 0),
      0,
    );
  };

  const approvalDecision = async (
    runId: string,
    requestEventId: string,
  ): Promise<'approved' | 'refused' | null> => {
    const trajectory = await getRunTrajectory(db, runId);
    for (const entry of [...(trajectory?.entries ?? [])].reverse()) {
      const event = entry.event;
      if (
        event?.type === 'approval' &&
        event.parentEventId === requestEventId &&
        (event.status === 'approved' || event.status === 'refused')
      ) {
        return event.status;
      }
    }
    return null;
  };

  const resolveInput = async (
    state: WorkflowCheckpointState,
    ownerId: string,
  ) => {
    if (state.inputRef === null) return state.input;
    if (!options.readInput) {
      throw new Error('This workflow passes input by reference: set readInput');
    }
    return options.readInput(state.inputRef, { ownerId, tenantId });
  };

  const defaultVariables = (
    step: WorkflowStep,
    context: WorkflowStepContext,
  ): Record<string, unknown> => ({
    input: JSON.stringify(context.input ?? null),
    outputs: JSON.stringify(context.outputs),
    schema: JSON.stringify(step.schema),
    attempt: String(context.attempt),
    repairOutput: context.repair ? JSON.stringify(context.repair.output) : '',
    repairErrors: context.repair ? context.repair.errors.join('\n') : '',
  });

  /** One attempt of a step's call; returns its output. */
  const callStep = async (
    step: WorkflowStep,
    context: WorkflowStepContext,
    runContext: AiRunContext,
  ): Promise<unknown> => {
    if (step.execute) {
      return parseOutput(await step.execute({ ...context, runContext }));
    }
    const variables = step.variables
      ? await step.variables(context)
      : defaultVariables(step, context);
    const resolved = await resolvePrompt(step.promptKey, {
      db,
      tenantId,
      variables,
    });
    const client = await ai.client(trackedPromptCall(resolved), { runContext });
    // The prompt's call options (params, model, temperature, maxTokens, its
    // effort as `reasoning`); its tier is already on the tracked client, so
    // no tier keys ride on the call. The driver's own options win; core
    // spreads the tier binding's params under all of them.
    const answer = await client.message(resolved.text, {
      ...promptMessageOptions(resolved.ai, { routeTier: false }),
      signal: context.signal,
      ...(step.expectedOutputTokens !== undefined
        ? { expectedOutputTokens: step.expectedOutputTokens }
        : {}),
    } as Parameters<typeof client.message>[1]);
    return parseOutput(answer);
  };

  return {
    definition,

    /**
     * Open the durable `workflow` run with its first checkpoint, in one
     * transaction. Throws `AiRunTrackingDisabledError` while usage tracking
     * is off. Schedule `run` on a background job; never on a request.
     */
    async start(input: StartWorkflowRun): Promise<WorkflowRunState> {
      if (!input.ownerId) throw new Error('Workflow runs require an owner');
      const { run } = await ai.openRun({
        ...(input.id ? { id: input.id } : {}),
        type: WORKFLOW_RUN_TYPE,
        definitionKey: definition.key,
        definitionVersion: definition.version,
        ownerId: input.ownerId,
        durable: true,
        checkpoint: {
          state: initialWorkflowState(
            input.inputRef ? null : (input.input ?? null),
            input.inputRef ?? null,
          ),
        },
        ...(input.budget ? { budget: input.budget } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.experimentId ? { experimentId: input.experimentId } : {}),
        ...(input.datasetItem ? { datasetItem: input.datasetItem } : {}),
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      });
      return current(storeFor(input.ownerId), run.id);
    },

    /** The run as this owner sees it. */
    get(runId: string, ownerId: string): Promise<WorkflowRunState> {
      return mustLoad(storeFor(ownerId), runId).then(snapshot);
    },

    /**
     * Work the run until it finishes, stops, fails or waits for approval.
     * Run it only from the job that holds the run, with that job's signal
     * and claim fence. Reconciles reservations a dead worker left behind
     * before the first call.
     */
    async run(
      runId: string,
      ownerId: string,
      runOptions: WorkflowRunOptions = {},
    ): Promise<WorkflowRunState> {
      const store = storeFor(ownerId, runOptions.fence);
      let loaded = await mustLoad(store, runId);
      if (loaded.run.status !== 'running') return snapshot(loaded);
      if (active.has(runId)) {
        throw new RunConflictError('This workflow run is already working');
      }
      const controller = new AbortController();
      const abort = () => controller.abort(runOptions.signal?.reason);
      runOptions.signal?.addEventListener('abort', abort, { once: true });
      if (runOptions.signal?.aborted) abort();
      active.set(runId, controller);
      const queue = serial();
      const fence = runOptions.fence;
      const fenced = fence ? { fence } : {};
      const stopFence = runOptions.stopFence ?? fence;
      let revision = loaded.checkpoint.revision;
      let state = loaded.state;
      const lease = () =>
        runOptions.holder
          ? JSON.stringify({
              holder: runOptions.holder,
              expiresAt: new Date(now().getTime() + leaseTtlMs).toISOString(),
            } satisfies WorkflowRunLease)
          : undefined;
      const persist = (
        next: WorkflowCheckpointState,
        extra: { definitionVersion?: string } = {},
      ) =>
        queue(async () => {
          revision = await store.save(runId, {
            expectedRevision: revision,
            state: next,
            ...extra,
          });
          state = next;
        });
      let renewal: ReturnType<typeof setInterval> | undefined;
      const stopIfRunning = async (
        reason: 'interrupted' | 'definition_changed',
      ) => {
        await stopAiRun(db, runId, {
          reason,
          ...(stopFence ? { fence: stopFence } : {}),
        }).catch((error) => {
          // A worker whose claim was taken over leaves the run alone.
          if (error instanceof AiRunClaimLostError) throw error;
          return null;
        });
      };
      const fail = async (
        stopReason: Extract<
          AiRunStopReason,
          'repairs_exhausted' | 'check_failed' | 'error'
        >,
      ) => {
        await finishAiRun(db, runId, { status: 'failed', stopReason }, fenced);
      };
      try {
        await reconcileAiRunOnClaim(db, runId);
        // Resume across versions (page section 7).
        const saved = loaded.checkpoint.definitionVersion;
        if (saved !== definition.version) {
          let migrated: WorkflowCheckpointState | null = null;
          if (definition.olderCheckpoints?.accepts(saved)) {
            try {
              const candidate = definition.olderCheckpoints.migrate(
                state,
                saved,
              );
              if (isWorkflowCheckpointState(candidate)) migrated = candidate;
            } catch {
              migrated = null;
            }
          }
          if (!migrated) {
            await stopIfRunning('definition_changed');
            return await current(store, runId);
          }
          await persist(migrated, { definitionVersion: definition.version });
        }
        const holderLease = lease();
        if (holderLease) {
          await queue(async () => {
            revision = await store.save(runId, {
              expectedRevision: revision,
              state,
              lease: holderLease,
            });
          });
          renewal = setInterval(
            () => {
              const renewed = lease();
              void queue(async () => {
                revision = await store.save(runId, {
                  expectedRevision: revision,
                  state,
                  lease: renewed ?? null,
                });
              }).catch(() => {
                // The run left `running` or the claim was lost: the next
                // write of the loop reports it; the lease expires.
                if (renewal) clearInterval(renewal);
              });
            },
            Math.max(10, Math.floor(leaseTtlMs / 3)),
          );
          renewal.unref?.();
        }

        let entered = false;
        let stepInstanceId: string | undefined;
        while (true) {
          if (state.stepIndex >= steps.length) {
            await finishAiRun(db, runId, { status: 'done' }, fenced);
            break;
          }
          if (controller.signal.aborted) {
            await stopIfRunning('interrupted');
            break;
          }
          const step = steps[state.stepIndex] as WorkflowStep;
          const base: WorkflowStepContext = {
            runId,
            step: stepInfo(state.stepIndex),
            input: await resolveInput(state, ownerId),
            outputs: state.outputs.slice(0, state.stepIndex),
            attempt: state.repairs + 1,
            repair: state.invalid,
            signal: controller.signal,
          };

          if (state.phase === 'call') {
            if (!entered) {
              const started = await queue(() =>
                startAiRunStep(db, runId, {
                  stepIndex: state.stepIndex,
                  ...(fence ? { fence } : {}),
                  checkpoint: { expectedRevision: revision, state },
                }),
              );
              if (started.revision !== null) revision = started.revision;
              stepInstanceId = started.stepInstanceId;
              entered = true;
              await current(store, runId);
            }
            const runContext: AiRunContext = {
              runId,
              db,
              tenantId,
              ...(fence ? { fence } : {}),
              stepIndex: state.stepIndex,
              stepName: step.name,
              ...(stepInstanceId ? { stepInstanceId } : {}),
              attempt: base.attempt,
            };
            const before = await lastSeq(runId);
            let output: unknown;
            let errors: string[] = [];
            try {
              output = await callStep(step, base, runContext);
            } catch (error) {
              if (
                error instanceof AiRunStoppedError ||
                error instanceof AiRunClaimLostError
              ) {
                throw error;
              }
              if (controller.signal.aborted) {
                await stopIfRunning('interrupted');
                break;
              }
              if (
                error instanceof WorkflowOutputError ||
                error instanceof AiCallLimitError
              ) {
                errors = [error.message];
              } else {
                throw error;
              }
            }
            if (!errors.length) {
              errors = [...options.validate(step.schema, output)];
            }
            if (errors.length) {
              const retries = loaded.run.budget.repairRetries ?? 0;
              if (state.repairs >= retries) {
                await fail('repairs_exhausted');
                break;
              }
              await persist({
                ...state,
                repairs: state.repairs + 1,
                invalid: { output: output ?? null, errors },
              });
              continue;
            }
            await persist({
              ...state,
              phase: 'check',
              pending: {
                output,
                judgedEventId: await judgedEvent(
                  runId,
                  before,
                  state.stepIndex,
                ),
              },
              invalid: null,
            });
            continue;
          }

          // The check phase: the accepted output awaits the host check.
          const pending = state.pending ?? {
            output: null,
            judgedEventId: null,
          };
          let approval: 'approved' | null = null;
          if (state.approval) {
            const decision = await approvalDecision(
              runId,
              state.approval.requestEventId,
            );
            if (decision === 'refused') {
              await fail('check_failed');
              break;
            }
            if (decision !== 'approved') {
              await waitAiRunApproval(db, runId, fenced);
              break;
            }
            approval = 'approved';
            // The decided hold is no longer outstanding; count it once.
            await persist({
              ...state,
              approval: null,
              approvals: (state.approvals ?? 0) + 1,
            });
          }
          const result: WorkflowStepCheck = step.check
            ? await step.check(pending.output, {
                ...base,
                approval,
                approvals: state.approvals ?? 0,
              })
            : {};
          if (controller.signal.aborted) {
            await stopIfRunning('interrupted');
            break;
          }
          const input =
            result.input !== undefined
              ? { input: result.input, inputRef: null }
              : { input: state.input, inputRef: state.inputRef };
          const checkEvent = (status: 'passed' | 'failed') =>
            appendAiRunEvent(
              db,
              runId,
              {
                type: 'check',
                status,
                parentEventId: pending.judgedEventId,
                stepIndex: state.stepIndex,
                name: step.name,
                ...(result.note || result.failure
                  ? {
                      payload: {
                        ...(result.note ? { note: result.note } : {}),
                        ...(result.failure ? { failure: result.failure } : {}),
                      },
                    }
                  : {}),
              },
              fenced,
            );
          if (result.failure !== undefined) {
            await checkEvent('failed');
            await fail('check_failed');
            break;
          }
          if (result.waitingApproval) {
            // Every hold is its own request; one approved earlier never
            // passes a later one (a step may gate several actions).
            const request = await appendAiRunEvent(
              db,
              runId,
              {
                type: 'approval',
                status: 'requested',
                parentEventId: pending.judgedEventId,
                stepIndex: state.stepIndex,
                name: step.name,
                ...(result.note ? { payload: { note: result.note } } : {}),
                ...(result.holdRef ? { payloadRef: result.holdRef } : {}),
              },
              fenced,
            );
            await persist({
              ...state,
              ...input,
              approval: { requestEventId: request.id },
            });
            await waitAiRunApproval(db, runId, fenced);
            break;
          }
          if (result.repeat) {
            await checkEvent('failed');
            if (state.repeats >= (step.maxRepeats ?? 0)) {
              await fail('check_failed');
              break;
            }
            await persist({
              ...state,
              ...input,
              phase: 'call',
              repeats: state.repeats + 1,
              repairs: 0,
              pending: null,
              invalid: null,
              approval: null,
              approvals: 0,
            });
            entered = false;
            continue;
          }
          await checkEvent('passed');
          const outputs = state.outputs.slice(0, state.stepIndex);
          outputs[state.stepIndex] = pending.output;
          if (result.complete) {
            await persist({
              ...state,
              ...input,
              outputs,
              pending: null,
              approval: null,
              approvals: 0,
            });
            await finishAiRun(db, runId, { status: 'done' }, fenced);
            break;
          }
          await persist({
            ...state,
            ...input,
            stepIndex: state.stepIndex + 1,
            phase: 'call',
            repairs: 0,
            repeats: 0,
            outputs,
            pending: null,
            invalid: null,
            approval: null,
            approvals: 0,
          });
          entered = false;
        }
      } catch (error) {
        if (
          error instanceof AiRunClaimLostError ||
          error instanceof RunConflictError
        ) {
          throw error;
        }
        if (!(error instanceof AiRunStoppedError)) {
          if (controller.signal.aborted) await stopIfRunning('interrupted');
          else await fail('error');
        }
        // A stop (a budget limit, a child's stop, a stop or cancel from
        // outside) is already written to the run: it is never a repair.
      } finally {
        if (renewal) clearInterval(renewal);
        runOptions.signal?.removeEventListener('abort', abort);
        if (active.get(runId) === controller) active.delete(runId);
      }
      loaded = await mustLoad(store, runId);
      const finalState = snapshot(loaded);
      await emit(finalState);
      return finalState;
    },

    /** Pause the run (`stopped`, `interrupted`): resumable. */
    async stop(runId: string, ownerId: string): Promise<WorkflowRunState> {
      const store = storeFor(ownerId);
      const { run } = await mustLoad(store, runId);
      if (run.status === 'running' || run.status === 'waiting-approval') {
        await stopAiRun(db, runId, { reason: 'interrupted', from: run.status });
      }
      active.get(runId)?.abort(new Error('Workflow run stopped'));
      return current(store, runId);
    },

    /** End the run for good, with every child run: never resumed or retried. */
    async cancel(runId: string, ownerId: string): Promise<WorkflowRunState> {
      const store = storeFor(ownerId);
      await mustLoad(store, runId);
      await cancelAiRun(db, runId);
      active.get(runId)?.abort(new Error('Workflow run cancelled'));
      return current(store, runId);
    },

    /**
     * Resume a stopped run (page section 7): under this definition version
     * (or one that accepts the checkpoint), with limits only raised and at
     * most to the app's ceiling; a budget stop needs the limit that stopped
     * it raised. Reconciles the run's stale reservations first. Then admit
     * its job again: with `admit`, the status change and `admit`'s writes
     * (the new job) commit in one transaction, so no stale worker's stop
     * can land between them.
     */
    async resume(
      runId: string,
      ownerId: string,
      resumeOptions: {
        budget?: AiRunBudget;
        fence?: AiRunClaimFence;
        admit?: (tx: DatabaseInterface, budget: AiRunBudget) => Promise<void>;
      } = {},
    ): Promise<WorkflowRunState> {
      const store = storeFor(ownerId);
      await mustLoad(store, runId);
      if (active.has(runId)) {
        throw new RunConflictError(
          'The previous run is still stopping. Try again when it has stopped.',
        );
      }
      const resumeWith = (database: DatabaseInterface, reconcile: boolean) =>
        resumeAiRun(database, runId, {
          ...(resumeOptions.budget ? { budget: resumeOptions.budget } : {}),
          ...(options.ceiling ? { ceiling: options.ceiling } : {}),
          definitionVersion: definition.version,
          acceptsVersion,
          ...(resumeOptions.fence ? { fence: resumeOptions.fence } : {}),
          ...(reconcile
            ? {
                reconcile: async (target: DatabaseInterface, id: string) => {
                  await reconcileAiRunOnClaim(target, id);
                },
              }
            : {}),
        });
      const admit = resumeOptions.admit;
      if (!admit) {
        await resumeWith(db, true);
        return current(store, runId);
      }
      await reconcileAiRunOnClaim(db, runId);
      // One accounting transaction for the status change and the enqueue:
      // retried as a whole on a conflict, with PostgreSQL's lock timeout.
      const refused = await withAiRunTransaction(db, async (tx) => {
        let resumed: Awaited<ReturnType<typeof resumeAiRun>>;
        try {
          resumed = await resumeWith(tx.db, false);
        } catch (error) {
          // A refusal may have written its reason (`definition_changed`):
          // commit it, admit nothing, and throw after the commit.
          if (error instanceof AiRunResumeRefusedError) return error;
          throw error;
        }
        await admit(tx.db, resumed.budget);
        return null;
      });
      if (refused) throw refused;
      return current(store, runId);
    },

    /**
     * Record a person's decision on the approval the run waits for (an
     * `approval` event whose parent is the request). Approved: the run goes
     * back to `running` and its next `run` re-runs the check with the
     * approval; refused: the run fails with `check_failed`. A run stopped
     * while it waited keeps the decision and stays stopped: `resume` then
     * continues with it.
     */
    async decide(
      runId: string,
      ownerId: string,
      decision: { approved: boolean; note?: string },
    ): Promise<WorkflowRunState> {
      const store = storeFor(ownerId);
      const loaded = await mustLoad(store, runId);
      const request = loaded.state.approval?.requestEventId;
      const stopped = loaded.run.status === 'stopped';
      if ((loaded.run.status !== 'waiting-approval' && !stopped) || !request) {
        throw new RunConflictError(
          'This workflow run is not waiting for approval',
        );
      }
      if (stopped && (await approvalDecision(runId, request))) {
        throw new RunConflictError('This approval was already decided');
      }
      await appendAiRunEvent(db, runId, {
        type: 'approval',
        status: decision.approved ? 'approved' : 'refused',
        parentEventId: request,
        stepIndex: loaded.state.stepIndex,
        name: stepInfo(loaded.state.stepIndex).name,
        ...(decision.note ? { payload: { note: decision.note } } : {}),
      });
      if (stopped) {
        // A stopped run keeps the decision; `resume` continues with it (an
        // approval re-runs the check, a refusal fails the step).
      } else if (decision.approved) {
        await resumeAiRun(db, runId, {
          definitionVersion: definition.version,
          acceptsVersion,
        });
      } else {
        await finishAiRun(
          db,
          runId,
          { status: 'failed', stopReason: 'check_failed' },
          { from: 'waiting-approval' },
        );
      }
      return current(store, runId);
    },

    /**
     * Retry a failed run from its last accepted step (page section 7): a new
     * durable run naming it in `retry_of_run_id`, inheriting only the
     * accepted outputs of its completed steps; its totals start at zero and
     * the inherited steps are not counted against its `maxSteps`. Refused
     * with `AiRunResumeRefusedError` (`not_retryable`, `definition_changed`,
     * `retry_source_pruned`) and nothing is opened.
     */
    async retry(
      runId: string,
      ownerId: string,
      retryOptions: { id?: string; budget?: AiRunBudget } = {},
    ): Promise<WorkflowRunState> {
      const store = storeFor(ownerId);
      const failed = await store.load(runId);
      if (failed && failed.run.definitionKey !== definition.key) {
        throw new WorkflowRunNotFoundError(runId);
      }
      if (!failed) {
        // Not visible, or pruned: core decides which and refuses.
        const visible = await getAiRun(db, runId);
        if (
          visible &&
          (visible.type !== WORKFLOW_RUN_TYPE ||
            visible.definitionKey !== definition.key ||
            visible.ownerId !== ownerId ||
            (visible.tenantId ?? null) !== tenantId)
        ) {
          throw new WorkflowRunNotFoundError(runId);
        }
      }
      const { run } = await ai.openRun({
        ...(retryOptions.id ? { id: retryOptions.id } : {}),
        type: WORKFLOW_RUN_TYPE,
        definitionKey: definition.key,
        definitionVersion: definition.version,
        ownerId,
        retryOfRunId: runId,
        ...(retryOptions.budget ? { budget: retryOptions.budget } : {}),
        retry: {
          acceptsVersion,
          carry: (checkpoint) => {
            let source = checkpoint.state;
            if (
              checkpoint.definitionVersion !== definition.version &&
              definition.olderCheckpoints &&
              isWorkflowCheckpointState(source)
            ) {
              source = definition.olderCheckpoints.migrate(
                source,
                checkpoint.definitionVersion,
              );
            }
            if (!isWorkflowCheckpointState(source)) {
              throw new TypeError(
                `Workflow run ${runId} has a checkpoint this package cannot read`,
              );
            }
            const stepIndex = source.stepIndex;
            return {
              state: {
                ...initialWorkflowState(source.input, source.inputRef),
                stepIndex,
                outputs: source.outputs.slice(0, stepIndex),
              },
              highestStepIndex: stepIndex > 0 ? stepIndex - 1 : null,
            };
          },
        },
      });
      return current(store, run.id);
    },
  };
}

/** A workflow run driver. */
export type WorkflowRunDriver = ReturnType<typeof createWorkflowRunDriver>;
