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
 *
 * @example
 * ```typescript
 * const scheduleRunner = new ScheduleRunner({ pollInterval: 30000 });
 * await scheduleRunner.initialize(db);
 * await scheduleRunner.start();
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
   * Process due schedules once and return the count
   * Useful for single-run mode (e.g., CLI --once flag)
   */
  async processOnce(): Promise<number> {
    if (!this.db) {
      throw new Error(
        'ScheduleRunner not initialized. Call initialize() first.',
      );
    }
    return this.poll();
  }

  /**
   * Poll for due schedules and create jobs
   * @returns Number of schedules processed
   */
  private async poll(): Promise<number> {
    if (!this.db || !this.jobCollection) return 0;

    const now = new Date().toISOString();

    // Find due schedules
    const result = await this.db.query(
      `SELECT * FROM _smrt_agent_schedules
       WHERE enabled = 1
       AND status = 'active'
       AND next_run <= ?
       AND running_count < max_concurrent
       ORDER BY next_run ASC
       LIMIT ?`,
      [now, this.config.batchSize],
    );

    for (const row of result.rows) {
      await this.triggerSchedule(row as ScheduleRow);
    }

    return result.rows.length;
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
      // Increment running count
      await this.db.query(
        `UPDATE _smrt_agent_schedules
         SET running_count = running_count + 1
         WHERE id = ?`,
        [schedule.id],
      );

      // Create a job for this schedule
      const job = await this.jobCollection.create({
        queue: 'agents',
        objectType: schedule.agent_type as string,
        objectId: schedule.agent_id as string | null,
        method: (schedule.method as string) || 'run',
        args: {
          ...((schedule.method_args as Record<string, unknown>) || {}),
          ...((schedule.agent_config as Record<string, unknown>) || {}),
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
      });
    } catch (error) {
      // Decrement running count on failure
      await this.db.query(
        `UPDATE _smrt_agent_schedules
         SET running_count = running_count - 1,
             status = 'error',
             last_error = ?
         WHERE id = ?`,
        [(error as Error).message, schedule.id],
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

/**
 * Create a ScheduleRunner instance
 */
export function createScheduleRunner(
  config?: ScheduleRunnerConfig,
): ScheduleRunner {
  return new ScheduleRunner(config);
}

export default ScheduleRunner;
