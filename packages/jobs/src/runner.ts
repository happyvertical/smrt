import { EventEmitter } from 'node:events';
import { fromConfig, type RetryDecision } from '@happyvertical/jobs';
import { createLogger } from '@happyvertical/logger';
import { ObjectRegistry, type SmrtObject } from '@happyvertical/smrt-core';
import { TenantContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { createId } from '@happyvertical/utils';
import { JobContextLogger } from './logger-extension.js';
import { type SmrtJob, SmrtJobCollection } from './smrt-job.js';

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
  heartbeatInterval: 30000,
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
  private running = false;
  private activeJobs = new Map<string, SmrtJob>();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private db: DatabaseInterface | null = null;

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
    this.collection = await SmrtJobCollection.create({
      db: { type: 'sqlite', url: ':memory:' }, // Placeholder, overridden
    });
    // Override the internal db reference
    (this.collection as unknown as { _db: DatabaseInterface })._db = db;
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

    // Find ready jobs
    const jobs = await this.collection.listReady({
      queues: this.config.queues,
      limit: available,
    });

    // Claim and process each job
    for (const job of jobs) {
      const jobId = job.id;
      if (!jobId) continue;

      // Claim the job
      job.status = 'running';
      job.workerId = this.id;
      job.workerHeartbeat = new Date();
      job.startedAt = new Date();
      job.attempts += 1;
      await job.save();

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
      const agentConfig = (rawArgs._agentConfig ?? {}) as Record<
        string,
        unknown
      >;
      const { _agentConfig: _, _scheduleId: __, ...methodArgs } = rawArgs;

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

      // Invoke the method with cleaned args (no internal keys)
      const method = (
        instance as unknown as Record<
          string,
          (args: unknown) => Promise<unknown>
        >
      )[job.method];
      if (typeof method !== 'function') {
        throw new Error(`Method not found: ${job.objectType}.${job.method}`);
      }

      const result = await method.call(instance, methodArgs);

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

      this.emit('job:retrying', job, error, decision.delay);
    } else {
      // Job failed permanently
      job.status = 'failed';
      job.completedAt = new Date();
      job.lastError = error.message;
      await job.save();

      this.emit('job:failed', job, error);
    }
  }

  /**
   * Recover jobs abandoned by dead workers.
   *
   * Jobs should heartbeat every {@link TaskRunnerConfig.heartbeatInterval}. If
   * a running job stops heartbeating beyond the stale threshold, we fail it so
   * other schedulers and operators are not left with permanently stuck work.
   */
  private async recoverStaleJobs(): Promise<void> {
    if (!this.db || !this.collection) return;

    const cutoff = new Date(
      Date.now() - this.config.staleJobThresholdMs,
    ).toISOString();
    const staleJobs = await this.db.query(
      `SELECT id
         FROM _smrt_jobs
        WHERE status = 'running'
          AND (
            (worker_heartbeat IS NOT NULL AND worker_heartbeat < ?)
            OR (worker_heartbeat IS NULL AND started_at IS NOT NULL AND started_at < ?)
          )`,
      cutoff,
      cutoff,
    );

    for (const row of staleJobs.rows as Array<{ id: string }>) {
      const job = await this.collection.get({ id: row.id });
      if (!job || job.status !== 'running') continue;

      const error = new Error(
        `Recovered stale running job after ${this.config.staleJobThresholdMs}ms without a heartbeat`,
      );

      job.status = 'failed';
      job.completedAt = new Date();
      job.lastError = error.message;
      job.workerId = null;
      job.workerHeartbeat = null;
      await job.save();

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
        console.warn(
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
