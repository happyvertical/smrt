/**
 * The AI run lifecycle (#5005; page sections 2, 6.2, 6.3 and 7): opening a
 * run, guarded status changes, steps, checkpoints, resuming and retrying.
 *
 * **Every status change is guarded.** It is a conditional update from the
 * status the writer expects (`... WHERE id = $1 AND status = $2`); when the
 * run has moved on, nothing is written and the change is refused. The moves
 * the transition table allows are in {@link AI_RUN_TRANSITIONS}; anything
 * else throws {@link AiRunTransitionError}.
 *
 * **Durable** is a property of a run: a durable run keeps a checkpoint row
 * (`_smrt_ai_run_checkpoints`), written with the run row when it opens. That
 * row is what makes it durable; there is no separate flag.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { insertAiRunEventTx } from './ai-run-events.js';
import {
  AI_RUN_FINAL_STATUSES,
  AI_RUN_LIMIT_REASONS,
  AI_RUN_STOP_REASONS,
  type AiRunBudget,
  type AiRunBudgetLimit,
  AiRunCheckpointConflictError,
  type AiRunClaimFence,
  AiRunNotFoundError,
  type AiRunReadScope,
  AiRunResumeRefusedError,
  type AiRunRow,
  type AiRunStatus,
  type AiRunStopDetail,
  AiRunStoppedError,
  type AiRunStopReason,
  AiRunTrackingDisabledError,
  AiRunTransitionError,
  type AiRunTx,
  type AiRunTxOptions,
  aiRunActiveTime,
  aiRunQuery,
  aiRunScopeClause,
  assertAiRunFence,
  assertAiRunId,
  expectedTenantOf,
  foldActive,
  getRows,
  insertAiRunRowTx,
  isAiRunFinal,
  isValidAiRunType,
  lockAiRun,
  lockAiRunChainFenced,
  newAiRunId,
  normalizeAiRunBudget,
  num,
  parseJsonObject,
  readAiRunChainIdsInTenant,
  readAiRunDescendantIds,
  text,
  withAiRunTransaction,
  writeAiRunTotals,
} from './ai-run-model.js';

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * The allowed moves (page section 2). `durableOnly` moves are refused for a
 * run without a checkpoint.
 */
export const AI_RUN_TRANSITIONS: Readonly<
  Record<AiRunStatus, ReadonlyArray<{ to: AiRunStatus; durableOnly?: true }>>
> = Object.freeze({
  running: [
    { to: 'waiting-approval', durableOnly: true },
    { to: 'stopped' },
    { to: 'cancelled' },
    { to: 'failed' },
    { to: 'done' },
  ],
  'waiting-approval': [
    { to: 'running' },
    { to: 'stopped' },
    { to: 'cancelled' },
    { to: 'failed' },
  ],
  stopped: [
    { to: 'running', durableOnly: true },
    { to: 'cancelled', durableOnly: true },
  ],
  cancelled: [],
  failed: [],
  done: [],
});

/** Whether the table allows `from` to `to` for a run of this durability. */
export function isAiRunTransitionAllowed(
  from: AiRunStatus,
  to: AiRunStatus,
  durable: boolean,
): boolean {
  const move = AI_RUN_TRANSITIONS[from]?.find((entry) => entry.to === to);
  return Boolean(move && (!move.durableOnly || durable));
}

/** The stop fields a status change writes. */
export interface AiRunStopFields {
  stopReason?: AiRunStopReason | null;
  stoppedByRunId?: string | null;
  stopDetail?: AiRunStopDetail | null;
  degraded?: boolean;
}

function checkReason(to: AiRunStatus, reason: AiRunStopReason | null): void {
  if (to === 'running' || to === 'waiting-approval' || to === 'done') {
    if (reason !== null) {
      throw new TypeError(`A run moving to ${to} carries no stop reason`);
    }
    return;
  }
  const allowed = AI_RUN_STOP_REASONS[to];
  if (!reason || !allowed.includes(reason)) {
    throw new TypeError(
      `A run moving to ${to} needs one of: ${allowed.join(', ')}`,
    );
  }
}

/**
 * The guarded status write, inside an accounting transaction that holds the
 * run's row lock. Returns false (and writes nothing) when the row is no
 * longer in `run.status`. Folds the open active period; leaving `running`
 * closes it, entering `running` opens a new one.
 */
export async function writeAiRunStatusTx(
  tx: AiRunTx,
  run: AiRunRow,
  to: AiRunStatus,
  fields: AiRunStopFields = {},
): Promise<boolean> {
  const from = run.status;
  if (!isAiRunTransitionAllowed(from, to, run.durable)) {
    throw new AiRunTransitionError(
      `AI run ${run.id} cannot move from ${from} to ${to}${
        run.durable ? '' : ' (it is not durable)'
      }`,
      run.id,
      from,
      to,
    );
  }
  const reason = fields.stopReason ?? null;
  checkReason(to, reason);
  const folded = foldActive(run, tx.now);
  const activeSince = to === 'running' ? tx.now.toISOString() : null;
  const final =
    AI_RUN_FINAL_STATUSES.includes(to) || (to === 'stopped' && !run.durable);
  const clear = to === 'running' || to === 'waiting-approval';
  const rows = getRows(
    await aiRunQuery(
      tx.db,
      `UPDATE _smrt_ai_runs
          SET status = $3, stop_reason = $4, stopped_by_run_id = $5,
              stop_detail = $6, duration = $7, active_since = $8,
              finished_at = $9, degraded = $10
        WHERE id = $1 AND status = $2
        RETURNING id`,
      run.id,
      from,
      to,
      clear ? null : reason,
      clear ? null : (fields.stoppedByRunId ?? null),
      clear || !fields.stopDetail ? null : JSON.stringify(fields.stopDetail),
      folded.duration,
      activeSince,
      final ? tx.now.toISOString() : null,
      (fields.degraded ?? run.degraded) ? 1 : 0,
    ),
  );
  if (rows.length === 0) return false;
  run.status = to;
  run.stopReason = clear ? null : reason;
  run.stoppedByRunId = clear ? null : (fields.stoppedByRunId ?? null);
  run.stopDetail = clear ? null : (fields.stopDetail ?? null);
  run.duration = folded.duration;
  run.activeSince = activeSince ? new Date(activeSince) : null;
  run.finishedAt = final ? tx.now : null;
  if (fields.degraded !== undefined) run.degraded = fields.degraded;
  return true;
}

/** The {@link AiRunStoppedError} describing a run's current state. */
export function aiRunStoppedError(run: AiRunRow): AiRunStoppedError {
  return new AiRunStoppedError({
    runId: run.id,
    status: run.status,
    stopReason: run.stopReason,
    stoppedByRunId: run.stoppedByRunId,
    stopDetail: run.stopDetail,
  });
}

/**
 * The stop a run takes from an ancestor that is no longer `running` (page
 * section 6.2): `cancelled` under a cancelled ancestor, else `stopped` with
 * the ancestor's stop reason, copying its `stopped_by_run_id` and
 * `stop_detail`. An ancestor that ended some other way (`failed`, `done`,
 * `waiting-approval`) gives `stopped` with `interrupted`: nothing under it
 * may spend more.
 */
export function inheritedStop(ancestor: AiRunRow): {
  to: 'stopped' | 'cancelled';
  fields: AiRunStopFields;
} {
  if (ancestor.status === 'cancelled') {
    return {
      to: 'cancelled',
      fields: {
        stopReason: 'cancelled',
        stoppedByRunId: ancestor.stoppedByRunId ?? ancestor.id,
        stopDetail: ancestor.stopDetail,
      },
    };
  }
  const stopReason =
    ancestor.status === 'stopped' && ancestor.stopReason
      ? ancestor.stopReason
      : 'interrupted';
  return {
    to: 'stopped',
    fields: {
      stopReason,
      stoppedByRunId: ancestor.stoppedByRunId ?? ancestor.id,
      stopDetail: ancestor.status === 'stopped' ? ancestor.stopDetail : null,
    },
  };
}

/**
 * The chain check every reservation and step start makes (page section
 * 6.4 steps 3-4): the calling run must be `running` (else the caller is
 * refused and nothing is written) and so must every ancestor (else the
 * calling run takes the ancestor's stop). Returns the error to throw after
 * commit, or `null` when the chain may go on.
 */
export async function checkAiRunChainRunning(
  tx: AiRunTx,
  chain: AiRunRow[],
): Promise<AiRunStoppedError | null> {
  const run = chain[chain.length - 1] as AiRunRow;
  if (run.status !== 'running') return aiRunStoppedError(run);
  const ancestor = chain
    .slice(0, -1)
    .find((candidate) => candidate.status !== 'running');
  if (!ancestor) return null;
  const { to, fields } = inheritedStop(ancestor);
  await writeAiRunStatusTx(tx, run, to, fields);
  return aiRunStoppedError(run);
}

/** Stop the calling run at a limit and describe it. */
export async function stopAiRunAtLimitTx(
  tx: AiRunTx,
  run: AiRunRow,
  detail: AiRunStopDetail,
): Promise<AiRunStoppedError> {
  await writeAiRunStatusTx(tx, run, 'stopped', {
    stopReason: AI_RUN_LIMIT_REASONS[detail.limit],
    stoppedByRunId: detail.runId,
    stopDetail: detail,
  });
  return aiRunStoppedError(run);
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/** The envelope version of a checkpoint's `state`. */
export const AI_RUN_CHECKPOINT_ENVELOPE_VERSION = 1;

/** A durable run's saved state (page section 7). */
export interface AiRunCheckpoint {
  runId: string;
  revision: number;
  lease: string | null;
  lastSeq: number;
  definitionVersion: string | null;
  /**
   * The highest step index counted against `maxSteps` (page section 6.3); a
   * step is new exactly when its index is greater. NULL before the first.
   */
  highestStepIndex: number | null;
  /** The run type's own state. */
  state: unknown;
}

function envelope(highestStepIndex: number | null, state: unknown): string {
  return JSON.stringify({
    v: AI_RUN_CHECKPOINT_ENVELOPE_VERSION,
    highestStepIndex,
    state: state ?? null,
  });
}

function toCheckpoint(row: Record<string, unknown>): AiRunCheckpoint {
  const parsed =
    parseJsonObject<{
      v?: number;
      highestStepIndex?: unknown;
      state?: unknown;
    }>(row.state) ?? {};
  if (
    parsed.v !== undefined &&
    parsed.v !== AI_RUN_CHECKPOINT_ENVELOPE_VERSION
  ) {
    throw new TypeError(
      `AI run ${String(row.run_id)} checkpoint has envelope v${parsed.v}`,
    );
  }
  const highest = parsed.highestStepIndex;
  return {
    runId: String(row.run_id),
    revision: num(row.revision),
    lease: text(row.lease),
    lastSeq: num(row.last_seq),
    definitionVersion: text(row.definition_version),
    highestStepIndex:
      highest === null || highest === undefined ? null : num(highest),
    state: parsed.state ?? null,
  };
}

/**
 * Read a run's checkpoint, or `null` (not durable, or pruned). With
 * `scope`, the checkpoint is read joined to its run within that scope, in
 * one statement: the checkpoint of a run outside it is never read.
 */
export async function readAiRunCheckpoint(
  db: DatabaseInterface,
  runId: string,
  scope?: AiRunReadScope,
): Promise<AiRunCheckpoint | null> {
  const scoped = aiRunScopeClause(scope, 2);
  const rows = getRows(
    await aiRunQuery(
      db,
      scope
        ? `SELECT c.* FROM _smrt_ai_run_checkpoints c
             JOIN _smrt_ai_runs r ON r.id = c.run_id
            WHERE c.run_id = $1${scoped.sql}`
        : 'SELECT * FROM _smrt_ai_run_checkpoints WHERE run_id = $1',
      runId,
      ...scoped.params,
    ),
  );
  return rows[0] ? toCheckpoint(rows[0]) : null;
}

async function writeCheckpointTx(
  tx: AiRunTx,
  current: AiRunCheckpoint,
  next: {
    expectedRevision?: number;
    state?: unknown;
    highestStepIndex?: number | null;
    lastSeq?: number;
    lease?: string | null;
    definitionVersion?: string | null;
  },
): Promise<number> {
  const expected = next.expectedRevision ?? current.revision;
  const version =
    next.definitionVersion !== undefined
      ? next.definitionVersion
      : current.definitionVersion;
  const rows = getRows(
    await aiRunQuery(
      tx.db,
      `UPDATE _smrt_ai_run_checkpoints
          SET revision = $3, state = $4, last_seq = $5, lease = $6,
              definition_version = $7
        WHERE run_id = $1 AND revision = $2
        RETURNING revision`,
      current.runId,
      expected,
      expected + 1,
      envelope(
        next.highestStepIndex !== undefined
          ? next.highestStepIndex
          : current.highestStepIndex,
        next.state !== undefined ? next.state : current.state,
      ),
      next.lastSeq ?? current.lastSeq,
      next.lease !== undefined ? next.lease : current.lease,
      version,
    ),
  );
  if (rows.length === 0) {
    throw new AiRunCheckpointConflictError(current.runId, expected);
  }
  if (version !== current.definitionVersion) {
    // The run row names the definition version its checkpoint now holds.
    await aiRunQuery(
      tx.db,
      'UPDATE _smrt_ai_runs SET definition_version = $2 WHERE id = $1',
      current.runId,
      version,
    );
  }
  return expected + 1;
}

/** Input of {@link saveAiRunCheckpoint}. */
export interface SaveAiRunCheckpointInput {
  /** The revision the caller read; a save from an older one fails. */
  expectedRevision: number;
  state: unknown;
  lastSeq?: number;
  lease?: string | null;
  /**
   * The definition version the saved state now belongs to: a newer version
   * that accepted an older checkpoint and migrated its state (page section
   * 7) records itself here, on the checkpoint and the run row, so the next
   * resume compares against it. Unchanged when absent.
   */
  definitionVersion?: string | null;
  fence?: AiRunClaimFence;
}

/**
 * Save a durable run's checkpoint with its run row, in one transaction
 * (page section 7): compare-and-swap on `revision`, after the claim fence.
 * Only a `running` run writes. Returns the new revision.
 */
export async function saveAiRunCheckpoint(
  db: DatabaseInterface,
  runId: string,
  input: SaveAiRunCheckpointInput,
  options: AiRunTxOptions = {},
): Promise<number> {
  const result = await withAiRunTransaction(
    db,
    async (tx) => {
      const chain = await lockAiRunChainFenced(tx, runId, input.fence);
      const run = chain[chain.length - 1] as AiRunRow;
      if (run.status !== 'running') return aiRunStoppedError(run);
      const current = await readAiRunCheckpoint(tx.db, runId);
      if (!current) {
        throw new AiRunTransitionError(
          `AI run ${runId} is not durable: it has no checkpoint`,
          runId,
          run.status,
          run.status,
        );
      }
      await writeAiRunTotals(tx, run);
      return writeCheckpointTx(tx, current, {
        expectedRevision: input.expectedRevision,
        state: input.state,
        ...(input.lastSeq !== undefined ? { lastSeq: input.lastSeq } : {}),
        ...(input.lease !== undefined ? { lease: input.lease } : {}),
        ...(input.definitionVersion !== undefined
          ? { definitionVersion: input.definitionVersion }
          : {}),
      });
    },
    options,
  );
  if (result instanceof AiRunStoppedError) throw result;
  return result;
}

// ---------------------------------------------------------------------------
// Opening a run
// ---------------------------------------------------------------------------

/**
 * Where runs are kept: one database (so one tenant's data), with usage
 * tracking said on or off. A run needs usage tracking (page section 3).
 */
export interface AiRunStore {
  db: DatabaseInterface | null | undefined;
  /** Usage persistence for this database. */
  usageTracking: boolean;
  tenantId?: string | null;
  className?: string | null;
}

/** Input of {@link openAiRun}. */
export interface OpenAiRunInput {
  id?: string;
  /** `fusion`, `turn`, `workflow`, or an owner's `@scope/pkg:type`. */
  type: string;
  definitionKey?: string | null;
  definitionVersion?: string | null;
  promptKey?: string | null;
  templateHash?: string | null;
  ownerId?: string | null;
  parentRunId?: string | null;
  experimentId?: string | null;
  datasetItem?: string | null;
  /** What was varied, for comparison. */
  tags?: Record<string, unknown>;
  budget?: AiRunBudget;
  /** Keep a checkpoint and allow resuming and waiting for approval. */
  durable?: boolean;
  /** A durable run's first state (the run type's own). */
  checkpoint?: { state?: unknown; lease?: string | null };
  /** Fusion runs only. */
  mode?: string | null;
  /**
   * A child run answering an entry call of its parent (page section 2): the
   * `handoff` event written in the parent, in the same transaction as the
   * child's row, with `child_run_id` the new run, `call_id` the entry call
   * and status `running`. Needs `parentRunId`.
   */
  handoff?: {
    /** Minted when absent. */
    eventId?: string;
    callId?: string | null;
    name?: string | null;
    stepIndex?: number | null;
    parentEventId?: string | null;
  };
  /**
   * Open a retry of this failed durable workflow run (page section 7). The
   * new run is durable and its first checkpoint carries what
   * `retry.carry` takes from the failed run's checkpoint.
   */
  retryOfRunId?: string | null;
  retry?: {
    /**
     * Whether a checkpoint written by `version` is accepted by the current
     * definition (`definitionVersion`). Default: only an equal version.
     */
    acceptsVersion?: (version: string | null) => boolean;
    /**
     * The new run's first state and its highest counted step index, from
     * the failed run's checkpoint: the accepted outputs of the completed
     * steps (the workflow owns the shape). Default: the failed state and
     * its highest counted step, unchanged.
     */
    carry?: (failed: AiRunCheckpoint) => {
      state: unknown;
      highestStepIndex: number | null;
    };
  };
}

/** Throw unless the store can hold runs. */
export function assertAiRunTracking(
  store: AiRunStore,
): asserts store is AiRunStore & { db: DatabaseInterface } {
  if (!store.usageTracking || !store.db) {
    throw new AiRunTrackingDisabledError({
      usageTracking: store.usageTracking,
      database: Boolean(store.db),
    });
  }
}

/**
 * Open a run: insert its row as `running` (and, for a durable run, its
 * checkpoint in the same transaction). Throws
 * {@link AiRunTrackingDisabledError} when usage tracking is off, before
 * anything is written or sent.
 */
export async function openAiRun(
  store: AiRunStore,
  input: OpenAiRunInput,
  options: AiRunTxOptions = {},
): Promise<AiRunRow> {
  // One snapshot of the store and the input: every public property is read
  // exactly once, here, whether it is an own field or a getter, and the
  // values validated below are the ones written, even if the caller's
  // objects change while this runs (a retry's `carry` callback runs in the
  // middle). A getter that throws fails the open before anything is read
  // from or written to the database.
  const scope = snapshotStore(store);
  const req = snapshotInput(input);
  assertAiRunTracking(scope);
  if (typeof req.type !== 'string' || !isValidAiRunType(req.type)) {
    throw new TypeError(
      `openAiRun: type must be fusion, turn, workflow or @scope/pkg:type, got ${String(req.type)}`,
    );
  }
  const budget = normalizeAiRunBudget(req.budget, 'openAiRun: budget');
  // A caller-chosen id is checked before anything is read or written; it
  // must never have named a run (insertAiRunRowTx, page section 8).
  const id =
    req.id === undefined ? newAiRunId() : assertAiRunId(req.id, 'openAiRun');
  const retryOf = req.retryOfRunId ?? null;
  const durable = Boolean(req.durable) || retryOf !== null;
  if (retryOf && req.type !== 'workflow') {
    throw new AiRunResumeRefusedError(
      'Only a workflow run is retried',
      retryOf,
      'not_retryable',
    );
  }
  if (req.handoff && !req.parentRunId) {
    throw new TypeError('openAiRun: a handoff needs parentRunId');
  }
  // Serialized before the transaction: a payload that cannot be written
  // fails here, never between two writes of a caller-owned transaction.
  const tagsJson = req.tags ? JSON.stringify(req.tags) : null;
  const budgetJson = JSON.stringify(budget);
  const tenantId = scope.tenantId ?? null;

  return withAiRunTransaction(
    scope.db,
    async (tx) => {
      let initial: { state: unknown; highestStepIndex: number | null } = {
        state: req.checkpoint?.state ?? null,
        highestStepIndex: null,
      };
      const locked = new Map<string, AiRunRow | null>();
      const requested = [req.parentRunId, retryOf].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      );
      // A referenced run of another tenant (global `null` included) is
      // treated exactly as a run that is not there: the new run is written
      // under the store's tenant, so a parent or retry source must share it.
      // Each is first looked up in that tenant (a SQL predicate): another
      // tenant's run is never read or locked, and neither its ancestry nor
      // its status, definition or checkpoint is read, so a refusal says
      // nothing about it.
      const targets: string[] = [];
      for (const id of new Set(requested)) {
        const found = getRows(
          await aiRunQuery(
            tx.db,
            `SELECT id FROM _smrt_ai_runs WHERE id = $1 AND ${
              tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = $2'
            }`,
            id,
            ...(tenantId === null ? [] : [tenantId]),
          ),
        );
        if (found.length > 0) targets.push(id);
        else locked.set(id, null);
      }
      // The parent and the retried run are locked in the page's order:
      // by depth, then id. Depth is walked in the run's tenant.
      const depths = new Map<string, number>();
      for (const id of targets) {
        const ids = await readAiRunChainIdsInTenant(tx.db, id, tenantId).catch(
          (error) => {
            if (error instanceof AiRunNotFoundError) return [id];
            throw error;
          },
        );
        depths.set(id, ids.length);
      }
      for (const id of targets.sort(
        (a, b) =>
          (depths.get(a) ?? 0) - (depths.get(b) ?? 0) || a.localeCompare(b),
      )) {
        // Locked in the tenant it was read in: a row that left the tenant
        // since is not locked, and reads as absent.
        locked.set(id, await lockAiRun(tx, id, tenantId));
      }
      if (req.parentRunId) {
        const parent = locked.get(req.parentRunId);
        if (!parent) throw new AiRunNotFoundError(req.parentRunId);
        if (parent.status !== 'running') throw aiRunStoppedError(parent);
      }
      if (retryOf) {
        initial = await retryStartTx(
          tx,
          locked.get(retryOf) ?? null,
          retryOf,
          req,
        );
      }
      // The first checkpoint is serialized before the first write too.
      const checkpointJson = durable
        ? envelope(initial.highestStepIndex, initial.state)
        : null;
      const now = tx.now.toISOString();
      // The id's digest is reserved in this transaction, before the row.
      await insertAiRunRowTx(tx, {
        id,
        type: req.type,
        definition_key: req.definitionKey ?? null,
        definition_version: req.definitionVersion ?? null,
        tenant_id: tenantId,
        class_name: scope.className ?? null,
        prompt_key: req.promptKey ?? null,
        template_hash: req.templateHash ?? null,
        owner_id: req.ownerId ?? null,
        parent_run_id: req.parentRunId ?? null,
        retry_of_run_id: retryOf,
        experiment_id: req.experimentId ?? null,
        dataset_item: req.datasetItem ?? null,
        tags: tagsJson,
        status: 'running',
        budget: budgetJson,
        active_since: now,
        started_at: now,
        created_at: now,
        mode: req.mode ?? null,
      });
      if (checkpointJson !== null) {
        await aiRunQuery(
          tx.db,
          `INSERT INTO _smrt_ai_run_checkpoints
             (run_id, revision, lease, last_seq, definition_version, state)
           VALUES ($1, 0, $2, 0, $3, $4)`,
          id,
          req.checkpoint?.lease ?? null,
          req.definitionVersion ?? null,
          checkpointJson,
        );
      }
      if (req.parentRunId && req.handoff) {
        // The parent's row is locked above, as every write of its events.
        await insertAiRunEventTx(tx, req.parentRunId, {
          id: req.handoff.eventId ?? newAiRunId(),
          type: 'handoff',
          childRunId: id,
          callId: req.handoff.callId ?? null,
          name: req.handoff.name ?? null,
          stepIndex: req.handoff.stepIndex ?? null,
          parentEventId: req.handoff.parentEventId ?? null,
          status: 'running',
        });
      }
      // The row returned is the one this transaction inserted, read before
      // it commits and in its tenant.
      const row = await lockAiRun(tx, id, tenantId);
      if (!row) throw new AiRunNotFoundError(id);
      return row;
    },
    options,
  );
}

/**
 * Every key of `T`, required to be present, with its declared value type
 * (an optional key may hold `undefined`). An object literal checked with
 * `satisfies Snapshot<T>` names every key of `T`, so a key added to `T`
 * later fails to compile until the snapshot copies it.
 */
type Snapshot<T> = { [K in keyof Required<T>]: T[K] };

/** Read each public property of the store exactly once. */
function snapshotStore(store: AiRunStore): AiRunStore {
  return {
    db: store.db,
    usageTracking: store.usageTracking,
    tenantId: store.tenantId,
    className: store.className,
  } satisfies Snapshot<AiRunStore>;
}

/**
 * Read each property of the input exactly once (own fields and getters
 * alike), copying the nested objects the open reads later. A callback keeps
 * its receiver.
 */
function snapshotInput(input: OpenAiRunInput): OpenAiRunInput {
  const tags = input.tags;
  const checkpoint = input.checkpoint;
  const handoff = input.handoff;
  const retry = input.retry;
  return {
    id: input.id,
    type: input.type,
    definitionKey: input.definitionKey,
    definitionVersion: input.definitionVersion,
    promptKey: input.promptKey,
    templateHash: input.templateHash,
    ownerId: input.ownerId,
    parentRunId: input.parentRunId,
    experimentId: input.experimentId,
    datasetItem: input.datasetItem,
    tags: tags ? { ...tags } : undefined,
    budget: input.budget,
    durable: input.durable,
    checkpoint: checkpoint
      ? ({
          state: checkpoint.state,
          lease: checkpoint.lease,
        } satisfies Snapshot<NonNullable<OpenAiRunInput['checkpoint']>>)
      : undefined,
    mode: input.mode,
    handoff: handoff
      ? ({
          eventId: handoff.eventId,
          callId: handoff.callId,
          name: handoff.name,
          stepIndex: handoff.stepIndex,
          parentEventId: handoff.parentEventId,
        } satisfies Snapshot<NonNullable<OpenAiRunInput['handoff']>>)
      : undefined,
    retryOfRunId: input.retryOfRunId,
    retry: retry ? snapshotRetry(retry) : undefined,
  } satisfies Snapshot<OpenAiRunInput>;
}

function snapshotRetry(
  retry: NonNullable<OpenAiRunInput['retry']>,
): NonNullable<OpenAiRunInput['retry']> {
  const acceptsVersion = retry.acceptsVersion;
  const carry = retry.carry;
  return {
    acceptsVersion: acceptsVersion?.bind(retry),
    carry: carry?.bind(retry),
  } satisfies Snapshot<NonNullable<OpenAiRunInput['retry']>>;
}

async function retryStartTx(
  tx: AiRunTx,
  failed: AiRunRow | null,
  failedId: string,
  input: OpenAiRunInput,
): Promise<{ state: unknown; highestStepIndex: number | null }> {
  const refuse = (
    message: string,
    reason: 'not_retryable' | 'definition_changed' | 'retry_source_pruned',
  ) => new AiRunResumeRefusedError(message, failedId, reason);
  if (!failed) {
    throw refuse(
      `AI run ${failedId} is gone (pruned); there is nothing to retry from`,
      'retry_source_pruned',
    );
  }
  // A retry runs for the failed run's own owner: compared under the source
  // lock, before its checkpoint is read or `carry` sees it. An owner
  // omitted on either side is `null`, so an ownerless run is still retried
  // without naming one, and a named owner never matches an ownerless run.
  if ((failed.ownerId ?? null) !== (input.ownerId ?? null)) {
    throw refuse(
      `A retry of ${failedId} must run for the failed run's owner`,
      'not_retryable',
    );
  }
  if (failed.status !== 'failed') {
    throw refuse(
      `AI run ${failedId} is ${failed.status}, not failed`,
      'not_retryable',
    );
  }
  if (failed.type !== 'workflow') {
    throw refuse(`AI run ${failedId} is not a workflow run`, 'not_retryable');
  }
  if ((input.definitionKey ?? null) !== failed.definitionKey) {
    throw refuse(
      `A retry of ${failedId} must run the failed run's definition`,
      'not_retryable',
    );
  }
  const checkpoint = await readAiRunCheckpoint(tx.db, failedId);
  if (!checkpoint) {
    throw refuse(
      `AI run ${failedId} has no checkpoint to retry from (pruned)`,
      'retry_source_pruned',
    );
  }
  const version = input.definitionVersion ?? null;
  const accepts =
    input.retry?.acceptsVersion ??
    ((saved: string | null) => saved === version);
  if (!accepts(checkpoint.definitionVersion)) {
    throw refuse(
      `AI run ${failedId} was saved by definition version ${String(
        checkpoint.definitionVersion,
      )}, which ${String(version)} does not accept`,
      'definition_changed',
    );
  }
  return input.retry?.carry
    ? input.retry.carry(checkpoint)
    : {
        state: checkpoint.state,
        highestStepIndex: checkpoint.highestStepIndex,
      };
}

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

/** Input of {@link transitionAiRun}. */
export interface AiRunTransition extends AiRunStopFields {
  /** The status the writer expects the run to be in. */
  from: AiRunStatus;
  to: AiRunStatus;
}

/**
 * One guarded status change. Returns the run after the change, or `null`
 * when the run was not in `from` (it moved on; nothing was written). An
 * illegal move throws {@link AiRunTransitionError}. With `options.fence`, a
 * worker whose job claim was taken over gets `AiRunClaimLostError`
 * before the run is read, and nothing is written.
 */
export async function transitionAiRun(
  db: DatabaseInterface,
  runId: string,
  change: AiRunTransition,
  options: AiRunTxOptions = {},
): Promise<AiRunRow | null> {
  return withAiRunTransaction(
    db,
    async (tx) => {
      await assertAiRunFence(tx, runId, options.fence);
      const run = await lockAiRun(tx, runId);
      if (!run) throw new AiRunNotFoundError(runId);
      if (run.status !== change.from) return null;
      const { from: _from, to, ...fields } = change;
      return (await writeAiRunStatusTx(tx, run, to, fields)) ? run : null;
    },
    options,
  );
}

/**
 * Pause a run (page section 2): `stopped` with `interrupted` (or
 * `definition_changed`). Resumable when durable; final when not.
 */
export async function stopAiRun(
  db: DatabaseInterface,
  runId: string,
  options: AiRunTxOptions & {
    reason?: 'interrupted' | 'definition_changed';
    from?: 'running' | 'waiting-approval';
  } = {},
): Promise<AiRunRow | null> {
  return transitionAiRun(
    db,
    runId,
    {
      from: options.from ?? 'running',
      to: 'stopped',
      stopReason: options.reason ?? 'interrupted',
      stoppedByRunId: runId,
    },
    options,
  );
}

/**
 * End a run for good, with every descendant that is not final (page section
 * 2): in one transaction the run moves to `cancelled` with `cancelled` and
 * `stopped_by_run_id` itself, and each descendant that is `running`,
 * `waiting-approval` or a durable `stopped` moves to `cancelled` with
 * `cancelled`, `stopped_by_run_id` the cancelled run, `stop_detail` NULL and
 * `finished_at` set. A descendant already final is left as it is. Cancel is
 * the one transaction that locks a subtree: the run, then its descendants by
 * increasing depth and, within a depth, increasing id (section 6.5). Calls a
 * cancelled descendant has in flight still settle. Returns null when the run
 * is already final (a stopped run that is not durable is final too); a
 * descendant opened while the cancel ran is left to the `ai-runs` sweep.
 */
export async function cancelAiRun(
  db: DatabaseInterface,
  runId: string,
  options: AiRunTxOptions = {},
): Promise<AiRunRow | null> {
  return withAiRunTransaction(
    db,
    async (tx) => {
      await assertAiRunFence(tx, runId, options.fence);
      const run = await lockAiRun(tx, runId);
      if (!run) throw new AiRunNotFoundError(runId);
      if (!isAiRunTransitionAllowed(run.status, 'cancelled', run.durable)) {
        return null;
      }
      if (
        !(await writeAiRunStatusTx(tx, run, 'cancelled', {
          stopReason: 'cancelled',
          stoppedByRunId: runId,
        }))
      ) {
        return null;
      }
      for (const id of await readAiRunDescendantIds(tx.db, runId)) {
        // Each descendant is locked in the run's tenant, as it was found.
        const descendant = await lockAiRun(tx, id, run.tenantId ?? null);
        if (!descendant || isAiRunFinal(descendant)) continue;
        await writeAiRunStatusTx(tx, descendant, 'cancelled', {
          stopReason: 'cancelled',
          stoppedByRunId: runId,
        });
      }
      return run;
    },
    options,
  );
}

/** Finish a run: `done`, or `failed` with a failure reason. */
export async function finishAiRun(
  db: DatabaseInterface,
  runId: string,
  outcome:
    | { status: 'done'; degraded?: boolean }
    | {
        status: 'failed';
        stopReason?:
          | 'repairs_exhausted'
          | 'check_failed'
          | 'abandoned'
          | 'error';
      },
  options: AiRunTxOptions & { from?: 'running' | 'waiting-approval' } = {},
): Promise<AiRunRow | null> {
  return transitionAiRun(
    db,
    runId,
    outcome.status === 'done'
      ? {
          from: options.from ?? 'running',
          to: 'done',
          ...(outcome.degraded !== undefined
            ? { degraded: outcome.degraded }
            : {}),
        }
      : {
          from: options.from ?? 'running',
          to: 'failed',
          stopReason: outcome.stopReason ?? 'error',
          stoppedByRunId: runId,
        },
    options,
  );
}

/** Pause a durable run at an approval (refused for a run that is not durable). */
export async function waitAiRunApproval(
  db: DatabaseInterface,
  runId: string,
  options: AiRunTxOptions = {},
): Promise<AiRunRow | null> {
  return transitionAiRun(
    db,
    runId,
    { from: 'running', to: 'waiting-approval' },
    options,
  );
}

/** The fields of a run that are not its status, totals or identity. */
export interface AiRunPatch {
  tags?: Record<string, unknown>;
  templateHash?: string | null;
  promptKey?: string | null;
  experimentId?: string | null;
  datasetItem?: string | null;
  retain?: boolean;
  degraded?: boolean;
  mode?: string | null;
  seats?: number | null;
  degradedSeats?: number | null;
  details?: Record<string, unknown> | null;
}

const PATCH_COLUMNS: Record<keyof AiRunPatch, string> = {
  tags: 'tags',
  templateHash: 'template_hash',
  promptKey: 'prompt_key',
  experimentId: 'experiment_id',
  datasetItem: 'dataset_item',
  retain: 'retain',
  degraded: 'degraded',
  mode: 'mode',
  seats: 'seats',
  degradedSeats: 'degraded_seats',
  details: 'details',
};

/**
 * Update a run's descriptive fields. Status goes through the guarded
 * changes; totals only through the accounting transactions.
 */
export async function updateAiRun(
  db: DatabaseInterface,
  runId: string,
  patch: AiRunPatch,
  options: AiRunTxOptions = {},
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [runId];
  for (const [key, value] of Object.entries(patch)) {
    const column = PATCH_COLUMNS[key as keyof AiRunPatch];
    if (!column) throw new TypeError(`updateAiRun: unknown field ${key}`);
    if (value === undefined) continue;
    params.push(
      typeof value === 'boolean'
        ? value
          ? 1
          : 0
        : value !== null && typeof value === 'object'
          ? JSON.stringify(value)
          : value,
    );
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return;
  await withAiRunTransaction(
    db,
    async (tx) => {
      const run = await lockAiRun(tx, runId);
      if (!run) throw new AiRunNotFoundError(runId);
      await aiRunQuery(
        tx.db,
        `UPDATE _smrt_ai_runs SET ${sets.join(', ')} WHERE id = $1`,
        ...params,
      );
    },
    options,
  );
}

/**
 * A child's stop reaching the run that made the entry call (page section
 * 6.2): move that run out of `running` with the child's status, reason,
 * `stopped_by_run_id` and `stop_detail` (guarded; nothing is written when it
 * already left `running`), and return the error to raise for it. A child
 * cancelled on its own does not cancel its parent: the parent stops with
 * `interrupted`. A child that `failed` is an ordinary failure and is
 * returned unchanged.
 */
export async function stopAiRunForChild(
  db: DatabaseInterface,
  runId: string,
  child: AiRunStoppedError,
  options: AiRunTxOptions = {},
): Promise<AiRunStoppedError> {
  if (child.status !== 'stopped' && child.status !== 'cancelled') return child;
  return withAiRunTransaction(
    db,
    async (tx) => {
      // In the tenant the caller's context established, when it names one:
      // a row that left that tenant is neither fenced nor stopped.
      const tenant = expectedTenantOf(options);
      await assertAiRunFence(tx, runId, options.fence, tenant);
      const run = await lockAiRun(tx, runId, tenant);
      if (!run) throw new AiRunNotFoundError(runId);
      if (run.status === 'running') {
        const own =
          child.status === 'cancelled' && child.stoppedByRunId === child.runId;
        if (own) {
          await writeAiRunStatusTx(tx, run, 'stopped', {
            stopReason: 'interrupted',
            stoppedByRunId: child.runId,
          });
        } else {
          await writeAiRunStatusTx(tx, run, child.status, {
            stopReason: child.stopReason,
            stoppedByRunId: child.stoppedByRunId ?? child.runId,
            stopDetail: child.stopDetail,
          });
        }
      }
      return aiRunStoppedError(run);
    },
    options,
  );
}

/**
 * The job of a durable run ended for good while the run is still `running`
 * (page section 6.7): the run follows it, to `failed` with `error` or to
 * `cancelled` with `cancelled`.
 */
export async function closeAiRunForJob(
  db: DatabaseInterface,
  runId: string,
  jobOutcome: 'failed' | 'cancelled',
  options: AiRunTxOptions = {},
): Promise<AiRunRow | null> {
  return transitionAiRun(
    db,
    runId,
    jobOutcome === 'failed'
      ? {
          from: 'running',
          to: 'failed',
          stopReason: 'error',
          stoppedByRunId: runId,
        }
      : {
          from: 'running',
          to: 'cancelled',
          stopReason: 'cancelled',
          stoppedByRunId: runId,
        },
    options,
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Input of {@link startAiRunStep}. */
export interface StartAiRunStepInput {
  stepIndex: number;
  fence?: AiRunClaimFence;
  /** A durable run's checkpoint to save with the step boundary. */
  checkpoint?: {
    expectedRevision: number;
    state: unknown;
    lastSeq?: number;
  };
}

/** What {@link startAiRunStep} returns. */
export interface AiRunStepStart {
  /** Whether this step index was counted against `maxSteps` now. */
  counted: boolean;
  /** A new id for this entry of the step, even when re-entered. */
  stepInstanceId: string;
  /** The checkpoint revision after the save, for a durable run. */
  revision: number | null;
}

/**
 * Record a step boundary (page section 6.3). In one transaction, with the
 * checkpoint for a durable run: the run and its chain must be `running`; a
 * step whose index was not counted before must fit `maxSteps` and is
 * counted; every start checks `maxDurationMs`. A refused start stops the run
 * with `max_steps` or `max_duration` and throws {@link AiRunStoppedError}.
 *
 * A step is new exactly when its index is greater than the highest counted:
 * the checkpoint's, for a durable run; for a run that is not durable (never
 * resumed) steps are indexed from 0 and the highest is `steps_used - 1`.
 */
export async function startAiRunStep(
  db: DatabaseInterface,
  runId: string,
  input: StartAiRunStepInput,
  options: AiRunTxOptions = {},
): Promise<AiRunStepStart> {
  if (!Number.isSafeInteger(input.stepIndex) || input.stepIndex < 0) {
    throw new TypeError(
      'startAiRunStep: stepIndex must be a non-negative integer',
    );
  }
  const result = await withAiRunTransaction(
    db,
    async (tx): Promise<AiRunStepStart | AiRunStoppedError> => {
      const chain = await lockAiRunChainFenced(tx, runId, input.fence);
      const stopped = await checkAiRunChainRunning(tx, chain);
      if (stopped) return stopped;
      const run = chain[chain.length - 1] as AiRunRow;
      const checkpoint = run.durable
        ? await readAiRunCheckpoint(tx.db, runId)
        : null;
      const highest = checkpoint
        ? checkpoint.highestStepIndex
        : run.stepsUsed > 0
          ? run.stepsUsed - 1
          : null;
      const isNew = highest === null || input.stepIndex > highest;

      const limitMs = run.budget.maxDurationMs;
      const active = aiRunActiveTime(run, tx.now);
      if (limitMs !== undefined && active >= limitMs) {
        return stopAiRunAtLimitTx(tx, run, {
          limit: 'maxDurationMs',
          runId: run.id,
          limitValue: limitMs,
          used: active,
          room: limitMs - active,
        });
      }
      const maxSteps = run.budget.maxSteps;
      if (isNew && maxSteps !== undefined && run.stepsUsed + 1 > maxSteps) {
        return stopAiRunAtLimitTx(tx, run, {
          limit: 'maxSteps',
          runId: run.id,
          limitValue: maxSteps,
          used: run.stepsUsed,
          requested: 1,
          room: maxSteps - run.stepsUsed,
        });
      }
      if (isNew) run.stepsUsed += 1;
      await writeAiRunTotals(tx, run);
      let revision: number | null = null;
      if (checkpoint) {
        revision = await writeCheckpointTx(tx, checkpoint, {
          ...(input.checkpoint
            ? {
                expectedRevision: input.checkpoint.expectedRevision,
                state: input.checkpoint.state,
                ...(input.checkpoint.lastSeq !== undefined
                  ? { lastSeq: input.checkpoint.lastSeq }
                  : {}),
              }
            : {}),
          highestStepIndex: isNew ? input.stepIndex : highest,
        });
      }
      return { counted: isNew, stepInstanceId: newAiRunId(), revision };
    },
    options,
  );
  if (result instanceof AiRunStoppedError) throw result;
  return result;
}

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

/** Options of {@link resumeAiRun}. */
export interface ResumeAiRunOptions extends AiRunTxOptions {
  /** Limits to raise; the rest stay as they were. Never lowered. */
  budget?: AiRunBudget;
  /** The app's ceiling on a raised limit. */
  ceiling?: AiRunBudget;
  /** The definition version resuming the run. */
  definitionVersion?: string | null;
  /** Whether that version accepts the checkpoint's version. */
  acceptsVersion?: (saved: string | null) => boolean;
  /**
   * When a child's own (definition) budget stopped the run: that
   * definition's budget now, compared with the one stored on the child.
   */
  stoppingDefinitionBudget?: AiRunBudget;
  fence?: AiRunClaimFence;
  /**
   * Reconcile the run's stale reservations first (default true); the
   * accounting module wires it, so a caller rarely sets it.
   */
  reconcile?: (db: DatabaseInterface, runId: string) => Promise<void>;
}

function limitUsage(
  run: AiRunRow,
  limit: AiRunBudgetLimit,
  now: Date,
): { used: number; reserved: number } {
  switch (limit) {
    case 'maxCalls':
      return { used: run.inclusiveCalls, reserved: run.reservedCalls };
    case 'maxTokens':
      return { used: run.inclusiveTokens, reserved: run.reservedTokens };
    case 'maxCost':
      return { used: run.inclusiveCost, reserved: run.reservedCost };
    case 'maxSteps':
      return { used: run.stepsUsed, reserved: 0 };
    case 'maxDurationMs':
      return { used: aiRunActiveTime(run, now), reserved: 0 };
  }
}

/**
 * Resume a `stopped` durable run (or one `waiting-approval`, once decided)
 * from its checkpoint (page section 7). Budget limits may only be raised,
 * up to the ceiling. A run stopped at a budget limit is refused with
 * {@link AiRunResumeRefusedError} unless the resume changes the limit that
 * stopped it on the run that stopped it, or (when that run is this one or an
 * ancestor) that run now has room for what was requested. A resume under a
 * definition version that does not accept the checkpoint records
 * `definition_changed` and is refused.
 */
export async function resumeAiRun(
  db: DatabaseInterface,
  runId: string,
  options: ResumeAiRunOptions = {},
): Promise<AiRunRow> {
  const raise = normalizeAiRunBudget(options.budget, 'resumeAiRun: budget');
  const ceiling = normalizeAiRunBudget(options.ceiling, 'resumeAiRun: ceiling');
  if (options.reconcile) await options.reconcile(db, runId);
  const result = await withAiRunTransaction(
    db,
    async (tx): Promise<AiRunRow | AiRunResumeRefusedError> => {
      const chain = await lockAiRunChainFenced(tx, runId, options.fence);
      const run = chain[chain.length - 1] as AiRunRow;
      const refuse = (
        message: string,
        reason: AiRunResumeRefusedError['reason'],
      ) => new AiRunResumeRefusedError(message, runId, reason);
      if (
        run.status !== 'waiting-approval' &&
        (run.status !== 'stopped' || !run.durable)
      ) {
        throw refuse(
          `AI run ${runId} is ${run.status}${run.durable ? '' : ' and not durable'}; only a stopped or waiting durable run resumes`,
          'not_resumable',
        );
      }
      // The ancestor chain must still stand (page section 7). Nothing is
      // written; the ai-runs sweep later moves the run to cancelled.
      const oldest = chain[0] as AiRunRow;
      // Missing only when the parent row is absent: a chain that ends at a
      // parent of another tenant (a link written before parents were
      // tenant-checked) is checked for existence only and stands.
      if (
        oldest.parentRunId !== null &&
        getRows(
          await aiRunQuery(
            tx.db,
            'SELECT 1 AS present FROM _smrt_ai_runs WHERE id = $1',
            oldest.parentRunId,
          ),
        ).length === 0
      ) {
        throw refuse(
          `AI run ${runId} cannot resume: its ancestor ${oldest.parentRunId} no longer exists`,
          'ancestor_missing',
        );
      }
      const finalAncestor = chain.slice(0, -1).find(isAiRunFinal);
      if (finalAncestor) {
        throw refuse(
          `AI run ${runId} cannot resume: its ancestor ${finalAncestor.id} is ${finalAncestor.status}`,
          'ancestor_final',
        );
      }
      if (run.status === 'waiting-approval') {
        await writeAiRunStatusTx(tx, run, 'running');
        return run;
      }
      const checkpoint = await readAiRunCheckpoint(tx.db, runId);
      if (options.definitionVersion !== undefined && checkpoint) {
        const accepts =
          options.acceptsVersion ??
          ((saved: string | null) =>
            saved === (options.definitionVersion ?? null));
        if (!accepts(checkpoint.definitionVersion)) {
          await aiRunQuery(
            tx.db,
            `UPDATE _smrt_ai_runs
                SET stop_reason = 'definition_changed', stopped_by_run_id = $2,
                    stop_detail = NULL
              WHERE id = $1 AND status = 'stopped'`,
            runId,
            runId,
          );
          return refuse(
            `AI run ${runId} was saved by definition version ${String(
              checkpoint.definitionVersion,
            )}, which ${String(options.definitionVersion)} does not accept`,
            'definition_changed',
          );
        }
      }
      const budget: AiRunBudget = { ...run.budget };
      for (const [key, value] of Object.entries(raise) as [
        keyof AiRunBudget,
        number,
      ][]) {
        const before = run.budget[key];
        if (before !== undefined && value < before) {
          throw refuse(
            `resumeAiRun: ${key} may only be raised`,
            'budget_lowered',
          );
        }
        const cap = ceiling[key];
        if (cap !== undefined && value > cap) {
          throw refuse(
            `resumeAiRun: ${key} ${value} is above the app's ceiling ${cap}`,
            'above_ceiling',
          );
        }
        budget[key] = value;
      }

      const detail = run.stopDetail;
      if (detail && run.stopReason?.startsWith('max_')) {
        const stopper = detail.runId;
        const inChain = chain.find((candidate) => candidate.id === stopper);
        let allowed = false;
        if (stopper === run.id) {
          allowed = budget[detail.limit] !== run.budget[detail.limit];
        } else if (!inChain) {
          // A descendant stopped by its definition's own budget.
          const stored = await lockAiRun(tx, stopper);
          const next = options.stoppingDefinitionBudget?.[detail.limit];
          allowed =
            next !== undefined &&
            next !== (stored?.budget[detail.limit] ?? detail.limitValue);
        }
        if (!allowed && inChain && detail.requested !== undefined) {
          const subject = stopper === run.id ? { ...run, budget } : inChain;
          const limitValue = subject.budget[detail.limit];
          if (limitValue === undefined) allowed = true;
          else {
            const { used, reserved } = limitUsage(
              subject,
              detail.limit,
              tx.now,
            );
            allowed = limitValue - used - reserved >= detail.requested;
          }
        }
        if (!allowed) {
          return refuse(
            `AI run ${runId} stopped at ${detail.limit} of run ${stopper}; resume it with that limit raised`,
            'budget_unchanged',
          );
        }
      }
      await aiRunQuery(
        tx.db,
        'UPDATE _smrt_ai_runs SET budget = $2 WHERE id = $1',
        runId,
        JSON.stringify(budget),
      );
      run.budget = budget;
      if (!(await writeAiRunStatusTx(tx, run, 'running'))) {
        throw refuse(
          `AI run ${runId} moved on while resuming`,
          'not_resumable',
        );
      }
      return run;
    },
    options,
  );
  if (result instanceof AiRunResumeRefusedError) throw result;
  return result;
}
