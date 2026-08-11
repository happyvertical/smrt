/**
 * Typed, SELECT-only readers for SMRT's operational system tables.
 *
 * The reader deliberately accepts an already-open database handle. Connection
 * discovery and authorization belong to the host (for example smrt-dev-mcp or
 * an authenticated admin endpoint); this module only applies the trusted scope
 * it is given and never initializes schemas or boots the ObjectRegistry.
 */

import { sanitizeConfig } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { type ChangeFeedPage, getChangesSince } from './change-feed.js';

export type SystemDiagnosticEngine = 'sqlite' | 'postgres' | 'duckdb';

/**
 * Scope selected by a trusted host. Untrusted tool/request input must never be
 * converted directly into `system`; it is an explicit cross-tenant capability.
 */
export type TrustedSystemDiagnosticScope =
  | { mode: 'global' }
  | { mode: 'tenant'; tenantId: string }
  | { mode: 'system' };

export interface SystemDiagnosticProvenance {
  source: 'runtime';
  observation: 'live-db';
  observedAt: string;
  engine: SystemDiagnosticEngine;
  connectionSource: 'argument' | 'environment' | 'config' | 'injected';
  scope: TrustedSystemDiagnosticScope;
}

export interface SystemDiagnosticMessage {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  tables?: string[];
}

export interface SystemDiagnosticResult<T> {
  status: 'available' | 'unavailable';
  provenance: SystemDiagnosticProvenance;
  data: T | null;
  diagnostics: SystemDiagnosticMessage[];
}

export interface MigrationDiagnosticRow {
  id: string;
  name: string;
  version: string;
  packageName: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
  appliedAt: string | null;
  executionTimeMs: number | null;
  attempts: number;
  errorMessage: string | null;
}

export interface MigrationStatusDiagnostics {
  counts: Record<MigrationDiagnosticRow['status'], number>;
  migrations: MigrationDiagnosticRow[];
}

export interface JobDiagnosticRow {
  id: string;
  tenantId: string | null;
  queue: string;
  objectType: string;
  method: string;
  runAt: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  lastError: string | null;
  workerId: string | null;
  workerHeartbeat: string | null;
}

export interface JobHealthDiagnostics {
  countsByStatus: Record<string, number>;
  queues: Array<{ queue: string; counts: Record<string, number> }>;
  recentFailures: JobDiagnosticRow[];
  stuckJobs: JobDiagnosticRow[];
}

export interface ScheduleDiagnosticRow {
  id: string;
  tenantId: string | null;
  agentType: string;
  agentId: string | null;
  cron: string;
  timezone: string;
  enabled: boolean;
  status: string;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  runningCount: number;
  due: boolean;
  overdue: boolean;
  errored: boolean;
}

export interface ScheduleHealthDiagnostics {
  countsByStatus: Record<string, number>;
  due: number;
  overdue: number;
  errored: number;
  schedules: ScheduleDiagnosticRow[];
}

export interface DispatchDiagnosticRow {
  id: string;
  tenantId: string | null;
  type: string;
  source: string;
  status: string;
  attempts: number;
  lastError: string | null;
  processedAt: string | null;
  targetSubscriber: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  stuck: boolean;
}

export interface DispatchSubscriptionDiagnosticRow {
  signalType: string;
  subscriber: string;
  delivery: string;
  enabled: boolean;
  tenantId: string | null;
  updatedAt: string | null;
}

export interface DispatchHealthDiagnostics {
  countsByStatus: Record<string, number>;
  countsByType: Record<string, Record<string, number>>;
  pending: number;
  stuck: number;
  dispatches: DispatchDiagnosticRow[];
  subscriptions: DispatchSubscriptionDiagnosticRow[];
}

export interface RegistryDiagnosticRow {
  className: string;
  schemaVersion: string | null;
  lastUpdated: string | null;
}

export interface RegistryDiagnostics {
  registrations: RegistryDiagnosticRow[];
}

export interface SystemDiagnosticsReaderOptions {
  engine: SystemDiagnosticEngine;
  connectionSource?: SystemDiagnosticProvenance['connectionSource'];
  scope: TrustedSystemDiagnosticScope;
  now?: () => Date;
}

export interface BoundedDiagnosticOptions {
  limit?: number;
}

export interface ScheduleHealthOptions extends BoundedDiagnosticOptions {
  overdueAfterMs?: number;
}

export interface DispatchHealthOptions extends BoundedDiagnosticOptions {
  stuckAfterMs?: number;
}

export interface RecentChangesDiagnosticOptions
  extends BoundedDiagnosticOptions {
  since?: number;
  tables?: string[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TABLE_FILTERS = 50;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

const ERROR_SECRET_KEY_VALUE_RE =
  /\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|token|credential|auth)[A-Za-z0-9_-]*)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;)]+)/gi;
const JSON_SECRET_KEY_VALUE_RE =
  /("(?:[A-Za-z0-9_-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|token|credential|auth)[A-Za-z0-9_-]*)")\s*:\s*"[^"]*"/gi;

/** Redact stored/runtime error text before it reaches an operator-facing tool. */
export function redactSystemDiagnosticText(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? '');
  const sanitized = String(sanitizeConfig(message) ?? '');
  return sanitized
    .replace(JSON_SECRET_KEY_VALUE_RE, '$1:"***REDACTED***"')
    .replace(ERROR_SECRET_KEY_VALUE_RE, '$1$2***REDACTED***');
}

export class SystemDiagnosticsReader {
  private readonly now: () => Date;

  constructor(
    private readonly db: DatabaseInterface,
    private readonly options: SystemDiagnosticsReaderOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async migrationStatus(
    options: BoundedDiagnosticOptions = {},
  ): Promise<SystemDiagnosticResult<MigrationStatusDiagnostics>> {
    return this.readCategory(
      'migration-status',
      ['_smrt_schema_migrations'],
      async () => {
        const countRows = await this.queryRows(
          `SELECT status, COUNT(*) AS count
           FROM _smrt_schema_migrations
          GROUP BY status`,
        );
        const rows = await this.queryRows(
          `SELECT id, name, version, package_name, status, applied_at,
                execution_time_ms, attempts, error_message
           FROM _smrt_schema_migrations
          ORDER BY applied_at DESC, name ASC
          LIMIT ${boundedLimit(options.limit)}`,
        );
        const counts: MigrationStatusDiagnostics['counts'] = {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          rolled_back: 0,
        };
        for (const row of countRows) {
          counts[migrationStatus(row.status)] += numberValue(row.count);
        }
        const migrations = rows.map((row) => {
          const status = migrationStatus(row.status);
          return {
            id: stringValue(row.id),
            name: stringValue(row.name),
            version: stringValue(row.version),
            packageName: nullableString(row.package_name),
            status,
            appliedAt: nullableTimestamp(row.applied_at),
            executionTimeMs: nullableNumber(row.execution_time_ms),
            attempts: numberValue(row.attempts),
            errorMessage: redactedNullableText(row.error_message),
          };
        });
        return { counts, migrations };
      },
    );
  }

  async jobHealth(
    options: BoundedDiagnosticOptions = {},
  ): Promise<SystemDiagnosticResult<JobHealthDiagnostics>> {
    return this.readCategory(
      'job-health',
      ['_smrt_jobs', '_smrt_workers'],
      async () => {
        const limit = boundedLimit(options.limit);
        const countScope = this.tenantPredicate('j');
        const countRows = await this.queryRows(
          `SELECT j.queue, j.status, COUNT(*) AS count
             FROM _smrt_jobs j
            ${where(countScope.sql)}
            GROUP BY j.queue, j.status
            ORDER BY j.queue, j.status`,
          ...countScope.params,
        );
        const failureScope = this.tenantPredicate('j');
        const failureRows = await this.queryRows(
          `SELECT j.id, j.tenant_id, j.queue, j.object_type, j.method, j.run_at,
                  j.status, j.attempts, j.max_attempts, j.started_at,
                  j.last_error, j.worker_id, j.worker_heartbeat
             FROM _smrt_jobs j
            WHERE ${and(failureScope.sql, "j.status = 'failed'")}
            ORDER BY j.completed_at DESC, j.run_at DESC
            LIMIT ${limit}`,
          ...failureScope.params,
        );
        const stuckScope = this.tenantPredicate('j');
        const nowPlaceholder = this.placeholder(stuckScope.params.length + 1);
        const stuckRows = await this.queryRows(
          `SELECT j.id, j.tenant_id, j.queue, j.object_type, j.method, j.run_at,
                  j.status, j.attempts, j.max_attempts, j.started_at,
                  j.last_error, j.worker_id, j.worker_heartbeat
             FROM _smrt_jobs j
             LEFT JOIN _smrt_workers w ON w.worker_id = j.worker_id
            WHERE ${and(
              stuckScope.sql,
              "j.status = 'running'",
              `(j.worker_id IS NULL OR w.worker_id IS NULL OR w.status <> 'running'
                OR w.lease_expires_at IS NULL OR w.lease_expires_at < ${nowPlaceholder})`,
            )}
            ORDER BY j.started_at ASC
            LIMIT ${limit}`,
          ...stuckScope.params,
          this.now().toISOString(),
        );

        const countsByStatus: Record<string, number> = {};
        const queueMap = new Map<string, Record<string, number>>();
        for (const row of countRows) {
          const queue = stringValue(row.queue, 'default');
          const status = stringValue(row.status, 'unknown');
          const count = numberValue(row.count);
          countsByStatus[status] = (countsByStatus[status] ?? 0) + count;
          const queueCounts = queueMap.get(queue) ?? {};
          queueCounts[status] = count;
          queueMap.set(queue, queueCounts);
        }

        return {
          countsByStatus,
          queues: Array.from(queueMap, ([queue, counts]) => ({
            queue,
            counts,
          })),
          recentFailures: failureRows.map(jobRow),
          stuckJobs: stuckRows.map(jobRow),
        };
      },
    );
  }

  async scheduleHealth(
    options: ScheduleHealthOptions = {},
  ): Promise<SystemDiagnosticResult<ScheduleHealthDiagnostics>> {
    return this.readCategory(
      'schedule-health',
      ['_smrt_agent_schedules'],
      async () => {
        const scope = this.tenantPredicate('s');
        const now = this.now().getTime();
        const overdueBefore = now - nonNegativeMs(options.overdueAfterMs);
        const duePlaceholder = this.placeholder(scope.params.length + 1);
        const overduePlaceholder = this.placeholder(scope.params.length + 2);
        const dueAt = new Date(now).toISOString();
        const overdueAt = new Date(overdueBefore).toISOString();
        const countRows = await this.queryRows(
          `SELECT s.status, COUNT(*) AS count,
                  SUM(CASE WHEN s.enabled = TRUE AND s.status = 'active'
                                AND s.next_run IS NOT NULL
                                AND s.next_run <= ${duePlaceholder}
                           THEN 1 ELSE 0 END) AS due_count,
                  SUM(CASE WHEN s.enabled = TRUE AND s.status = 'active'
                                AND s.next_run IS NOT NULL
                                AND s.next_run < ${overduePlaceholder}
                           THEN 1 ELSE 0 END) AS overdue_count,
                  SUM(CASE WHEN s.status = 'error' OR s.last_status = 'failed'
                           THEN 1 ELSE 0 END) AS error_count
             FROM _smrt_agent_schedules s
            ${where(scope.sql)}
            GROUP BY s.status
            ORDER BY s.status`,
          ...(this.options.engine === 'postgres'
            ? [...scope.params, dueAt, overdueAt]
            : [dueAt, overdueAt, ...scope.params]),
        );
        const rows = await this.queryRows(
          `SELECT s.id, s.tenant_id, s.agent_type, s.agent_id, s.cron, s.timezone,
                  s.enabled, s.status, s.last_run, s.next_run, s.last_status,
                  s.last_error, s.run_count, s.success_count, s.failure_count,
                  s.running_count
             FROM _smrt_agent_schedules s
            ${where(scope.sql)}
            ORDER BY s.next_run ASC
            LIMIT ${boundedLimit(options.limit)}`,
          ...scope.params,
        );
        const schedules = rows.map((row) => {
          const enabled = booleanValue(row.enabled);
          const status = stringValue(row.status, 'unknown');
          const nextRun = nullableTimestamp(row.next_run);
          const nextRunMs = nextRun ? Date.parse(nextRun) : Number.NaN;
          const active = enabled && status === 'active';
          const due = active && Number.isFinite(nextRunMs) && nextRunMs <= now;
          return {
            id: stringValue(row.id),
            tenantId: nullableString(row.tenant_id),
            agentType: stringValue(row.agent_type),
            agentId: nullableString(row.agent_id),
            cron: stringValue(row.cron),
            timezone: stringValue(row.timezone, 'UTC'),
            enabled,
            status,
            lastRun: nullableTimestamp(row.last_run),
            nextRun,
            lastStatus: nullableString(row.last_status),
            lastError: redactedNullableText(row.last_error),
            runCount: numberValue(row.run_count),
            successCount: numberValue(row.success_count),
            failureCount: numberValue(row.failure_count),
            runningCount: numberValue(row.running_count),
            due,
            overdue: due && nextRunMs < overdueBefore,
            errored: status === 'error' || row.last_status === 'failed',
          };
        });
        const countsByStatus: Record<string, number> = {};
        let due = 0;
        let overdue = 0;
        let errored = 0;
        for (const row of countRows) {
          const status = stringValue(row.status, 'unknown');
          countsByStatus[status] = numberValue(row.count);
          due += numberValue(row.due_count);
          overdue += numberValue(row.overdue_count);
          errored += numberValue(row.error_count);
        }
        return {
          countsByStatus,
          due,
          overdue,
          errored,
          schedules,
        };
      },
    );
  }

  async dispatchHealth(
    options: DispatchHealthOptions = {},
  ): Promise<SystemDiagnosticResult<DispatchHealthDiagnostics>> {
    return this.readCategory(
      'dispatch-health',
      ['_smrt_dispatch', '_smrt_dispatch_subscriptions'],
      async () => {
        const limit = boundedLimit(options.limit);
        const staleBefore =
          this.now().getTime() - nonNegativeMs(options.stuckAfterMs);
        const dispatchScope = this.tenantPredicate('d');
        const stalePlaceholder = this.placeholder(
          dispatchScope.params.length + 1,
        );
        const staleAt = new Date(staleBefore).toISOString();
        const countRows = await this.queryRows(
          `SELECT d.type, d.status, COUNT(*) AS count,
                  SUM(CASE WHEN d.status = 'processing'
                                AND d.updated_at IS NOT NULL
                                AND d.updated_at < ${stalePlaceholder}
                           THEN 1 ELSE 0 END) AS stuck_count
             FROM _smrt_dispatch d
            ${where(dispatchScope.sql)}
            GROUP BY d.type, d.status
            ORDER BY d.type, d.status`,
          ...(this.options.engine === 'postgres'
            ? [...dispatchScope.params, staleAt]
            : [staleAt, ...dispatchScope.params]),
        );
        const dispatchRows = await this.queryRows(
          `SELECT d.id, d.tenant_id, d.type, d.source, d.status, d.attempts,
                  d.last_error, d.processed_at, d.target_subscriber,
                  d.created_at, d.updated_at
             FROM _smrt_dispatch d
            ${where(dispatchScope.sql)}
            ORDER BY d.updated_at DESC
            LIMIT ${limit}`,
          ...dispatchScope.params,
        );
        const subscriptionScope = this.tenantPredicate('s', true);
        const subscriptionRows = await this.queryRows(
          `SELECT s.signal_type, s.subscriber, s.delivery, s.enabled,
                  s.tenant_id, s.updated_at
             FROM _smrt_dispatch_subscriptions s
            ${where(subscriptionScope.sql)}
            ORDER BY s.signal_type, s.subscriber
            LIMIT ${limit}`,
          ...subscriptionScope.params,
        );
        const dispatches = dispatchRows.map((row) => {
          const updatedAt = nullableTimestamp(row.updated_at);
          const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
          return {
            id: stringValue(row.id),
            tenantId: nullableString(row.tenant_id),
            type: stringValue(row.type),
            source: stringValue(row.source),
            status: stringValue(row.status, 'unknown'),
            attempts: numberValue(row.attempts),
            lastError: redactedNullableText(row.last_error),
            processedAt: nullableTimestamp(row.processed_at),
            targetSubscriber: nullableString(row.target_subscriber),
            createdAt: nullableTimestamp(row.created_at),
            updatedAt,
            stuck:
              row.status === 'processing' &&
              Number.isFinite(updatedAtMs) &&
              updatedAtMs < staleBefore,
          };
        });
        const countsByStatus: Record<string, number> = {};
        const countsByType: Record<string, Record<string, number>> = {};
        let stuck = 0;
        for (const row of countRows) {
          const type = stringValue(row.type);
          const status = stringValue(row.status, 'unknown');
          const count = numberValue(row.count);
          countsByStatus[status] = (countsByStatus[status] ?? 0) + count;
          const typeCounts = countsByType[type] ?? {};
          typeCounts[status] = count;
          countsByType[type] = typeCounts;
          stuck += numberValue(row.stuck_count);
        }
        return {
          countsByStatus,
          countsByType,
          pending: countsByStatus.pending ?? 0,
          stuck,
          dispatches,
          subscriptions: subscriptionRows.map((row) => ({
            signalType: stringValue(row.signal_type),
            subscriber: stringValue(row.subscriber),
            delivery: stringValue(row.delivery, 'compete'),
            enabled: booleanValue(row.enabled),
            tenantId: nullableString(row.tenant_id),
            updatedAt: nullableTimestamp(row.updated_at),
          })),
        };
      },
    );
  }

  async recentChanges(
    options: RecentChangesDiagnosticOptions = {},
  ): Promise<SystemDiagnosticResult<ChangeFeedPage>> {
    return this.readCategory('recent-changes', ['_smrt_changes'], async () =>
      getChangesSince(this.db, {
        since: nonNegativeInteger(options.since),
        tables: options.tables?.slice(0, MAX_TABLE_FILTERS),
        tenantId:
          this.options.scope.mode === 'system'
            ? undefined
            : this.options.scope.mode === 'tenant'
              ? this.options.scope.tenantId
              : null,
        limit: boundedLimit(options.limit),
      }),
    );
  }

  async registrySnapshot(
    options: BoundedDiagnosticOptions = {},
  ): Promise<SystemDiagnosticResult<RegistryDiagnostics>> {
    return this.readCategory('registry-drift', ['_smrt_registry'], async () => {
      const rows = await this.queryRows(
        `SELECT class_name, schema_version, last_updated
           FROM _smrt_registry
          ORDER BY class_name
          LIMIT ${boundedLimit(options.limit)}`,
      );
      return {
        registrations: rows.map((row) => ({
          className: stringValue(row.class_name),
          schemaVersion: nullableString(row.schema_version),
          lastUpdated: nullableTimestamp(row.last_updated),
        })),
      };
    });
  }

  private provenance(): SystemDiagnosticProvenance {
    return {
      source: 'runtime',
      observation: 'live-db',
      observedAt: this.now().toISOString(),
      engine: this.options.engine,
      connectionSource: this.options.connectionSource ?? 'injected',
      scope: this.options.scope,
    };
  }

  private async readCategory<T>(
    category: string,
    tables: string[],
    read: () => Promise<T>,
  ): Promise<SystemDiagnosticResult<T>> {
    const provenance = this.provenance();
    try {
      return {
        status: 'available',
        provenance,
        data: await read(),
        diagnostics: [],
      };
    } catch (error) {
      const missing = isMissingTableError(error);
      return {
        status: 'unavailable',
        provenance,
        data: null,
        diagnostics: [
          {
            severity: 'warning',
            code: missing ? 'table-unavailable' : 'query-unavailable',
            message: missing
              ? `${category} is unavailable because its system table has not been migrated.`
              : `${category} could not be read from the runtime database.`,
            tables,
          },
        ],
      };
    }
  }

  private tenantPredicate(
    alias: string,
    subscription = false,
  ): { sql: string; params: unknown[] } {
    const scope = this.options.scope;
    if (scope.mode === 'system') return { sql: '', params: [] };
    if (scope.mode === 'global') {
      return { sql: `${alias}.tenant_id IS NULL`, params: [] };
    }
    if (subscription) {
      return {
        sql: `${alias}.tenant_id = ${this.placeholder(1)}`,
        params: [scope.tenantId],
      };
    }
    return {
      sql: `(${alias}.tenant_id = ${this.placeholder(1)} OR ${alias}.tenant_id IS NULL)`,
      params: [scope.tenantId],
    };
  }

  private placeholder(index: number): string {
    return this.options.engine === 'postgres' ? `$${index}` : '?';
  }

  private async queryRows(
    sql: string,
    ...params: unknown[]
  ): Promise<Record<string, unknown>[]> {
    const result = await this.db.query(sql, ...params);
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    if (result && typeof result === 'object' && 'rows' in result) {
      const rows = (result as { rows?: unknown }).rows;
      if (Array.isArray(rows)) return rows as Record<string, unknown>[];
    }
    return [];
  }
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

function nonNegativeInteger(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

function nonNegativeMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_STALE_AFTER_MS;
  return Math.max(0, value ?? DEFAULT_STALE_AFTER_MS);
}

function where(predicate: string): string {
  return predicate ? `WHERE ${predicate}` : '';
}

function and(...predicates: string[]): string {
  return predicates.filter(Boolean).join(' AND ');
}

function jobRow(row: Record<string, unknown>): JobDiagnosticRow {
  return {
    id: stringValue(row.id),
    tenantId: nullableString(row.tenant_id),
    queue: stringValue(row.queue, 'default'),
    objectType: stringValue(row.object_type),
    method: stringValue(row.method),
    runAt: nullableTimestamp(row.run_at),
    status: stringValue(row.status, 'unknown'),
    attempts: numberValue(row.attempts),
    maxAttempts: numberValue(row.max_attempts),
    startedAt: nullableTimestamp(row.started_at),
    lastError: redactedNullableText(row.last_error),
    workerId: nullableString(row.worker_id),
    workerHeartbeat: nullableTimestamp(row.worker_heartbeat),
  };
}

function migrationStatus(value: unknown): MigrationDiagnosticRow['status'] {
  switch (value) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'rolled_back':
      return value;
    default:
      return 'pending';
  }
}

function stringValue(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function nullableTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function redactedNullableText(value: unknown): string | null {
  if (value == null || value === '') return null;
  return redactSystemDiagnosticText(value);
}

function isMissingTableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    const message =
      value instanceof Error ? value.message : String(value ?? '');
    if (
      /no such table|does not exist|unknown table|catalog error/i.test(message)
    ) {
      return true;
    }
    if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      pending.push(...Object.values(value));
    }
  }
  return false;
}
