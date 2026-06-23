// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
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
import { isBackgroundEligibleMethod } from './background-policy.js';
import { redactErrorForPersistence } from './error-redaction.js';
import {
  JobContextLogger,
  type JobEventInput,
  type JobExecutionContext,
  type JobProgressInput,
} from './logger-extension.js';
import { type SmrtJob, SmrtJobCollection } from './smrt-job.js';
import { type SmrtJobEvent, SmrtJobEventCollection } from './smrt-job-event.js';
import { SmrtWorkerCollection } from './smrt-worker.js';
import {
  DEFAULT_LEASE_TICK_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_TASK_HEARTBEAT_INTERVAL_MS,
  getEffectiveLeaseTtlMs,
} from './stale-recovery.js';
import {
  createWorkerKey,
  isWorkerAlive,
  offLoopEligible,
  registerLiveWorker,
  resolveEngine,
  resolveUrl,
  tuneSqliteForConcurrency,
  unregisterLiveWorker,
} from './worker-liveness.js';

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
  /**
   * @deprecated No longer used. Recovery keys on worker liveness, not per-job
   * heartbeat staleness (#1474). Use {@link leaseTtlMs} / {@link leaseTickMs}.
   */
  staleJobThresholdMs?: number;
  /** Worker liveness lease time-to-live in milliseconds */
  leaseTtlMs?: number;
  /** How often to renew the worker liveness lease, in milliseconds */
  leaseTickMs?: number;
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
 * Max time to wait for the liveness thread to report ready before giving up and
 * falling back to main-loop renewal (guards against a hung connect in-thread).
 */
const LIVENESS_THREAD_START_TIMEOUT_MS = 10000;

/**
 * Raised when a job exceeds its timeout under `timeoutBehavior` `'fail'`/`'kill'`.
 *
 * Distinguished from an ordinary handler error so the failure path can choose
 * NOT to auto-retry: the original handler keeps running after a timeout (JS
 * can't preempt it), so re-queueing the row as `pending` while the original
 * still executes guarantees concurrent duplicate execution (see #2 in the
 * #1401 review). A timed-out job is therefore failed terminally rather than
 * retried, shrinking — though, given the at-least-once contract, not fully
 * eliminating — the overlap window.
 */
export class JobTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobTimeoutError';
  }
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
  leaseTtlMs: DEFAULT_LEASE_TTL_MS,
  leaseTickMs: DEFAULT_LEASE_TICK_MS,
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
  /**
   * Per-incarnation-unique worker key. Stored as the `worker_id` on claimed
   * jobs and in `_smrt_workers`, so a restart of a runner sharing the same
   * configured `id` does not look like it still owns the previous
   * incarnation's orphaned jobs. The human-facing {@link id} stays stable for
   * events/logs.
   */
  private readonly workerKey: string;
  private readonly config: Required<TaskRunnerConfig>;
  private readonly effectiveLeaseTtlMs: number;
  private collection: SmrtJobCollection | null = null;
  private eventCollection: SmrtJobEventCollection | null = null;
  private workerCollection: SmrtWorkerCollection | null = null;
  private workersTableVerified = false;
  private lastRecoverySweepAt = 0;
  private running = false;
  private activeJobs = new Map<string, SmrtJob>();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private livenessWorker: Worker | null = null;
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
    this.workerKey = createWorkerKey(this.id);
    this.effectiveLeaseTtlMs = getEffectiveLeaseTtlMs(
      this.config.leaseTtlMs,
      this.config.leaseTickMs,
    );
  }

  /**
   * Initialize the runner with database connection
   */
  async initialize(db: DatabaseInterface): Promise<void> {
    this.db = db;
    this.collection = await SmrtJobCollection.create({ db });
    this.eventCollection = await SmrtJobEventCollection.create({ db });
    this.workerCollection = await SmrtWorkerCollection.create({ db });
  }

  /**
   * Start processing jobs
   */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.collection || !this.workerCollection) {
      throw new Error('TaskRunner not initialized. Call initialize() first.');
    }

    // Fail fast if the job-system tables were never migrated, with an
    // actionable error rather than a confusing recovery failure later.
    await this.workerCollection.assertReady();

    // On SQLite, the runner's writes will race the off-loop ticker's writes to
    // the same file; enable WAL + a busy timeout up front so neither loses a
    // lock race under load (#1474 flake). Best-effort, file-level.
    if (this.db && resolveEngine(this.db) === 'sqlite') {
      await tuneSqliteForConcurrency(this.db);
    }

    // Register this worker incarnation with a seeded lease BEFORE polling, so
    // the first claimReady() cannot leave just-claimed jobs looking orphaned to
    // a concurrent recoverer.
    await this.workerCollection.registerWorker({
      workerKey: this.workerKey,
      pid: typeof process !== 'undefined' ? process.pid : null,
      hostname:
        typeof process !== 'undefined' ? (process.env.HOSTNAME ?? null) : null,
      leaseTtlMs: this.effectiveLeaseTtlMs,
    });
    registerLiveWorker(this.workerKey);

    this.running = true;

    // Renew the worker lease. Prefer an off-loop worker thread so a CPU-bound
    // synchronous handler can never starve renewal (#1474); fall back to
    // main-loop renewal for engines a second connection can't reach
    // (in-memory SQLite, DuckDB) or if the thread fails to start.
    if (offLoopEligible(this.db as DatabaseInterface)) {
      const threadStarted = await this.startLivenessThread();
      if (!threadStarted) this.startLeaseRenewal();
    } else {
      this.startLeaseRenewal();
    }

    // Start polling loop
    this.startPolling();

    // Start heartbeat loop (per-job telemetry only; no longer gates recovery)
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

    // Stop polling and the telemetry heartbeat immediately; no new jobs claim.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // NOTE: leave lease renewal (the leaseTimer or the off-loop thread) running
    // through the drain so a still-executing handler keeps its lease fresh and
    // isn't recovered by a peer; both are torn down after the drain below.

    // Wait for active jobs to complete (with timeout)
    this.shutdownPromise = this.waitForActiveJobs();

    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = null;
      // Stop off-loop lease renewal (thread) and main-loop renewal (timer) only
      // AFTER the drain, so a still-running handler kept its lease fresh.
      await this.stopLivenessThread();
      if (this.leaseTimer) {
        clearInterval(this.leaseTimer);
        this.leaseTimer = null;
      }
      // Release liveness only AFTER the drain: doing it earlier would make
      // still-draining jobs look orphaned to other recoverers.
      unregisterLiveWorker(this.workerKey);
      // Only delete the lease row if the drain finished cleanly. If jobs are
      // still executing past the shutdown timeout, leave the row to lapse
      // naturally (≤ TTL) so a nearly-finished handler keeps its chance to land
      // its own completion before peers can recover it.
      if (this.activeJobs.size === 0) {
        try {
          await this.workerCollection?.expireWorker(this.workerKey);
        } catch {
          // Best-effort: a left-over row simply expires via its lease.
        }
      }
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
      workerId: this.workerKey,
      queues: this.config.queues,
      limit: available,
    });

    for (const job of jobs) {
      const jobId = job.id;
      if (!jobId) continue;

      // Process asynchronously. We deliberately do NOT await — concurrency is
      // bounded by `activeJobs` above, not by serializing here. But a bare
      // fire-and-forget call means any unexpected rejection (e.g. the failure-
      // path write in handleJobError rejecting, a failure mode correlated with
      // whatever is already failing the job) escapes as an unhandled promise
      // rejection and crashes the worker under Node's default
      // `--unhandled-rejections=throw`. handleJobError is itself wrapped in
      // try/catch, but guard the caller too as defense in depth so no rejection
      // can ever escape the poll loop.
      this.processJob(job).catch((error) => {
        this.emit('runner:error', error as Error);
      });
    }
  }

  /**
   * Process a single job.
   *
   * AT-LEAST-ONCE EXECUTION CONTRACT: a `timeout` only races the handler's
   * promise — JavaScript cannot preempt an already-running handler, so on a
   * `'fail'` (or `'kill'`) timeout the original handler keeps executing in the
   * background while the job row is failed. Timeouts are NOT auto-retried (see
   * handleJobError) precisely so a still-running handler is not duplicated by a
   * retry; but the orphaned handler's own side effects still happen, and an
   * ordinary (non-timeout) failure IS retried and re-claimable by any worker.
   * Handlers invoked from a job MUST be idempotent (e.g. keyed by
   * `context.job.jobId` or a caller-supplied idempotency key); do not rely on a
   * job body running exactly once. See AGENTS.md "Timeouts & at-least-once".
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

    // Capture the timeout handle so it is always cleared in `finally`. Without
    // this, every fast job left a ~5-min (default) armed timer on the heap
    // until it fired and was swallowed by the settled race — timer-heap
    // pressure plus a delayed clean process exit.
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      const result = await this.runWithTimeout(job, (handle) => {
        timeoutHandle = handle;
      });

      // Job completed successfully. Write the terminal state conditionally so a
      // recovered/reclaimed row (worker died, recovery ran, the work finished
      // anyway) is never stomped back to 'completed'.
      const completedAt = new Date();
      const applied = await this.writeOwnedJob(jobId, {
        status: 'completed',
        completed_at: completedAt.toISOString(),
        result_pointer: result?.resultPointer ?? null,
        updated_at: completedAt.toISOString(),
      });

      if (applied) {
        job.status = 'completed';
        job.completedAt = completedAt;
        job.resultPointer = result?.resultPointer ?? null;
        await this.appendJobEvent(job, {
          type: 'progress',
          level: 'info',
          stage: 'completed',
          progress: 100,
          message: `Completed job: ${job.getDescription()}`,
        });
        this.emit('job:completed', job, result);
      }
    } catch (error) {
      // handleJobError is wrapped so its own failure-path write (a `db.query`
      // that may reject for the same reason the job is failing) cannot turn
      // into an unhandled rejection / unbounded crash. A failure to persist the
      // failure is surfaced as a runner error, not a thrown rejection.
      try {
        await this.handleJobError(job, error as Error);
      } catch (handlerError) {
        this.emit('runner:error', handlerError as Error);
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Execute a job honoring its {@link SmrtJob.timeoutBehavior}.
   *
   * - `'fail'` (default) and `'kill'`: race the handler against a timeout. On
   *   timeout the race rejects and the caller fails/retries the job.
   *   `'kill'` cannot actually preempt the handler in-process (JavaScript has
   *   no thread interruption), so it is treated identically to `'fail'` — the
   *   handler keeps running in the background; only the job row is failed. This
   *   is documented in AGENTS.md so `'kill'` is honest about what it does
   *   rather than silently behaving like a no-op.
   * - `'warn'`: do NOT fail on timeout. Arm a one-shot warning (logged + emitted
   *   as a job event) at the deadline, but await the handler to completion so a
   *   slow-but-successful handler still completes. This makes `'warn'` honest:
   *   previously every timeout was treated as `'fail'` regardless of the
   *   persisted/UI-shown behavior.
   */
  private async runWithTimeout(
    job: SmrtJob,
    captureHandle: (handle: NodeJS.Timeout) => void,
  ): Promise<{ result?: unknown; resultPointer?: string }> {
    if (job.timeoutBehavior === 'warn') {
      const handle = setTimeout(() => {
        this.logger.warn(
          `Job exceeded timeout (${job.timeout}ms) but timeoutBehavior='warn'; letting it finish: ${job.getDescription()}`,
        );
        // Best-effort telemetry; must not change the job outcome.
        void this.appendJobEvent(job, {
          type: 'status',
          level: 'warn',
          stage: 'timeout-warning',
          message: `Job exceeded timeout of ${job.timeout}ms (timeoutBehavior='warn')`,
          data: { timeout: job.timeout },
        });
      }, job.timeout);
      captureHandle(handle);
      return this.executeJob(job);
    }

    // 'fail' (default) and 'kill' (treated as 'fail'; see doc comment).
    const timeoutPromise = new Promise<never>((_, reject) => {
      const handle = setTimeout(() => {
        reject(new JobTimeoutError(`Job timeout after ${job.timeout}ms`));
      }, job.timeout);
      captureHandle(handle);
    });

    return Promise.race([this.executeJob(job), timeoutPromise]);
  }

  /**
   * Apply a terminal/retry state transition to a job only if this worker still
   * owns it and it is still `running`. Returns whether the write applied.
   *
   * This closes the completion-vs-recovery race: if recovery already failed a
   * job out from under a finishing handler (a genuine zombie), the handler's
   * outcome is dropped rather than resurrecting the row.
   */
  private async writeOwnedJob(
    jobId: string,
    assignments: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.db) return false;
    const columns = Object.keys(assignments);
    const setSql = columns.map((column) => `${column} = ?`).join(', ');
    const values = columns.map((column) => assignments[column]);
    // RETURNING id (not rowCount): the DuckDB/JSON adapters report rowCount as
    // the number of result rows, so an UPDATE that matched nothing still
    // reports 1 — only the returned-row set is a reliable "did it apply".
    const result = await this.db.query(
      `UPDATE _smrt_jobs
          SET ${setSql}
        WHERE id = ? AND worker_id = ? AND status = 'running'
        RETURNING id`,
      ...values,
      jobId,
      this.workerKey,
    );
    return (result.rows?.length ?? 0) > 0;
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

      // Opt-in allowlist: if the target class declares background-eligible
      // methods, refuse to invoke anything outside that set. Dispatch is already
      // bounded to existing prototype methods (no eval/dynamic import), but a
      // class can narrow the reachable surface to an explicit contract
      // (S5 audit #1402). Classes that don't opt in keep current behaviour.
      if (!isBackgroundEligibleMethod(ObjectClass, job.method)) {
        throw new Error(
          `Method not background-eligible: ${job.objectType}.${job.method}`,
        );
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

    const jobId = job.id;
    if (!jobId) return;

    // A timed-out handler keeps running in the background (JS can't preempt it).
    // Re-queueing the row as `pending` while the original still executes would
    // make the next worker run a *second* concurrent copy. So do not auto-retry
    // a timeout — fail it terminally. This narrows the duplicate-execution
    // window from the at-least-once contract (#2 in the #1401 review); it does
    // not remove it (the orphaned handler can still finish and write a terminal
    // state, which writeOwnedJob's ownership guard then drops).
    const isTimeout = error instanceof JobTimeoutError;

    // `last_error` is persisted to the durable `_smrt_jobs` row and is readable
    // through generated (tenant-scoped) list/get routes. Strip secret-shaped
    // substrings before persistence so a failing job that echoes a credential
    // in its message does not turn into a durable leak (S5 audit #1402).
    // Use the throwable-tolerant wrapper: `error` is typed `Error` but reaches
    // here via an `as Error` cast at the call site, so a non-Error throwable
    // (no `.message`) would otherwise persist an empty `last_error`.
    const safeMessage = redactErrorForPersistence(error);

    if (!isTimeout && decision.shouldRetry && job.attempts < job.maxAttempts) {
      // Schedule retry
      const nextRunAt = new Date(Date.now() + decision.delay);

      // Conditional: don't resurrect a row that recovery already failed.
      const applied = await this.writeOwnedJob(jobId, {
        status: 'pending',
        last_error: safeMessage,
        run_at: nextRunAt.toISOString(),
        worker_id: null,
        worker_heartbeat: null,
        updated_at: new Date().toISOString(),
      });
      if (!applied) return;

      job.status = 'pending';
      job.lastError = safeMessage;
      job.runAt = nextRunAt;
      job.workerId = null;
      job.workerHeartbeat = null;

      await this.appendJobEvent(job, {
        type: 'status',
        level: 'warn',
        stage: 'retrying',
        message: `Retrying job after failure: ${safeMessage}`,
        data: { delay: decision.delay, attempts: job.attempts },
      });
      this.emit('job:retrying', job, error, decision.delay);
    } else {
      // Job failed permanently
      const completedAt = new Date();
      const applied = await this.writeOwnedJob(jobId, {
        status: 'failed',
        completed_at: completedAt.toISOString(),
        last_error: safeMessage,
        updated_at: completedAt.toISOString(),
      });
      if (!applied) return;

      job.status = 'failed';
      job.completedAt = completedAt;
      job.lastError = safeMessage;

      await this.appendJobEvent(job, {
        type: 'error',
        level: 'error',
        stage: 'failed',
        message: safeMessage,
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
   * Whether the `_smrt_workers` table exists. Cached once positive — the table
   * never disappears mid-run, so this avoids a probe query on every poll.
   */
  private async workersTableReady(): Promise<boolean> {
    if (this.workersTableVerified) return true;
    const ready = (await this.workerCollection?.tableReady()) ?? false;
    if (ready) this.workersTableVerified = true;
    return ready;
  }

  /**
   * Recover jobs orphaned by dead/restarted workers.
   *
   * A `running` job is recovered only when its owning worker is *not alive*
   * (issue #1474): not live in this process and holding no fresh lease in
   * `_smrt_workers`. This is independent of the handler event loop, so a worker
   * whose handler holds the loop synchronously keeps a fresh lease (renewed off
   * the loop by the liveness thread) or stays in this process's live set, and is
   * never false-recovered. The live set takes precedence over a stale lease, and
   * a runner never recovers its own active jobs.
   *
   * Recovery is swept at most once per lease tick (not every poll), since
   * detection is TTL-bound anyway — this bounds the per-poll database load.
   */
  private async recoverStaleJobs(): Promise<void> {
    if (!this.db || !this.collection || !this.workerCollection) return;

    // Without the workers table we cannot reason about liveness; skip rather
    // than treat every worker as unknown and mass-recover live jobs.
    if (!(await this.workersTableReady())) return;

    // Throttle: at most one sweep per lease tick. Detection latency is bounded
    // by the lease TTL (>= 3x tick), so a faster cadence only adds DB load.
    const now = Date.now();
    if (now - this.lastRecoverySweepAt < this.config.leaseTickMs) return;
    this.lastRecoverySweepAt = now;

    // Drop long-dead worker rows so the table stays small, regardless of
    // whether any orphan is found this sweep.
    try {
      await this.workerCollection.pruneExpired(this.effectiveLeaseTtlMs * 10);
    } catch {
      // Pruning is best-effort and must not affect recovery outcomes.
    }

    const freshLeaseKeys = await this.workerCollection.freshLeaseWorkerKeys();
    // Worker-internal cross-tenant recovery scan; SmrtJob is @TenantScoped
    // (S5 #1402) so this raw read needs an explicit opt-in.
    const running = await this.collection.query(
      `SELECT * FROM _smrt_jobs WHERE status = 'running'`,
      [],
      { allowRawOnTenantScoped: true },
    );
    if (running.length === 0) return;

    // A job is orphaned iff its owning worker is not alive: not live in this
    // process AND no fresh database lease. The live set takes precedence over a
    // stale lease (a worker whose lease lapsed while its loop was blocked is
    // still alive here); a runner also never recovers its own active jobs.
    const orphans = running.filter((job) => {
      const jobId = job.id;
      if (jobId && this.activeJobs.has(jobId)) return false;
      return !isWorkerAlive(job.workerId, freshLeaseKeys);
    });
    if (orphans.length === 0) return;

    const orphanIds = orphans
      .map((job) => job.id)
      .filter((jobId): jobId is string => typeof jobId === 'string');
    if (orphanIds.length === 0) return;

    const placeholders = orphanIds.map(() => '?').join(', ');
    const recoveredAt = new Date();
    const errorMessage =
      'Recovered orphaned running job: its owning worker is no longer alive ' +
      '(no fresh liveness lease in _smrt_workers and not running in this process).';

    // RETURNING id so we only emit failures for jobs this pass actually
    // transitioned — a concurrent recoverer or a late completion may have
    // already moved some of the candidates out of 'running'.
    const updated = await this.db.query(
      `UPDATE _smrt_jobs
          SET status = 'failed',
              completed_at = ?,
              last_error = ?,
              worker_id = NULL,
              worker_heartbeat = NULL
        WHERE status = 'running'
          AND id IN (${placeholders})
        RETURNING id`,
      recoveredAt.toISOString(),
      errorMessage,
      ...orphanIds,
    );
    const recoveredIds = new Set(
      (updated.rows as Array<{ id?: unknown }>)
        .map((row) => row.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    if (recoveredIds.size === 0) return;

    for (const job of orphans) {
      if (!job.id || !recoveredIds.has(job.id)) continue;
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
   * Renew this worker's liveness lease.
   *
   * In Stage 1 this runs on the main event loop, so it provides cross-process
   * detection no weaker than the old per-job heartbeat. Stage 2 moves the
   * renewal to an off-loop worker thread so a synchronous handler can no longer
   * starve it. Same-process correctness never depends on this timer — the
   * in-memory live set covers it.
   */
  private startLeaseRenewal(): void {
    this.leaseTimer = setInterval(async () => {
      try {
        await this.workerCollection?.renewLease(
          this.workerKey,
          this.effectiveLeaseTtlMs,
        );
      } catch {
        // Ignore transient lease-renewal errors; the next tick retries.
      }
    }, this.config.leaseTickMs);
  }

  /**
   * Spawn the off-loop liveness thread. It opens its own connection and renews
   * this worker's lease on its own thread (unstarvable by handler CPU). Returns
   * false if the thread can't be resolved or fails to start, so the caller can
   * fall back to main-loop renewal.
   */
  private async startLivenessThread(): Promise<boolean> {
    if (!this.db) return false;
    let entry: string;
    try {
      // Resolve by package subpath, not as a sibling of this module: the bundle
      // hoists `runner` into dist/chunks/, so a relative URL would miss.
      entry = (
        import.meta as unknown as { resolve(s: string): string }
      ).resolve('@happyvertical/smrt-jobs/worker-liveness-thread');
    } catch {
      return false;
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL(entry), {
        workerData: {
          url: resolveUrl(this.db),
          type: resolveEngine(this.db),
          workerKey: this.workerKey,
          leaseTtlMs: this.effectiveLeaseTtlMs,
          leaseTickMs: this.config.leaseTickMs,
        },
      });
    } catch {
      return false;
    }

    // Bound the handshake so a hung connect inside the thread (slow/unreachable
    // database) can't stall start() forever — fall back to main-loop renewal.
    const ready = await new Promise<boolean>((resolve) => {
      const onMessage = (message: unknown) => {
        if (message === 'ready') {
          cleanup();
          resolve(true);
        } else if (
          message &&
          typeof message === 'object' &&
          (message as { type?: string }).type === 'error'
        ) {
          cleanup();
          resolve(false);
        }
      };
      const onFail = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onFail);
        worker.off('exit', onFail);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, LIVENESS_THREAD_START_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      worker.on('message', onMessage);
      worker.once('error', onFail);
      worker.once('exit', onFail);
    });

    if (!ready) {
      await worker.terminate().catch(() => {});
      return false;
    }

    this.livenessWorker = worker;
    // Don't keep the process alive on the liveness thread alone.
    worker.unref();
    // If the thread dies while we're still running, fall back to main-loop
    // renewal so the lease keeps being renewed.
    worker.once('error', () => this.handleLivenessThreadLoss(worker));
    worker.once('exit', () => this.handleLivenessThreadLoss(worker));
    return true;
  }

  private handleLivenessThreadLoss(worker: Worker): void {
    if (this.livenessWorker !== worker) return;
    this.livenessWorker = null;
    if (this.running && !this.leaseTimer) {
      this.startLeaseRenewal();
    }
  }

  /** Stop the liveness thread (graceful, with a short bound), if running. */
  private async stopLivenessThread(): Promise<void> {
    const worker = this.livenessWorker;
    if (!worker) return;
    this.livenessWorker = null;

    const stopped = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        resolve();
      };
      const onMessage = (message: unknown) => {
        if (message === 'stopped') done();
      };
      worker.on('message', onMessage);
      worker.once('exit', done);
      const timer = setTimeout(done, 2000);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      // The worker may have already exited (it's unref'd and best-effort);
      // postMessage to a dead worker throws ERR_WORKER_NOT_RUNNING.
      worker.postMessage('stop');
    } catch {
      // Nothing to ask it to do; fall through to terminate.
    }
    await stopped;
    await worker.terminate().catch(() => {});
  }

  /**
   * Per-job heartbeat loop — telemetry only ("last activity" for the UI). It no
   * longer gates recovery (that is the worker lease), so a blocked loop missing
   * a heartbeat is harmless.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      if (!this.db) return;
      const jobIds = [...this.activeJobs.keys()];
      if (jobIds.length === 0) return;
      const placeholders = jobIds.map(() => '?').join(', ');
      try {
        await this.db.query(
          `UPDATE _smrt_jobs
              SET worker_heartbeat = ?
            WHERE status = 'running'
              AND id IN (${placeholders})`,
          new Date().toISOString(),
          ...jobIds,
        );
      } catch {
        // Telemetry is best-effort.
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
