/**
 * System-table retention — bounded growth for framework-owned tables (#2375).
 *
 * Several `_smrt_*` tables are append-only by construction and were, until
 * this module, unbounded by default: `_smrt_changes` grew one row per
 * framework save/delete, `_smrt_ai_usage` one row per AI call (persistence is
 * on by default, see `config.ts`), `_smrt_contexts` accumulated rows whose
 * `expires_at` nothing ever enforced, and `_smrt_dispatch` retained completed
 * work until an operator remembered to run `smrt dispatch:cleanup`.
 *
 * This module supplies the missing half:
 *
 * - {@link pruneAiUsage} — the retention API `_smrt_ai_usage` never had.
 * - {@link pruneExpiredContexts} — enforcement for `_smrt_contexts.expires_at`.
 * - {@link runRetentionSweep} — one entry point that applies a documented,
 *   opt-out {@link RetentionPolicy} across every framework-owned table, plus
 *   any task other packages contribute via {@link registerRetentionTask}
 *   (`@happyvertical/smrt-jobs` registers job/job-event cleanup;
 *   `@happyvertical/smrt-users` registers session and token expiry).
 *
 * Scheduling is the caller's: `smrt db:prune` is the cron entry point, and a
 * running `TaskRunner` sweeps on an interval unless configured otherwise.
 *
 * ## Failure policy
 *
 * A sweep is maintenance, not a transaction. One failing task never aborts the
 * rest — the failure is captured on that task's {@link RetentionTaskResult}
 * and the sweep continues. Callers decide what a partial sweep means; the CLI
 * exits non-zero when any task failed.
 *
 * ## Predicate indexes
 *
 * Every predicate below is indexed by the system DDL in `system/schema.ts`
 * (`_smrt_contexts(expires_at)`, `_smrt_ai_usage(tenant_id, created_at)`,
 * `_smrt_dispatch(status, processed_at)` / `(status, updated_at)`) or by the
 * jobs compatibility path in `system/compatibility.ts`
 * (`_smrt_jobs(status, completed_at)`, `_smrt_job_events(created_at)`).
 * A new retention predicate must ship with its index.
 *
 * @see https://github.com/happyvertical/smrt/issues/2375
 * @packageDocumentation
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { pruneChangeFeed } from '../change-feed.js';
import { detectEngine } from '../schema/ddl/index.js';

const logger = createLogger({ level: 'info' });

/** Milliseconds in a day — the unit every retention policy is expressed in. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================================
// Policy
// ============================================================================

/** Retention for the append-only change feed (`_smrt_changes`). */
export interface ChangeFeedRetentionPolicy {
  /** Run this task (default `true`). */
  enabled?: boolean;
  /** Drop entries older than this many days (default 30). */
  maxAgeDays?: number;
  /** Additionally keep at most this many newest entries (default: unbounded). */
  maxRows?: number;
}

/** Retention for AI usage telemetry (`_smrt_ai_usage`). */
export interface AiUsageRetentionPolicy {
  /** Run this task (default `true`). */
  enabled?: boolean;
  /** Drop records older than this many days (default 90). */
  maxAgeDays?: number;
  /** Additionally keep at most this many newest records (default: unbounded). */
  maxRows?: number;
}

/** Retention for remembered context entries (`_smrt_contexts`). */
export interface ContextsRetentionPolicy {
  /** Run this task (default `true`). */
  enabled?: boolean;
}

/** Retention for the dispatch queue (`_smrt_dispatch`). */
export interface DispatchRetentionPolicy {
  /** Run this task (default `true`). */
  enabled?: boolean;
  /** Drop completed dispatches processed more than this many days ago (default 30). */
  completedOlderThanDays?: number;
  /** Drop failed dispatches last touched more than this many days ago (default 90). */
  failedOlderThanDays?: number;
}

/**
 * Retention policy for a sweep.
 *
 * Every table is pruned by default; set a table's entry to `false` (or
 * `{ enabled: false }`) to opt that table out, or `enabled: false` at the top
 * level to opt the whole sweep out.
 */
export interface RetentionPolicy {
  /** Run the sweep at all (default `true`). */
  enabled?: boolean;
  /** Report what would be pruned without deleting anything (default `false`). */
  dryRun?: boolean;
  /** `_smrt_changes` retention, or `false` to skip. */
  changes?: ChangeFeedRetentionPolicy | false;
  /** `_smrt_ai_usage` retention, or `false` to skip. */
  aiUsage?: AiUsageRetentionPolicy | false;
  /** `_smrt_contexts` expiry enforcement, or `false` to skip. */
  contexts?: ContextsRetentionPolicy | false;
  /** `_smrt_dispatch` retention, or `false` to skip. */
  dispatch?: DispatchRetentionPolicy | false;
  /**
   * Enable/disable individual tasks contributed through
   * {@link registerRetentionTask}, keyed by task name. Unlisted tasks run.
   */
  tasks?: Record<string, boolean>;
}

/**
 * Documented retention defaults.
 *
 * Chosen to be generous relative to every in-tree consumer: change-feed
 * cursors resync automatically past the window, AI usage outlives a monthly
 * billing cycle by two months, and dispatch keeps a full quarter of failures
 * for forensics. Applications that need longer history raise these; those that
 * need none set the table to `false`.
 */
export const DEFAULT_RETENTION_POLICY: {
  changes: ChangeFeedRetentionPolicy;
  aiUsage: AiUsageRetentionPolicy;
  contexts: ContextsRetentionPolicy;
  dispatch: DispatchRetentionPolicy;
} = {
  changes: { maxAgeDays: 30 },
  aiUsage: { maxAgeDays: 90 },
  contexts: {},
  dispatch: { completedOlderThanDays: 30, failedOlderThanDays: 90 },
};

// ============================================================================
// Tasks
// ============================================================================

/** Per-run inputs handed to every retention task. */
export interface RetentionTaskContext {
  /** Count what would be deleted instead of deleting it. */
  dryRun: boolean;
  /** Sweep start time — every task derives its cutoffs from this one clock. */
  now: Date;
}

/** What one task did (or why it did nothing). */
export interface RetentionTaskResult {
  /** Task name, unique within a sweep. */
  task: string;
  /** Rows deleted, or — under `dryRun` — rows that would be deleted. */
  pruned: number;
  /**
   * Why the task did no work: `disabled` (policy opted it out) or
   * `unavailable` (the table does not exist in this database).
   */
  skipped?: 'disabled' | 'unavailable';
  /** Message of the error this task failed with, if any. */
  error?: string;
  /** Optional per-bucket breakdown (e.g. completed vs failed dispatches). */
  details?: Record<string, number>;
}

/** What a task returns; a bare number is shorthand for `{ pruned }`. */
export type RetentionTaskOutcome =
  | number
  | { pruned: number; details?: Record<string, number> };

/**
 * A retention task contributed by a package that owns its own tables.
 *
 * Tasks must honour `context.dryRun` — a task that deletes during a dry run
 * makes the whole preview a lie.
 */
export interface RetentionTask {
  /** Unique name; also the {@link RetentionPolicy.tasks} opt-out key. */
  name: string;
  /** One-line description surfaced by `smrt db:prune --json`. */
  description?: string;
  /** Perform (or, under `dryRun`, count) the deletion. */
  run(
    db: DatabaseInterface,
    context: RetentionTaskContext,
  ): Promise<RetentionTaskOutcome>;
}

const RETENTION_TASKS_KEY = Symbol.for('smrt.retention-tasks');

/**
 * The task registry, held on `globalThis` rather than in module scope.
 *
 * Contributing packages resolve their own copy of `@happyvertical/smrt-core`
 * whenever a consumer's install is not fully deduped, and the CLI resolves a
 * third. A module-local `Map` would give each of them a private, empty
 * registry — the task would register in one and the sweep would run in
 * another. `ObjectRegistry` is on `globalThis` for the same reason.
 */
function registeredTasks(): Map<string, RetentionTask> {
  const root = globalThis as typeof globalThis & {
    [RETENTION_TASKS_KEY]?: Map<string, RetentionTask>;
  };
  root[RETENTION_TASKS_KEY] ??= new Map<string, RetentionTask>();
  return root[RETENTION_TASKS_KEY];
}

/**
 * Register a retention task so {@link runRetentionSweep} includes it.
 *
 * Registering a task does not schedule anything — a task only runs when
 * something calls {@link runRetentionSweep}, and the policy can still turn it
 * off by name. Re-registering the same name replaces the previous task, which
 * keeps module re-evaluation (HMR, repeated test imports) idempotent.
 */
export function registerRetentionTask(task: RetentionTask): void {
  if (!task.name) {
    throw new Error('registerRetentionTask requires a non-empty task name');
  }
  registeredTasks().set(task.name, task);
}

/** Remove a registered retention task. Returns `true` if one was removed. */
export function unregisterRetentionTask(name: string): boolean {
  return registeredTasks().delete(name);
}

/** Registered retention tasks, ordered by name for deterministic sweeps. */
export function getRetentionTasks(): RetentionTask[] {
  return [...registeredTasks().values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Drop every registered retention task (test helper). */
export function clearRetentionTasks(): void {
  registeredTasks().clear();
}

// ============================================================================
// AI usage retention
// ============================================================================

/** Bounds for {@link pruneAiUsage}. At least one bound is required. */
export interface AiUsageRetention {
  /** Delete records older than this many milliseconds. */
  maxAgeMs?: number;
  /**
   * Keep at most this many newest records (by `created_at`).
   *
   * Rows sharing the cutoff timestamp all survive, so the retained count can
   * exceed `maxRows` by the size of one timestamp tie.
   */
  maxRows?: number;
  /**
   * Restrict the prune to one tenant: a string matches that tenant, `null`
   * matches the global (tenant-less) records. Omit to prune every tenant.
   */
  tenantId?: string | null;
  /** Count matching records without deleting them. */
  dryRun?: boolean;
  /** Clock for the age cutoff (default: now). */
  now?: Date;
}

/** Name of the AI usage telemetry table. */
const AI_USAGE_TABLE = '_smrt_ai_usage';

/** Name of the remembered-context table. */
const CONTEXTS_TABLE = '_smrt_contexts';

/**
 * Prune AI usage telemetry to bound `_smrt_ai_usage` growth.
 *
 * `_smrt_ai_usage` gains one row per AI call and persistence is on by default,
 * so a busy deployment writes millions of rows a year with nothing to remove
 * them. Both bounds may be combined; each is applied independently and the
 * returned count is the total deleted.
 *
 * Predicates are covered by `idx_smrt_ai_usage_tenant_created`
 * (`tenant_id, created_at`) — the same index the subscriptions billing meter
 * needs for its `tenant_id + created_at` range scan.
 *
 * @param db - Database holding the system tables.
 * @param retention - At least one of `maxAgeMs` / `maxRows`.
 * @returns Number of records deleted (or, under `dryRun`, matched).
 */
export async function pruneAiUsage(
  db: DatabaseInterface,
  retention: AiUsageRetention,
): Promise<{ pruned: number }> {
  const { maxAgeMs, maxRows, dryRun = false } = retention;

  if (maxAgeMs == null && maxRows == null) {
    throw new Error('pruneAiUsage requires maxAgeMs and/or maxRows');
  }
  if (maxAgeMs != null && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)) {
    throw new Error(`pruneAiUsage maxAgeMs must be >= 0, got ${maxAgeMs}`);
  }
  if (maxRows != null && (!Number.isFinite(maxRows) || maxRows < 0)) {
    throw new Error(`pruneAiUsage maxRows must be >= 0, got ${maxRows}`);
  }

  const now = retention.now ?? new Date();
  const scope = tenantScopeClause(retention);
  let pruned = 0;

  // Rows the age bound already accounted for. Redundant when they were really
  // deleted, load-bearing under `dryRun`, where they were not — without it the
  // row bound would count the same records a second time.
  const alreadyCounted: { conditions: string[]; params: unknown[] } = {
    conditions: [],
    params: [],
  };

  if (maxAgeMs != null) {
    const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
    pruned += await deleteFrom(
      db,
      AI_USAGE_TABLE,
      [...scope.conditions, 'created_at < ?'],
      [...scope.params, cutoff],
      dryRun,
    );
    alreadyCounted.conditions.push('created_at >= ?');
    alreadyCounted.params.push(cutoff);
  }

  if (maxRows != null) {
    const keep = Math.floor(maxRows);
    if (keep === 0) {
      pruned += await deleteFrom(
        db,
        AI_USAGE_TABLE,
        [...scope.conditions, ...alreadyCounted.conditions],
        [...scope.params, ...alreadyCounted.params],
        dryRun,
      );
    } else {
      // The oldest retained row's timestamp is the cutoff. `LIMIT 1 OFFSET n`
      // is portable across every supported engine, unlike the
      // `LIMIT ALL`/`LIMIT -1` spellings of "all rows past an offset".
      const boundary = await selectOne(
        db,
        `SELECT created_at FROM ${AI_USAGE_TABLE}
         ${whereClause(scope.conditions)}
         ORDER BY created_at DESC
         LIMIT 1 OFFSET ${keep - 1}`,
        scope.params,
      );
      const cutoff = boundary?.created_at;
      if (cutoff != null) {
        pruned += await deleteFrom(
          db,
          AI_USAGE_TABLE,
          [...scope.conditions, 'created_at < ?', ...alreadyCounted.conditions],
          [...scope.params, cutoff, ...alreadyCounted.params],
          dryRun,
        );
      }
    }
  }

  return { pruned };
}

/**
 * Delete context entries whose `expires_at` has passed.
 *
 * `remember({ expiresAt })` has always stored the expiry and never acted on
 * it. Enforcement is deliberately prune-side only: `recall()`/`recallAll()`
 * keep their documented "expiry is not applied at read time" contract, so this
 * bounds storage without changing read semantics for existing callers.
 * (`LearningMemory` filters expired rows itself.)
 *
 * Rows with a `NULL` `expires_at` never expire and are never touched.
 * The predicate is covered by `idx_smrt_contexts_expires_at`.
 *
 * @param db - Database holding the system tables.
 * @param options.now - Clock for the expiry comparison (default: now).
 * @param options.dryRun - Count matching rows without deleting them.
 * @returns Number of expired entries deleted (or, under `dryRun`, matched).
 */
export async function pruneExpiredContexts(
  db: DatabaseInterface,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<{ pruned: number }> {
  const now = (options.now ?? new Date()).toISOString();
  const pruned = await deleteFrom(
    db,
    CONTEXTS_TABLE,
    ['expires_at IS NOT NULL', 'expires_at < ?'],
    [now],
    options.dryRun ?? false,
  );
  return { pruned };
}

// ============================================================================
// Sweep
// ============================================================================

/** Aggregate outcome of one {@link runRetentionSweep} call. */
export interface RetentionSweepResult {
  /** Whether this run only counted rows. */
  dryRun: boolean;
  /** Sweep start time, ISO-8601. */
  startedAt: string;
  /** Wall-clock duration of the sweep. */
  durationMs: number;
  /** Total rows pruned (or matched) across all tasks. */
  pruned: number;
  /** Per-task outcomes, in execution order. */
  tasks: RetentionTaskResult[];
  /** Whether any task failed — the sweep never throws for a task failure. */
  failed: boolean;
}

/**
 * Apply a {@link RetentionPolicy} across every framework-owned table.
 *
 * Built-in tasks run first, in a fixed order (`changes`, `ai-usage`,
 * `contexts`, `dispatch`), followed by tasks registered via
 * {@link registerRetentionTask} in name order. Tables that do not exist in
 * this database are reported as `skipped: 'unavailable'` rather than failing —
 * a sweep must be safe to run against a partially bootstrapped database.
 *
 * @param db - Database holding the system tables.
 * @param policy - Overrides on {@link DEFAULT_RETENTION_POLICY}.
 * @returns Per-task and aggregate counts; never throws for a task failure.
 */
export async function runRetentionSweep(
  db: DatabaseInterface,
  policy: RetentionPolicy = {},
): Promise<RetentionSweepResult> {
  const startedAt = new Date();
  const dryRun = policy.dryRun ?? false;

  if (policy.enabled === false) {
    return {
      dryRun,
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      pruned: 0,
      tasks: [],
      failed: false,
    };
  }

  const context: RetentionTaskContext = { dryRun, now: startedAt };
  const tasks: RetentionTaskResult[] = [];

  for (const builtIn of builtInTasks(policy)) {
    if (!builtIn.task) {
      tasks.push({ task: builtIn.name, pruned: 0, skipped: 'disabled' });
      continue;
    }
    tasks.push(await runTask(db, builtIn.table, builtIn.task, context));
  }

  for (const task of getRetentionTasks()) {
    if (policy.tasks?.[task.name] === false) {
      tasks.push({ task: task.name, pruned: 0, skipped: 'disabled' });
      continue;
    }
    tasks.push(await runTask(db, null, task, context));
  }

  const pruned = tasks.reduce((total, task) => total + task.pruned, 0);
  const failed = tasks.some((task) => task.error !== undefined);

  logger.info('[smrt] retention sweep complete', {
    dryRun,
    pruned,
    failed,
    tasks: tasks.map((task) => `${task.task}=${task.pruned}`).join(' '),
  });

  return {
    dryRun,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    pruned,
    tasks,
    failed,
  };
}

/**
 * Run one task, converting an absent table or a thrown error into a result.
 *
 * `requiredTable` is checked before the task runs so a sweep against a
 * database that never bootstrapped a given system table reports
 * `unavailable` instead of surfacing an engine-specific "no such table".
 */
async function runTask(
  db: DatabaseInterface,
  requiredTable: string | null,
  task: RetentionTask,
  context: RetentionTaskContext,
): Promise<RetentionTaskResult> {
  try {
    if (requiredTable && !(await tableExists(db, requiredTable))) {
      return { task: task.name, pruned: 0, skipped: 'unavailable' };
    }

    const outcome = await task.run(db, context);
    return typeof outcome === 'number'
      ? { task: task.name, pruned: outcome }
      : { task: task.name, pruned: outcome.pruned, details: outcome.details };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[smrt] retention task "${task.name}" failed: ${message}`);
    return { task: task.name, pruned: 0, error: message };
  }
}

/** Resolve a per-table policy entry, or `null` when it is opted out. */
function resolveEntry<T extends { enabled?: boolean }>(
  entry: T | false | undefined,
  defaults: T,
): T | null {
  if (entry === false) return null;
  const merged = { ...defaults, ...(entry ?? {}) };
  return merged.enabled === false ? null : merged;
}

/** A built-in task plus the table it needs and whether policy enabled it. */
interface BuiltInRetentionTask {
  name: string;
  table: string;
  task: RetentionTask | null;
}

/** The framework-owned tasks, in their fixed execution order. */
function builtInTasks(policy: RetentionPolicy): BuiltInRetentionTask[] {
  return [
    { name: 'changes', table: '_smrt_changes', task: changeFeedTask(policy) },
    { name: 'ai-usage', table: AI_USAGE_TABLE, task: aiUsageTask(policy) },
    { name: 'contexts', table: CONTEXTS_TABLE, task: contextsTask(policy) },
    { name: 'dispatch', table: '_smrt_dispatch', task: dispatchTask(policy) },
  ];
}

function changeFeedTask(policy: RetentionPolicy): RetentionTask | null {
  const config = resolveEntry<ChangeFeedRetentionPolicy>(
    policy.changes,
    DEFAULT_RETENTION_POLICY.changes,
  );
  if (!config) return null;

  return {
    name: 'changes',
    description: 'Prune the append-only change feed (_smrt_changes)',
    run: async (db, context) => {
      const { pruned } = await pruneChangeFeed(db, {
        maxAgeMs:
          config.maxAgeDays == null
            ? undefined
            : config.maxAgeDays * MS_PER_DAY,
        maxRows: config.maxRows,
        dryRun: context.dryRun,
      });
      return pruned;
    },
  };
}

function aiUsageTask(policy: RetentionPolicy): RetentionTask | null {
  const config = resolveEntry<AiUsageRetentionPolicy>(
    policy.aiUsage,
    DEFAULT_RETENTION_POLICY.aiUsage,
  );
  if (!config) return null;

  return {
    name: 'ai-usage',
    description: 'Prune AI usage telemetry (_smrt_ai_usage)',
    run: async (db, context) => {
      const { pruned } = await pruneAiUsage(db, {
        maxAgeMs:
          config.maxAgeDays == null
            ? undefined
            : config.maxAgeDays * MS_PER_DAY,
        maxRows: config.maxRows,
        dryRun: context.dryRun,
        now: context.now,
      });
      return pruned;
    },
  };
}

function contextsTask(policy: RetentionPolicy): RetentionTask | null {
  const config = resolveEntry<ContextsRetentionPolicy>(
    policy.contexts,
    DEFAULT_RETENTION_POLICY.contexts,
  );
  if (!config) return null;

  return {
    name: 'contexts',
    description: 'Delete expired context entries (_smrt_contexts)',
    run: async (db, context) => {
      const { pruned } = await pruneExpiredContexts(db, {
        now: context.now,
        dryRun: context.dryRun,
      });
      return pruned;
    },
  };
}

function dispatchTask(policy: RetentionPolicy): RetentionTask | null {
  const config = resolveEntry<DispatchRetentionPolicy>(
    policy.dispatch,
    DEFAULT_RETENTION_POLICY.dispatch,
  );
  if (!config) return null;

  return {
    name: 'dispatch',
    description: 'Prune processed dispatch queue rows (_smrt_dispatch)',
    run: async (db, context) => {
      // Imported lazily: the dispatch collection pulls in the whole dispatch
      // module graph, which this module must not force onto callers that only
      // prune system tables.
      const { DispatchCollection } = await import(
        '../dispatch/collections/Dispatches.js'
      );
      const result = await DispatchCollection.cleanup(db, {
        completedOlderThanDays: config.completedOlderThanDays,
        failedOlderThanDays: config.failedOlderThanDays,
        dryRun: context.dryRun,
      });
      return {
        pruned: result.completedDeleted + result.failedDeleted,
        details: {
          completed: result.completedDeleted,
          failed: result.failedDeleted,
        },
      };
    },
  };
}

// ============================================================================
// SQL helpers
// ============================================================================

function getQueryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows as Record<string, unknown>[];
    }
  }
  return [];
}

function getDatabaseUrl(db: DatabaseInterface): string {
  return db.url || (db as { config?: { url?: string } }).config?.url || '';
}

/**
 * Rewrite `?` placeholders to `$n` on PostgreSQL.
 *
 * Retention SQL is written once in the portable `?` form; only the binding
 * syntax differs between engines.
 */
function bindPlaceholders(db: DatabaseInterface, sql: string): string {
  const engine = detectEngine(
    getDatabaseUrl(db),
    (db as { type?: string }).type,
  );
  if (engine !== 'postgres') return sql;

  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function whereClause(conditions: string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
}

function tenantScopeClause(retention: AiUsageRetention): {
  conditions: string[];
  params: unknown[];
} {
  if (!('tenantId' in retention)) return { conditions: [], params: [] };
  if (retention.tenantId === undefined) return { conditions: [], params: [] };
  if (retention.tenantId === null) {
    return { conditions: ['tenant_id IS NULL'], params: [] };
  }
  return { conditions: ['tenant_id = ?'], params: [retention.tenantId] };
}

async function selectOne(
  db: DatabaseInterface,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown> | undefined> {
  const rows = getQueryRows(
    await db.query(bindPlaceholders(db, sql), ...params),
  );
  return rows[0];
}

/**
 * Count matching rows, then delete them unless this is a dry run.
 *
 * Counting first gives a usable number on every adapter — `rowCount` is not
 * reliably populated across the engines SMRT supports — and is what makes
 * `dryRun` a genuine preview of the same predicate rather than an estimate of
 * a different one.
 *
 * The count and the delete are two statements and deliberately not a
 * transaction: a maintenance sweep must not hold a write lock over a large
 * delete. The returned figure is therefore approximate under concurrent
 * writers, exactly as `pruneChangeFeed` documents.
 */
async function deleteFrom(
  db: DatabaseInterface,
  table: string,
  conditions: string[],
  params: unknown[],
  dryRun: boolean,
): Promise<number> {
  const where = whereClause(conditions);
  const countRow = await selectOne(
    db,
    `SELECT COUNT(*) AS total FROM ${table} ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  if (!Number.isFinite(total) || total <= 0) return 0;

  if (!dryRun) {
    await db.query(
      bindPlaceholders(db, `DELETE FROM ${table} ${where}`),
      ...params,
    );
  }

  return total;
}

/** Best-effort table probe used to report `unavailable` rather than throwing. */
async function tableExists(
  db: DatabaseInterface,
  table: string,
): Promise<boolean> {
  try {
    if (typeof db.tableExists === 'function') {
      return await db.tableExists(table);
    }
  } catch {
    return false;
  }

  try {
    await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}
