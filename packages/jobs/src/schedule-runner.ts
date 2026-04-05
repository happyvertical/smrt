import { EventEmitter } from 'node:events';
import { createLogger } from '@happyvertical/logger';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { createId } from '@happyvertical/utils';
import { SmrtJobCollection } from './smrt-job.js';

/**
 * ScheduleRunner configuration
 */
export interface ScheduleRunnerConfig {
  /** Runner ID (auto-generated if not provided) */
  id?: string;
  /** Polling interval in milliseconds (default: 60000 - 1 minute) */
  pollInterval?: number;
  /** Maximum schedules to process per poll */
  batchSize?: number;
  /** Reconcile running schedule slots after this many milliseconds without a worker heartbeat */
  staleJobThresholdMs?: number;
}

/**
 * ScheduleRunner events
 */
export interface ScheduleRunnerEvents {
  'schedule:triggered': (schedule: ScheduleInfo) => void;
  'schedule:error': (schedule: ScheduleInfo, error: Error) => void;
  'schedule:completed': (scheduleId: string) => void;
  'schedule:failed': (scheduleId: string, error: string) => void;
  'runner:started': () => void;
  'runner:stopped': () => void;
  'runner:error': (error: Error) => void;
}

/**
 * Schedule info for events
 */
export interface ScheduleInfo {
  id: string;
  agentType: string;
  agentId: string | null;
  cron: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<ScheduleRunnerConfig> = {
  id: '',
  pollInterval: 60000, // 1 minute
  batchSize: 50,
  staleJobThresholdMs: 90000,
};

/**
 * ScheduleRunner polls for due agent schedules and creates jobs for them
 *
 * This runner works in conjunction with TaskRunner:
 * 1. ScheduleRunner checks for due schedules based on cron expressions
 * 2. When a schedule is due, it creates a SmrtJob for the agent
 * 3. TaskRunner picks up and executes the job
 * 4. On job completion/failure, call handleJobCompletion() to update the schedule
 *
 * @example
 * ```typescript
 * const scheduleRunner = new ScheduleRunner({ pollInterval: 30000 });
 * await scheduleRunner.initialize(db);
 * await scheduleRunner.start();
 *
 * // Wire up TaskRunner events to update schedule state
 * taskRunner.on('job:completed', (job) => {
 *   const scheduleId = job.args?._scheduleId;
 *   if (scheduleId) scheduleRunner.handleJobCompletion(scheduleId, true);
 * });
 * taskRunner.on('job:failed', (job, error) => {
 *   const scheduleId = job.args?._scheduleId;
 *   if (scheduleId) scheduleRunner.handleJobCompletion(scheduleId, false, error.message);
 * });
 *
 * // Graceful shutdown
 * process.on('SIGTERM', () => scheduleRunner.stop());
 * ```
 */
export class ScheduleRunner extends EventEmitter {
  readonly id: string;
  private readonly config: Required<ScheduleRunnerConfig>;
  private jobCollection: SmrtJobCollection | null = null;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private db: DatabaseInterface | null = null;
  private logger = createLogger(true);

  constructor(config: ScheduleRunnerConfig = {}) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      id: config.id || `schedule_${createId().slice(0, 8)}`,
    };
    this.id = this.config.id;
  }

  /**
   * Initialize the runner with database connection
   */
  async initialize(db: DatabaseInterface): Promise<void> {
    this.db = db;
    this.jobCollection = await SmrtJobCollection.create({
      db: { type: 'sqlite', url: ':memory:' }, // Placeholder, overridden
    });
    // Override the internal db reference
    (this.jobCollection as unknown as { _db: DatabaseInterface })._db = db;
  }

  /**
   * Start processing schedules
   */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.db) {
      throw new Error(
        'ScheduleRunner not initialized. Call initialize() first.',
      );
    }

    this.running = true;

    // Start polling loop
    this.startPolling();

    this.emit('runner:started');
    this.logger.info('ScheduleRunner started', { id: this.id });
  }

  /**
   * Stop processing schedules
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.emit('runner:stopped');
    this.logger.info('ScheduleRunner stopped', { id: this.id });
  }

  /**
   * Check if runner is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle job completion for a scheduled job.
   *
   * Call this from TaskRunner's job:completed / job:failed events
   * when the job has a `_scheduleId` in its args.
   */
  async handleJobCompletion(
    scheduleId: string,
    success: boolean,
    errorMessage?: string,
  ): Promise<void> {
    if (!this.db) return;

    try {
      if (success) {
        await this.db.query(
          `UPDATE _smrt_agent_schedules
           SET running_count = CASE WHEN COALESCE(running_count, 0) > 0 THEN running_count - 1 ELSE 0 END,
               last_run = ?,
               last_status = 'success',
               last_error = NULL,
               run_count = COALESCE(run_count, 0) + 1,
               success_count = COALESCE(success_count, 0) + 1
           WHERE id = ?`,
          new Date().toISOString(),
          scheduleId,
        );
        this.emit('schedule:completed', scheduleId);
      } else {
        await this.db.query(
          `UPDATE _smrt_agent_schedules
           SET running_count = CASE WHEN COALESCE(running_count, 0) > 0 THEN running_count - 1 ELSE 0 END,
               last_run = ?,
               last_status = 'failed',
               last_error = ?,
               run_count = COALESCE(run_count, 0) + 1,
               failure_count = COALESCE(failure_count, 0) + 1
           WHERE id = ?`,
          new Date().toISOString(),
          errorMessage ?? 'Unknown error',
          scheduleId,
        );
        this.emit(
          'schedule:failed',
          scheduleId,
          errorMessage ?? 'Unknown error',
        );
      }
    } catch (err) {
      this.logger.error('Failed to update schedule after job completion', {
        scheduleId,
        error: err,
      });
    }
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
        this.logger.error('ScheduleRunner poll error', { error });
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
   * Poll for due schedules and create jobs
   */
  private async poll(): Promise<void> {
    if (!this.db || !this.jobCollection) return;

    await this.recoverStaleScheduleState();

    const now = new Date().toISOString();

    // Find due schedules
    const result = await this.db.query(
      `SELECT * FROM _smrt_agent_schedules
       WHERE enabled = true
       AND status = 'active'
       AND next_run <= ?
       AND COALESCE(running_count, 0) < COALESCE(max_concurrent, 1)
       ORDER BY next_run ASC
       LIMIT ?`,
      now,
      this.config.batchSize,
    );

    for (const row of result.rows) {
      await this.triggerSchedule(row as ScheduleRow);
    }
  }

  /**
   * Reconcile stuck schedule slots against running jobs.
   *
   * This handles two failure modes:
   * - a running job is still marked `running` but its heartbeat is stale
   * - a schedule slot remains occupied even though no running job still exists
   */
  private async recoverStaleScheduleState(): Promise<void> {
    if (!this.db) return;

    const schedulesResult = await this.db.query(
      `SELECT id, running_count
         FROM _smrt_agent_schedules
        WHERE COALESCE(running_count, 0) > 0`,
    );
    const schedules = schedulesResult.rows as Array<{
      id: string;
      running_count: number;
    }>;
    if (schedules.length === 0) return;

    const cutoff = new Date(
      Date.now() - this.config.staleJobThresholdMs,
    ).toISOString();
    const jobsResult = await this.db.query(
      `SELECT id, args, worker_heartbeat, started_at
         FROM _smrt_jobs
        WHERE status = 'running'`,
    );

    type ScheduleState = { live: number; staleJobIds: string[] };
    const stateBySchedule = new Map<string, ScheduleState>();
    for (const schedule of schedules) {
      stateBySchedule.set(schedule.id, { live: 0, staleJobIds: [] });
    }

    for (const row of jobsResult.rows as Array<{
      id: string;
      args: unknown;
      worker_heartbeat: string | null;
      started_at: string | null;
    }>) {
      const scheduleId = this.getScheduleIdFromJobArgs(row.args);
      if (!scheduleId) continue;

      const state = stateBySchedule.get(scheduleId);
      if (!state) continue;

      const heartbeat = row.worker_heartbeat;
      const startedAt = row.started_at;
      const isStale =
        (heartbeat !== null && heartbeat < cutoff) ||
        (heartbeat === null && startedAt !== null && startedAt < cutoff);

      if (isStale) {
        state.staleJobIds.push(row.id);
      } else {
        state.live += 1;
      }
    }

    const now = new Date().toISOString();
    for (const schedule of schedules) {
      const state = stateBySchedule.get(schedule.id);
      if (!state) continue;

      for (const staleJobId of state.staleJobIds) {
        await this.db.query(
          `UPDATE _smrt_jobs
              SET status = 'failed',
                  completed_at = ?,
                  last_error = ?,
                  worker_id = NULL,
                  worker_heartbeat = NULL
            WHERE id = ?
              AND status = 'running'`,
          now,
          `Recovered stale scheduled job after ${this.config.staleJobThresholdMs}ms without a heartbeat`,
          staleJobId,
        );
      }

      const desiredRunningCount = state.live;
      const recoveredCount = Math.max(
        state.staleJobIds.length,
        Math.max(0, Number(schedule.running_count) - desiredRunningCount),
      );

      if (
        Number(schedule.running_count) === desiredRunningCount &&
        recoveredCount === 0
      ) {
        continue;
      }

      if (recoveredCount > 0) {
        await this.db.query(
          `UPDATE _smrt_agent_schedules
              SET running_count = ?,
                  last_run = ?,
                  last_status = 'failed',
                  last_error = ?,
                  run_count = COALESCE(run_count, 0) + ?,
                  failure_count = COALESCE(failure_count, 0) + ?
            WHERE id = ?`,
          desiredRunningCount,
          now,
          `Recovered ${recoveredCount} stale scheduled job(s) after missing heartbeats`,
          recoveredCount,
          recoveredCount,
          schedule.id,
        );
        this.emit(
          'schedule:failed',
          schedule.id,
          `Recovered ${recoveredCount} stale scheduled job(s)`,
        );
      } else {
        await this.db.query(
          `UPDATE _smrt_agent_schedules
              SET running_count = ?
            WHERE id = ?`,
          desiredRunningCount,
          schedule.id,
        );
      }
    }
  }

  private getScheduleIdFromJobArgs(args: unknown): string | null {
    if (!args) return null;

    let parsedArgs = args;
    if (typeof parsedArgs === 'string') {
      try {
        parsedArgs = JSON.parse(parsedArgs) as Record<string, unknown>;
      } catch {
        return null;
      }
    }

    if (
      !parsedArgs ||
      typeof parsedArgs !== 'object' ||
      Array.isArray(parsedArgs)
    ) {
      return null;
    }

    const scheduleId = (parsedArgs as Record<string, unknown>)._scheduleId;
    return typeof scheduleId === 'string' && scheduleId.length > 0
      ? scheduleId
      : null;
  }

  /**
   * Trigger a schedule by creating a job
   */
  private async triggerSchedule(schedule: ScheduleRow): Promise<void> {
    if (!this.db || !this.jobCollection) return;

    const rawAgentType = schedule.agent_type as string;
    const canonicalAgentType =
      ObjectRegistry.getClass(rawAgentType)?.qualifiedName || rawAgentType;

    const scheduleInfo: ScheduleInfo = {
      id: schedule.id as string,
      agentType: canonicalAgentType,
      agentId: schedule.agent_id as string | null,
      cron: schedule.cron as string,
    };

    try {
      // Parse method_args and agent_config from JSON strings if needed
      let methodArgs: Record<string, unknown> = {};
      if (schedule.method_args) {
        methodArgs =
          typeof schedule.method_args === 'string'
            ? JSON.parse(schedule.method_args as string)
            : (schedule.method_args as Record<string, unknown>);
      }
      let agentConfig: Record<string, unknown> = {};
      if (schedule.agent_config) {
        agentConfig =
          typeof schedule.agent_config === 'string'
            ? JSON.parse(schedule.agent_config as string)
            : (schedule.agent_config as Record<string, unknown>);
      }

      // Compute next run time from cron before creating the job
      const nextRun = getNextCronDate(schedule.cron as string);

      // Increment running count and advance next_run in one update
      await this.db.query(
        `UPDATE _smrt_agent_schedules
         SET agent_type = ?,
             running_count = running_count + 1,
             next_run = ?
         WHERE id = ?`,
        canonicalAgentType,
        nextRun.toISOString(),
        schedule.id,
      );

      // Create a job for this schedule
      // Nest agent_config under _agentConfig so TaskRunner can pass it
      // to the agent constructor separately from method args
      const args: Record<string, unknown> = {
        ...methodArgs,
        _scheduleId: schedule.id,
      };
      if (Object.keys(agentConfig).length > 0) {
        args._agentConfig = agentConfig;
      }

      const job = await this.jobCollection.create({
        tenantId:
          typeof schedule.tenant_id === 'string' &&
          schedule.tenant_id.length > 0
            ? (schedule.tenant_id as string)
            : null,
        queue: 'agents',
        objectType: canonicalAgentType,
        objectId: schedule.agent_id as string | null,
        method: (schedule.method as string) || 'run',
        args,
        priority: 75, // High priority for scheduled agents
        maxAttempts: 3,
        timeout: (schedule.timeout as number) || 3600000,
      });

      await job.save();

      this.emit('schedule:triggered', scheduleInfo);
      this.logger.info('Schedule triggered', {
        scheduleId: schedule.id,
        agentType: canonicalAgentType,
        jobId: job.id,
        nextRun: nextRun.toISOString(),
      });
    } catch (error) {
      // Decrement running count on failure
      await this.db.query(
        `UPDATE _smrt_agent_schedules
         SET running_count = running_count - 1,
             status = 'error',
             last_error = ?
         WHERE id = ?`,
        (error as Error).message,
        schedule.id,
      );

      this.emit('schedule:error', scheduleInfo, error as Error);
      this.logger.error('Schedule trigger failed', {
        scheduleId: schedule.id,
        error,
      });
    }
  }
}

/**
 * Database row type for schedule
 */
interface ScheduleRow {
  id: unknown;
  agent_type: unknown;
  agent_id: unknown;
  tenant_id: unknown;
  agent_config: unknown;
  cron: unknown;
  method: unknown;
  method_args: unknown;
  timeout: unknown;
}

// --- Cron helpers (self-contained, no external dependency) ---

/**
 * Parse a cron expression and get the next run date.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 *
 * Limitations:
 * - Numeric values only (no abbreviated names like JAN, MON)
 * - No field range validation (e.g., minute=70 won't error, just won't match)
 * - Day-of-week accepts 0-7 where both 0 and 7 represent Sunday
 */
function getNextCronDate(cron: string): Date {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields, got ${parts.length}`,
    );
  }

  const [minuteExpr, hourExpr, dayExpr, monthExpr, dowExpr] = parts;

  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0);
  candidate.setMilliseconds(0);

  // Move to next minute at minimum
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Standard cron DOM/DOW semantics:
  // When both day-of-month and day-of-week are restricted (not *),
  // a date matches if EITHER condition is met (OR logic).
  const dayIsWildcard = dayExpr === '*';
  const dowIsWildcard = dowExpr === '*';

  // Search for next matching date (limit to 1 year)
  const maxIterations = 525600;
  for (let i = 0; i < maxIterations; i++) {
    const dayMatches = matchesCronField(candidate.getDate(), dayExpr);
    // getDay() returns 0 for Sunday; standard cron accepts both 0 and 7
    const dow = candidate.getDay();
    const dowMatches =
      matchesCronField(dow, dowExpr) ||
      (dow === 0 && matchesCronField(7, dowExpr));

    let dayOfMonthOrWeekMatches: boolean;
    if (!dayIsWildcard && !dowIsWildcard) {
      dayOfMonthOrWeekMatches = dayMatches || dowMatches;
    } else if (!dayIsWildcard) {
      dayOfMonthOrWeekMatches = dayMatches;
    } else if (!dowIsWildcard) {
      dayOfMonthOrWeekMatches = dowMatches;
    } else {
      dayOfMonthOrWeekMatches = true;
    }

    if (
      matchesCronField(candidate.getMonth() + 1, monthExpr) &&
      dayOfMonthOrWeekMatches &&
      matchesCronField(candidate.getHours(), hourExpr) &&
      matchesCronField(candidate.getMinutes(), minuteExpr)
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`Could not find next run date for cron: ${cron}`);
}

/**
 * Check if a value matches a cron field expression
 */
function matchesCronField(value: number, expr: string): boolean {
  if (expr === '*') return true;

  // Step values (*/5, 0-30/2)
  if (expr.includes('/')) {
    const [range, stepStr] = expr.split('/');
    const step = parseInt(stepStr, 10);
    if (range === '*') return value % step === 0;
    if (range.includes('-')) {
      const [startStr, endStr] = range.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (value < start || value > end) return false;
      return (value - start) % step === 0;
    }
  }

  // Ranges (1-5)
  if (expr.includes('-')) {
    const [startStr, endStr] = expr.split('-');
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return value >= start && value <= end;
  }

  // Lists (1,3,5)
  if (expr.includes(',')) {
    const values = expr.split(',').map((v) => parseInt(v.trim(), 10));
    return values.includes(value);
  }

  // Exact match
  return value === parseInt(expr, 10);
}

/**
 * Create a ScheduleRunner instance
 */
export function createScheduleRunner(
  config?: ScheduleRunnerConfig,
): ScheduleRunner {
  return new ScheduleRunner(config);
}

export default ScheduleRunner;
