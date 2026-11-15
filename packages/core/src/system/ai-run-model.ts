/**
 * The shared vocabulary of the AI run lifecycle and accounting (#5005;
 * `docs/content/ai-runs.md`): statuses, stop reasons, budgets, the run row,
 * the typed errors, and the short accounting transaction every reservation,
 * settlement, release, step start and status change runs in.
 *
 * Every function takes the database explicitly. Nothing here keeps a
 * process-wide run: a run is named by id, on the database (and so the tenant)
 * its caller passes.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import {
  isEmbeddedDatabase,
  isKnownDatabaseTransaction,
  withEmbeddedWriteTransaction,
} from '../embedded-write-queue.js';
import { SmrtError } from '../smrt-error.js';
import { getDatabaseEngine } from './compatibility.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** A run's status (page section 2). */
export type AiRunStatus =
  | 'running'
  | 'waiting-approval'
  | 'stopped'
  | 'cancelled'
  | 'failed'
  | 'done';

/** Every run status. */
export const AI_RUN_LIFECYCLE_STATUSES: readonly AiRunStatus[] = Object.freeze([
  'running',
  'waiting-approval',
  'stopped',
  'cancelled',
  'failed',
  'done',
]);

/** Statuses nothing moves out of. */
export const AI_RUN_FINAL_STATUSES: readonly AiRunStatus[] = Object.freeze([
  'cancelled',
  'failed',
  'done',
]);

/** A budget limit's stop reason. */
export type AiRunLimitStopReason =
  | 'max_steps'
  | 'max_calls'
  | 'max_cost'
  | 'max_tokens'
  | 'max_duration';

/** The typed reason a run stopped, was cancelled or failed. */
export type AiRunStopReason =
  | AiRunLimitStopReason
  | 'interrupted'
  | 'definition_changed'
  | 'cancelled'
  | 'repairs_exhausted'
  | 'check_failed'
  | 'abandoned'
  | 'error';

/** The reasons each status may carry. */
export const AI_RUN_STOP_REASONS: Readonly<
  Record<'stopped' | 'cancelled' | 'failed', readonly AiRunStopReason[]>
> = Object.freeze({
  stopped: [
    'max_steps',
    'max_calls',
    'max_cost',
    'max_tokens',
    'max_duration',
    'interrupted',
    'definition_changed',
  ],
  cancelled: ['cancelled'],
  failed: ['repairs_exhausted', 'check_failed', 'abandoned', 'error'],
});

/** The budget key behind each limit stop reason. */
export const AI_RUN_LIMIT_REASONS: Readonly<
  Record<AiRunBudgetLimit, AiRunLimitStopReason>
> = Object.freeze({
  maxSteps: 'max_steps',
  maxCalls: 'max_calls',
  maxCost: 'max_cost',
  maxTokens: 'max_tokens',
  maxDurationMs: 'max_duration',
});

/** The framework's own run types; others are `@scope/pkg:type`. */
export const AI_RUN_FRAMEWORK_TYPES = Object.freeze([
  'fusion',
  'turn',
  'workflow',
] as const);

const NAMESPACED_TYPE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*:[\w.-]+$/i;

/** Whether `type` is a framework type or an owner-namespaced one. */
export function isValidAiRunType(type: string): boolean {
  return (
    (AI_RUN_FRAMEWORK_TYPES as readonly string[]).includes(type) ||
    NAMESPACED_TYPE.test(type)
  );
}

/** A run's limits (page section 6.1); every key optional. */
export interface AiRunBudget {
  maxSteps?: number;
  maxCalls?: number;
  maxCost?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  maxCallTokens?: number;
  callTimeoutMs?: number;
  actionTimeoutMs?: number;
  repairRetries?: number;
}

/** The budget keys whose limit stops the run. */
export type AiRunBudgetLimit =
  | 'maxSteps'
  | 'maxCalls'
  | 'maxCost'
  | 'maxTokens'
  | 'maxDurationMs';

const BUDGET_KEYS: readonly (keyof AiRunBudget)[] = [
  'maxSteps',
  'maxCalls',
  'maxCost',
  'maxTokens',
  'maxDurationMs',
  'maxCallTokens',
  'callTimeoutMs',
  'actionTimeoutMs',
  'repairRetries',
];

/** What a budget stop records (page section 6.4). */
export interface AiRunStopDetail {
  limit: AiRunBudgetLimit;
  runId: string;
  limitValue: number;
  used: number;
  /** Room held for other calls in flight (calls, tokens and cost only). */
  reserved?: number;
  /** Absent for `maxDurationMs`. */
  requested?: number;
  room: number;
}

/** One `_smrt_ai_runs` row in the run vocabulary. */
export interface AiRunRow {
  id: string;
  type: string;
  definitionKey: string | null;
  definitionVersion: string | null;
  tenantId: string | null;
  className: string | null;
  promptKey: string | null;
  templateHash: string | null;
  ownerId: string | null;
  parentRunId: string | null;
  retryOfRunId: string | null;
  experimentId: string | null;
  datasetItem: string | null;
  tags: Record<string, unknown>;
  status: AiRunStatus;
  degraded: boolean;
  stopReason: AiRunStopReason | null;
  stoppedByRunId: string | null;
  stopDetail: AiRunStopDetail | null;
  budget: AiRunBudget;
  tokens: number;
  costUsed: number;
  calls: number;
  uncostedCalls: number;
  stepsUsed: number;
  /** Closed active periods, ms. */
  duration: number;
  activeSince: Date | null;
  inclusiveTokens: number;
  inclusiveCost: number;
  inclusiveCalls: number;
  inclusiveUncostedCalls: number;
  reservedTokens: number;
  reservedCost: number;
  reservedCalls: number;
  checksPassed: number;
  checksFailed: number;
  approvalsGiven: number;
  approvalsRefused: number;
  retain: boolean;
  trajectoryPruned: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  /** Whether the run keeps a checkpoint (a durable run). */
  durable: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base of every typed AI run error; never retried by an accounting loop. */
export abstract class AiRunError extends SmrtError {}

/** A run was asked for while usage persistence is off (page section 3). */
export class AiRunTrackingDisabledError extends AiRunError {
  constructor(details?: Record<string, unknown>) {
    super(
      'AI runs need usage tracking: turn usage persistence on for this database before opening a run, a fusion or a chat turn',
      'AI_RUN_TRACKING_DISABLED',
      'configuration',
      details,
    );
  }
}

/** No run row with that id on this database. */
export class AiRunNotFoundError extends AiRunError {
  constructor(runId: string) {
    super(`AI run ${runId} does not exist`, 'AI_RUN_NOT_FOUND', 'runtime', {
      runId,
    });
  }
}

/** A status change the transition table does not allow, or that lost a race. */
export class AiRunTransitionError extends AiRunError {
  constructor(
    message: string,
    readonly runId: string,
    readonly from: AiRunStatus | null,
    readonly to: AiRunStatus,
  ) {
    super(message, 'AI_RUN_TRANSITION_REFUSED', 'runtime', {
      runId,
      from,
      to,
    });
  }
}

/**
 * A run (or the child that answered its entry call) is no longer `running`:
 * it stopped, was cancelled or failed. Raised instead of an answer or an
 * ordinary failure; the run's own row already says so.
 */
export class AiRunStoppedError extends AiRunError {
  readonly runId: string;
  readonly status: AiRunStatus;
  readonly stopReason: AiRunStopReason | null;
  readonly stoppedByRunId: string | null;
  readonly stopDetail: AiRunStopDetail | null;

  constructor(input: {
    runId: string;
    status: AiRunStatus;
    stopReason: AiRunStopReason | null;
    stoppedByRunId: string | null;
    stopDetail?: AiRunStopDetail | null;
  }) {
    super(
      `AI run ${input.runId} is ${input.status}${
        input.stopReason ? ` (${input.stopReason})` : ''
      }`,
      'AI_RUN_STOPPED',
      'runtime',
      {
        runId: input.runId,
        status: input.status,
        stopReason: input.stopReason,
        stoppedByRunId: input.stoppedByRunId,
        stopDetail: input.stopDetail ?? null,
      },
    );
    this.runId = input.runId;
    this.status = input.status;
    this.stopReason = input.stopReason;
    this.stoppedByRunId = input.stoppedByRunId;
    this.stopDetail = input.stopDetail ?? null;
  }
}

/**
 * A resume or a retry the rules of page section 7 refuse. `reason` is one
 * typed code of the page's table: `not_resumable`, `ancestor_missing`,
 * `ancestor_final`, `budget_unchanged`, `budget_lowered`, `above_ceiling`,
 * `definition_changed`, `not_retryable` or `retry_source_pruned`.
 */
export class AiRunResumeRefusedError extends AiRunError {
  constructor(
    message: string,
    readonly runId: string,
    readonly reason:
      | 'not_resumable'
      | 'budget_unchanged'
      | 'budget_lowered'
      | 'above_ceiling'
      | 'definition_changed'
      | 'not_retryable'
      | 'ancestor_missing'
      | 'ancestor_final'
      | 'retry_source_pruned',
  ) {
    super(message, 'AI_RUN_RESUME_REFUSED', 'runtime', { runId, reason });
  }
}

/**
 * A per-call limit failed the call before it was sent (`maxCallTokens`: the
 * input alone does not fit). The run is not stopped.
 */
export class AiCallLimitError extends AiRunError {
  constructor(
    message: string,
    readonly limit: 'maxCallTokens' | 'callTimeoutMs',
    readonly runId: string,
  ) {
    super(message, 'AI_CALL_LIMIT', 'ai', { limit, runId });
  }
}

/** The claim fence refused a write: another worker holds the job now. */
export class AiRunClaimLostError extends AiRunError {
  constructor(runId: string, cause?: Error) {
    super(
      `The job claim for durable AI run ${runId} is no longer current`,
      'AI_RUN_CLAIM_LOST',
      'runtime',
      { runId },
      cause,
    );
  }
}

/** A checkpoint save that read an older revision. */
export class AiRunCheckpointConflictError extends AiRunError {
  constructor(runId: string, expected: number) {
    super(
      `AI run ${runId} checkpoint moved past revision ${expected}; reload it`,
      'AI_RUN_CHECKPOINT_CONFLICT',
      'runtime',
      { runId, expected },
    );
  }
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/**
 * Run one statement with `$N` placeholders numbered in any order. SQLite
 * reads `$N` as a named parameter and numbers it by first appearance, so a
 * statement whose placeholders do not appear in ascending order would bind
 * the wrong values there; every placeholder is renumbered in order of
 * appearance, with its value repeated as needed.
 */
export function aiRunQuery(
  db: DatabaseInterface,
  sql: string,
  ...params: unknown[]
): Promise<unknown> {
  const ordered: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_, index: string) => {
    ordered.push(params[Number(index) - 1]);
    return `$${ordered.length}`;
  });
  return db.query(text, ...ordered);
}

export function getRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function flag(value: unknown): boolean {
  return value === true || num(value) !== 0;
}

export function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseJsonObject<T = Record<string, unknown>>(
  value: unknown,
): T | null {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  }
}

/** Validate a budget: known keys, non-negative finite numbers. */
export function normalizeAiRunBudget(
  budget: unknown,
  where = 'budget',
): AiRunBudget {
  if (budget === undefined || budget === null) return {};
  if (typeof budget !== 'object' || Array.isArray(budget)) {
    throw new TypeError(`${where} must be an object`);
  }
  const out: AiRunBudget = {};
  for (const [key, value] of Object.entries(budget)) {
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`${where}: unknown limit ${key}`);
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${where}.${key} must be a non-negative number`);
    }
    out[key as keyof AiRunBudget] = value;
  }
  return out;
}

/** Columns every lifecycle and accounting read selects. */
export const AI_RUN_COLUMNS = `r.id, r.type, r.definition_key, r.definition_version, r.tenant_id,
  r.class_name, r.prompt_key, r.template_hash, r.owner_id, r.parent_run_id,
  r.retry_of_run_id, r.experiment_id, r.dataset_item, r.tags, r.status,
  r.degraded, r.stop_reason, r.stopped_by_run_id, r.stop_detail, r.budget,
  r.tokens, r.cost_used, r.calls, r.uncosted_calls, r.steps_used, r.duration,
  r.active_since, r.inclusive_tokens, r.inclusive_cost, r.inclusive_calls,
  r.inclusive_uncosted_calls, r.reserved_tokens, r.reserved_cost,
  r.reserved_calls, r.checks_passed, r.checks_failed, r.approvals_given,
  r.approvals_refused, r.retain, r.trajectory_pruned, r.started_at,
  r.finished_at, r.created_at,
  CASE WHEN EXISTS (SELECT 1 FROM _smrt_ai_run_checkpoints c
                     WHERE c.run_id = r.id) THEN 1 ELSE 0 END AS durable`;

export function toAiRunRow(row: Record<string, unknown>): AiRunRow {
  return {
    id: String(row.id),
    type: String(row.type),
    definitionKey: text(row.definition_key),
    definitionVersion: text(row.definition_version),
    tenantId: text(row.tenant_id),
    className: text(row.class_name),
    promptKey: text(row.prompt_key),
    templateHash: text(row.template_hash),
    ownerId: text(row.owner_id),
    parentRunId: text(row.parent_run_id),
    retryOfRunId: text(row.retry_of_run_id),
    experimentId: text(row.experiment_id),
    datasetItem: text(row.dataset_item),
    tags: parseJsonObject(row.tags) ?? {},
    status: String(row.status) as AiRunStatus,
    degraded: flag(row.degraded),
    stopReason: text(row.stop_reason) as AiRunStopReason | null,
    stoppedByRunId: text(row.stopped_by_run_id),
    stopDetail: parseJsonObject<AiRunStopDetail>(row.stop_detail),
    budget: (parseJsonObject(row.budget) ?? {}) as AiRunBudget,
    tokens: num(row.tokens),
    costUsed: num(row.cost_used),
    calls: num(row.calls),
    uncostedCalls: num(row.uncosted_calls),
    stepsUsed: num(row.steps_used),
    duration: num(row.duration),
    activeSince: dateOrNull(row.active_since),
    inclusiveTokens: num(row.inclusive_tokens),
    inclusiveCost: num(row.inclusive_cost),
    inclusiveCalls: num(row.inclusive_calls),
    inclusiveUncostedCalls: num(row.inclusive_uncosted_calls),
    reservedTokens: num(row.reserved_tokens),
    reservedCost: num(row.reserved_cost),
    reservedCalls: num(row.reserved_calls),
    checksPassed: num(row.checks_passed),
    checksFailed: num(row.checks_failed),
    approvalsGiven: num(row.approvals_given),
    approvalsRefused: num(row.approvals_refused),
    retain: flag(row.retain),
    trajectoryPruned: flag(row.trajectory_pruned),
    startedAt: dateOrNull(row.started_at) ?? new Date(0),
    finishedAt: dateOrNull(row.finished_at),
    createdAt: dateOrNull(row.created_at) ?? new Date(0),
    durable: flag(row.durable),
  };
}

/** Read one run, or `null`. */
export async function getAiRun(
  db: DatabaseInterface,
  runId: string,
): Promise<AiRunRow | null> {
  const rows = getRows(
    await aiRunQuery(
      db,
      `SELECT ${AI_RUN_COLUMNS} FROM _smrt_ai_runs r WHERE r.id = $1`,
      runId,
    ),
  );
  return rows[0] ? toAiRunRow(rows[0]) : null;
}

/**
 * Whether a run is final: `cancelled`, `failed` or `done`, or `stopped`
 * without a checkpoint (a stop of a run that is not durable is final, page
 * section 2).
 */
export function isAiRunFinal(
  run: Pick<AiRunRow, 'status' | 'durable'>,
): boolean {
  return (
    run.status === 'cancelled' ||
    run.status === 'failed' ||
    run.status === 'done' ||
    (run.status === 'stopped' && !run.durable)
  );
}

/** The run's active time at `now`: closed periods plus the open one. */
export function aiRunActiveTime(run: AiRunRow, now: Date): number {
  if (!run.activeSince) return run.duration;
  return run.duration + Math.max(0, now.getTime() - run.activeSince.getTime());
}

// ---------------------------------------------------------------------------
// The accounting transaction
// ---------------------------------------------------------------------------

/** The SQL dialect an accounting transaction speaks. */
export type AiRunEngine = 'postgres' | 'sqlite' | 'duckdb';

/** One accounting transaction in progress. */
export interface AiRunTx {
  /** The transaction-bound handle; every statement goes through it. */
  db: DatabaseInterface;
  engine: AiRunEngine;
  /** One clock reading for the whole transaction. */
  now: Date;
}

export function aiRunEngine(db: DatabaseInterface): AiRunEngine {
  const engine = getDatabaseEngine(db);
  return engine === 'postgres'
    ? 'postgres'
    : engine === 'sqlite'
      ? 'sqlite'
      : 'duckdb';
}

/** Accounting transactions retried after a conflict (page section 6.5). */
export const AI_RUN_TX_ATTEMPTS = 5;
const MIN_DELAY_MS = 10;
const MAX_DELAY_MS = 500;

function retryDelay(attempt: number): number {
  const base = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 3 ** (attempt - 1));
  return Math.round(base / 2 + (Math.random() * base) / 2);
}

/** Options of {@link withAiRunTransaction}. */
export interface AiRunTxOptions {
  /** Clock; tests pin it. */
  now?: () => Date;
  /** Attempts in all; default {@link AI_RUN_TX_ATTEMPTS}. */
  attempts?: number;
}

/**
 * Run `operation` as one short accounting transaction, retried as a whole up
 * to five times with a jittered 10-500 ms delay when the database reports a
 * conflict or any other failure (page section 6.5). A typed
 * {@link AiRunError} or a `TypeError` is never retried: it is the answer.
 *
 * PostgreSQL gets `SET LOCAL lock_timeout = '5s'`; SQLite's adapters begin
 * with `BEGIN IMMEDIATE`; DuckDB is optimistic and a conflict surfaces here
 * and is retried. Called with a handle that is already a transaction, it
 * runs once on that handle: the caller owns commit, rollback and retry, and
 * DuckDB has no savepoint to nest one in.
 *
 * Never call a model inside `operation`.
 */
export async function withAiRunTransaction<T>(
  db: DatabaseInterface,
  operation: (tx: AiRunTx) => Promise<T>,
  options: AiRunTxOptions = {},
): Promise<T> {
  const engine = aiRunEngine(db);
  const clock = options.now ?? (() => new Date());
  if (isKnownDatabaseTransaction(db)) {
    return operation({ db, engine, now: clock() });
  }
  const attempts = Math.max(1, options.attempts ?? AI_RUN_TX_ATTEMPTS);
  for (let attempt = 1; ; attempt++) {
    try {
      return await withEmbeddedWriteTransaction(
        db,
        isEmbeddedDatabase(db),
        async (bound) => {
          if (engine === 'postgres') {
            await bound.query(`SET LOCAL lock_timeout = '5s'`);
          }
          return operation({ db: bound, engine, now: clock() });
        },
      );
    } catch (error) {
      if (
        error instanceof AiRunError ||
        error instanceof TypeError ||
        attempt >= attempts
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
    }
  }
}

/** `FOR UPDATE` on PostgreSQL; the write transaction is exclusive elsewhere. */
export function forUpdate(tx: AiRunTx): string {
  return tx.engine === 'postgres' ? ' FOR UPDATE' : '';
}

/** Lock and read one run row inside an accounting transaction. */
export async function lockAiRun(
  tx: AiRunTx,
  runId: string,
): Promise<AiRunRow | null> {
  const rows = getRows(
    await aiRunQuery(
      tx.db,
      `SELECT ${AI_RUN_COLUMNS} FROM _smrt_ai_runs r WHERE r.id = $1${forUpdate(tx)}`,
      runId,
    ),
  );
  return rows[0] ? toAiRunRow(rows[0]) : null;
}

const MAX_CHAIN_DEPTH = 64;

/**
 * The run's ancestor ids, root first, ending with the run itself. Read
 * without locks: `parent_run_id` never changes after a run is created.
 */
export async function readAiRunChainIds(
  db: DatabaseInterface,
  runId: string,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current: string | null = runId;
  while (current) {
    if (seen.has(current) || ids.length >= MAX_CHAIN_DEPTH) {
      throw new TypeError(`AI run ${runId} has a parent cycle or is too deep`);
    }
    seen.add(current);
    const rows = getRows(
      await aiRunQuery(
        db,
        'SELECT id, parent_run_id FROM _smrt_ai_runs WHERE id = $1',
        current,
      ),
    );
    if (!rows[0]) {
      if (current === runId) throw new AiRunNotFoundError(runId);
      // A pruned ancestor: the chain ends at the oldest one still kept.
      break;
    }
    ids.push(current);
    current = text(rows[0].parent_run_id);
  }
  return ids.reverse();
}

/**
 * The run's descendants, found through `parent_run_id` (which never changes),
 * in the page's lock order: by increasing depth below the run, then by `id`
 * within a depth (page section 6.5). Read without locks.
 */
export async function readAiRunDescendantIds(
  db: DatabaseInterface,
  runId: string,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>([runId]);
  let level = [runId];
  for (let depth = 0; level.length > 0; depth++) {
    if (depth >= MAX_CHAIN_DEPTH) {
      throw new TypeError(`AI run ${runId} has a subtree that is too deep`);
    }
    const next: string[] = [];
    for (const parent of level) {
      for (const row of getRows(
        await aiRunQuery(
          db,
          'SELECT id FROM _smrt_ai_runs WHERE parent_run_id = $1',
          parent,
        ),
      )) {
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
      }
    }
    next.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out.push(...next);
    level = next;
  }
  return out;
}

/**
 * Lock the run's chain root first (page section 6.5: increasing depth, one
 * statement per row) and return the rows in that order; the last is the run.
 */
export async function lockAiRunChain(
  tx: AiRunTx,
  runId: string,
): Promise<AiRunRow[]> {
  const ids = await readAiRunChainIds(tx.db, runId);
  const chain: AiRunRow[] = [];
  for (const id of ids) {
    const row = await lockAiRun(tx, id);
    if (row) chain.push(row);
  }
  if (chain[chain.length - 1]?.id !== runId) {
    throw new AiRunNotFoundError(runId);
  }
  return chain;
}

/** Fold the open active period into `duration` (every run-row write). */
export function foldActive(
  run: AiRunRow,
  now: Date,
): { duration: number; activeSince: string | null } {
  if (!run.activeSince) return { duration: run.duration, activeSince: null };
  return {
    duration: aiRunActiveTime(run, now),
    activeSince: now.toISOString(),
  };
}

/** Write a run's totals, folding its active period, under the chain lock. */
export async function writeAiRunTotals(
  tx: AiRunTx,
  run: AiRunRow,
): Promise<void> {
  const folded = foldActive(run, tx.now);
  // Float residue: a run with nothing in flight holds no cost.
  const reservedCost =
    run.reservedCalls <= 0 ? 0 : Math.max(0, run.reservedCost);
  await aiRunQuery(
    tx.db,
    `UPDATE _smrt_ai_runs
        SET tokens = $2, cost_used = $3, calls = $4, uncosted_calls = $5,
            steps_used = $6, duration = $7, active_since = $8,
            inclusive_tokens = $9, inclusive_cost = $10, inclusive_calls = $11,
            inclusive_uncosted_calls = $12, reserved_tokens = $13,
            reserved_cost = $14, reserved_calls = $15
      WHERE id = $1`,
    run.id,
    run.tokens,
    run.costUsed,
    run.calls,
    run.uncostedCalls,
    run.stepsUsed,
    folded.duration,
    folded.activeSince,
    run.inclusiveTokens,
    run.inclusiveCost,
    run.inclusiveCalls,
    run.inclusiveUncostedCalls,
    Math.max(0, run.reservedTokens),
    reservedCost,
    Math.max(0, run.reservedCalls),
  );
  run.duration = folded.duration;
  run.activeSince = folded.activeSince ? new Date(folded.activeSince) : null;
}

// ---------------------------------------------------------------------------
// Claim fencing
// ---------------------------------------------------------------------------

/**
 * Asserts, inside the caller's transaction, that this process still holds
 * the job claim of the durable run `durableRunId` (page section 6.4 step 1).
 * Core never imports `smrt-jobs`: the host passes a fence built from its
 * claim, such as `(tx) => assertJobClaim(tx, claim)`. It must throw when the
 * claim is gone.
 */
export type AiRunClaimFence = (
  tx: DatabaseInterface,
  durableRunId: string,
) => Promise<void>;

/** The durable run nearest the end of a chain of ids (lock-free read). */
async function nearestDurable(
  db: DatabaseInterface,
  ids: readonly string[],
): Promise<string | null> {
  for (let i = ids.length - 1; i >= 0; i--) {
    const rows = getRows(
      await aiRunQuery(
        db,
        'SELECT run_id FROM _smrt_ai_run_checkpoints WHERE run_id = $1',
        ids[i],
      ),
    );
    if (rows.length > 0) return ids[i] ?? null;
  }
  return null;
}

/**
 * Open a chain inside an accounting transaction, in the page's lock order:
 * the job row first, through the fence of the nearest durable run in the
 * chain (when the caller passes one), then the run rows root first.
 */
export async function lockAiRunChainFenced(
  tx: AiRunTx,
  runId: string,
  fence: AiRunClaimFence | undefined,
): Promise<AiRunRow[]> {
  if (fence) {
    const ids = await readAiRunChainIds(tx.db, runId);
    const durable = await nearestDurable(tx.db, ids);
    if (durable) {
      try {
        await fence(tx.db, durable);
      } catch (error) {
        throw new AiRunClaimLostError(
          durable,
          error instanceof Error ? error : undefined,
        );
      }
    }
  }
  return lockAiRunChain(tx, runId);
}

export function newAiRunId(): string {
  return crypto.randomUUID();
}
