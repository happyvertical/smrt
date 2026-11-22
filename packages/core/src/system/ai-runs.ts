/**
 * Readers of `_smrt_ai_runs` (#4753, #5005): {@link listAiRuns} and
 * {@link reportAiRuns} cover runs of every type (`fusion`, `turn`,
 * `workflow`, an owner's `@scope/pkg:type`) in the run vocabulary of
 * docs/content/ai-runs.md: statuses `running`, `waiting-approval`,
 * `stopped`, `cancelled`, `failed`, `done` (a legacy `ok` or `degraded` row
 * reads as `done`, `degraded` as the flag), own and inclusive totals, and
 * check and approval counts (from the events, or the counts saved on a run
 * whose trajectory was pruned).
 *
 * {@link recordAiRun} is the pre-#5005 writer of a finished fusion row, kept
 * for executors on older cores: a fusion's run is now opened at its start
 * (`openAiEntryRun`, through the executor context's `openRun`).
 *
 * A fusion's `details` hold identities and totals only (seat persona,
 * prompt key, target and model labels, token usage, substitutions, gate
 * verdict, failure class): never prompts, inputs, outputs, or keys.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import type { InferenceRunStatus } from '../inference.js';
import {
  assertAiRunId,
  insertAiRunRowTx,
  withAiRunTransaction,
} from './ai-run-model.js';
import {
  type AiUsageTenantScope,
  requireAiUsageScope,
} from './ai-usage-scope.js';

function getRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function count(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** The fusion statuses this module speaks; stored as run status and flag. */
export const AI_RUN_STATUSES = ['ok', 'degraded', 'failed'] as const;

/** Input for {@link recordAiRun}. */
export interface AiRunInput {
  /** The run id its usage rows carry in `_smrt_ai_usage.run_id`. */
  id: string;
  fusionKey: string;
  mode: string;
  status: InferenceRunStatus;
  seats: number;
  degradedSeats: number;
  /** Wall time in ms. */
  duration: number;
  /** The entry call's prompt key. */
  promptKey?: string | null;
  className?: string | null;
  tenantId?: string | null;
  details?: Record<string, unknown>;
  createdAt?: Date;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`recordAiRun: ${name} must be a non-empty string`);
  }
  return value;
}

function requireCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `recordAiRun: ${name} must be a non-negative safe integer`,
    );
  }
  return value;
}

/**
 * Write one finished fusion row, at its end.
 *
 * @deprecated Since #5005 a fusion's run is opened at its start through the
 * executor context's `openRun` (`openAiEntryRun`).
 */
export async function recordAiRun(
  db: DatabaseInterface,
  input: AiRunInput,
): Promise<void> {
  const id = assertAiRunId(requireText(input.id, 'id'), 'recordAiRun');
  const fusionKey = requireText(input.fusionKey, 'fusionKey');
  const mode = requireText(input.mode, 'mode');
  if (!AI_RUN_STATUSES.includes(input.status)) {
    throw new TypeError(
      `recordAiRun: status must be one of ${AI_RUN_STATUSES.join(', ')}`,
    );
  }
  const seats = requireCount(input.seats, 'seats');
  const degradedSeats = requireCount(input.degradedSeats, 'degradedSeats');
  const duration = Math.max(0, Math.round(Number(input.duration) || 0));
  const createdAt = input.createdAt ?? new Date();
  const details = JSON.stringify(input.details ?? {});
  // Through the one run-row writer, in its own transaction: the id's digest
  // is reserved with the row, so a used id is refused (AiRunIdUsedError).
  await withAiRunTransaction(db, (tx) =>
    insertAiRunRowTx(tx, {
      id,
      type: 'fusion',
      definition_key: fusionKey,
      mode,
      tenant_id: input.tenantId ?? null,
      class_name: input.className ?? null,
      prompt_key: input.promptKey ?? null,
      seats,
      degraded_seats: degradedSeats,
      status: input.status === 'failed' ? 'failed' : 'done',
      degraded: input.status === 'degraded' ? 1 : 0,
      stop_reason: input.status === 'failed' ? 'error' : null,
      duration,
      details,
      started_at: new Date(createdAt.getTime() - duration).toISOString(),
      finished_at: createdAt.toISOString(),
      created_at: createdAt.toISOString(),
    }),
  );
}

function parseDetails(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A run's status as a reader reports it (#5005). */
export type AiRunReadStatus =
  | 'running'
  | 'waiting-approval'
  | 'stopped'
  | 'cancelled'
  | 'failed'
  | 'done';

/** A persisted run row, of any type (#5005). */
export interface AiRunRecord {
  id: string;
  /** `fusion`, `turn`, `workflow`, or an owner's `@scope/pkg:type`. */
  type: string;
  definitionKey: string | null;
  /** @deprecated The fusion key is the `definitionKey`; same value. */
  fusionKey: string;
  definitionVersion: string | null;
  /** Lifecycle status: a legacy `ok` / `degraded` row reads as `done`. */
  status: AiRunReadStatus;
  degraded: boolean;
  stopReason: string | null;
  stoppedByRunId: string | null;
  parentRunId: string | null;
  retryOfRunId: string | null;
  experimentId: string | null;
  /** Fusion runs; empty for other types. */
  mode: string;
  seats: number;
  degradedSeats: number;
  /** Active time in ms. */
  duration: number;
  promptKey: string | null;
  templateHash: string | null;
  className: string | null;
  tenantId: string | null;
  /** Own totals: this run's own calls. */
  tokens: number;
  costUsed: number;
  calls: number;
  uncostedCalls: number;
  stepsUsed: number;
  /** Inclusive totals: with every descendant run. */
  inclusiveTokens: number;
  inclusiveCost: number;
  inclusiveCalls: number;
  trajectoryPruned: boolean;
  retain: boolean;
  /** Parsed `details`; `{}` when absent or unreadable. */
  details: Record<string, unknown>;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

function readStatus(row: Record<string, unknown>): AiRunReadStatus {
  const status = String(row.status);
  if (status === 'ok' || status === 'degraded') return 'done';
  return status as AiRunReadStatus;
}

function nullableDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  return toDate(value);
}

const RUN_COLUMNS = `id, type, definition_key, definition_version, mode,
  tenant_id, class_name, prompt_key, template_hash, seats, degraded_seats,
  status, degraded, stop_reason, stopped_by_run_id, parent_run_id,
  retry_of_run_id, experiment_id, duration, details, tokens, cost_used, calls,
  uncosted_calls, steps_used, inclusive_tokens, inclusive_cost,
  inclusive_calls, trajectory_pruned, retain, started_at, finished_at,
  created_at`;

function toRunRecord(row: Record<string, unknown>): AiRunRecord {
  const definitionKey = nullableString(row.definition_key);
  return {
    id: String(row.id),
    type: nullableString(row.type) ?? 'fusion',
    definitionKey,
    fusionKey: definitionKey ?? '',
    definitionVersion: nullableString(row.definition_version),
    status: readStatus(row),
    degraded: count(row.degraded) > 0 || String(row.status) === 'degraded',
    stopReason: nullableString(row.stop_reason),
    stoppedByRunId: nullableString(row.stopped_by_run_id),
    parentRunId: nullableString(row.parent_run_id),
    retryOfRunId: nullableString(row.retry_of_run_id),
    experimentId: nullableString(row.experiment_id),
    mode: nullableString(row.mode) ?? '',
    seats: count(row.seats),
    degradedSeats: count(row.degraded_seats),
    duration: count(row.duration),
    promptKey: nullableString(row.prompt_key),
    templateHash: nullableString(row.template_hash),
    className: nullableString(row.class_name),
    tenantId: nullableString(row.tenant_id),
    tokens: count(row.tokens),
    costUsed: count(row.cost_used),
    calls: count(row.calls),
    uncostedCalls: count(row.uncosted_calls),
    stepsUsed: count(row.steps_used),
    inclusiveTokens: count(row.inclusive_tokens),
    inclusiveCost: count(row.inclusive_cost),
    inclusiveCalls: count(row.inclusive_calls),
    trajectoryPruned: count(row.trajectory_pruned) > 0,
    retain: count(row.retain) > 0,
    details: parseDetails(row.details),
    startedAt: nullableDate(row.started_at),
    finishedAt: nullableDate(row.finished_at),
    createdAt: toDate(row.created_at),
  };
}

/**
 * The legacy fusion vocabulary (`ok`, `degraded`) a `status` filter still
 * accepts, mapped to the lifecycle columns.
 */
const LEGACY_STATUS_SQL: Record<string, string> = {
  ok: "status IN ('done', 'ok') AND degraded = 0",
  degraded:
    "(status = 'degraded' OR (status IN ('done', 'ok') AND degraded <> 0))",
  done: "status IN ('done', 'ok', 'degraded')",
};

const READ_STATUSES: readonly string[] = [
  'running',
  'waiting-approval',
  'stopped',
  'cancelled',
  'failed',
  'done',
  'ok',
  'degraded',
];

/** Filters for {@link listAiRuns}. */
export interface ListAiRunsOptions extends AiUsageTenantScope {
  id?: string;
  /** One run type (`fusion`, `turn`, `workflow`, `@scope/pkg:type`). */
  type?: string;
  definitionKey?: string;
  /** @deprecated Use `definitionKey` (and `type: 'fusion'`). */
  fusionKey?: string;
  /**
   * A lifecycle status; `ok` (done, not degraded) and `degraded` are still
   * accepted.
   */
  status?: AiRunReadStatus | 'ok' | 'degraded';
  parentRunId?: string;
  experimentId?: string;
  /** Only this tenant; `null` only global runs. */
  tenantId?: string | null;
  since?: Date;
  until?: Date;
  /** Default 100, at most 1000. */
  limit?: number;
}

function statusCondition(status: string): string {
  if (!READ_STATUSES.includes(status)) {
    throw new TypeError(`listAiRuns: unknown status ${status}`);
  }
  return LEGACY_STATUS_SQL[status] ?? `status = '${status}'`;
}

/** Runs of every type, newest first. */
export async function listAiRuns(
  db: DatabaseInterface,
  options: ListAiRunsOptions,
): Promise<AiRunRecord[]> {
  requireAiUsageScope('listAiRuns', options ?? {});
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (options.id) add('id = ?', options.id);
  if (options.type) add('type = ?', options.type);
  if (options.fusionKey) {
    conditions.push("type = 'fusion'");
    add('definition_key = ?', options.fusionKey);
  }
  if (options.definitionKey) add('definition_key = ?', options.definitionKey);
  if (options.status) conditions.push(statusCondition(options.status));
  if (options.parentRunId) add('parent_run_id = ?', options.parentRunId);
  if (options.experimentId) add('experiment_id = ?', options.experimentId);
  if (options.tenantId === null) conditions.push('tenant_id IS NULL');
  else if (options.tenantId !== undefined)
    add('tenant_id = ?', options.tenantId);
  if (options.since) add('created_at >= ?', options.since.toISOString());
  if (options.until) add('created_at <= ?', options.until.toISOString());
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1000);
  params.push(limit);
  const rows = getRows(
    await db.query(
      `SELECT ${RUN_COLUMNS}
         FROM _smrt_ai_runs
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      ...params,
    ),
  );
  return rows.map(toRunRecord);
}

/** Totals for one bucket of runs (or all of them). */
export interface AiRunReportStats {
  runs: number;
  running: number;
  waitingApproval: number;
  stopped: number;
  cancelled: number;
  failed: number;
  done: number;
  /** Done runs that were degraded (a fusion seat died or substituted). */
  degraded: number;
  /** @deprecated Done and not degraded; the old fusion `ok`. */
  ok: number;
  /** Fusion seats that ran, summed. */
  seats: number;
  /** Fusion seats that died or answered through a substitution, summed. */
  degradedSeats: number;
  /** Own calls, tokens and cost (uncosted calls counted, never priced). */
  calls: number;
  tokens: number;
  cost: number;
  uncostedCalls: number;
  /**
   * Checks and approval decisions: counted from the events, or the counts
   * saved on a run whose trajectory was pruned. A decision counts in the
   * run that recorded it; a request never counts.
   */
  checksPassed: number;
  checksFailed: number;
  approvalsGiven: number;
  approvalsRefused: number;
  /** `checksPassed / (checksPassed + checksFailed)`, or null. */
  checkPassRate: number | null;
  /** `approvalsGiven / (approvalsGiven + approvalsRefused)`, or null. */
  approvalRate: number | null;
  /** Median active time in ms (lower median), or null with no runs. */
  p50DurationMs: number | null;
}

/** One `(type, definition)` bucket. */
export interface AiRunReportBucket extends AiRunReportStats {
  type: string;
  definitionKey: string | null;
  /** @deprecated The `definitionKey` ('' when none). */
  fusionKey: string;
}

/** Options for {@link reportAiRuns}. */
export interface AiRunReportOptions extends AiUsageTenantScope {
  /** Only runs of this type (`smrt ai:usage --by fusion` passes `fusion`). */
  type?: string;
  since?: Date;
  until?: Date;
  /**
   * Read and total only this tenant's runs; `null` only global runs. The
   * filter is a SQL predicate: runs of other tenants are never read.
   */
  tenantId?: string | null;
}

/** The result of {@link reportAiRuns}. */
export interface AiRunReport {
  since: Date | null;
  until: Date | null;
  tenantId?: string | null;
  type?: string;
  totals: AiRunReportStats;
  /** Most runs first. */
  buckets: AiRunReportBucket[];
  excluded: {
    /**
     * @deprecated Always 0. The tenant filter is applied in SQL, so runs of
     * other tenants are neither read nor counted.
     */
    otherTenants: number;
  };
}

const REPORT_PAGE_SIZE = 1000;

function lowerMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function emptyStats(): { stats: AiRunReportStats; durations: number[] } {
  return {
    stats: {
      runs: 0,
      running: 0,
      waitingApproval: 0,
      stopped: 0,
      cancelled: 0,
      failed: 0,
      done: 0,
      degraded: 0,
      ok: 0,
      seats: 0,
      degradedSeats: 0,
      calls: 0,
      tokens: 0,
      cost: 0,
      uncostedCalls: 0,
      checksPassed: 0,
      checksFailed: 0,
      approvalsGiven: 0,
      approvalsRefused: 0,
      checkPassRate: null,
      approvalRate: null,
      p50DurationMs: null,
    },
    durations: [],
  };
}

const STATUS_FIELD: Record<
  AiRunReadStatus,
  'running' | 'waitingApproval' | 'stopped' | 'cancelled' | 'failed' | 'done'
> = {
  running: 'running',
  'waiting-approval': 'waitingApproval',
  stopped: 'stopped',
  cancelled: 'cancelled',
  failed: 'failed',
  done: 'done',
};

/** Check and approval counts per run of a page, from its events. */
async function eventCounts(
  db: DatabaseInterface,
  runIds: string[],
): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  for (let start = 0; start < runIds.length; start += 500) {
    const chunk = runIds.slice(start, start + 500);
    if (chunk.length === 0) continue;
    const marks = chunk.map((_, i) => `$${i + 1}`).join(', ');
    for (const row of getRows(
      await db.query(
        `SELECT run_id, type, status, COUNT(*) AS n FROM _smrt_ai_run_events
          WHERE run_id IN (${marks}) AND type IN ('check', 'approval')
          GROUP BY run_id, type, status`,
        ...chunk,
      ),
    )) {
      const id = String(row.run_id);
      const counts = out.get(id) ?? {};
      counts[`${String(row.type)}:${String(row.status)}`] = count(row.n);
      out.set(id, counts);
    }
  }
  return out;
}

/**
 * Group `_smrt_ai_runs` by `(type, definition)` (`smrt ai:usage --runs`;
 * `--by fusion` reads `type: 'fusion'` only): runs per status, degraded,
 * fusion seats, own calls, tokens and cost, checks and approvals with their
 * rates (saved counts for a pruned trajectory), and median active time.
 * Reads bounded keyset pages and aggregates in memory, like
 * `reportAiUsage()`; a tenant filter is a predicate of the page query, so
 * other tenants' runs are never read or counted.
 */
export async function reportAiRuns(
  db: DatabaseInterface,
  options: AiRunReportOptions,
): Promise<AiRunReport> {
  requireAiUsageScope('reportAiRuns', options ?? {});
  const windowConditions: string[] = [];
  const windowParams: unknown[] = [];
  if (options.type) {
    windowParams.push(options.type);
    windowConditions.push(`type = $${windowParams.length}`);
  }
  if (options.since) {
    windowParams.push(options.since.toISOString());
    windowConditions.push(`created_at >= $${windowParams.length}`);
  }
  if (options.until) {
    windowParams.push(options.until.toISOString());
    windowConditions.push(`created_at <= $${windowParams.length}`);
  }
  const tenantFiltered = options.tenantId !== undefined;
  if (options.tenantId === null) windowConditions.push('tenant_id IS NULL');
  else if (options.tenantId !== undefined) {
    windowParams.push(options.tenantId);
    windowConditions.push(`tenant_id = $${windowParams.length}`);
  }

  const totals = emptyStats();
  const buckets = new Map<
    string,
    { type: string; definitionKey: string | null } & ReturnType<
      typeof emptyStats
    >
  >();
  const excluded = { otherTenants: 0 };
  let lastId: string | null = null;
  for (;;) {
    const params = [...windowParams];
    const conditions = [...windowConditions];
    if (lastId !== null) {
      params.push(lastId);
      conditions.push(`id > $${params.length}`);
    }
    params.push(REPORT_PAGE_SIZE);
    const page = getRows(
      await db.query(
        `SELECT id, type, definition_key, tenant_id, seats, degraded_seats,
                status, degraded, duration, calls, tokens, cost_used,
                uncosted_calls, trajectory_pruned, checks_passed,
                checks_failed, approvals_given, approvals_refused
           FROM _smrt_ai_runs
          ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY id ASC
          LIMIT $${params.length}`,
        ...params,
      ),
    );
    if (page.length === 0) break;
    lastId = String(page[page.length - 1]?.id);
    const counted = page;
    const live = await eventCounts(
      db,
      counted
        .filter((row) => count(row.trajectory_pruned) === 0)
        .map((row) => String(row.id)),
    );
    for (const row of counted) {
      const type = nullableString(row.type) ?? 'fusion';
      const definitionKey = nullableString(row.definition_key);
      const key = JSON.stringify([type, definitionKey]);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { type, definitionKey, ...emptyStats() };
        buckets.set(key, bucket);
      }
      const status = readStatus(row);
      const degraded =
        count(row.degraded) > 0 || String(row.status) === 'degraded';
      const pruned = count(row.trajectory_pruned) > 0;
      const events = live.get(String(row.id)) ?? {};
      const checksPassed = pruned
        ? count(row.checks_passed)
        : (events['check:passed'] ?? 0);
      const checksFailed = pruned
        ? count(row.checks_failed)
        : (events['check:failed'] ?? 0);
      const approvalsGiven = pruned
        ? count(row.approvals_given)
        : (events['approval:approved'] ?? 0);
      const approvalsRefused = pruned
        ? count(row.approvals_refused)
        : (events['approval:refused'] ?? 0);
      for (const acc of [totals, bucket]) {
        const stats = acc.stats;
        stats.runs++;
        const field = STATUS_FIELD[status];
        if (field) stats[field]++;
        if (status === 'done') {
          if (degraded) stats.degraded++;
          else stats.ok++;
        }
        stats.seats += count(row.seats);
        stats.degradedSeats += count(row.degraded_seats);
        stats.calls += count(row.calls);
        stats.tokens += count(row.tokens);
        stats.cost += count(row.cost_used);
        stats.uncostedCalls += count(row.uncosted_calls);
        stats.checksPassed += checksPassed;
        stats.checksFailed += checksFailed;
        stats.approvalsGiven += approvalsGiven;
        stats.approvalsRefused += approvalsRefused;
        acc.durations.push(count(row.duration));
      }
    }
    if (page.length < REPORT_PAGE_SIZE) break;
  }

  const finish = (acc: ReturnType<typeof emptyStats>): AiRunReportStats => {
    const checks = acc.stats.checksPassed + acc.stats.checksFailed;
    const decided = acc.stats.approvalsGiven + acc.stats.approvalsRefused;
    return {
      ...acc.stats,
      checkPassRate: checks > 0 ? acc.stats.checksPassed / checks : null,
      approvalRate: decided > 0 ? acc.stats.approvalsGiven / decided : null,
      p50DurationMs: lowerMedian(acc.durations),
    };
  };
  const report: AiRunReport = {
    since: options.since ?? null,
    until: options.until ?? null,
    totals: finish(totals),
    buckets: [...buckets.values()]
      .map(({ type, definitionKey, stats, durations }) => ({
        type,
        definitionKey,
        fusionKey: definitionKey ?? '',
        ...finish({ stats, durations }),
      }))
      .sort(
        (a, b) =>
          b.runs - a.runs ||
          a.type.localeCompare(b.type) ||
          (a.definitionKey ?? '').localeCompare(b.definitionKey ?? ''),
      ),
    excluded,
  };
  if (tenantFiltered) report.tenantId = options.tenantId;
  if (options.type) report.type = options.type;
  return report;
}
