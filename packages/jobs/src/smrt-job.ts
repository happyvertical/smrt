import { createHash, randomUUID } from 'node:crypto';
import type { RetryStrategyConfig } from '@happyvertical/jobs';
import {
  detectEngine,
  ensureJobsSystemTableCompatibility,
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  assertWithinTenantCreationCap,
  clampRetries,
  DEFAULT_TENANT_JOB_CAP,
} from './background-policy.js';
import { SmrtJobDedupeSlotCollection } from './smrt-job-dedupe-slot.js';
import { terminalSnapshot, transitionTerminalJob } from './terminal-outcome.js';

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
 * Full job projection with portable string job and tenant identities.
 *
 * Native DuckDB currently exposes UUID result values as internal objects.
 * Worker claim/recovery state and restored tenant context use string IDs.
 * Both paths use this projection instead of hydrating raw UUIDs from `SELECT *`.
 */
export const SMRT_JOB_PORTABLE_SELECT_COLUMNS = `
  CAST(id AS VARCHAR) AS id,
  slug, context, created_at, updated_at,
  CAST(tenant_id AS VARCHAR) AS tenant_id, queue,
  object_type, object_id, method, args, run_at,
  priority, status, attempts, max_attempts, timeout,
  timeout_behavior, started_at, completed_at, last_error,
  result_pointer, task_id, task_owner_id, task_result,
  task_input_requests, task_input_responses, retry_strategy,
  worker_id, worker_heartbeat, dedupe_key
`;

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
  // Composite for the claim-loop predicate every runner polls roughly once
  // per second (`claimReady()`/`listReady()`: `status = 'pending' AND
  // run_at <= ?`, #2364, epic #2382 finding A3). Declared here rather than
  // left to the jobs-compat path (`ensureJobsSystemTableCompatibility()`,
  // #2375/#2376): that path exists to reshape a table that predates the
  // column/index it adds on databases where the manifest hasn't migrated
  // yet, not as the default route for new indexes on a normal decorated
  // class — this one reaches every path (manifest, registry, `db:migrate`)
  // the standard way and rolls out on the next `smrt db:migrate`.
  //
  // Roll this out with `smrt db:migrate --postgres-safe` (#2362): `_smrt_jobs`
  // is under continuous write load (every claim is an UPDATE), so a plain
  // atomic `CREATE INDEX` would hold ACCESS EXCLUSIVE for the build and stall
  // claiming on a busy deployment.
  indexes: [
    { name: '_smrt_jobs_status_run_at_idx', columns: ['status', 'runAt'] },
    // Keep suspended, already-due tasks out of the hot ready scan (#3211).
    // SQLite/PostgreSQL partial index; DuckDB/JSON retain a full index fallback.
    {
      name: '_smrt_jobs_ready_idx',
      columns: ['status', 'runAt'],
      where:
        "status = 'pending' AND (task_input_requests IS NULL OR task_input_responses IS NOT NULL)",
    },
  ],
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

  /** Caller key retained as provenance; only pending/running jobs reserve it. */
  @field({ type: 'text', nullable: true, indexed: true })
  dedupeKey: string | null = null;

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

  /**
   * When to run the job.
   *
   * Indexed (single-column, plus the class-level `(status, run_at)`
   * composite): the claim-loop predicate every runner polls roughly once per
   * second (#2364).
   */
  @field({ type: 'datetime', required: true, indexed: true })
  runAt: Date = new Date();

  /** Priority (higher = sooner) */
  @field({ type: 'integer', required: true, default: 50 })
  priority: number = 50;

  /**
   * Current status.
   *
   * Indexed (single-column, plus the class-level `(status, run_at)`
   * composite): the claim-loop predicate every runner polls roughly once per
   * second (#2364). `(status, completed_at)` — the retention cleanup
   * predicate — is a separate index from `ensureJobsSystemTableCompatibility()`
   * (#2375).
   */
  @field({ type: 'text', required: true, default: 'pending', indexed: true })
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

  /**
   * Correlation identifier for an MCP Tasks extension task.
   *
   * A task is deliberately represented by its backing job rather than a second
   * queue row: every task transition therefore has exactly one durable worker
   * target to cancel, recover, and inspect.
   */
  @field({ type: 'text', nullable: true, unique: true })
  taskId: string | null = null;

  /** Principal that created an MCP task, when the transport has one. */
  @field({ type: 'text', nullable: true })
  taskOwnerId: string | null = null;

  /** Completed MCP CallToolResult, stored only for MCP task jobs. */
  @field({ type: 'json', nullable: true })
  taskResult: Record<string, unknown> | null = null;

  /** Outstanding input requests made through JobExecutionContext.task. */
  @field({ type: 'json', nullable: true })
  taskInputRequests: Record<string, unknown> | null = null;

  /** Accepted task input responses, keyed by the requested input name. */
  @field({ type: 'json', nullable: true })
  taskInputResponses: Record<string, unknown> | null = null;

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
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (this.tenantId === undefined) {
      const contextTenantId = getTenantId();
      if (contextTenantId) {
        this.tenantId = contextTenantId;
      }
    }

    return super.save(options);
  }

  /**
   * Mark the job for retry
   */
  async retry(
    options: Pick<EnqueueJobOptions, 'transaction'> = {},
  ): Promise<void> {
    if (!this.id) throw new Error('Cannot retry an unpersisted job');
    const executor = options.transaction ?? this.db;
    const initial = await readRetryJob(executor, this.id);
    assertRetryTenant(initial.tenant_id);
    assertRetryStatus(initial.status);
    const association = persistedScheduleAssociation(initial.args);
    const originalArguments = JSON.stringify(persistedArguments(initial.args));
    const originalTarget = persistedJobTarget(initial);
    const dedupeKey = persistedDedupeKey(initial.dedupe_key);
    const tenant = initial.tenant_id;
    const tenantPredicate =
      tenant === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
    const tenantValues = tenant === null ? [] : [tenant];

    const retry = async (
      tx: DatabaseInterface,
    ): Promise<Record<string, unknown>> => {
      // All paths acquire schedule -> dedupe slot -> job. Completion's job
      // transaction commits before its separate schedule callback acquires a row.
      const schedule = association
        ? await lockRetrySchedule(tx, association, initial)
        : null;
      let slotKey: string | null = null;
      let slotJobId: unknown;
      if (dedupeKey !== null) {
        slotKey = jobSlotKey(tenant, dedupeKey);
        const slot = await tx.query(
          'UPDATE _smrt_job_dedupe_slots SET slot_key = slot_key WHERE slot_key = ? RETURNING job_id',
          slotKey,
        );
        if (slot.rows.length !== 1)
          throw new Error('Keyed job retry requires its enqueue slot');
        slotJobId = slot.rows[0].job_id;
      }
      const locked = await tx.query(
        `UPDATE _smrt_jobs SET id = id WHERE id = ? AND ${tenantPredicate}
         RETURNING ${SMRT_JOB_PORTABLE_SELECT_COLUMNS}`,
        initial.id,
        ...tenantValues,
      );
      if (locked.rows.length !== 1)
        throw new Error('Job ownership changed before retry');
      const current = retryRow(locked.rows[0]);
      assertRetryTenant(current.tenant_id);
      if (
        current.tenant_id !== tenant ||
        JSON.stringify(persistedScheduleAssociation(current.args)) !==
          JSON.stringify(association) ||
        JSON.stringify(persistedArguments(current.args)) !==
          originalArguments ||
        JSON.stringify(persistedJobTarget(current)) !==
          JSON.stringify(originalTarget) ||
        persistedDedupeKey(current.dedupe_key) !== dedupeKey
      ) {
        throw new Error(
          'Persisted retry association changed; retry from current state',
        );
      }
      assertRetryStatus(current.status);
      const occupied = schedule
        ? await countScheduleJobs(
            tx,
            schedule.id,
            tenant,
            schedule.target,
            current.id,
          )
        : 0;
      if (schedule && occupied >= schedule.capacity)
        throw new Error('Scheduled retry capacity is full');
      if (
        slotKey &&
        typeof slotJobId === 'string' &&
        slotJobId !== current.id
      ) {
        const active = await tx.query(
          "SELECT id FROM _smrt_jobs WHERE id = ? AND status IN ('pending', 'running')",
          slotJobId,
        );
        if (active.rows.length)
          throw new Error('Another job already reserves this dedupeKey');
      }
      const retried = await tx.query(
        `UPDATE _smrt_jobs SET status = 'pending', attempts = 0, last_error = NULL,
           started_at = NULL, completed_at = NULL, worker_id = NULL, worker_heartbeat = NULL,
           updated_at = ? WHERE id = ? AND ${tenantPredicate}
           AND status IN ('pending', 'failed', 'cancelled')
           RETURNING ${SMRT_JOB_PORTABLE_SELECT_COLUMNS}`,
        new Date().toISOString(),
        current.id,
        ...tenantValues,
      );
      if (retried.rows.length !== 1)
        throw new Error('Job status changed before retry');
      if (slotKey)
        await tx.query(
          'UPDATE _smrt_job_dedupe_slots SET job_id = ? WHERE slot_key = ?',
          current.id,
          slotKey,
        );
      if (schedule)
        await tx.query(
          `UPDATE _smrt_agent_schedules SET running_count = ? WHERE id = ? AND ${tenantPredicate}`,
          occupied + 1,
          schedule.id,
          ...tenantValues,
        );
      return retried.rows[0];
    };
    let row: Record<string, unknown>;
    if (options.transaction) row = await retry(options.transaction);
    else {
      if (!executor.transaction)
        throw new Error('Job retry requires transaction support');
      row = await executor.transaction(retry);
    }
    // Hydrate the authoritative revision and immutable stored arguments. Do not
    // save caller-edited business fields or leak an ended transaction handle.
    await this.loadDataFromDb(row);
  }

  /**
   * Cancel the job
   */
  async cancel(): Promise<void> {
    if (this.status === 'completed' || this.status === 'cancelled') {
      throw new Error(`Cannot cancel job with status: ${this.status}`);
    }

    const snapshot = terminalSnapshot(this);
    if (!snapshot) throw new Error('Cannot cancel an unpersisted job');
    const contextTenantId = getTenantId();
    if (
      contextTenantId &&
      snapshot.tenantId !== contextTenantId &&
      !isSystemContext() &&
      !isSuperAdminBypass()
    ) {
      throw new TenantIsolationError(
        `Tenant isolation violation: cannot cancel SmrtJob with tenantId '${snapshot.tenantId}' in context of tenant '${contextTenantId}'`,
        {
          tenantId: contextTenantId,
          attemptedTenantId: snapshot.tenantId ?? 'null',
        },
      );
    }
    const completedAt = new Date();
    const event = await transitionTerminalJob(this.db, {
      job: snapshot,
      status: 'cancelled',
      completedAt,
      expectedStatuses: ['pending', 'running', 'failed'],
    });
    if (!event) throw new Error('Job status changed before cancellation');

    this.status = 'cancelled';
    this.completedAt = completedAt;
    this.updated_at = completedAt;
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
  /** At most one pending/running job per effective tenant and key. */
  dedupeKey?: string | null;
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
  /** MCP task correlation ID. Internal callers only. */
  taskId?: string | null;
  /** MCP task owner/principal ID. Internal callers only. */
  taskOwnerId?: string | null;
  /** Completed MCP CallToolResult. Internal callers only. */
  taskResult?: Record<string, unknown> | null;
  /** Outstanding MCP task input requests. Internal callers only. */
  taskInputRequests?: Record<string, unknown> | null;
  /** Accepted MCP task input responses. Internal callers only. */
  taskInputResponses?: Record<string, unknown> | null;
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
  /**
   * Existing caller-owned transaction. All enqueue reads/writes use this handle;
   * the caller must propagate failures and commit/rollback the transaction.
   * Avoids nested transactions on engines without savepoints (DuckDB).
   */
  transaction?: DatabaseInterface;
}

/**
 * Options for listReady
 */
export interface ListReadyOptions {
  limit?: number;
  queues?: string[];
  /** Allowed tenant identities; undefined selects all, [] selects none. */
  tenantIds?: readonly (string | null)[];
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
  async listReady(options: ListReadyOptions = {}): Promise<SmrtJob[]> {
    const now = new Date().toISOString();
    const whereConditions: string[] = [
      "status = 'pending'",
      'run_at <= ?',
      '(task_input_requests IS NULL OR task_input_responses IS NOT NULL)',
    ];
    const params: unknown[] = [now];

    if (options.queues?.length) {
      const placeholders = options.queues.map(() => '?').join(', ');
      whereConditions.push(`queue IN (${placeholders})`);
      params.push(...options.queues);
    }

    const scope = jobTenantScope(options.tenantIds);
    params.push(...scope.params);
    params.push(options.limit || 100);

    // Worker-internal scan: the runner intentionally processes ready jobs
    // across all tenants, so it manages tenant context per-job at execution
    // time rather than filtering here (SmrtJob is now @TenantScoped, S5 #1402).
    return this.query(
      `SELECT * FROM _smrt_jobs WHERE ${whereConditions.join(' AND ')}${scope.sql} ORDER BY priority DESC, run_at ASC LIMIT ?`,
      params,
      { allowRawOnTenantScoped: true },
    );
  }

  /**
   * Atomically claim pending jobs ready to run for a worker.
   *
   * The claim is performed as one conditional UPDATE so concurrent workers
   * cannot receive the same pending row, and it never claims more than
   * `limit` rows. PostgreSQL additionally skips rows locked by other workers
   * instead of waiting behind them.
   *
   * On PostgreSQL the candidate set is selected once in a `MATERIALIZED` CTE
   * and the UPDATE joins to it. The previous `WHERE id IN (SELECT … LIMIT ?
   * FOR UPDATE SKIP LOCKED)` form let the planner choose a nested-loop semi
   * join that rescans the subquery for every outer pending row; each rescan
   * skipped the row the statement had just updated and returned the next one,
   * so a single claim could take the whole backlog and a `concurrency: 1`
   * runner started every ready job at once (#3145).
   */
  async claimReady(options: ClaimReadyOptions): Promise<SmrtJob[]> {
    const limit = options.limit ?? 100;
    if (limit <= 0) return [];

    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const whereConditions: string[] = [
      "status = 'pending'",
      'run_at <= ?',
      '(task_input_requests IS NULL OR task_input_responses IS NOT NULL)',
    ];
    const whereParams: unknown[] = [nowIso];

    if (options.queues?.length) {
      const placeholders = options.queues.map(() => '?').join(', ');
      whereConditions.push(`queue IN (${placeholders})`);
      whereParams.push(...options.queues);
    }

    const scope = jobTenantScope(options.tenantIds);
    whereParams.push(...scope.params);
    const isPostgres = getDatabaseEngine(this.db) === 'postgres';
    const candidateSelect = `
      SELECT id AS claim_id
        FROM _smrt_jobs
       WHERE ${whereConditions.join(' AND ')}${scope.sql}
       ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
       LIMIT ?${isPostgres ? ' FOR UPDATE SKIP LOCKED' : ''}
    `;
    const setClause = `
          SET status = 'running',
              worker_id = ?,
              worker_heartbeat = ?,
              started_at = ?,
              attempts = attempts + 1,
              updated_at = ?`;
    const setParams = [options.workerId, nowIso, nowIso, nowIso];

    // Worker-internal cross-tenant claim; tenant context is restored
    // per-job at execution (SmrtJob is now @TenantScoped, S5 #1402).
    const claimed = isPostgres
      ? await this.query(
          `WITH claim_candidates AS MATERIALIZED (${candidateSelect})
           UPDATE _smrt_jobs${setClause}
             FROM claim_candidates
            WHERE _smrt_jobs.id = claim_candidates.claim_id
              AND _smrt_jobs.status = 'pending'
            RETURNING ${SMRT_JOB_PORTABLE_SELECT_COLUMNS}`,
          [...whereParams, limit, ...setParams],
          { allowRawOnTenantScoped: true },
        )
      : await this.query(
          `UPDATE _smrt_jobs${setClause}
            WHERE id IN (${candidateSelect})
              AND status = 'pending'
            RETURNING ${SMRT_JOB_PORTABLE_SELECT_COLUMNS}`,
          [...setParams, ...whereParams, limit],
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

    if (data.dedupeKey != null) {
      if (
        typeof data.dedupeKey !== 'string' ||
        data.dedupeKey.trim().length === 0 ||
        data.dedupeKey.length > 512
      ) {
        throw new TypeError(
          'dedupeKey must be a nonblank string of at most 512 characters',
        );
      }
      assertDedupeTenantSpelling(effectiveTenant);
      const ambientTenant = getTenantId();
      assertDedupeTenantSpelling(ambientTenant ?? null);
      if (
        ambientTenant &&
        effectiveTenant !== ambientTenant &&
        !isSystemContext() &&
        !isSuperAdminBypass()
      ) {
        throw new TenantIsolationError(
          'Cannot enqueue a job for another tenant',
          {
            tenantId: ambientTenant,
            attemptedTenantId: effectiveTenant ?? 'null',
          },
        );
      }
      const db = options.transaction ?? this.db;
      if (!options.transaction && !db.transaction)
        throw new Error('Job deduplication requires transaction support');
      await SmrtJobDedupeSlotCollection.create({ db });
      const slotKey = jobSlotKey(effectiveTenant, data.dedupeKey);
      const enqueue = async (tx: DatabaseInterface): Promise<string> => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await tx.query(
          `INSERT INTO _smrt_job_dedupe_slots
           (id, slug, context, created_at, updated_at, slot_key, job_id)
           VALUES (?, ?, '', ?, ?, ?, NULL) ON CONFLICT (slot_key) DO NOTHING`,
          id,
          id,
          now,
          now,
          slotKey,
        );
        const slot = await tx.query(
          `UPDATE _smrt_job_dedupe_slots SET updated_at = ?
           WHERE slot_key = ? RETURNING job_id`,
          now,
          slotKey,
        );
        if (slot.rows.length !== 1)
          throw new Error('Job deduplication slot unavailable; retry enqueue');
        const jobs = await SmrtJobCollection.create({ db: tx });
        const jobId = slot.rows[0].job_id;
        if (typeof jobId === 'string') {
          const existing = await jobs.get({ id: jobId });
          if (existing && (existing.tenantId ?? null) !== effectiveTenant)
            throw new Error(
              'Job deduplication slot has invalid tenant ownership',
            );
          if (
            existing &&
            (existing.status === 'pending' || existing.status === 'running')
          )
            return String(existing.id);
        }
        // Store provenance in the initial insert without reacquiring the slot.
        const job = await jobs.createQueuedJob(
          { ...data, tenantId: effectiveTenant },
          cap,
        );
        await tx.query(
          'UPDATE _smrt_job_dedupe_slots SET job_id = ? WHERE slot_key = ?',
          job.id,
          slotKey,
        );
        return String(job.id);
      };
      let jobId: string;
      if (options.transaction) jobId = await enqueue(options.transaction);
      else {
        if (!db.transaction)
          throw new Error('Job deduplication requires transaction support');
        jobId = await db.transaction(enqueue);
      }
      // Do not return a model bound to a now-ended transaction.
      const resultCollection = options.transaction
        ? await SmrtJobCollection.create({ db: options.transaction })
        : this;
      const job = await resultCollection.get({ id: jobId });
      if (!job) throw new Error('Enqueued job is unavailable');
      return job;
    }
    if (options.transaction) {
      const jobs = await SmrtJobCollection.create({ db: options.transaction });
      return jobs.createQueuedJob({ ...data, tenantId: effectiveTenant }, cap);
    }
    return this.createQueuedJob({ ...data, tenantId: effectiveTenant }, cap);
  }

  /** Persist once, without a second save racing a consumer's first claim. */
  private async createQueuedJob(
    data: SmrtJobData,
    cap: number,
  ): Promise<SmrtJob> {
    const effectiveTenant = data.tenantId;
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
   * Cleanup old completed/failed jobs.
   *
   * Predicates are `(status, completed_at)` pairs, covered by
   * `idx_smrt_jobs_status_completed_at` (created by the jobs compatibility
   * path this collection runs on initialize — #2375).
   *
   * @param options.dryRun - Count the jobs the cutoffs select without deleting
   *   them, so a retention preview reports exactly what a real run removes.
   * @returns Number of jobs deleted (or, under `dryRun`, matched).
   */
  async cleanup(options: {
    completedBefore?: Date;
    failedBefore?: Date;
    cancelledBefore?: Date;
    limit?: number;
    dryRun?: boolean;
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

    const selector = options.limit
      ? `id IN (
          SELECT id FROM _smrt_jobs
          WHERE (${conditions.join(' OR ')})
          LIMIT ?
        )`
      : `(${conditions.join(' OR ')})`;
    const selectorParams = options.limit
      ? [...params, options.limit]
      : [...params];

    // Count first: `rowCount` is not reliably populated across the engines
    // SMRT supports, and counting is what lets `dryRun` preview the exact
    // predicate a real cleanup would delete (#2375).
    const counted = await this._db.query(
      `SELECT COUNT(*) AS total FROM _smrt_jobs WHERE ${selector}`,
      ...selectorParams,
    );
    const total = Number(counted.rows?.[0]?.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) return 0;

    if (!options.dryRun) {
      await this._db.query(
        `DELETE FROM _smrt_jobs WHERE ${selector}`,
        ...selectorParams,
      );
    }

    return total;
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

function jobSlotKey(tenant: string | null, key: string): string {
  return createHash('sha256')
    .update(JSON.stringify([tenant, key]))
    .digest('hex');
}

/** Internal SQL predicate shared by ready claims and worker recovery. */
export function jobTenantScope(
  tenantIds: readonly (string | null)[] | undefined,
): { sql: string; params: string[] } {
  if (tenantIds === undefined) return { sql: '', params: [] };
  if (
    !Array.isArray(tenantIds) ||
    tenantIds.some(
      (id) => id !== null && (typeof id !== 'string' || !id.trim()),
    )
  )
    throw new TypeError('tenantIds must contain nonblank identities or null');
  const ids = tenantIds.filter((id): id is string => id !== null);
  const terms: string[] = [];
  if (ids.length) terms.push(`tenant_id IN (${ids.map(() => '?').join(', ')})`);
  if (tenantIds.includes(null)) terms.push('tenant_id IS NULL');
  return {
    sql: ` AND ${terms.length ? `(${terms.join(' OR ')})` : '1 = 0'}`,
    params: ids,
  };
}

type RetryJobRow = Record<string, unknown> & {
  id: string;
  tenant_id: string | null;
  dedupe_key: string | null;
  status: JobStatus;
  args: unknown;
};

function retryRow(row: Record<string, unknown>): RetryJobRow {
  if (
    typeof row.id !== 'string' ||
    (row.tenant_id !== null && typeof row.tenant_id !== 'string')
  )
    throw new Error('Invalid persisted job identity');
  return row as RetryJobRow;
}

async function readRetryJob(
  db: DatabaseInterface,
  id: string,
): Promise<RetryJobRow> {
  const result = await db.query(
    `SELECT ${SMRT_JOB_PORTABLE_SELECT_COLUMNS} FROM _smrt_jobs WHERE id = ?`,
    id,
  );
  if (result.rows.length !== 1)
    throw new Error('Persisted retry job is unavailable');
  return retryRow(result.rows[0]);
}

function assertRetryTenant(tenant: string | null): void {
  const ambient = getTenantId();
  if (
    ambient &&
    tenant !== ambient &&
    !isSystemContext() &&
    !isSuperAdminBypass()
  ) {
    throw new TenantIsolationError('Cannot retry a job for another tenant', {
      tenantId: ambient,
      attemptedTenantId: tenant ?? 'null',
    });
  }
}

function assertRetryStatus(status: JobStatus): void {
  if (status === 'completed' || status === 'running')
    throw new Error(`Cannot retry a ${status} job`);
  if (!['pending', 'failed', 'cancelled'].includes(status))
    throw new Error('Unknown persisted retry job status');
}

function persistedDedupeKey(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Invalid persisted dedupeKey');
  return value;
}

function persistedArguments(value: unknown): Record<string, unknown> {
  const args = typeof value === 'string' ? JSON.parse(value) : value;
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Invalid persisted job arguments');
  return args as Record<string, unknown>;
}

interface PersistedScheduleAssociation {
  id: string;
  canonicalOccurrence: boolean;
}
function persistedScheduleAssociation(
  value: unknown,
): PersistedScheduleAssociation | null {
  const args = persistedArguments(value);
  const canonicalOccurrence =
    Object.hasOwn(args, '_scheduledFor') ||
    Object.hasOwn(args, '_scheduleAdmission');
  if (!Object.hasOwn(args, '_scheduleId')) {
    if (canonicalOccurrence)
      throw new Error('Invalid persisted schedule association');
    return null;
  }
  if (typeof args._scheduleId !== 'string' || !args._scheduleId.trim())
    throw new Error('Invalid persisted schedule association');
  return { id: args._scheduleId, canonicalOccurrence };
}

/** @internal Execution target of an AgentSchedule, independent of caller metadata names. */
export interface ScheduleJobTarget {
  objectType: string;
  objectId: string | null;
  method: string;
}
function persistedJobTarget(row: Record<string, unknown>): ScheduleJobTarget {
  if (
    typeof row.object_type !== 'string' ||
    typeof row.method !== 'string' ||
    (row.object_id !== null && typeof row.object_id !== 'string')
  )
    throw new Error('Invalid persisted retry target');
  return {
    objectType: row.object_type,
    objectId: row.object_id as string | null,
    method: row.method,
  };
}
function scheduleJobTarget(row: Record<string, unknown>): ScheduleJobTarget {
  return {
    objectType: String(row.agent_type ?? ''),
    objectId: row.agent_id == null ? null : String(row.agent_id),
    method: String(row.method || 'run'),
  };
}
function sameScheduleTarget(
  left: ScheduleJobTarget,
  right: ScheduleJobTarget,
): boolean {
  const canonical = (name: string) =>
    ObjectRegistry.getClass(name)?.qualifiedName || name;
  return (
    canonical(left.objectType) === canonical(right.objectType) &&
    left.objectId === right.objectId &&
    left.method === right.method
  );
}
async function lockRetrySchedule(
  tx: DatabaseInterface,
  association: PersistedScheduleAssociation,
  job: RetryJobRow,
): Promise<{ id: string; capacity: number; target: ScheduleJobTarget } | null> {
  // _scheduleId predates AgentSchedule admission and is also ordinary producer
  // metadata. Do not issue missing-table SQL and then continue an aborted PG tx.
  if (!(await tx.tableExists('_smrt_agent_schedules'))) {
    if (association.canonicalOccurrence)
      throw new Error('Scheduled retry association is unavailable');
    return null;
  }
  const predicate =
    job.tenant_id === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
  const tenants = job.tenant_id === null ? [] : [job.tenant_id];
  const columns =
    'CAST(id AS VARCHAR) AS id, agent_type, CAST(agent_id AS VARCHAR) AS agent_id, method, max_concurrent';
  // Cast the read identity so unrelated producers' opaque metadata never causes
  // an invalid-UUID error merely because an AgentSchedule table is installed.
  const candidate = (
    await tx.query(
      `SELECT ${columns} FROM _smrt_agent_schedules WHERE CAST(id AS VARCHAR) = ? AND ${predicate}`,
      association.id,
      ...tenants,
    )
  ).rows[0];
  if (
    !candidate ||
    (!association.canonicalOccurrence &&
      !sameScheduleTarget(
        persistedJobTarget(job),
        scheduleJobTarget(candidate),
      ))
  ) {
    if (association.canonicalOccurrence)
      throw new Error('Scheduled retry association is unavailable');
    return null;
  }
  const locked = (
    await tx.query(
      `UPDATE _smrt_agent_schedules SET running_count = running_count
     WHERE id = ? AND ${predicate} RETURNING ${columns}`,
      candidate.id,
      ...tenants,
    )
  ).rows[0];
  if (
    !locked ||
    (!association.canonicalOccurrence &&
      !sameScheduleTarget(persistedJobTarget(job), scheduleJobTarget(locked)))
  )
    throw new Error(
      'Scheduled retry association changed; retry from current state',
    );
  const capacity = Number(locked.max_concurrent ?? 1);
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new Error('Scheduled retry capacity is invalid');
  return { id: String(locked.id), capacity, target: scheduleJobTarget(locked) };
}

/** @internal Count canonical occurrences and matching legacy target slots for admission/retry. */
export async function countScheduleJobs(
  db: DatabaseInterface,
  scheduleId: string,
  tenant: string | null,
  target: ScheduleJobTarget,
  excludeJobId?: string,
): Promise<number> {
  const result = await db.query(
    `SELECT args, object_type, CAST(object_id AS VARCHAR) AS object_id, method FROM _smrt_jobs WHERE status IN ('pending', 'running')
     AND ${tenant === null ? 'tenant_id IS NULL' : 'tenant_id = ?'}${excludeJobId ? ' AND id <> ?' : ''}`,
    ...(tenant === null ? [] : [tenant]),
    ...(excludeJobId ? [excludeJobId] : []),
  );
  return result.rows.filter((row) => {
    try {
      const association = persistedScheduleAssociation(row.args);
      return (
        association?.id === scheduleId &&
        (association.canonicalOccurrence ||
          sameScheduleTarget(persistedJobTarget(row), target))
      );
    } catch {
      return false;
    }
  }).length;
}

function assertDedupeTenantSpelling(tenant: string | null): void {
  if (tenant === null) return;
  const uuidLike = /^[0-9a-f]{32}$/i.test(tenant.replace(/[{}-]/g, ''));
  const canonical =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      tenant,
    );
  if (uuidLike && !canonical)
    throw new TypeError(
      'Keyed jobs require canonical lowercase hyphenated UUID tenant IDs; load the canonical tenant identity before enqueue',
    );
}
