/**
 * SMRT system-diagnostics reader.
 *
 * A typed, SELECT-only view over the framework-owned `_smrt_*` system tables
 * for development tooling (smrt-dev-mcp runtime diagnostics). Every read is a
 * bounded SELECT against explicitly projected safe columns; sensitive columns
 * are never selected and no statement here writes.
 *
 * The reader takes a `DatabaseInterface` (connection resolution lives with the
 * caller) and degrades per category to a `CategoryUnavailable` result when its
 * table is missing or a read fails — it never throws for missing tables and
 * never fabricates data. `_smrt_registry` is a retired system table
 * ({@link RETIRED_SYSTEM_TABLES}) and is reported as retired rather than
 * queried.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { type ChangeFeedEntry, getChangesSince } from '../change-feed.js';
import { getDatabaseEngine, tableExists } from './compatibility.js';

/** Physical `_smrt_*` tables the diagnostics reader knows about. */
export const SYSTEM_DIAGNOSTICS_TABLES = {
  migrations: '_smrt_schema_migrations',
  dispatch: '_smrt_dispatch',
  dispatchSubscriptions: '_smrt_dispatch_subscriptions',
  changes: '_smrt_changes',
  jobs: '_smrt_jobs',
  jobEvents: '_smrt_job_events',
  workers: '_smrt_workers',
  schedules: '_smrt_agent_schedules',
  registry: '_smrt_registry',
} as const;

/** Default page size for row-listing categories. */
export const DIAGNOSTICS_DEFAULT_LIMIT = 50;

/**
 * A category whose table is missing (or whose read failed) on the live
 * database. Callers must surface this as "category unavailable" — never as an
 * empty-but-healthy category and never as a fabricated value.
 */
export interface CategoryUnavailable {
  available: false;
  reason: 'table-missing' | 'retired' | 'read-error';
  message: string;
  tableName?: string;
}

// ---------------------------------------------------------------------------
// Migration status
// ---------------------------------------------------------------------------

/** Safe projection of one `_smrt_schema_migrations` row. */
export interface MigrationStatusRow {
  id: string;
  name: string;
  version: string;
  status: string;
  appliedAt: string | null;
  executionTimeMs: number | null;
  attempts: number | null;
  errorMessage: string | null;
  packageName: string | null;
  sourceFile: string | null;
  isReversible: boolean | null;
  rolledBackAt: string | null;
  appliedBy: string | null;
  batch: number | null;
}

export interface MigrationStatusSummary {
  total: number;
  byStatus: Record<string, number>;
  applied: number;
  pending: number;
  failed: number;
}

export type MigrationStatusResult =
  | {
      available: true;
      summary: MigrationStatusSummary;
      /** Most recently applied migrations, newest first. */
      latest: MigrationStatusRow[];
      /** Failed migrations, newest first. */
      failed: MigrationStatusRow[];
    }
  | CategoryUnavailable;

export interface MigrationStatusOptions {
  /** Row budget for `latest`/`failed` lists (default {@link DIAGNOSTICS_DEFAULT_LIMIT}). */
  limit?: number;
}

/**
 * Bounded, SELECT-only migration history read.
 *
 * Deliberately does not use `MigrationTracker` — its history helpers run
 * DDL-initializing bootstrap — and reads `_smrt_schema_migrations` directly.
 */
export async function readMigrationStatus(
  db: DatabaseInterface,
  options: MigrationStatusOptions = {},
): Promise<MigrationStatusResult> {
  const table = SYSTEM_DIAGNOSTICS_TABLES.migrations;
  if (!(await tableExists(db, table))) {
    return unavailable(table, 'table-missing');
  }
  const limit = boundedLimit(options.limit);

  try {
    const p = placeholders(db);
    const countRows = queryRows(
      await db.query(
        `SELECT status, COUNT(*) AS total FROM ${table} GROUP BY status`,
      ),
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of countRows) {
      const status = String(row.status ?? 'unknown');
      const count = toCount(row.total);
      byStatus[status] = count;
      total += count;
    }
    const applied = byStatus.applied ?? 0;
    const pending = byStatus.pending ?? 0;
    const failed = byStatus.failed ?? 0;

    const latest = queryRows(
      await db.query(
        `SELECT ${MIGRATION_COLUMNS} FROM ${table}
          WHERE status = 'applied'
          ORDER BY applied_at DESC, id ASC
          LIMIT ${p(1)}`,
        limit,
      ),
    ).map(toMigrationRow);

    const failedRows = queryRows(
      await db.query(
        `SELECT ${MIGRATION_COLUMNS} FROM ${table}
          WHERE status = 'failed'
          ORDER BY applied_at DESC, id ASC
          LIMIT ${p(1)}`,
        limit,
      ),
    ).map(toMigrationRow);

    return {
      available: true,
      summary: { total, byStatus, applied, pending, failed },
      latest,
      failed: failedRows,
    };
  } catch {
    return unavailable(table, 'read-error');
  }
}

const MIGRATION_COLUMNS = [
  'id',
  'name',
  'version',
  'status',
  'applied_at',
  'execution_time_ms',
  'attempts',
  'error_message',
  'package_name',
  'source_file',
  'is_reversible',
  'rolled_back_at',
  'applied_by',
  'batch',
].join(', ');

function toMigrationRow(row: Record<string, unknown>): MigrationStatusRow {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    version: String(row.version ?? ''),
    status: String(row.status ?? ''),
    appliedAt: toIso(row.applied_at),
    executionTimeMs: toNumber(row.execution_time_ms),
    attempts: toNumber(row.attempts),
    errorMessage: toNullableString(row.error_message),
    packageName: toNullableString(row.package_name),
    sourceFile: toNullableString(row.source_file),
    isReversible: toBoolean(row.is_reversible),
    rolledBackAt: toIso(row.rolled_back_at),
    appliedBy: toNullableString(row.applied_by),
    batch: toNumber(row.batch),
  };
}

// ---------------------------------------------------------------------------
// Job health
// ---------------------------------------------------------------------------

/**
 * Safe projection of one `_smrt_jobs` row. Job payload/result columns
 * (`args`, `task_result`, `task_input_requests`, `task_input_responses`,
 * `result_pointer`) are deliberately never selected.
 */
export interface JobHealthRow {
  id: string;
  tenantId: string | null;
  queue: string;
  objectType: string;
  objectId: string | null;
  method: string;
  status: string;
  attempts: number | null;
  maxAttempts: number | null;
  runAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  taskId: string | null;
  taskOwnerId: string | null;
  workerId: string | null;
  workerHeartbeat: string | null;
}

/** Safe projection of one `_smrt_workers` row (no sensitive columns). */
export interface WorkerHealthRow {
  id: string;
  workerId: string;
  pid: number | null;
  hostname: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  status: string;
}

export interface JobHealthSummary {
  total: number;
  byStatus: Record<string, number>;
  failed: number;
  /** `running` jobs whose heartbeat is older than the stale threshold. */
  stuck: number;
  /** Total rows in `_smrt_job_events`, or null when that table is missing. */
  eventCount: number | null;
}

export type JobHealthResult =
  | {
      available: true;
      summary: JobHealthSummary;
      jobs: JobHealthRow[];
      workers: WorkerHealthRow[];
    }
  | CategoryUnavailable;

export interface JobHealthOptions {
  /** Row budget for `jobs` (default {@link DIAGNOSTICS_DEFAULT_LIMIT}). */
  limit?: number;
  /** Heartbeat older than this (ms) marks a `running` job as stuck. */
  staleAfterMs?: number;
  /** Clock for staleness computations (defaults to `new Date()`). */
  now?: Date;
}

/** Read `_smrt_jobs`, `_smrt_workers`, and a `_smrt_job_events` count. */
export async function readJobHealth(
  db: DatabaseInterface,
  options: JobHealthOptions = {},
): Promise<JobHealthResult> {
  const table = SYSTEM_DIAGNOSTICS_TABLES.jobs;
  if (!(await tableExists(db, table))) {
    return unavailable(table, 'table-missing');
  }
  const limit = boundedLimit(options.limit);
  const staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
  const now = options.now ?? new Date();
  const staleCutoff = new Date(now.getTime() - staleAfterMs);

  try {
    const p = placeholders(db);
    const statusRows = queryRows(
      await db.query(
        `SELECT status, COUNT(*) AS total FROM ${table} GROUP BY status`,
      ),
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of statusRows) {
      const status = String(row.status ?? 'unknown');
      const count = toCount(row.total);
      byStatus[status] = count;
      total += count;
    }
    const failed = byStatus.failed ?? 0;

    const stuckRows = queryRows(
      await db.query(
        `SELECT COUNT(*) AS total FROM ${table}
          WHERE status = 'running'
            AND (worker_heartbeat IS NULL OR worker_heartbeat < ${p(1)})`,
        staleCutoff.toISOString(),
      ),
    );
    const stuck = toCount(stuckRows[0]?.total);

    const jobs = queryRows(
      await db.query(
        `SELECT ${JOB_COLUMNS} FROM ${table}
          ORDER BY run_at DESC, id ASC
          LIMIT ${p(1)}`,
        limit,
      ),
    ).map(toJobHealthRow);

    let workers: WorkerHealthRow[] = [];
    const workersTable = SYSTEM_DIAGNOSTICS_TABLES.workers;
    if (await tableExists(db, workersTable)) {
      workers = queryRows(
        await db.query(
          `SELECT ${WORKER_COLUMNS} FROM ${workersTable}
            ORDER BY heartbeat_at DESC, id ASC
            LIMIT ${p(1)}`,
          limit,
        ),
      ).map(toWorkerHealthRow);
    }

    let eventCount: number | null = null;
    const eventsTable = SYSTEM_DIAGNOSTICS_TABLES.jobEvents;
    if (await tableExists(db, eventsTable)) {
      const eventRows = queryRows(
        await db.query(`SELECT COUNT(*) AS total FROM ${eventsTable}`),
      );
      eventCount = toNumber(eventRows[0]?.total);
    }

    return {
      available: true,
      summary: { total, byStatus, failed, stuck, eventCount },
      jobs,
      workers,
    };
  } catch {
    return unavailable(table, 'read-error');
  }
}

const JOB_COLUMNS = [
  'id',
  'tenant_id',
  'queue',
  'object_type',
  'object_id',
  'method',
  'status',
  'attempts',
  'max_attempts',
  'run_at',
  'started_at',
  'completed_at',
  'last_error',
  'task_id',
  'task_owner_id',
  'worker_id',
  'worker_heartbeat',
].join(', ');

const WORKER_COLUMNS = [
  'id',
  'worker_id',
  'pid',
  'hostname',
  'started_at',
  'heartbeat_at',
  'lease_expires_at',
  'status',
].join(', ');

function toJobHealthRow(row: Record<string, unknown>): JobHealthRow {
  return {
    id: String(row.id ?? ''),
    tenantId: toNullableString(row.tenant_id),
    queue: String(row.queue ?? ''),
    objectType: String(row.object_type ?? ''),
    objectId: toNullableString(row.object_id),
    method: String(row.method ?? ''),
    status: String(row.status ?? ''),
    attempts: toNumber(row.attempts),
    maxAttempts: toNumber(row.max_attempts),
    runAt: toIso(row.run_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    lastError: toNullableString(row.last_error),
    taskId: toNullableString(row.task_id),
    taskOwnerId: toNullableString(row.task_owner_id),
    workerId: toNullableString(row.worker_id),
    workerHeartbeat: toIso(row.worker_heartbeat),
  };
}

function toWorkerHealthRow(row: Record<string, unknown>): WorkerHealthRow {
  return {
    id: String(row.id ?? ''),
    workerId: String(row.worker_id ?? ''),
    pid: toNumber(row.pid),
    hostname: toNullableString(row.hostname),
    startedAt: toIso(row.started_at),
    heartbeatAt: toIso(row.heartbeat_at),
    leaseExpiresAt: toIso(row.lease_expires_at),
    status: String(row.status ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Schedule health
// ---------------------------------------------------------------------------

/**
 * Safe projection of one `_smrt_agent_schedules` row. The sensitive
 * `agent_config` and `method_args` columns are never selected.
 */
export interface ScheduleHealthRow {
  id: string;
  tenantId: string | null;
  agentType: string;
  agentId: string | null;
  cron: string;
  timezone: string;
  enabled: boolean | null;
  status: string;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number | null;
  successCount: number | null;
  failureCount: number | null;
  maxConcurrent: number | null;
  runningCount: number | null;
  timeout: number | null;
  method: string;
}

export interface ScheduleHealthSummary {
  total: number;
  enabled: number;
  active: number;
  errored: number;
  /** Schedules whose last run failed (`last_status = 'failed'`). */
  failed: number;
  /** Enabled, active schedules whose `next_run` is due (<= now). */
  overdue: number;
}

export type ScheduleHealthResult =
  | {
      available: true;
      summary: ScheduleHealthSummary;
      schedules: ScheduleHealthRow[];
    }
  | CategoryUnavailable;

export interface ScheduleHealthOptions {
  /** Row budget for `schedules` (default {@link DIAGNOSTICS_DEFAULT_LIMIT}). */
  limit?: number;
  /** Clock for overdue computation (defaults to `new Date()`). */
  now?: Date;
}

/** Read `_smrt_agent_schedules` (owned by `@happyvertical/smrt-agents`). */
export async function readScheduleHealth(
  db: DatabaseInterface,
  options: ScheduleHealthOptions = {},
): Promise<ScheduleHealthResult> {
  const table = SYSTEM_DIAGNOSTICS_TABLES.schedules;
  if (!(await tableExists(db, table))) {
    return unavailable(table, 'table-missing');
  }
  const limit = boundedLimit(options.limit);
  const now = options.now ?? new Date();

  try {
    const p = placeholders(db);
    const enabledRows = queryRows(
      await db.query(
        `SELECT enabled, status, COUNT(*) AS total FROM ${table} GROUP BY enabled, status`,
      ),
    );
    let total = 0;
    let enabled = 0;
    let active = 0;
    let errored = 0;
    for (const row of enabledRows) {
      const count = toCount(row.total);
      total += count;
      if (toBoolean(row.enabled)) enabled += count;
      const status = String(row.status ?? '');
      if (status === 'active') active += count;
      if (status === 'error') errored += count;
    }

    const failedRows = queryRows(
      await db.query(
        `SELECT COUNT(*) AS total FROM ${table} WHERE last_status = 'failed'`,
      ),
    );
    const failed = toCount(failedRows[0]?.total);

    const overdueRows = queryRows(
      await db.query(
        `SELECT COUNT(*) AS total FROM ${table}
          WHERE enabled = true AND status = 'active' AND next_run IS NOT NULL AND next_run <= ${p(1)}`,
        now.toISOString(),
      ),
    );
    const overdue = toCount(overdueRows[0]?.total);

    const schedules = queryRows(
      await db.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM ${table}
          ORDER BY next_run ASC, id ASC
          LIMIT ${p(1)}`,
        limit,
      ),
    ).map(toScheduleHealthRow);

    return {
      available: true,
      summary: { total, enabled, active, errored, failed, overdue },
      schedules,
    };
  } catch {
    return unavailable(table, 'read-error');
  }
}

const SCHEDULE_COLUMNS = [
  'id',
  'tenant_id',
  'agent_type',
  'agent_id',
  'cron',
  'timezone',
  'enabled',
  'status',
  'last_run',
  'next_run',
  'last_status',
  'last_error',
  'run_count',
  'success_count',
  'failure_count',
  'max_concurrent',
  'running_count',
  'timeout',
  'method',
].join(', ');

function toScheduleHealthRow(row: Record<string, unknown>): ScheduleHealthRow {
  return {
    id: String(row.id ?? ''),
    tenantId: toNullableString(row.tenant_id),
    agentType: String(row.agent_type ?? ''),
    agentId: toNullableString(row.agent_id),
    cron: String(row.cron ?? ''),
    timezone: String(row.timezone ?? ''),
    enabled: toBoolean(row.enabled),
    status: String(row.status ?? ''),
    lastRun: toIso(row.last_run),
    nextRun: toIso(row.next_run),
    lastStatus: toNullableString(row.last_status),
    lastError: toNullableString(row.last_error),
    runCount: toNumber(row.run_count),
    successCount: toNumber(row.success_count),
    failureCount: toNumber(row.failure_count),
    maxConcurrent: toNumber(row.max_concurrent),
    runningCount: toNumber(row.running_count),
    timeout: toNumber(row.timeout),
    method: String(row.method ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Dispatch health
// ---------------------------------------------------------------------------

/**
 * Safe projection of one `_smrt_dispatch` row. The `payload` and `metadata`
 * columns are never selected.
 */
export interface DispatchHealthRow {
  id: string;
  type: string;
  source: string;
  sourceId: string | null;
  status: string;
  attempts: number | null;
  lastError: string | null;
  processedAt: string | null;
  processedBy: string | null;
  targetSubscriber: string | null;
  correlationId: string | null;
  tenantId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Safe projection of one `_smrt_dispatch_subscriptions` row. */
export interface DispatchSubscriptionHealthRow {
  id: string;
  signalType: string;
  subscriber: string;
  handler: string;
  delivery: string;
  enabled: boolean | null;
  tenantId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DispatchHealthSummary {
  total: number;
  byStatus: Record<string, number>;
  pending: number;
  processing: number;
  failed: number;
  completed: number;
  subscriptions: number;
}

export type DispatchHealthResult =
  | {
      available: true;
      summary: DispatchHealthSummary;
      dispatches: DispatchHealthRow[];
      subscriptions: DispatchSubscriptionHealthRow[];
    }
  | CategoryUnavailable;

export interface DispatchHealthOptions {
  /** Row budget for `dispatches`/`subscriptions` (default {@link DIAGNOSTICS_DEFAULT_LIMIT}). */
  limit?: number;
}

/** Read `_smrt_dispatch` and `_smrt_dispatch_subscriptions`. */
export async function readDispatchHealth(
  db: DatabaseInterface,
  options: DispatchHealthOptions = {},
): Promise<DispatchHealthResult> {
  const table = SYSTEM_DIAGNOSTICS_TABLES.dispatch;
  if (!(await tableExists(db, table))) {
    return unavailable(table, 'table-missing');
  }
  const limit = boundedLimit(options.limit);

  try {
    const p = placeholders(db);
    const statusRows = queryRows(
      await db.query(
        `SELECT status, COUNT(*) AS total FROM ${table} GROUP BY status`,
      ),
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of statusRows) {
      const status = String(row.status ?? 'unknown');
      const count = toCount(row.total);
      byStatus[status] = count;
      total += count;
    }
    const pending = byStatus.pending ?? 0;
    const processing = byStatus.processing ?? 0;
    const failed = byStatus.failed ?? 0;
    const completed = byStatus.completed ?? 0;

    const dispatches = queryRows(
      await db.query(
        `SELECT ${DISPATCH_COLUMNS} FROM ${table}
          ORDER BY created_at DESC, id ASC
          LIMIT ${p(1)}`,
        limit,
      ),
    ).map(toDispatchHealthRow);

    let subscriptions: DispatchSubscriptionHealthRow[] = [];
    let subscriptionCount = 0;
    const subsTable = SYSTEM_DIAGNOSTICS_TABLES.dispatchSubscriptions;
    if (await tableExists(db, subsTable)) {
      // The summary count is a COUNT(*) aggregate, not the listed-page length:
      // `subscriptions` honors the row budget like every other list, so the
      // list length would silently under-report topology above the limit.
      const countRows = queryRows(
        await db.query(`SELECT COUNT(*) AS total FROM ${subsTable}`),
      );
      subscriptionCount = toCount(countRows[0]?.total);
      const subsRows = queryRows(
        await db.query(
          `SELECT ${SUBSCRIPTION_COLUMNS} FROM ${subsTable}
            ORDER BY created_at DESC, id ASC
            LIMIT ${p(1)}`,
          limit,
        ),
      );
      subscriptions = subsRows.map(toSubscriptionHealthRow);
    }

    return {
      available: true,
      summary: {
        total,
        byStatus,
        pending,
        processing,
        failed,
        completed,
        subscriptions: subscriptionCount,
      },
      dispatches,
      subscriptions,
    };
  } catch {
    return unavailable(table, 'read-error');
  }
}

const DISPATCH_COLUMNS = [
  'id',
  'type',
  'source',
  'source_id',
  'status',
  'attempts',
  'last_error',
  'processed_at',
  'processed_by',
  'target_subscriber',
  'correlation_id',
  'tenant_id',
  'created_at',
  'updated_at',
].join(', ');

const SUBSCRIPTION_COLUMNS = [
  'id',
  'signal_type',
  'subscriber',
  'handler',
  'delivery',
  'enabled',
  'tenant_id',
  'created_at',
  'updated_at',
].join(', ');

function toDispatchHealthRow(row: Record<string, unknown>): DispatchHealthRow {
  return {
    id: String(row.id ?? ''),
    type: String(row.type ?? ''),
    source: String(row.source ?? ''),
    sourceId: toNullableString(row.source_id),
    status: String(row.status ?? ''),
    attempts: toNumber(row.attempts),
    lastError: toNullableString(row.last_error),
    processedAt: toIso(row.processed_at),
    processedBy: toNullableString(row.processed_by),
    targetSubscriber: toNullableString(row.target_subscriber),
    correlationId: toNullableString(row.correlation_id),
    tenantId: toNullableString(row.tenant_id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toSubscriptionHealthRow(
  row: Record<string, unknown>,
): DispatchSubscriptionHealthRow {
  return {
    id: String(row.id ?? ''),
    signalType: String(row.signal_type ?? ''),
    subscriber: String(row.subscriber ?? ''),
    handler: String(row.handler ?? ''),
    delivery: String(row.delivery ?? ''),
    enabled: toBoolean(row.enabled),
    tenantId: toNullableString(row.tenant_id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Recent changes
// ---------------------------------------------------------------------------

export type RecentChangesResult =
  | {
      available: true;
      changes: ChangeFeedEntry[];
      cursor: number;
      resyncRequired?: boolean;
      resyncCursor?: number;
      count: number;
    }
  | CategoryUnavailable;

export interface RecentChangesOptions {
  /** Cursor to read after (default 0). */
  since?: number;
  /** Restrict to these physical table names. */
  tables?: string[];
  /** Tenant narrowing filter (see the change-feed reader's tenant semantics). */
  tenantId?: string | null;
  /** Page size (default 200, capped like the change feed's own limit). */
  limit?: number;
}

/**
 * Read the recent change feed via the canonical SELECT-only
 * {@link getChangesSince} reader. A missing `_smrt_changes` table degrades to
 * category-unavailable.
 */
export async function readRecentChanges(
  db: DatabaseInterface,
  options: RecentChangesOptions = {},
): Promise<RecentChangesResult> {
  const table = SYSTEM_DIAGNOSTICS_TABLES.changes;
  if (!(await tableExists(db, table))) {
    return unavailable(table, 'table-missing');
  }
  try {
    const page = await getChangesSince(db, {
      since: options.since ?? 0,
      tables: options.tables,
      tenantId: options.tenantId,
      limit: boundedLimit(options.limit, 200),
    });
    return {
      available: true,
      changes: page.changes,
      cursor: page.cursor,
      ...(page.resyncRequired !== undefined
        ? {
            resyncRequired: page.resyncRequired,
            resyncCursor: page.resyncCursor,
          }
        : {}),
      count: page.changes.length,
    };
  } catch {
    return unavailable(table, 'read-error');
  }
}

// ---------------------------------------------------------------------------
// Registry (retired)
// ---------------------------------------------------------------------------

/**
 * `_smrt_registry` is retired: never written since system schema 1.10.1, absent
 * on new databases, and deliberately not dropped by the framework. The
 * diagnostics reader reports the retirement — it never reads registry rows and
 * never fabricates drift; `stillPresent` is a table-existence probe only, so a
 * probe failure reads as absence, which the message keeps non-committal about.
 */
export interface RegistryDriftResult {
  available: false;
  reason: 'retired';
  message: string;
  tableName: string;
  /** True when a legacy `_smrt_registry` table still exists on this database. */
  stillPresent: boolean;
}

export async function readRegistryDrift(
  db: DatabaseInterface,
): Promise<RegistryDriftResult> {
  const table = SYSTEM_DIAGNOSTICS_TABLES.registry;
  const stillPresent = await tableExists(db, table);
  return {
    available: false,
    reason: 'retired',
    message: stillPresent
      ? `The ${table} table is retired (SMRT system schema ${'1.10.1'}) and is no longer written or read; a legacy empty table remains on this database and can be dropped. No registry drift is reported.`
      : `The ${table} table is retired (SMRT system schema ${'1.10.1'}) and is no longer written or read; no such table was found on this database. No registry drift is reported.`,
    tableName: table,
    stillPresent,
  };
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

export interface SystemDiagnosticsOptions {
  migrations?: MigrationStatusOptions;
  jobs?: JobHealthOptions;
  schedules?: ScheduleHealthOptions;
  dispatch?: DispatchHealthOptions;
  changes?: RecentChangesOptions;
}

export interface SystemDiagnosticsResult {
  migrations: MigrationStatusResult;
  jobs: JobHealthResult;
  schedules: ScheduleHealthResult;
  dispatch: DispatchHealthResult;
  changes: RecentChangesResult;
  registry: RegistryDriftResult;
}

/** Read every diagnostics category in one pass (SELECT-only). */
export async function readSystemDiagnostics(
  db: DatabaseInterface,
  options: SystemDiagnosticsOptions = {},
): Promise<SystemDiagnosticsResult> {
  const [migrations, jobs, schedules, dispatch, changes, registry] =
    await Promise.all([
      readMigrationStatus(db, options.migrations),
      readJobHealth(db, options.jobs),
      readScheduleHealth(db, options.schedules),
      readDispatchHealth(db, options.dispatch),
      readRecentChanges(db, options.changes),
      readRegistryDrift(db),
    ]);
  return { migrations, jobs, schedules, dispatch, changes, registry };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unavailable(
  tableName: string,
  reason: CategoryUnavailable['reason'],
  message?: string,
): CategoryUnavailable {
  return {
    available: false,
    reason,
    message:
      message ??
      (reason === 'retired'
        ? `${tableName} is retired and no longer read.`
        : reason === 'table-missing'
          ? `The ${tableName} system table is not present on this database.`
          : `Reading ${tableName} failed; the live diagnostic is unavailable.`),
    tableName,
  };
}

function boundedLimit(
  value: number | undefined,
  fallback = DIAGNOSTICS_DEFAULT_LIMIT,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), 500);
}

function placeholders(db: DatabaseInterface): (index: number) => string {
  // Engine detection follows the repo convention (`getDatabaseEngine` prefers
  // an explicit `type`/config hint, then the connection URL's scheme), so a
  // postgres URL opened without a matching `type` field still binds `$n`.
  const engine = getDatabaseEngine(db);
  return engine === 'postgres' ? (index) => `$${index}` : () => '?';
}

function queryRows(result: unknown): Record<string, unknown>[] {
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

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Count aggregation: `COUNT(*)` always yields a number (0 when absent). */
function toCount(value: unknown): number {
  return toNumber(value) ?? 0;
}

function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (
    value === true ||
    value === 'true' ||
    value === 't' ||
    value === '1' ||
    value === 1
  ) {
    return true;
  }
  if (
    value === false ||
    value === 'false' ||
    value === 'f' ||
    value === '0' ||
    value === 0
  ) {
    return false;
  }
  return Boolean(value);
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const text = String(value);
  return text.length > 0 ? text : null;
}
