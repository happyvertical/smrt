import {
  exponential,
  type RetryStrategy,
  type RetryStrategyConfig,
} from '@happyvertical/jobs';
import { clampRetries, DEFAULT_TENANT_JOB_CAP } from './background-policy.js';
import { JobHandle } from './job-handle.js';
import type { SmrtJobCollection, TimeoutBehavior } from './smrt-job.js';

/**
 * Priority levels for jobs
 */
export type Priority = 'critical' | 'high' | 'normal' | 'low' | number;

/**
 * Convert priority to numeric value
 */
export function priorityToNumber(priority: Priority): number {
  if (typeof priority === 'number') return priority;
  switch (priority) {
    case 'critical':
      return 100;
    case 'high':
      return 75;
    case 'normal':
      return 50;
    case 'low':
      return 25;
    default:
      return 50;
  }
}

/**
 * Parse delay string to milliseconds
 */
export function parseDelay(delay: string | number): number {
  if (typeof delay === 'number') return delay;

  const match = delay.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`Invalid delay format: ${delay}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2] || 'ms';

  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return value;
  }
}

/**
 * Fluent builder for creating background jobs
 *
 * Example:
 * ```typescript
 * const handle = await doc.background('generateSummary', { format: 'md' })
 *   .delay('5m')
 *   .retries(5)
 *   .priority('high')
 *   .queue('summaries')
 *   .timeout(300000)
 *   .enqueue();
 * ```
 */
export class JobBuilder<T = unknown> {
  private _queue: string = 'default';
  private _delay: number = 0;
  private _retries: number = 3;
  private _priority: number = 50;
  private _timeout: number = 300000;
  private _timeoutBehavior: TimeoutBehavior = 'fail';
  private _retryStrategy: RetryStrategy = exponential();
  private _tenantJobCap: number = DEFAULT_TENANT_JOB_CAP;

  constructor(
    private readonly objectType: string,
    private readonly objectId: string | null,
    private readonly method: string,
    private readonly args: Record<string, unknown>,
    private readonly collection: SmrtJobCollection,
  ) {}

  /**
   * Set the queue name
   */
  queue(name: string): this {
    this._queue = name;
    return this;
  }

  /**
   * Set a delay before the job runs
   * @param delay - Delay as milliseconds or string like '5m', '1h', '30s'
   */
  delay(delay: string | number): this {
    this._delay = parseDelay(delay);
    return this;
  }

  /**
   * Set when the job should run
   */
  runAt(date: Date): this {
    this._delay = date.getTime() - Date.now();
    return this;
  }

  /**
   * Set the maximum number of retry attempts.
   *
   * Clamped to {@link MAX_JOB_RETRIES} so a misconfigured caller cannot pin a
   * worker on a poison job indefinitely (S5 audit #1402).
   */
  retries(count: number): this {
    this._retries = clampRetries(count);
    return this;
  }

  /**
   * Set the retry strategy
   */
  retryStrategy(strategy: RetryStrategy): this {
    this._retryStrategy = strategy;
    return this;
  }

  /**
   * Set the job priority
   */
  priority(level: Priority): this {
    this._priority = priorityToNumber(level);
    return this;
  }

  /**
   * Set the job timeout in milliseconds
   */
  timeout(ms: number): this {
    this._timeout = ms;
    return this;
  }

  /**
   * Set what happens when the job times out
   */
  timeoutBehavior(behavior: TimeoutBehavior): this {
    this._timeoutBehavior = behavior;
    return this;
  }

  /**
   * Override the per-tenant in-flight job cap for this enqueue.
   *
   * Defaults to {@link DEFAULT_TENANT_JOB_CAP}. Pass `0` (or a negative value)
   * to disable the cap for trusted internal callers (S5 audit #1402).
   */
  tenantJobCap(max: number): this {
    this._tenantJobCap = max;
    return this;
  }

  /**
   * Enqueue the job and return a handle
   */
  async enqueue(): Promise<JobHandle<T>> {
    const runAt = new Date(Date.now() + this._delay);

    const retryConfig: RetryStrategyConfig =
      'toConfig' in this._retryStrategy
        ? this._retryStrategy.toConfig()
        : (this._retryStrategy as RetryStrategyConfig);

    // Route through the collection's single creation path so the per-tenant
    // in-flight cap and the retry ceiling are enforced in one place, shared with
    // the ScheduleRunner (S5 audit #1402). The cap applies to the ambient tenant
    // (resolved inside enqueueJob); global (no-context) jobs are exempt.
    const job = await this.collection.enqueueJob(
      {
        queue: this._queue,
        objectType: this.objectType,
        objectId: this.objectId,
        method: this.method,
        args: this.args,
        runAt,
        priority: this._priority,
        maxAttempts: this._retries,
        timeout: this._timeout,
        timeoutBehavior: this._timeoutBehavior,
        retryStrategy: retryConfig,
      },
      { tenantJobCap: this._tenantJobCap },
    );

    const jobId = job.id;
    if (!jobId) {
      throw new Error('Job was created but has no ID');
    }

    return new JobHandle<T>(jobId, this.collection);
  }
}

export default JobBuilder;
