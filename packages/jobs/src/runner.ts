// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import { EventEmitter } from 'node:events';
import { fromConfig, type RetryDecision } from '@happyvertical/jobs';
import { createLogger } from '@happyvertical/logger';
import {
  getClassConfigResolvers,
  ObjectRegistry,
  resolveLazyConfig,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { TenantContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { createId } from '@happyvertical/utils';
import {
  JobContextLogger,
  type JobEventInput,
  type JobExecutionContext,
  type JobProgressInput,
} from './logger-extension.js';
import { type SmrtJob, SmrtJobCollection } from './smrt-job.js';
import { type SmrtJobEvent, SmrtJobEventCollection } from './smrt-job-event.js';
import {
  DEFAULT_TASK_HEARTBEAT_INTERVAL_MS,
  getEffectiveStaleJobThresholdMs,
} from './stale-recovery.js';

/**
 * TaskRunner configuration
 */
export interface TaskRunnerConfig {
  /** Worker ID (auto-generated if not provided) */
  id?: string;
  /** Number of concurrent jobs to process */
  concurrency?: number;
  /** Queues to process (default: ['default']) */
  queues?: string[];
  /** Polling interval in milliseconds */
  pollInterval?: number;
  /** Heartbeat interval in milliseconds */
  heartbeatInterval?: number;
  /** Maximum time to wait for jobs to complete on shutdown */
  shutdownTimeout?: number;
  /** Mark running jobs stale after this many milliseconds without a heartbeat */
  staleJobThresholdMs?: number;
}

/**
 * TaskRunner events
 */
export interface TaskRunnerEvents {
  'job:started': (job: SmrtJob) => void;
  'job:event': (job: SmrtJob, event: SmrtJobEvent) => void;
  'job:progress': (job: SmrtJob, event: SmrtJobEvent) => void;
  'job:completed': (job: SmrtJob, result: unknown) => void;
  'job:failed': (job: SmrtJob, error: Error) => void;
  'job:retrying': (job: SmrtJob, error: Error, delay: number) => void;
  'runner:started': () => void;
  'runner:stopped': () => void;
  'runner:error': (error: Error) => void;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<TaskRunnerConfig> = {
  id: '',
  concurrency: 5,
  queues: ['default'],
  pollInterval: 1000,
  heartbeatInterval: DEFAULT_TASK_HEARTBEAT_INTERVAL_MS,
  shutdownTimeout: 30000,
  staleJobThresholdMs: 90000,
};

/**
 * TaskRunner processes SMRT jobs by invoking methods on SmrtObjects
 *
 * Features:
 * - Executes jobs via SmrtObject method invocation
 * - Configurable concurrency and timeout behavior
 * - Automatic retry with configurable strategies
 * - Job context logging for visibility
 * - Embedded mode (in-process) or standalone (CLI)
 */
export class TaskRunner extends EventEmitter {
  readonly id: string;
  private readonly config: Required<TaskRunnerConfig>;
  private collection: SmrtJobCollection | null = null;
  private eventCollection: SmrtJobEventCollection | null = null;
  private running = false;
  private activeJobs = new Map<string, SmrtJob>();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private db: DatabaseInterface | null = null;
  private logger = createLogger(true);

  constructor(config: TaskRunnerConfig = {}) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      id: config.id || `runner_${createId().slice(0, 8)}`,
    };
    this.id = this.config.id;
  }

  /**
   * Initialize the runner with database connection
   */
  async initialize(db: DatabaseInterface): Promise<void> {
    this.db = db;
    this.collection = await SmrtJobCollection.create({ db });
    this.eventCollection = await SmrtJobEventCollection.create({ db });
  }

  /**
   * Start processing jobs
   */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.collection) {
      throw new Error('TaskRunner not initialized. Call initialize() first.');
    }

    this.running = true;

    // Start polling loop
    this.startPolling();

    // Start heartbeat loop
    this.startHeartbeat();

    this.emit('runner:started');
  }

  /**
   * Stop processing jobs (graceful shutdown)
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    if (this.shutdownPromise) return this.shutdownPromise;

    this.running = false;

    // Stop timers
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Wait for active jobs to complete (with timeout)
    this.shutdownPromise = this.waitForActiveJobs();

    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = null;
      this.emit('runner:stopped');
    }
  }

  /**
   * Check if runner is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get count of active jobs
   */
  activeJobCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Start the polling loop
   */
  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;

      try {
        await this.poll();
      } catch (error) {
        this.emit('runner:error', error as Error);
      }

      // Schedule next poll
      if (this.running) {
        this.pollTimer = setTimeout(poll, this.config.pollInterval);
      }
    };

    // Start immediately
    poll();
  }

  /**
   * Poll for and process jobs
   */
  private async poll(): Promise<void> {
    if (!this.collection || !this.db) return;

    await this.recoverStaleJobs();

    // Calculate how many jobs we can take
    const available = this.config.concurrency - this.activeJobs.size;
    if (available <= 0) return;

    // Atomically claim ready jobs before processing so multiple workers cannot
    // receive the same pending row.
    const jobs = await this.collection.claimReady({
      workerId: this.id,
      queues: this.config.queues,
      limit: available,
    });

    for (const job of jobs) {
      const jobId = job.id;
      if (!jobId) continue;

      // Process asynchronously
      this.processJob(job);
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: SmrtJob): Promise<void> {
    const jobId = job.id;
    if (!jobId) {
      this.emit('runner:error', new Error('Job has no ID'));
      return;
    }

    this.activeJobs.set(jobId, job);
    this.emit('job:started', job);
    await this.appendJobEvent(job, {
      type: 'status',
      level: 'info',
      stage: 'started',
      progress: 0,
      message: `Started job: ${job.getDescription()}`,
    });

    try {
      // Set up timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Job timeout after ${job.timeout}ms`));
        }, job.timeout);
      });

      // Execute the job with timeout
      const result = await Promise.race([this.executeJob(job), timeoutPromise]);

      // Job completed successfully
      job.status = 'completed';
      job.completedAt = new Date();
      job.resultPointer = result?.resultPointer ?? null;
      await job.save();

      await this.appendJobEvent(job, {
        type: 'progress',
        level: 'info',
        stage: 'completed',
        progress: 100,
        message: `Completed job: ${job.getDescription()}`,
      });
      this.emit('job:completed', job, result);
    } catch (error) {
      await this.handleJobError(job, error as Error);
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Execute a job by invoking the method on the SmrtObject
   */
  private async executeJob(
    job: SmrtJob,
  ): Promise<{ result?: unknown; resultPointer?: string }> {
    const runJob = async (): Promise<{
      result?: unknown;
      resultPointer?: string;
    }> => {
      // Get the object class from registry
      const registeredClass = ObjectRegistry.getClass(job.objectType);
      if (!registeredClass) {
        throw new Error(`Unknown object type: ${job.objectType}`);
      }

      // Get the constructor from the registry entry
      const ObjectClass = registeredClass.constructor as unknown as new (
        options: Record<string, unknown>,
      ) => SmrtObject;

      // Extract internal keys from args before passing to constructor/method
      const rawArgs = (job.args ?? {}) as Record<string, unknown>;
      const persistedAgentConfig = (rawArgs._agentConfig ?? {}) as Record<
        string,
        unknown
      >;
      const { _agentConfig: _, _scheduleId: __, ...methodArgs } = rawArgs;

      // Resolve any lazy / env-derived config sentinels at execute time so
      // operators can rotate env vars without rewriting persisted schedule
      // rows (issue #1161). Class-level `static configResolvers` are layered
      // on top so live values always win over snapshotted ones.
      //
      // `onError: 'throw'` so a misconfigured deployment fails fast at the
      // job boundary with a clear "unknown resolver X" error, rather than
      // silently spreading a `{ $env: '...' }` sentinel object into the
      // agent constructor (where it would surface much later as a confusing
      // downstream failure — e.g. `[object Object]` masquerading as a
      // bucket name).
      const classResolvers = getClassConfigResolvers(ObjectClass);
      const agentConfig = await resolveLazyConfig(persistedAgentConfig, {
        classResolvers,
        onError: 'throw',
      });

      // Create or load the object instance
      let instance: SmrtObject;

      if (job.objectId) {
        // Load existing object
        instance = new ObjectClass({ db: this.db, ...agentConfig });
        await instance.initialize();
        await (
          instance as SmrtObject & { loadFromId(id: string): Promise<void> }
        ).loadFromId(job.objectId);
      } else {
        // Create new instance for static-like methods
        instance = new ObjectClass({ db: this.db, ...agentConfig });
        await instance.initialize();
      }

      const jobId = job.id;
      if (!jobId) {
        throw new Error('Job has no ID');
      }

      // Create a base logger for job context
      const baseLogger = createLogger(true);

      // Inject job context logger
      const contextLogger = new JobContextLogger(baseLogger, {
        jobId,
        attempt: job.attempts,
        queue: job.queue,
        objectType: job.objectType,
        method: job.method,
      });

      // Log job start
      contextLogger.info(`Starting job: ${job.getDescription()}`);
      const executionContext = this.createExecutionContext(job, contextLogger);

      // Invoke the method with cleaned args (no internal keys)
      const method = (
        instance as unknown as Record<
          string,
          (
            args: unknown,
            context?: JobExecutionContext,
          ) => Promise<unknown> | unknown
        >
      )[job.method];
      if (typeof method !== 'function') {
        throw new Error(`Method not found: ${job.objectType}.${job.method}`);
      }

      const result = await method.call(instance, methodArgs, executionContext);

      return { result };
    };

    if (job.tenantId) {
      return TenantContext.runWithJobContext(
        { tenantId: job.tenantId },
        runJob,
      );
    }

    return runJob();
  }

  /**
   * Handle job execution error
   */
  private async handleJobError(job: SmrtJob, error: Error): Promise<void> {
    const strategy = fromConfig(job.retryStrategy);
    const decision: RetryDecision = strategy.shouldRetry(job.attempts, error);

    if (decision.shouldRetry && job.attempts < job.maxAttempts) {
      // Schedule retry
      const nextRunAt = new Date(Date.now() + decision.delay);

      job.status = 'pending';
      job.lastError = error.message;
      job.runAt = nextRunAt;
      job.workerId = null;
      job.workerHeartbeat = null;
      await job.save();

      await this.appendJobEvent(job, {
        type: 'status',
        level: 'warn',
        stage: 'retrying',
        message: `Retrying job after failure: ${error.message}`,
        data: { delay: decision.delay, attempts: job.attempts },
      });
      this.emit('job:retrying', job, error, decision.delay);
    } else {
      // Job failed permanently
      job.status = 'failed';
      job.completedAt = new Date();
      job.lastError = error.message;
      await job.save();

      await this.appendJobEvent(job, {
        type: 'error',
        level: 'error',
        stage: 'failed',
        message: error.message,
        data: { attempts: job.attempts },
      });
      this.emit('job:failed', job, error);
    }
  }

  private createExecutionContext(
    job: SmrtJob,
    contextLogger: JobContextLogger,
  ): JobExecutionContext {
    const jobContext = {
      jobId: job.id ?? '',
      tenantId: job.tenantId ?? null,
      attempt: job.attempts,
      queue: job.queue,
      objectType: job.objectType,
      method: job.method,
    };

    return {
      job: jobContext,
      logger: contextLogger,
      event: async (input: JobEventInput) => {
        await this.appendJobEvent(job, input);
      },
      progress: async (input: JobProgressInput) => {
        const data = {
          ...(input.data ?? {}),
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.source ? { source: input.source } : {}),
        };
        await this.appendJobEvent(job, {
          type: 'progress',
          level: 'info',
          stage: input.stage,
          progress: input.progress,
          message:
            input.message ??
            input.detail ??
            `${input.stage} ${Math.round(input.progress)}%`,
          data,
        });
      },
      log: async (
        level: 'debug' | 'info' | 'warn' | 'error',
        message: string,
        data?: Record<string, unknown>,
      ) => {
        contextLogger[level](message, data);
        await this.appendJobEvent(job, {
          type: level === 'error' ? 'error' : 'log',
          level,
          message,
          data,
        });
      },
    };
  }

  private async appendJobEvent(
    job: SmrtJob,
    input: JobEventInput,
  ): Promise<SmrtJobEvent | null> {
    if (!this.eventCollection || !job.id) {
      return null;
    }

    try {
      const event = await this.eventCollection.append({
        tenantId: job.tenantId ?? null,
        jobId: job.id,
        type: input.type ?? 'log',
        level: input.level ?? 'info',
        stage: input.stage ?? null,
        progress: input.progress ?? null,
        message: input.message ?? '',
        data: input.data ?? {},
      });

      this.emit('job:event', job, event);
      if (event.type === 'progress') {
        this.emit('job:progress', job, event);
      }

      return event;
    } catch (error) {
      const telemetryError =
        error instanceof Error
          ? error
          : new Error(`Failed to append job telemetry: ${String(error)}`);

      try {
        this.emit('runner:error', telemetryError);
      } catch {
        // Telemetry is best-effort and must not change job outcomes.
      }

      return null;
    }
  }

  /**
   * Recover jobs abandoned by dead workers.
   *
   * Jobs should heartbeat every {@link TaskRunnerConfig.heartbeatInterval}. If
   * a running job stops heartbeating beyond the stale threshold, we fail it so
   * other schedulers and operators are not left with permanently stuck work.
   * The effective threshold is never allowed to fall below three heartbeat
   * intervals, which avoids marking healthy slow-heartbeat workers stale.
   */
  private async recoverStaleJobs(): Promise<void> {
    if (!this.db || !this.collection) return;

    const effectiveStaleThresholdMs = getEffectiveStaleJobThresholdMs(
      this.config.staleJobThresholdMs,
      this.config.heartbeatInterval,
    );
    const cutoff = new Date(
      Date.now() - effectiveStaleThresholdMs,
    ).toISOString();
    const staleJobs = await this.collection.query(
      `SELECT *
         FROM _smrt_jobs
        WHERE status = 'running'
          AND (
            (worker_heartbeat IS NOT NULL AND worker_heartbeat < ?)
            OR (worker_heartbeat IS NULL AND started_at IS NOT NULL AND started_at < ?)
          )`,
      [cutoff, cutoff],
    );
    if (staleJobs.length === 0) return;

    const staleJobIds = staleJobs
      .map((job) => job.id)
      .filter((jobId): jobId is string => typeof jobId === 'string');
    if (staleJobIds.length === 0) return;

    const placeholders = staleJobIds.map(() => '?').join(', ');
    const recoveredAt = new Date();
    const errorMessage =
      `Recovered stale running job after ${effectiveStaleThresholdMs}ms without a heartbeat. ` +
      `Long synchronous work can block heartbeats; prefer async subprocess APIs or raise the stale threshold for intentionally long jobs.`;

    await this.db.query(
      `UPDATE _smrt_jobs
          SET status = 'failed',
              completed_at = ?,
              last_error = ?,
              worker_id = NULL,
              worker_heartbeat = NULL
        WHERE status = 'running'
          AND id IN (${placeholders})`,
      recoveredAt.toISOString(),
      errorMessage,
      ...staleJobIds,
    );

    for (const job of staleJobs) {
      job.status = 'failed';
      job.completedAt = recoveredAt;
      job.lastError = errorMessage;
      job.workerId = null;
      job.workerHeartbeat = null;
      const error = new Error(errorMessage);
      await this.appendJobEvent(job, {
        type: 'error',
        level: 'error',
        stage: 'stale-recovery',
        message: errorMessage,
      });
      this.emit('job:failed', job, error);
    }
  }

  /**
   * Start heartbeat loop to keep jobs alive
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      for (const [, job] of this.activeJobs) {
        try {
          job.workerHeartbeat = new Date();
          await job.save();
        } catch {
          // Ignore heartbeat errors
        }
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Wait for active jobs to complete with timeout
   */
  private async waitForActiveJobs(): Promise<void> {
    if (this.activeJobs.size === 0) return;

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.activeJobs.size === 0) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);

      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        this.logger.warn(
          `Shutdown timeout: ${this.activeJobs.size} jobs still active`,
        );
        resolve();
      }, this.config.shutdownTimeout);
    });
  }
}

/**
 * Create a TaskRunner instance
 */
export function createTaskRunner(config?: TaskRunnerConfig): TaskRunner {
  return new TaskRunner(config);
}

export default TaskRunner;
