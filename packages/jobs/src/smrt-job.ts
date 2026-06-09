import type { RetryStrategyConfig } from '@happyvertical/jobs';
import {
  detectEngine,
  ensureJobsSystemTableCompatibility,
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTenantId, tenantId } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';

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
  api: { include: ['list', 'get'] },
  // retry/cancel are operator commands invoked in-process via the CLI;
  // they intentionally aren't exposed over HTTP.
  cli: {
    include: ['list', 'get', 'retry', 'cancel'],
    skipApiCheck: true,
    http: false,
  },
  mcp: { include: ['list', 'get'] },
})
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

    return this.query(
      `SELECT * FROM _smrt_jobs WHERE ${whereConditions.join(' AND ')} ORDER BY priority DESC, run_at ASC LIMIT ?`,
      params,
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
    );

    return claimed.toSorted(compareClaimOrder);
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
