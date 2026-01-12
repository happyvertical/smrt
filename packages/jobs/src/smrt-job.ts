import type { RetryStrategyConfig } from '@happyvertical/jobs';
import { SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';

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
 * SmrtJob model for persisting background jobs
 *
 * This extends SmrtObject to store job metadata in the SMRT database.
 * Jobs are executed by the TaskRunner which processes the method calls.
 */
@smrt({
  tableName: '_smrt_jobs',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get', 'retry', 'cancel'] },
  mcp: { include: ['list', 'get'] },
})
export class SmrtJob extends SmrtObject {
  /** Queue name for the job */
  queue: string = 'default';

  /** Type of object to invoke method on */
  objectType: string = '';

  /** ID of the specific object (null for static methods) */
  objectId: string | null = null;

  /** Method name to invoke */
  method: string = '';

  /** Arguments to pass to the method (JSON) */
  args: Record<string, unknown> = {};

  /** When to run the job */
  runAt: Date = new Date();

  /** Priority (higher = sooner) */
  priority: number = 50;

  /** Current status */
  status: JobStatus = 'pending';

  /** Number of execution attempts */
  attempts: number = 0;

  /** Maximum retry attempts */
  maxAttempts: number = 3;

  /** Timeout in milliseconds */
  timeout: number = 300000;

  /** What to do on timeout */
  timeoutBehavior: TimeoutBehavior = 'fail';

  /** When execution started */
  startedAt: Date | null = null;

  /** When execution completed */
  completedAt: Date | null = null;

  /** Last error message */
  lastError: string | null = null;

  /** Pointer to where result is stored */
  resultPointer: string | null = null;

  /** Retry strategy configuration */
  retryStrategy: RetryStrategyConfig = {
    type: 'exponential',
    config: { initialDelay: 1000, multiplier: 2, maxDelay: 300000 },
  };

  /** ID of the worker processing this job */
  workerId: string | null = null;

  /** Last heartbeat from the worker */
  workerHeartbeat: Date | null = null;

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
 * Collection for managing SmrtJob objects
 */
export class SmrtJobCollection extends SmrtCollection<SmrtJob> {
  static readonly _itemClass = SmrtJob;

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
      orderBy: 'priority DESC, run_at ASC',
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
    const whereConditions: string[] = [
      "status = 'pending'",
      `run_at <= '${now}'`,
    ];

    if (options.queues?.length) {
      const queueList = options.queues.map((q) => `'${q}'`).join(', ');
      whereConditions.push(`queue IN (${queueList})`);
    }

    return this.query(
      `SELECT * FROM _smrt_jobs WHERE ${whereConditions.join(' AND ')} ORDER BY priority DESC, run_at ASC LIMIT ?`,
      [options.limit || 100],
    );
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
    const queueFilter = queue ? `WHERE queue = '${queue}'` : '';

    const result = await this._db.query(
      `SELECT status, COUNT(*) as count FROM _smrt_jobs ${queueFilter} GROUP BY status`,
    );

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

    const result = await this._db.query(query, params);
    return result.rowCount ?? 0;
  }
}

export default SmrtJob;
