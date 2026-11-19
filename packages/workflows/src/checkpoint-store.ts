import {
  type AiRunCheckpoint,
  AiRunCheckpointConflictError,
  type AiRunClaimFence,
  type AiRunRow,
  getAiRun,
  listAiRuns,
  readAiRunCheckpoint,
  saveAiRunCheckpoint,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  WORKFLOW_RUN_TYPE,
  WORKFLOW_STATE_VERSION,
  type WorkflowCheckpointState,
} from './types.js';

/**
 * The run moved on underneath the caller (a checkpoint save from an older
 * revision, a run that is no longer where the caller expected, another
 * worker still holding it). Reload its current state.
 */
export class RunConflictError extends Error {
  constructor(message = 'Workflow run changed; reload its current status') {
    super(message);
    this.name = 'RunConflictError';
  }
}

/** A workflow run is not visible to this owner and tenant. */
export class WorkflowRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super('Workflow run not found');
    this.name = 'WorkflowRunNotFoundError';
  }
}

/** One workflow run with its checkpoint. */
export interface LoadedWorkflowRun {
  run: AiRunRow;
  checkpoint: AiRunCheckpoint;
  state: WorkflowCheckpointState;
}

/** Input of {@link RunCheckpointStore.save}. */
export interface SaveRunCheckpointInput {
  expectedRevision: number;
  state: WorkflowCheckpointState;
  lease?: string | null;
  definitionVersion?: string | null;
}

/** Owner- and tenant-scoped access to workflow checkpoints. */
export interface RunCheckpointStore {
  readonly db: DatabaseInterface;
  readonly ownerId: string;
  readonly tenantId: string | null;
  /** The run and its checkpoint, or null when this owner cannot see it. */
  load(runId: string): Promise<LoadedWorkflowRun | null>;
  /**
   * Save with the run row, compare-and-swap on `expectedRevision`, after the
   * claim fence. Throws {@link RunConflictError} when another save won; an
   * `AiRunStoppedError` when the run is no longer `running`.
   */
  save(runId: string, input: SaveRunCheckpointInput): Promise<number>;
}

/** Options of {@link createRunCheckpointStore}. */
export interface RunCheckpointStoreOptions {
  db: DatabaseInterface;
  /** The authenticated owner; never taken from model or tool arguments. */
  ownerId: string;
  tenantId?: string | null;
  /** The job claim of the worker running the run (claim fencing). */
  fence?: AiRunClaimFence;
}

/** Whether a stored state has the workflow state's shape. */
export function isWorkflowCheckpointState(
  value: unknown,
): value is WorkflowCheckpointState {
  const state = value as Partial<WorkflowCheckpointState> | null;
  return Boolean(
    state &&
      typeof state === 'object' &&
      state.v === WORKFLOW_STATE_VERSION &&
      Number.isSafeInteger(state.stepIndex) &&
      (state.stepIndex as number) >= 0 &&
      (state.phase === 'call' || state.phase === 'check') &&
      Number.isSafeInteger(state.repairs) &&
      Number.isSafeInteger(state.repeats) &&
      Array.isArray(state.outputs) &&
      (state.inputRef === null || typeof state.inputRef === 'string'),
  );
}

/**
 * Workflow checkpoints in core's `_smrt_ai_run_checkpoints`, scoped to one
 * authenticated owner and tenant. It creates no schema: the table is core
 * system DDL.
 */
export function createRunCheckpointStore(
  options: RunCheckpointStoreOptions,
): RunCheckpointStore {
  if (!options.ownerId) throw new Error('Workflow runs require an owner');
  const tenantId = options.tenantId ?? null;
  return {
    db: options.db,
    ownerId: options.ownerId,
    tenantId,
    async load(runId) {
      // Looked up in the store's tenant first (a SQL predicate): a run of
      // another tenant is not read, only not found.
      const listed = await listAiRuns(options.db, {
        id: runId,
        tenantId,
        limit: 1,
      });
      if (listed.length === 0) return null;
      const run = await getAiRun(options.db, runId);
      if (
        !run ||
        run.type !== WORKFLOW_RUN_TYPE ||
        run.ownerId !== options.ownerId ||
        (run.tenantId ?? null) !== tenantId
      ) {
        return null;
      }
      const checkpoint = await readAiRunCheckpoint(options.db, runId);
      // The checkpoint is read by run id alone, so the run is read again
      // afterwards: it must be the same row (same tenant, owner, type and
      // creation) before and after, else the id changed hands in between
      // (pruned and reused) and the checkpoint is not this run's.
      const after = await getAiRun(options.db, runId);
      if (
        !after ||
        after.createdAt.getTime() !== run.createdAt.getTime() ||
        after.startedAt.getTime() !== run.startedAt.getTime() ||
        after.type !== run.type ||
        after.ownerId !== run.ownerId ||
        (after.tenantId ?? null) !== tenantId
      ) {
        return null;
      }
      if (!checkpoint) return null;
      if (!isWorkflowCheckpointState(checkpoint.state)) {
        throw new TypeError(
          `Workflow run ${runId} has a checkpoint this package cannot read`,
        );
      }
      return { run, checkpoint, state: checkpoint.state };
    },
    async save(runId, input) {
      try {
        return await saveAiRunCheckpoint(options.db, runId, {
          expectedRevision: input.expectedRevision,
          state: input.state,
          ...(input.lease !== undefined ? { lease: input.lease } : {}),
          ...(input.definitionVersion !== undefined
            ? { definitionVersion: input.definitionVersion }
            : {}),
          ...(options.fence ? { fence: options.fence } : {}),
        });
      } catch (error) {
        if (error instanceof AiRunCheckpointConflictError) {
          throw new RunConflictError();
        }
        throw error;
      }
    },
  };
}
