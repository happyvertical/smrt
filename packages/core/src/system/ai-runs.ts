/**
 * Multi-call run records (`_smrt_ai_runs`, #4753).
 *
 * A fusion runs several model calls for one answer. Every call keeps its own
 * `_smrt_ai_usage` row (tagged `runId`, `fusionKey`, `seat`); the run row
 * says what the run was (fusion, mode, entry prompt), how it went (`ok`,
 * `degraded`, `failed`), and holds the per-seat details as JSON. The run row
 * is written by core's executor context (`recordRun`), never by the executor
 * itself, so it takes the instance's tenant and class like a usage row.
 *
 * `details` holds identities and totals only (seat persona, prompt key,
 * target and model labels, token usage, substitutions, gate verdict, failure
 * class and message): never prompts, inputs, outputs, or keys.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import type { InferenceRunStatus } from '../inference.js';

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

/** `_smrt_ai_runs.status` values. */
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

/** A persisted run row. */
export interface AiRunRecord {
  id: string;
  fusionKey: string;
  mode: string;
  status: InferenceRunStatus;
  seats: number;
  degradedSeats: number;
  duration: number;
  promptKey: string | null;
  className: string | null;
  tenantId: string | null;
  /** Parsed `details`; `{}` when absent or unreadable. */
  details: Record<string, unknown>;
  createdAt: Date;
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

/** Write one `_smrt_ai_runs` row. */
export async function recordAiRun(
  db: DatabaseInterface,
  input: AiRunInput,
): Promise<void> {
  const id = requireText(input.id, 'id');
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
  await db.query(
    `INSERT INTO _smrt_ai_runs
      (id, fusion_key, mode, tenant_id, class_name, prompt_key, seats,
       degraded_seats, status, duration, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    id,
    fusionKey,
    mode,
    input.tenantId ?? null,
    input.className ?? null,
    input.promptKey ?? null,
    seats,
    degradedSeats,
    input.status,
    duration,
    JSON.stringify(input.details ?? {}),
    (input.createdAt ?? new Date()).toISOString(),
  );
}

function parseDetails(value: unknown): Record<string, unknown> {
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

function toRunRecord(row: Record<string, unknown>): AiRunRecord {
  return {
    id: String(row.id),
    fusionKey: String(row.fusion_key),
    mode: String(row.mode),
    status: String(row.status) as InferenceRunStatus,
    seats: count(row.seats),
    degradedSeats: count(row.degraded_seats),
    duration: count(row.duration),
    promptKey: nullableString(row.prompt_key),
    className: nullableString(row.class_name),
    tenantId: nullableString(row.tenant_id),
    details: parseDetails(row.details),
    createdAt: toDate(row.created_at),
  };
}

/** Filters for {@link listAiRuns}. */
export interface ListAiRunsOptions {
  id?: string;
  fusionKey?: string;
  status?: InferenceRunStatus;
  /** Only this tenant; `null` only global runs. */
  tenantId?: string | null;
  since?: Date;
  until?: Date;
  /** Default 100, at most 1000. */
  limit?: number;
}

/** Runs newest first. */
export async function listAiRuns(
  db: DatabaseInterface,
  options: ListAiRunsOptions = {},
): Promise<AiRunRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (options.id) add('id = ?', options.id);
  if (options.fusionKey) add('fusion_key = ?', options.fusionKey);
  if (options.status) add('status = ?', options.status);
  if (options.tenantId === null) conditions.push('tenant_id IS NULL');
  else if (options.tenantId) add('tenant_id = ?', options.tenantId);
  if (options.since) add('created_at >= ?', options.since.toISOString());
  if (options.until) add('created_at <= ?', options.until.toISOString());
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1000);
  params.push(limit);
  const rows = getRows(
    await db.query(
      `SELECT id, fusion_key, mode, tenant_id, class_name, prompt_key, seats,
              degraded_seats, status, duration, details, created_at
         FROM _smrt_ai_runs
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      ...params,
    ),
  );
  return rows.map(toRunRecord);
}

/** Totals for one fusion (or all runs). */
export interface AiRunReportStats {
  runs: number;
  ok: number;
  degraded: number;
  failed: number;
  /** Seats that ran, summed. */
  seats: number;
  /** Seats that died or answered through a substitution, summed. */
  degradedSeats: number;
  /** Median run duration in ms (lower median), or null with no runs. */
  p50DurationMs: number | null;
}

/** One fusion's runs. */
export interface AiRunReportBucket extends AiRunReportStats {
  fusionKey: string;
}

/** Options for {@link reportAiRuns}. */
export interface AiRunReportOptions {
  since?: Date;
  until?: Date;
  /** Total only this tenant; `null` totals only global runs. */
  tenantId?: string | null;
}

/** The result of {@link reportAiRuns}. */
export interface AiRunReport {
  since: Date | null;
  until: Date | null;
  tenantId?: string | null;
  totals: AiRunReportStats;
  /** Most runs first. */
  buckets: AiRunReportBucket[];
  /** Runs in the window a tenant filter left out. */
  excluded: { otherTenants: number };
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
      ok: 0,
      degraded: 0,
      failed: 0,
      seats: 0,
      degradedSeats: 0,
      p50DurationMs: null,
    },
    durations: [],
  };
}

/**
 * Group `_smrt_ai_runs` by fusion key (`smrt ai:usage --by fusion`). Reads
 * bounded keyset pages and aggregates in memory, like `reportAiUsage()`; a
 * tenant filter selects what is totalled and counts the rest in `excluded`.
 */
export async function reportAiRuns(
  db: DatabaseInterface,
  options: AiRunReportOptions = {},
): Promise<AiRunReport> {
  const windowConditions: string[] = [];
  const windowParams: unknown[] = [];
  if (options.since) {
    windowParams.push(options.since.toISOString());
    windowConditions.push(`created_at >= $${windowParams.length}`);
  }
  if (options.until) {
    windowParams.push(options.until.toISOString());
    windowConditions.push(`created_at <= $${windowParams.length}`);
  }
  const tenantFiltered = options.tenantId !== undefined;

  const totals = emptyStats();
  const buckets = new Map<string, ReturnType<typeof emptyStats>>();
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
        `SELECT id, fusion_key, tenant_id, seats, degraded_seats, status, duration
           FROM _smrt_ai_runs
          ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY id ASC
          LIMIT $${params.length}`,
        ...params,
      ),
    );
    if (page.length === 0) break;
    lastId = String(page[page.length - 1]?.id);
    for (const row of page) {
      if (
        tenantFiltered &&
        nullableString(row.tenant_id) !== options.tenantId
      ) {
        excluded.otherTenants++;
        continue;
      }
      const key = String(row.fusion_key);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = emptyStats();
        buckets.set(key, bucket);
      }
      for (const acc of [totals, bucket]) {
        acc.stats.runs++;
        const status = String(row.status);
        if (status === 'ok' || status === 'degraded' || status === 'failed') {
          acc.stats[status]++;
        }
        acc.stats.seats += count(row.seats);
        acc.stats.degradedSeats += count(row.degraded_seats);
        acc.durations.push(count(row.duration));
      }
    }
    if (page.length < REPORT_PAGE_SIZE) break;
  }

  const finish = (acc: ReturnType<typeof emptyStats>): AiRunReportStats => ({
    ...acc.stats,
    p50DurationMs: lowerMedian(acc.durations),
  });
  const report: AiRunReport = {
    since: options.since ?? null,
    until: options.until ?? null,
    totals: finish(totals),
    buckets: [...buckets.entries()]
      .map(([fusionKey, acc]) => ({ fusionKey, ...finish(acc) }))
      .sort(
        (a, b) => b.runs - a.runs || a.fusionKey.localeCompare(b.fusionKey),
      ),
    excluded,
  };
  if (tenantFiltered) report.tenantId = options.tenantId;
  return report;
}
