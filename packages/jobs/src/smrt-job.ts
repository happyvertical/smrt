import type { RetryStrategyConfig } from '@happyvertical/jobs';
import {
  detectEngine,
  ensureJobsSystemTableCompatibility,
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  assertWithinTenantCreationCap,
  clampRetries,
  DEFAULT_TENANT_JOB_CAP,
} from './background-policy.js';

/**
 * Job status type
 */
export type JobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Timeout behavior type
 */
export type TimeoutBehavior = 'fail' | 'kill' | 'warn';

/**
 * Persistent job record stored in the `_smrt_jobs` system table.
 *
 * @remarks
 * Each SmrtJob represents a deferred method call on a SmrtObject. The TaskRunner polls for
 * pending jobs, resolves the target class via ObjectRegistry, and invokes the method. Jobs
 * track status (`pending -> running -> completed/failed/cancelled`), retry attempts with
 * configurable strategies, worker heartbeats for stale-job detection, and optional result pointers.
 * Priority ordering is `higher = sooner`; the default timeout is 5 minutes (300000ms).
 */
@smrt({
  tableName: '_smrt_jobs',
  // Fail closed: `_smrt_jobs` is an internal operational queue table. Generated
  // REST/MCP list/get only filter by tenant when a tenant context is active;
  // reached without context (a tenant-less/admin principal, or any non-SvelteKit
  // surface) an `optional`-mode class returns UNFILTERED rows, leaking every
  // tenant's jobs. Workers read this table via the collection directly
  // (allowRawOnTenantScoped), never through generated routes, so nothing
  // internal needs the read surface — so we do not generate one (S5 audit #1402).
  api: false,
  // retry/cancel are operator commands invoked in-process via the CLI;
  // they intentionally aren't exposed over HTTP.
  cli: {
    include: ['list', 'get', 'retry', 'cancel'],
    skipApiCheck: true,
    http: false,
  },
  mcp: false,
})
// Keep the data model tenant-scoped (defense in depth): even without a generated
// read route, the @tenantId() field alone does NOT make collection reads filter
// by tenant. `optional` mode preserves global (NULL tenant) jobs while scoping
// tenant-owned rows for any future tenant-context-required path (S5 audit #1402).
@TenantScoped({ mode: 'optional' })
export class SmrtJob extends SmrtObject {
  /** Tenant context captured for this job, if any */
  @tenantId({ nullable: true })
  tenantId: string | null | undefined = undefined;

  /** Queue name for the job */
  @field({ type: 'text', required: true, default: 'default' })
  queue: string = 'default';

  /** Type of object to invoke method on */
  @field({ type: 'text', required: true })
  objectType: string = '';

  /** ID of the specific object (null for static methods) */
  @field({ type: 'text', nullable: true })
  objectId: string | null = null;

  /** Method name to invoke */
  @field({ type: 'text', required: true })
  method: string = '';

  /** Arguments to pass to the method (JSON) */
  @field({ type: 'json' })
  args: Record<string, unknown> = {};

  /** When to run the job */
  @field({ type: 'datetime', required: true })
  runAt: Date = new Date();

  /** Priority (higher = sooner) */
  @field({ type: 'integer', required: true, default: 50 })
  priority: number = 50;

  /** Current status */
  @field({ type: 'text', required: true, default: 'pending' })
  status: JobStatus = 'pending';

  /** Number of execution attempts */
  @field({ type: 'integer', required: true, default: 0 })
  attempts: number = 0;

  /** Maximum retry attempts */
  @field({ type: 'integer', required: true, default: 3 })
  maxAttempts: number = 3;

  /** Timeout in milliseconds */
  @field({ type: 'integer', required: true, default: 300000 })
  timeout: number = 300000;

  /** What to do on timeout */
  @field({ type: 'text', required: true, default: 'fail' })
  timeoutBehavior: TimeoutBehavior = 'fail';

  /** When execution started */
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;

  /** When execution completed */
  @field({ type: 'datetime', nullable: true })
  completedAt: Date | null = null;

  /** Last error message */
  @field({ type: 'text', nullable: true })
  lastError: string | null = null;

  /** Pointer to where result is stored */
  @field({ type: 'text', nullable: true })
  resultPointer: string | null = null;

  /** Retry strategy configuration */
  @field({ type: 'json' })
  retryStrategy: RetryStrategyConfig = {
    type: 'exponential',
    config: { initialDelay: 1000, multiplier: 2, maxDelay: 300000 },
  };

  /** ID of the worker processing this job */
  @field({ type: 'text', nullable: true })
  workerId: string | null = null;

  /** Last heartbeat from the worker */
  @field({ type: 'datetime', nullable: true })
  workerHeartbeat: Date | null = null;

  /**
   * Capture ambient tenant context when a job is saved inside withTenant().
   *
   * Scheduled jobs can also set this explicitly from their owning schedule.
   */
  override async save(): Promise<this> {
    if (this.tenantId === undefined) {
      const contextTenantId = getTenantId();
      if (contextTenantId) {
        this.tenantId = contextTenantId;
      }
    }

    return super.save();
  }

  /**
   * Mark the job for retry
   */
  async retry(): Promise<void> {
    if (this.status === 'completed') {
      throw new Error('Cannot retry a completed job');
    }

    this.status = 'pending';
    this.attempts = 0;
    this.lastError = null;
    this.startedAt = null;
    this.completedAt = null;
    this.workerId = null;
    this.workerHeartbeat = null;

    await this.save();
  }

  /**
   * Cancel the job
   */
  async cancel(): Promise<void> {
    if (this.status === 'completed' || this.status === 'cancelled') {
      throw new Error(`Cannot cancel job with status: ${this.status}`);
    }

    this.status = 'cancelled';
    this.completedAt = new Date();

    await this.save();
  }

  /**
   * Get a human-readable description of the job
   */
  getDescription(): string {
    const target = this.objectId
      ? `${this.objectType}#${this.objectId}`
      : this.objectType;
    return `${target}.${this.method}()`;
  }
}

/**
 * Job data type (for create operations)
 */
export interface SmrtJobData {
  tenantId?: string | null;
  queue?: string;
  objectType: string;
  objectId?: string | null;
  method: string;
  args?: Record<string, unknown>;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  timeout?: number;
  timeoutBehavior?: TimeoutBehavior;
  retryStrategy?: RetryStrategyConfig;
}

/**
 * Options controlling a centralized {@link SmrtJobCollection.enqueueJob} call.
 */
export interface EnqueueJobOptions {
  /**
   * Per-tenant in-flight cap. Defaults to {@link DEFAULT_TENANT_JOB_CAP}.
   * `0`/negative disables the cap (trusted internal callers). Global
   * (no-context / null tenant) jobs are always exempt.
   */
  tenantJobCap?: number;
}

/**
 * Options for listReady
 */
export interface ListReadyOptions {
  limit?: number;
  queues?: string[];
}

/**
 * Options for atomically claiming ready jobs.
 */
export interface ClaimReadyOptions extends ListReadyOptions {
  workerId: string;
  now?: Date;
}

type DatabaseWithConfig = DatabaseInterface & {
  config?: {
    type?: string;
    url?: string;
  };
  type?: string;
};

/**
 * Collection for managing SmrtJob objects
 */
export class SmrtJobCollection extends SmrtCollection<SmrtJob> {
  static readonly _itemClass = SmrtJob;

  override async initialize(): Promise<this> {
    await super.initialize();
    await ensureJobsSystemTableCompatibility(this.db);
    return this;
  }

  /**
   * List jobs by status
   */
  async listByStatus(
    status: JobStatus | JobStatus[],
    options: { limit?: number; queue?: string } = {},
  ): Promise<SmrtJob[]> {
    const where: Record<string, unknown> = {
      status: Array.isArray(status) ? status : [status],
    };

    if (options.queue) {
      where.queue = options.queue;
    }

    return this.list({
      where,
      orderBy: ['priority DESC', 'run_at ASC'],
      limit: options.limit,
    });
  }

  /**
   * List pending jobs ready to run
   */
  async listReady(
    options: { limit?: number; queues?: string[] } = {},
  ): Promise<SmrtJob[]> {
    const now = new Date().toISOString();
    const whereConditions: string[] = ["status = 'pending'", 'run_at <= ?'];
    const params: unknown[] = [now];

    if (options.queues?.length) {
      const placeholders = options.queues.map(() => '?').join(', ');
      whereConditions.push(`queue IN (${placeholders})`);
      params.push(...options.queues);
    }

    params.push(options.limit || 100);

    // Worker-internal scan: the runner intentionally processes ready jobs
    // across all tenants, so it manages tenant context per-job at execution
    // time rather than filtering here (SmrtJob is now @TenantScoped, S5 #1402).
    return this.query(
      `SELECT * FROM _smrt_jobs WHERE ${whereConditions.join(' AND ')} ORDER BY priority DESC, run_at ASC LIMIT ?`,
      params,
      { allowRawOnTenantScoped: true },
    );
  }

  /**
   * Atomically claim pending jobs ready to run for a worker.
   *
   * The claim is performed as one conditional UPDATE so concurrent workers
   * cannot receive the same pending row. PostgreSQL additionally skips rows
   * locked by other workers instead of waiting behind them.
   */
  async claimReady(options: ClaimReadyOptions): Promise<SmrtJob[]> {
    const limit = options.limit ?? 100;
    if (limit <= 0) return [];

    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const whereConditions: string[] = ["status = 'pending'", 'run_at <= ?'];
    const whereParams: unknown[] = [nowIso];

    if (options.queues?.length) {
      const placeholders = options.queues.map(() => '?').join(', ');
      whereConditions.push(`queue IN (${placeholders})`);
      whereParams.push(...options.queues);
    }

    const lockClause =
      getDatabaseEngine(this.db) === 'postgres'
        ? ' FOR UPDATE SKIP LOCKED'
        : '';
    const candidateSelect = `
      SELECT id
        FROM _smrt_jobs
       WHERE ${whereConditions.join(' AND ')}
       ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
       LIMIT ?${lockClause}
    `;

    const claimed = await this.query(
      `UPDATE _smrt_jobs
          SET status = 'running',
              worker_id = ?,
              worker_heartbeat = ?,
              started_at = ?,
              attempts = attempts + 1,
              updated_at = ?
        WHERE id IN (${candidateSelect})
          AND status = 'pending'
        RETURNING *`,
      [options.workerId, nowIso, nowIso, nowIso, ...whereParams, limit],
      // Worker-internal cross-tenant claim; tenant context is restored
      // per-job at execution (SmrtJob is now @TenantScoped, S5 #1402).
      { allowRawOnTenantScoped: true },
    );

    return claimed.toSorted(compareClaimOrder);
  }

  /**
   * Count non-terminal (pending/running) jobs owned by a tenant.
   *
   * Used to enforce the per-tenant creation cap so one tenant cannot exhaust
   * the shared worker pool (S5 audit #1402). Reads `_smrt_jobs` directly so it
   * works regardless of ambient tenant context.
   *
   * @param tenantId - Tenant to count for. `null` counts global (NULL-tenant)
   *   jobs.
   */
  async countInFlightForTenant(tenantId: string | null): Promise<number> {
    const predicate = tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
    const params = tenantId === null ? [] : [tenantId];

    // Use the public `db` accessor (with its init guard), not the protected
    // `_db` internal — consistent with claimReady()/this.db usage above. This
    // is a deliberately cross-tenant count (it must see every tenant's rows to
    // bound a single tenant), so it intentionally bypasses the tenant-scoped
    // query interceptor rather than routing through this.query().
    const result = await this.db.query(
      `SELECT COUNT(*) AS count
         FROM _smrt_jobs
        WHERE status IN ('pending', 'running')
          AND ${predicate}`,
      ...params,
    );

    const row = result.rows[0] as { count?: number | string } | undefined;
    return Number(row?.count ?? 0);
  }

  /**
   * The single creation path for queued jobs.
   *
   * Centralizes the two creation-time security guards from the S5 audit (#1402)
   * so every enqueue — the fluent {@link "./job-builder".JobBuilder} *and* the
   * ScheduleRunner's cron-triggered jobs — goes through one place:
   *
   * 1. `maxAttempts` is clamped to {@link MAX_JOB_RETRIES} so a misconfigured
   *    caller cannot pin a worker on a poison job indefinitely.
   * 2. A per-tenant in-flight cap bounds how many non-terminal jobs one tenant
   *    may hold, so one tenant cannot exhaust the shared worker pool
   *    (cross-tenant denial of service). The cap applies to the row's effective
   *    tenant (explicit `data.tenantId` or, when absent, the ambient context);
   *    global (null-tenant) jobs are exempt.
   *
   * Atomicity note (best-effort soft cap, by design): the cap is a
   * count-then-insert, NOT a hard transactional invariant. It is intentionally
   * left non-atomic. A plain transaction would not help — under the adapters'
   * default isolation two concurrent same-tenant enqueues would each read the
   * same COUNT and both insert, so serializing them would require either a
   * per-tenant lock row (`SELECT ... FOR UPDATE`) or SERIALIZABLE-isolation
   * retry loops. That cross-process locking is fragile (lock-row contention,
   * adapter-specific isolation behavior, the `transaction` adapter method being
   * optional) and out of proportion to the threat: this cap is defense in depth
   * against runaway/accidental creation exhausting the shared worker pool, not a
   * billing/quota boundary. So under truly simultaneous enqueues a tenant may
   * momentarily overshoot by the number of in-flight creators; the bound still
   * prevents unbounded growth and closes the prior ScheduleRunner bypass. If a
   * hard guarantee is ever needed, enforce it with a DB CHECK/trigger or a
   * dedicated counter row, not an application-level lock.
   */
  async enqueueJob(
    data: SmrtJobData,
    options: EnqueueJobOptions = {},
  ): Promise<SmrtJob> {
    const cap = options.tenantJobCap ?? DEFAULT_TENANT_JOB_CAP;

    // Effective tenant: an explicitly provided tenantId wins (ScheduleRunner
    // passes the schedule's tenant even when no ambient context exists);
    // otherwise fall back to the ambient context (JobBuilder path).
    const explicitTenant =
      typeof data.tenantId === 'string' && data.tenantId.length > 0
        ? data.tenantId
        : data.tenantId === null
          ? null
          : undefined;
    const effectiveTenant =
      explicitTenant !== undefined ? explicitTenant : (getTenantId() ?? null);

    if (effectiveTenant && cap > 0) {
      const current = await this.countInFlightForTenant(effectiveTenant);
      assertWithinTenantCreationCap(effectiveTenant, current, cap);
    }

    const job = await this.create({
      ...data,
      // Clamp here so neither the builder nor the schedule runner can bypass the
      // retry ceiling (S5 audit #1402).
      maxAttempts: clampRetries(data.maxAttempts ?? 3),
    });
    await job.save();
    return job;
  }

  /**
   * Get job statistics
   */
  async stats(queue?: string): Promise<{
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  }> {
    const query = queue
      ? 'SELECT status, COUNT(*) as count FROM _smrt_jobs WHERE queue = ? GROUP BY status'
      : 'SELECT status, COUNT(*) as count FROM _smrt_jobs GROUP BY status';
    const params = queue ? [queue] : [];

    const result = await this._db.query(query, ...params);

    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.status as string] = row.count as number;
    }

    return {
      pending: counts.pending ?? 0,
      running: counts.running ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      cancelled: counts.cancelled ?? 0,
    };
  }

  /**
   * Cleanup old completed/failed jobs
   */
  async cleanup(options: {
    completedBefore?: Date;
    failedBefore?: Date;
    cancelledBefore?: Date;
    limit?: number;
  }): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.completedBefore) {
      conditions.push("(status = 'completed' AND completed_at < ?)");
      params.push(options.completedBefore.toISOString());
    }

    if (options.failedBefore) {
      conditions.push("(status = 'failed' AND completed_at < ?)");
      params.push(options.failedBefore.toISOString());
    }

    if (options.cancelledBefore) {
      conditions.push("(status = 'cancelled' AND completed_at < ?)");
      params.push(options.cancelledBefore.toISOString());
    }

    if (conditions.length === 0) return 0;

    let query = `DELETE FROM _smrt_jobs WHERE (${conditions.join(' OR ')})`;

    if (options.limit) {
      query = `
        DELETE FROM _smrt_jobs
        WHERE id IN (
          SELECT id FROM _smrt_jobs
          WHERE (${conditions.join(' OR ')})
          LIMIT ?
        )
      `;
      params.push(options.limit);
    }

    const result = await this._db.query(query, ...params);
    return result.rowCount ?? 0;
  }
}

function getDatabaseEngine(
  db: DatabaseInterface,
): ReturnType<typeof detectEngine> {
  const dbWithConfig = db as DatabaseWithConfig;
  return detectEngine(
    db.url || dbWithConfig.config?.url || '',
    dbWithConfig.type || dbWithConfig.config?.type,
  );
}

function compareClaimOrder(left: SmrtJob, right: SmrtJob): number {
  const priority = right.priority - left.priority;
  if (priority !== 0) return priority;

  const runAt = left.runAt.getTime() - right.runAt.getTime();
  if (runAt !== 0) return runAt;

  const createdAt = timestamp(left.created_at) - timestamp(right.created_at);
  if (createdAt !== 0) return createdAt;

  return (left.id ?? '').localeCompare(right.id ?? '');
}

function timestamp(value: Date | null | undefined): number {
  return value?.getTime() ?? 0;
}

export default SmrtJob;
