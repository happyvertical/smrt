import { EventEmitter } from 'node:events';
import { createLogger } from '@happyvertical/logger';
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
   * Trigger a schedule by creating a job
   */
  private async triggerSchedule(schedule: ScheduleRow): Promise<void> {
    if (!this.db || !this.jobCollection) return;

    const scheduleInfo: ScheduleInfo = {
      id: schedule.id as string,
      agentType: schedule.agent_type as string,
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
         SET running_count = running_count + 1,
             next_run = ?
         WHERE id = ?`,
        nextRun.toISOString(),
        schedule.id,
      );

      // Create a job for this schedule
      const job = await this.jobCollection.create({
        queue: 'agents',
        objectType: schedule.agent_type as string,
        objectId: schedule.agent_id as string | null,
        method: (schedule.method as string) || 'run',
        args: {
          ...methodArgs,
          ...agentConfig,
          _scheduleId: schedule.id,
        },
        priority: 75, // High priority for scheduled agents
        maxAttempts: 3,
        timeout: (schedule.timeout as number) || 3600000,
      });

      await job.save();

      this.emit('schedule:triggered', scheduleInfo);
      this.logger.info('Schedule triggered', {
        scheduleId: schedule.id,
        agentType: schedule.agent_type,
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

  // Search for next matching date (limit to 1 year)
  const maxIterations = 525600;
  for (let i = 0; i < maxIterations; i++) {
    if (
      matchesCronField(candidate.getMonth() + 1, monthExpr) &&
      matchesCronField(candidate.getDate(), dayExpr) &&
      matchesCronField(candidate.getDay(), dowExpr) &&
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
