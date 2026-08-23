import { ObjectRegistry, type SmrtObject } from '@happyvertical/smrt-core';
import { getTenantId, withSystemContext } from '@happyvertical/smrt-tenancy';
import {
  type DatabaseInterface,
  tableExists,
  validateColumnName,
} from '@happyvertical/sql';
import type { ReportRefreshActionDescriptor } from './adapter.js';
import { buildReportDefinition } from './compiler.js';
import { enqueueReportRefresh } from './scheduler.js';
import {
  assertReportTablesReady,
  REPORT_LOCKS_TABLE,
  REPORT_RUNS_TABLE,
  scopeKeyForTenant,
} from './state.js';
import type {
  ReportRefreshMode,
  ReportRefreshResult,
  ReportRefreshTrigger,
} from './types.js';

type ReportCtor = new (...args: any[]) => SmrtObject;

function registeredReport(reportCtor: ReportCtor) {
  return (
    ObjectRegistry.getClassByConstructor(reportCtor) ??
    ObjectRegistry.getClass(reportCtor.name)
  );
}

export type ReportLifecycleState =
  | 'current'
  | 'stale'
  | 'refreshing'
  | 'lock-skipped'
  | 'failed';

export interface ReportLifecycleRun {
  id: string;
  status: 'running' | 'success' | 'failed' | 'skipped';
  mode: ReportRefreshMode;
  trigger: ReportRefreshTrigger;
  startedAt?: string;
  completedAt?: string;
  rowCount: number;
  changedGroupCount: number;
  /** A failed run is safe to retry through the separately permissioned action. */
  mayRetry: boolean;
}

/**
 * Transport-neutral report lifecycle state. It deliberately never includes a
 * lock owner, a raw failure message, or tenant fanout identifiers.
 */
export interface ReportLifecycleSnapshot {
  version: 1;
  state: ReportLifecycleState;
  asOf?: string;
  refreshedAt?: string;
  /** Whether existing materialized rows can remain visible while work changes state. */
  hasUsableRows: boolean;
  mode: ReportRefreshMode;
  run?: ReportLifecycleRun;
  /** A stable, redacted failure signal; raw executor errors stay server-side. */
  failure?: {
    code: 'refresh_failed';
    retryable: true;
  };
  lock: {
    held: boolean;
    expiresAt?: string;
  };
}

export interface ReportLifecycleOptions {
  db: DatabaseInterface;
  /** Test seam; production callers use the current clock. */
  now?: Date;
}

export interface ReportRefreshJobHandle {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  /** Bounded polling guidance; this API does not create a second queue. */
  pollAfterMs: number;
}

export interface ReportRefreshActionContext {
  phase: 'preview' | 'apply';
  reportClassName: string;
  /** The action always applies to the caller's already-bound tenant scope. */
  tenantScope: 'ambient';
  mode: ReportRefreshMode;
  requiredPermission: string;
}

/** Authority and audit stay with the application action host, not reports. */
export interface ReportRefreshActionHost {
  authorize(context: ReportRefreshActionContext): Promise<void> | void;
  audit(context: ReportRefreshActionContext): Promise<void> | void;
}

export interface PreviewReportRefreshOptions extends ReportLifecycleOptions {
  host: ReportRefreshActionHost;
  mode?: ReportRefreshMode;
  /**
   * Pass `descriptor.refresh.action` when the adapter declares a custom
   * refresh permission, so the displayed and enforced action stay aligned.
   */
  refreshAction?: Pick<ReportRefreshActionDescriptor, 'requiredPermission'>;
}

export interface ReportRefreshPreview {
  phase: 'preview';
  lifecycle: ReportLifecycleSnapshot;
  action: ReportRefreshActionContext;
  execution: 'background';
}

export interface ApplyReportRefreshOptions extends PreviewReportRefreshOptions {
  queue?: string;
  priority?: number;
  timeout?: number;
  maxAttempts?: number;
  tenantJobCap?: number;
}

export interface AppliedReportRefresh {
  phase: 'apply';
  job: ReportRefreshJobHandle;
}

export interface ReportRefreshOutcome {
  state: 'current' | 'lock-skipped' | 'partial';
  rowCount: number;
  changedGroupCount: number;
  completedScopes: number;
  lockSkippedScopes: number;
  mode: ReportRefreshMode;
  refreshedAt: string;
  runId?: string;
}

function canonicalClassName(reportCtor: ReportCtor): string {
  const registered = registeredReport(reportCtor);
  return registered?.qualifiedName ?? registered?.name ?? reportCtor.name;
}

function reportTableName(reportCtor: ReportCtor): string {
  const reportClassName = canonicalClassName(reportCtor);
  const tableName = ObjectRegistry.getTableName(reportClassName);
  if (!tableName) {
    throw new Error(`No report table registered for ${reportCtor.name}`);
  }
  return validateColumnName(tableName);
}

async function reportColumnName(
  reportClassName: string,
  fieldName: string,
): Promise<string> {
  const fields = await ObjectRegistry.getAllFields(reportClassName);
  const direct = fields.get(fieldName) as
    | { columnName?: string; _meta?: { columnName?: string } }
    | undefined;
  return validateColumnName(
    direct?.columnName ??
      direct?._meta?.columnName ??
      fieldName.replace(/([A-Z])/g, '_$1').toLowerCase(),
  );
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function latestIso(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  if (!first) return second;
  if (!second) return first;
  return new Date(first).getTime() >= new Date(second).getTime()
    ? first
    : second;
}

function lifecycleTenantId(reportCtor: ReportCtor): string | null {
  return registeredReport(reportCtor)?.tenantScopedConfig
    ? (getTenantId() ?? null)
    : null;
}

function numberValue(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function rowWhere(
  reportClassName: string,
  scopeKey: string,
  tenantId: string | null,
): { sql: string; values: unknown[] } {
  if (tenantId) {
    return {
      sql: 'report_class = ? AND scope_key = ? AND tenant_id = ?',
      values: [reportClassName, scopeKey, tenantId],
    };
  }
  return {
    sql: 'report_class = ? AND scope_key = ? AND tenant_id IS NULL',
    values: [reportClassName, scopeKey],
  };
}

function runFromRow(
  row: Record<string, unknown> | undefined,
): ReportLifecycleRun | undefined {
  if (!row || typeof row.id !== 'string') return undefined;
  const status = row.status;
  if (
    status !== 'running' &&
    status !== 'success' &&
    status !== 'failed' &&
    status !== 'skipped'
  ) {
    return undefined;
  }
  const mode: ReportRefreshMode =
    row.mode === 'incremental' ? 'incremental' : 'rebuild';
  const trigger: ReportRefreshTrigger =
    row.trigger === 'schedule' ||
    row.trigger === 'change' ||
    row.trigger === 'ttl' ||
    row.trigger === 'job'
      ? row.trigger
      : 'manual';
  return {
    id: row.id,
    status,
    mode,
    trigger,
    ...(toIso(row.started_at) ? { startedAt: toIso(row.started_at) } : {}),
    ...(toIso(row.completed_at)
      ? { completedAt: toIso(row.completed_at) }
      : {}),
    rowCount: numberValue(row.row_count),
    changedGroupCount: numberValue(row.changed_group_count),
    mayRetry: status === 'failed',
  };
}

function jobHandle(job: {
  id?: unknown;
  status: ReportRefreshJobHandle['status'];
  attempts: number;
  maxAttempts: number;
}): ReportRefreshJobHandle {
  if (typeof job.id !== 'string' || job.id.length === 0) {
    throw new Error('Queued report refresh is missing its job id');
  }
  return {
    jobId: job.id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    pollAfterMs: 1_000,
  };
}

/**
 * Read only the ambient tenant's report state. The caller cannot supply a
 * tenant selector, which prevents lifecycle lookup from becoming a tenant
 * enumeration surface.
 */
export async function getReportLifecycle(
  reportCtor: ReportCtor,
  options: ReportLifecycleOptions,
): Promise<ReportLifecycleSnapshot> {
  await assertReportTablesReady(options.db, [
    REPORT_RUNS_TABLE,
    REPORT_LOCKS_TABLE,
  ]);

  const definition = await buildReportDefinition(reportCtor);
  const reportClassName = canonicalClassName(reportCtor);
  const tenantId = lifecycleTenantId(reportCtor);
  const scopeKey = scopeKeyForTenant(tenantId);
  const where = rowWhere(reportClassName, scopeKey, tenantId);
  const now = options.now ?? new Date();

  const [runResult, lockResult] = await Promise.all([
    options.db.query(
      `SELECT id, mode, trigger, status, started_at, completed_at, row_count, changed_group_count
         FROM ${REPORT_RUNS_TABLE}
        WHERE ${where.sql}
        ORDER BY started_at DESC, created_at DESC, id DESC
        LIMIT 1`,
      ...where.values,
    ),
    options.db.query(
      `SELECT expires_at
         FROM ${REPORT_LOCKS_TABLE}
        WHERE ${where.sql} AND expires_at > ?
        LIMIT 1`,
      ...where.values,
      now.toISOString(),
    ),
  ]);

  const tableName = reportTableName(reportCtor);
  if (!(await tableExists(options.db, tableName))) {
    throw new Error(
      `Report table '${tableName}' does not exist for ${reportClassName}`,
    );
  }
  const refreshedAtColumn = await reportColumnName(
    reportClassName,
    'refreshedAt',
  );
  const registered = registeredReport(reportCtor);
  const configuredTenantField = registered?.tenantScopedConfig?.field;
  const tenantColumn = configuredTenantField
    ? await reportColumnName(reportClassName, configuredTenantField)
    : undefined;
  const materialized = tenantColumn
    ? await options.db.query(
        `SELECT MAX(${refreshedAtColumn}) AS refreshed_at FROM ${tableName} WHERE ${tenantColumn} ${tenantId ? '= ?' : 'IS NULL'}`,
        ...(tenantId ? [tenantId] : []),
      )
    : await options.db.query(
        `SELECT MAX(${refreshedAtColumn}) AS refreshed_at FROM ${tableName}`,
      );

  const run = runFromRow(
    runResult.rows[0] as Record<string, unknown> | undefined,
  );
  const refreshedAt = toIso(materialized.rows[0]?.refreshed_at);
  const completedAt = run?.status === 'success' ? run.completedAt : undefined;
  const asOf = latestIso(refreshedAt, completedAt);
  const ttlMs = definition.refresh?.ttl;
  const isStale =
    !asOf ||
    (ttlMs !== undefined && now.getTime() - new Date(asOf).getTime() > ttlMs);
  const lockExpiresAt = toIso(lockResult.rows[0]?.expires_at);
  const lockHeld = Boolean(lockExpiresAt);
  const state: ReportLifecycleState =
    run?.status === 'skipped'
      ? 'lock-skipped'
      : lockHeld
        ? 'refreshing'
        : run?.status === 'failed'
          ? 'failed'
          : run?.status === 'running'
            ? 'stale'
            : isStale
              ? 'stale'
              : 'current';

  return {
    version: 1,
    state,
    ...(asOf ? { asOf } : {}),
    ...(refreshedAt ? { refreshedAt } : {}),
    hasUsableRows: Boolean(refreshedAt),
    mode: run?.mode ?? definition.refresh?.mode ?? 'rebuild',
    ...(run ? { run } : {}),
    ...(run?.status === 'failed'
      ? { failure: { code: 'refresh_failed' as const, retryable: true } }
      : {}),
    lock: {
      held: lockHeld,
      ...(lockExpiresAt ? { expiresAt: lockExpiresAt } : {}),
    },
  };
}

function actionContext(
  reportCtor: ReportCtor,
  phase: ReportRefreshActionContext['phase'],
  mode: ReportRefreshMode,
  refreshAction:
    | Pick<ReportRefreshActionDescriptor, 'requiredPermission'>
    | undefined,
): ReportRefreshActionContext {
  return {
    phase,
    reportClassName: canonicalClassName(reportCtor),
    tenantScope: 'ambient',
    mode,
    requiredPermission:
      refreshAction?.requiredPermission &&
      refreshAction.requiredPermission.trim().length > 0
        ? refreshAction.requiredPermission
        : 'reports.refresh',
  };
}

async function actionMode(
  reportCtor: ReportCtor,
  requested: ReportRefreshMode | undefined,
): Promise<ReportRefreshMode> {
  if (requested) return requested;
  const definition = await buildReportDefinition(reportCtor);
  return definition.refresh?.mode ?? 'rebuild';
}

/** Preview only declares a separately authorized and audited refresh request. */
export async function previewReportRefresh(
  reportCtor: ReportCtor,
  options: PreviewReportRefreshOptions,
): Promise<ReportRefreshPreview> {
  const mode = await actionMode(reportCtor, options.mode);
  const action = actionContext(
    reportCtor,
    'preview',
    mode,
    options.refreshAction,
  );
  await options.host.authorize(action);
  await options.host.audit(action);
  return {
    phase: 'preview',
    lifecycle: await getReportLifecycle(reportCtor, options),
    action,
    execution: 'background',
  };
}

/** Queue a manual refresh only after the action host authorizes and audits it. */
export async function applyReportRefresh(
  reportCtor: ReportCtor,
  options: ApplyReportRefreshOptions,
): Promise<AppliedReportRefresh> {
  const mode = await actionMode(reportCtor, options.mode);
  const action = actionContext(
    reportCtor,
    'apply',
    mode,
    options.refreshAction,
  );
  await options.host.authorize(action);
  await options.host.audit(action);
  const tenantId = lifecycleTenantId(reportCtor);
  const enqueue = () =>
    enqueueReportRefresh({
      db: options.db,
      reportClass: canonicalClassName(reportCtor),
      mode,
      trigger: 'manual',
      tenantId,
      queue: options.queue,
      priority: options.priority,
      timeout: options.timeout,
      maxAttempts: options.maxAttempts,
      tenantJobCap: options.tenantJobCap,
    });
  const job =
    tenantId === null && getTenantId()
      ? await withSystemContext(enqueue)
      : await enqueue();
  return { phase: 'apply', job: jobHandle(job) };
}

/** Normalize executor results without exposing the tenant identifiers in a fanout. */
export function reportRefreshOutcome(
  result: ReportRefreshResult,
): ReportRefreshOutcome {
  const scopes = result.tenantResults ?? [result];
  const lockSkippedScopes = scopes.filter((scope) => scope.skipped).length;
  const completedScopes = scopes.length - lockSkippedScopes;
  return {
    state:
      scopes.length > 1 && lockSkippedScopes > 0
        ? 'partial'
        : lockSkippedScopes > 0
          ? 'lock-skipped'
          : 'current',
    rowCount: result.rowCount,
    changedGroupCount: result.changedGroupCount ?? 0,
    completedScopes,
    lockSkippedScopes,
    mode: result.mode,
    refreshedAt: result.refreshedAt.toISOString(),
    ...(result.runId ? { runId: result.runId } : {}),
  };
}
