import { EventEmitter } from 'node:events';
import { createLogger } from '@happyvertical/logger';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { createId } from '@happyvertical/utils';
import {
  redactErrorForPersistence,
  redactErrorMessage,
} from './error-redaction.js';
import { SmrtJobCollection } from './smrt-job.js';
import { SmrtWorkerCollection } from './smrt-worker.js';
import { DEFAULT_TASK_HEARTBEAT_INTERVAL_MS } from './stale-recovery.js';
import { isWorkerAlive } from './worker-liveness.js';

/**
 * ScheduleRunner configuration
 */
/**
 * Queue that {@link ScheduleRunner} enqueues triggered schedules to. A task
 * worker must poll it (alongside `default`) or scheduled jobs stay `pending`
 * (#3141).
 */
export const SCHEDULED_JOB_QUEUE = 'agents';

export interface ScheduleRunnerConfig {
  /** Runner ID (auto-generated if not provided) */
  id?: string;
  /** Polling interval in milliseconds (default: 60000 - 1 minute) */
  pollInterval?: number;
  /** Maximum schedules to process per poll */
  batchSize?: number;
  /**
   * @deprecated No longer used. Slot reconciliation keys on worker liveness
   * (the `_smrt_workers` lease), not per-job heartbeat staleness (#1474).
   */
  staleJobThresholdMs?: number;
  /**
   * @deprecated No longer used. See {@link staleJobThresholdMs}.
   */
  taskHeartbeatInterval?: number;
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
  taskHeartbeatInterval: DEFAULT_TASK_HEARTBEAT_INTERVAL_MS,
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
  private workerCollection: SmrtWorkerCollection | null = null;
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
    this.jobCollection = await SmrtJobCollection.create({ db });
    this.workerCollection = await SmrtWorkerCollection.create({ db });
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

    // `last_error` is persisted to a durable schedule row; strip secret-shaped
    // substrings the same way the job runner does (S5 audit #1402).
    const safeErrorMessage = redactErrorMessage(
      errorMessage ?? 'Unknown error',
    );

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
          safeErrorMessage,
          scheduleId,
        );
        this.emit('schedule:failed', scheduleId, safeErrorMessage);
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
   * - a running job's owning worker is no longer alive (dead/restarted)
   * - a schedule slot remains occupied even though no running job still exists
   *
   * Staleness keys on worker *liveness* (issue #1474), not per-job heartbeat
   * freshness: a job whose `worker_id` is live in this process or holds a fresh
   * lease in `_smrt_workers` is healthy even if its handler is holding the loop
   * synchronously. ScheduleRunner has no in-process active-job set, so this is
   * its entire correctness mechanism.
   */
  private async recoverStaleScheduleState(): Promise<void> {
    if (!this.db || !this.workerCollection) return;

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

    // Without the workers table we cannot reason about liveness; treat every
    // running job as alive (reconcile slot drift only, never fail jobs).
    const workersReady = await this.workerCollection.tableReady();
    const freshLeaseKeys = workersReady
      ? await this.workerCollection.freshLeaseWorkerKeys()
      : new Set<string>();

    const jobsResult = await this.db.query(
      `SELECT id, args, worker_id
         FROM _smrt_jobs
        WHERE status = 'running'`,
    );
    const jobRows = jobsResult.rows as Array<{
      id: string;
      args: unknown;
      worker_id: string | null;
    }>;

    type ScheduleState = { live: number; staleJobIds: string[] };
    const stateBySchedule = new Map<string, ScheduleState>();
    for (const schedule of schedules) {
      stateBySchedule.set(schedule.id, { live: 0, staleJobIds: [] });
    }

    for (const row of jobRows) {
      const scheduleId = this.getScheduleIdFromJobArgs(row.args);
      if (!scheduleId) continue;

      const state = stateBySchedule.get(scheduleId);
      if (!state) continue;

      const alive = workersReady
        ? isWorkerAlive(row.worker_id, freshLeaseKeys)
        : true;

      if (!alive) {
        state.staleJobIds.push(row.id);
      } else {
        state.live += 1;
      }
    }

    const now = new Date().toISOString();
    const staleJobIds = schedules.flatMap((schedule) => {
      const state = stateBySchedule.get(schedule.id);
      return state?.staleJobIds ?? [];
    });

    // Only the jobs this pass actually transitioned to 'failed' — RETURNING id
    // (not rowCount, which DuckDB/JSON always report as ≥1) so a job another
    // recoverer already failed isn't double-counted into the schedule's
    // run_count/failure_count.
    const recoveredJobIds = new Set<string>();
    if (staleJobIds.length > 0) {
      const placeholders = staleJobIds.map(() => '?').join(', ');
      const result = await this.db.query(
        `UPDATE _smrt_jobs
            SET status = 'failed',
                completed_at = ?,
                last_error = ?,
                worker_id = NULL,
                worker_heartbeat = NULL
          WHERE status = 'running'
            AND id IN (${placeholders})
          RETURNING id`,
        now,
        'Recovered orphaned scheduled job: its owning worker is no longer ' +
          'alive (no fresh liveness lease in _smrt_workers and not running in ' +
          'this process).',
        ...staleJobIds,
      );
      for (const row of result.rows as Array<{ id?: unknown }>) {
        if (typeof row.id === 'string') recoveredJobIds.add(row.id);
      }
    }

    for (const schedule of schedules) {
      const state = stateBySchedule.get(schedule.id);
      if (!state) continue;

      const desiredRunningCount = state.live;
      const recoveredCount = state.staleJobIds.filter((id) =>
        recoveredJobIds.has(id),
      ).length;

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
          `Recovered ${recoveredCount} orphaned scheduled job(s) from dead worker(s)`,
          recoveredCount,
          recoveredCount,
          schedule.id,
        );
        this.emit(
          'schedule:failed',
          schedule.id,
          `Recovered ${recoveredCount} orphaned scheduled job(s)`,
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

      // Compute next run time from cron before creating the job, evaluated
      // in the row's zone; a missing/blank zone falls back to the column
      // default (UTC) rather than the host's process zone (#3859).
      // An invalid cron or zone is a deterministic configuration failure:
      // retrying it every poll can never succeed, so move the row to
      // status='error' (as AgentSchedule.calculateNextRun does). Only these
      // validation errors are terminal; a valid cron whose next run lies past
      // the search horizon (a leap-day schedule) stays active.
      const timezone =
        typeof schedule.timezone === 'string' && schedule.timezone.trim()
          ? schedule.timezone.trim()
          : 'UTC';
      try {
        validateCronExpression(schedule.cron as string);
        validateCronTimezone(timezone);
      } catch (error) {
        await this.db.query(
          `UPDATE _smrt_agent_schedules
           SET status = 'error', last_error = ?
           WHERE id = ?`,
          redactErrorForPersistence(error),
          schedule.id,
        );
        this.emit('schedule:error', scheduleInfo, error as Error);
        this.logger.error('Schedule has an invalid cron or time zone', {
          scheduleId: schedule.id,
          error,
        });
        return;
      }
      const nextRun = getNextCronDate(schedule.cron as string, timezone);

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

      // Enqueue the job BEFORE advancing next_run / incrementing running_count.
      // Previously next_run was advanced and running_count incremented first; if
      // enqueueJob then threw (a transient tenant-cap hit or DB blip), the catch
      // disabled the schedule but never rolled next_run back, permanently losing
      // that run slot AND taking the schedule out of the poll until manual
      // re-activation (#4 in the #1401 review). By enqueuing first, a transient
      // failure leaves next_run untouched, so the same due slot is retried on
      // the next poll and the schedule stays active.
      //
      // Route scheduled jobs through the same centralized creation path as the
      // fluent builder so the per-tenant in-flight cap and retry ceiling apply
      // here too — previously a direct create() bypassed both (S5 audit #1402).
      // The schedule's own tenant is passed explicitly so the cap is enforced
      // for the owning tenant even with no ambient context.
      const job = await this.jobCollection.enqueueJob({
        tenantId:
          typeof schedule.tenant_id === 'string' &&
          schedule.tenant_id.length > 0
            ? (schedule.tenant_id as string)
            : null,
        queue: SCHEDULED_JOB_QUEUE,
        objectType: canonicalAgentType,
        objectId: schedule.agent_id as string | null,
        method: (schedule.method as string) || 'run',
        args,
        priority: 75, // High priority for scheduled agents
        maxAttempts: 3,
        timeout: (schedule.timeout as number) || 3600000,
      });

      // Only now that the job is durably enqueued do we consume the slot:
      // increment running_count and advance next_run in one update.
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

      this.emit('schedule:triggered', scheduleInfo);
      this.logger.info('Schedule triggered', {
        scheduleId: schedule.id,
        agentType: canonicalAgentType,
        jobId: job.id,
        nextRun: nextRun.toISOString(),
      });
    } catch (error) {
      // The slot was NOT consumed (enqueue runs before the next_run/
      // running_count advance), so there is nothing to roll back: leave
      // next_run and status='active' untouched so the next poll retries the
      // same due slot rather than skipping it or disabling the schedule on a
      // transient failure (#4). Record last_error for operator visibility only.
      await this.db.query(
        `UPDATE _smrt_agent_schedules
         SET last_error = ?
         WHERE id = ?`,
        // Tolerate non-Error throwables: a thrown string/object has no
        // `.message`, which would otherwise persist an empty `last_error`.
        redactErrorForPersistence(error),
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
  timezone: unknown;
  method: unknown;
  method_args: unknown;
  timeout: unknown;
}

// --- Cron helpers (self-contained, no external dependency) ---

/**
 * Inclusive valid range for each cron field, by position.
 * minute, hour, day-of-month, month, day-of-week.
 * Day-of-week accepts 0-7 where both 0 and 7 represent Sunday.
 */
const CRON_FIELD_RANGES: ReadonlyArray<{
  name: string;
  min: number;
  max: number;
}> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

/**
 * Validate that every numeric component of a single cron field falls within
 * the field's inclusive range. Rejects malformed values up front so an
 * out-of-range field (e.g. `minute=70`) fails fast at schedule-trigger time
 * instead of silently scanning ~525k candidate minutes and never matching
 * (S5 audit #1402).
 */
function validateCronField(
  expr: string,
  range: { name: string; min: number; max: number },
): void {
  if (expr === '*') return;

  const reject = (detail: string): never => {
    throw new Error(
      `Invalid cron expression: ${range.name} field "${expr}" ${detail} ` +
        `(valid range ${range.min}-${range.max})`,
    );
  };

  const assertInRange = (value: number): void => {
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      reject('is out of range');
    }
  };

  for (const term of expr.split(',')) {
    if (term === '') reject('contains an empty value');

    let body = term;
    if (body.includes('/')) {
      // Exactly one '/' is valid (`base/step`). `1/2/3` must be rejected, not
      // silently parsed as `1/2` by dropping the trailing segment.
      const stepParts = body.split('/');
      if (stepParts.length !== 2) {
        reject('has malformed step syntax');
      }
      const [rangePart, stepStr] = stepParts;
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) {
        reject('has an invalid step');
      }
      body = rangePart;
      if (body === '*') continue;
    }

    if (body.includes('-')) {
      // Exactly one '-' is valid (`start-end`). `1-2-3` must be rejected, not
      // silently parsed as `1-2` by dropping the trailing segment.
      const rangeParts = body.split('-');
      if (rangeParts.length !== 2) {
        reject('has malformed range syntax');
      }
      const [startStr, endStr] = rangeParts;
      if (startStr === '' || endStr === '') {
        reject('has an empty range part');
      }
      const start = Number(startStr);
      const end = Number(endStr);
      assertInRange(start);
      assertInRange(end);
      if (start > end) reject('has an inverted range');
    } else {
      assertInRange(Number(body));
    }
  }
}

/**
 * Validate a standard 5-field cron expression: field count plus per-field
 * value ranges. Throws a descriptive `Error` on the first invalid field.
 *
 * Exposed so callers (and the agents package, which owns schedule creation)
 * can reject a bad cron at write time rather than letting an out-of-range
 * field silently never match (S5 audit #1402).
 *
 * @param cron - The cron expression to validate.
 * @returns The trimmed, whitespace-split fields when valid.
 */
export function validateCronExpression(cron: string): string[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields, got ${parts.length}`,
    );
  }

  parts.forEach((field, index) => {
    validateCronField(field, CRON_FIELD_RANGES[index]);
  });

  return parts;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Wall-clock minutes scanned before giving up (one year, as before). */
const CRON_SEARCH_HORIZON_MS = 525_600 * MINUTE_MS;

/** UTC offset (ms, east-positive) of a zone at an instant. */
type ZoneOffsetAt = (epochMs: number) => number;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Resolve the offset function for a cron time zone. `undefined`/`null` keeps
 * the legacy host-local behaviour (the process `TZ`); any other value must be
 * an IANA zone name accepted by `Intl.DateTimeFormat`.
 */
function resolveZoneOffset(timezone: string | null | undefined): ZoneOffsetAt {
  if (timezone === undefined || timezone === null) {
    return (epochMs) => -new Date(epochMs).getTimezoneOffset() * MINUTE_MS;
  }

  let formatter = zoneFormatters.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new Error(
        `Invalid cron timezone: "${timezone}" is not a recognized IANA time zone`,
      );
    }
    zoneFormatters.set(timezone, formatter);
  }

  const zoned = formatter;
  return (epochMs) => {
    const fields: Record<string, number> = {};
    for (const part of zoned.formatToParts(epochMs)) {
      if (part.type !== 'literal') fields[part.type] = Number(part.value);
    }
    const wallMs = Date.UTC(
      fields.year,
      fields.month - 1,
      fields.day,
      // `% 24` guards ICU builds that render midnight as hour 24.
      fields.hour % 24,
      fields.minute,
      fields.second,
    );
    return wallMs - (epochMs - (((epochMs % 1000) + 1000) % 1000));
  };
}

/**
 * Instants at which a wall-clock time (given as UTC-epoch ms of its naive
 * fields) occurs in the zone: one normally, two in a backward-transition
 * overlap (earlier first), none in a forward-transition gap. Assumes at most
 * one offset transition within a day either side, true of every IANA zone.
 */
function wallTimeInstants(
  wallMs: number,
  offsetAt: ZoneOffsetAt,
): { instants: number[]; offsetBefore: number; offsetAfter: number } {
  const offsetBefore = offsetAt(wallMs - DAY_MS);
  const offsetAfter = offsetAt(wallMs + DAY_MS);
  const instants: number[] = [];
  for (const offset of new Set([offsetBefore, offsetAfter])) {
    const instant = wallMs - offset;
    if (offsetAt(instant) === offset) instants.push(instant);
  }
  instants.sort((a, b) => a - b);
  return { instants, offsetBefore, offsetAfter };
}

/**
 * Validate a cron time zone without computing a run date.
 *
 * @throws `Invalid cron timezone` when the name is not an IANA zone.
 */
function validateCronTimezone(timezone: string): void {
  resolveZoneOffset(timezone);
}

/**
 * Parse a cron expression and get the next run date.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 *
 * Fields are matched against the wall clock of `timezone`, an IANA zone name
 * such as `America/Edmonton` (DST-correct via `Intl.DateTimeFormat`). When
 * `timezone` is omitted (`undefined`/`null`) the host process's local zone is
 * used — the legacy behaviour, kept for callers that have no zone to pass.
 * Persisted schedules should always pass their row's zone; the
 * `_smrt_agent_schedules.timezone` column defaults to `UTC`.
 *
 * Daylight-saving transitions follow Vixie cron's split:
 * - **Fixed-time** expressions (no `*` in the minute or hour field) run once
 *   per matching day. A wall time skipped by a forward transition runs
 *   shifted forward by the gap (`30 2 * * *` on the spring-forward day in
 *   `America/Edmonton` runs at 03:30 MDT, RFC 5545 / Temporal "compatible"
 *   resolution); a wall time repeated by a backward transition runs only at
 *   its first occurrence.
 * - **Wildcard** expressions (`*` in the minute or hour field, including
 *   `*\/n`) follow elapsed time: skipped wall times do not run and repeated
 *   wall times run again in the repeated hour.
 *
 * Limitations:
 * - Numeric values only (no abbreviated names like JAN, MON)
 * - Day-of-week accepts 0-7 where both 0 and 7 represent Sunday
 *
 * Out-of-range fields and unknown time zones are rejected eagerly (see
 * {@link validateCronExpression}).
 *
 * @param cron - 5-field cron expression.
 * @param timezone - IANA zone the cron is evaluated in; omit for host-local.
 * @returns The first matching instant at least one minute after now.
 */
export function getNextCronDate(cron: string, timezone?: string | null): Date {
  const [minuteExpr, hourExpr, dayExpr, monthExpr, dowExpr] =
    validateCronExpression(cron);
  const offsetAt = resolveZoneOffset(timezone);

  // Standard cron DOM/DOW semantics:
  // When both day-of-month and day-of-week are restricted (not *),
  // a date matches if EITHER condition is met (OR logic).
  const dayIsWildcard = dayExpr === '*';
  const dowIsWildcard = dowExpr === '*';
  const fixedTime = !minuteExpr.includes('*') && !hourExpr.includes('*');

  const dayMatches = (wall: Date): boolean => {
    const domMatches = matchesCronField(
      wall.getUTCDate(),
      dayExpr,
      CRON_FIELD_RANGES[2],
    );
    // getUTCDay() returns 0 for Sunday; standard cron accepts both 0 and 7
    const dow = wall.getUTCDay();
    const dowMatches =
      matchesCronField(dow, dowExpr, CRON_FIELD_RANGES[4]) ||
      (dow === 0 && matchesCronField(7, dowExpr, CRON_FIELD_RANGES[4]));
    if (!dayIsWildcard && !dowIsWildcard) return domMatches || dowMatches;
    if (!dayIsWildcard) return domMatches;
    if (!dowIsWildcard) return dowMatches;
    return true;
  };

  // The earliest eligible instant: the start of the next minute.
  const now = Date.now();
  const threshold =
    now - (((now % MINUTE_MS) + MINUTE_MS) % MINUTE_MS) + MINUTE_MS;

  // Scan naive wall-clock minutes (UTC accessors on wall-time epochs). A
  // transition near the threshold can map earlier wall times to eligible
  // instants (the repeated hour, or a gap shifted forward), so start the
  // scan one transition-width before the threshold's wall time.
  const thresholdOffset = offsetAt(threshold);
  const thresholdSpread = Math.abs(
    offsetAt(threshold - DAY_MS) - offsetAt(threshold + DAY_MS),
  );
  let wallMs = threshold + thresholdOffset - thresholdSpread;
  const wallEnd = threshold + thresholdOffset + CRON_SEARCH_HORIZON_MS;

  let best: number | null = null;
  let stopAfterWall = Number.POSITIVE_INFINITY;

  while (wallMs <= wallEnd && wallMs <= stopAfterWall) {
    const wall = new Date(wallMs);
    const year = wall.getUTCFullYear();
    const month = wall.getUTCMonth();
    const day = wall.getUTCDate();
    const hour = wall.getUTCHours();

    if (!matchesCronField(month + 1, monthExpr, CRON_FIELD_RANGES[3])) {
      wallMs = Date.UTC(year, month + 1, 1);
      continue;
    }
    if (!dayMatches(wall)) {
      wallMs = Date.UTC(year, month, day + 1);
      continue;
    }
    if (!matchesCronField(hour, hourExpr, CRON_FIELD_RANGES[1])) {
      wallMs = Date.UTC(year, month, day, hour + 1);
      continue;
    }
    if (
      !matchesCronField(wall.getUTCMinutes(), minuteExpr, CRON_FIELD_RANGES[0])
    ) {
      wallMs += MINUTE_MS;
      continue;
    }

    const { instants, offsetBefore, offsetAfter } = wallTimeInstants(
      wallMs,
      offsetAt,
    );
    let candidates = instants;
    if (instants.length === 0) {
      // Forward-transition gap: fixed-time runs shift forward by the gap.
      candidates = fixedTime ? [wallMs - offsetBefore] : [];
    } else if (instants.length > 1 && fixedTime) {
      // Backward-transition overlap: fixed-time runs fire once, first.
      candidates = [instants[0]];
    }

    for (const instant of candidates) {
      if (instant >= threshold && (best === null || instant < best)) {
        if (best === null) {
          // Later wall times within one transition width can still map to
          // an earlier instant (the repeated hour); keep scanning that far.
          stopAfterWall = wallMs + Math.abs(offsetBefore - offsetAfter);
        }
        best = instant;
      }
    }

    wallMs += MINUTE_MS;
  }

  if (best === null) {
    throw new Error(`Could not find next run date for cron: ${cron}`);
  }
  return new Date(best);
}

/**
 * Check if a value matches a cron field expression.
 *
 * Each comma-separated term is evaluated on its own, so mixed lists such as
 * `1-5,10` or `0,30-40/5` match every term rather than parsing the whole
 * list as one range. `*\/step` steps from the field minimum (day-of-month
 * `*\/2` is 1,3,5,…; month `*\/3` is 1,4,7,10), and `base/step` without a range
 * (`5/15`) steps from `base` to the field maximum — the common cron extension
 * the validator already accepts.
 */
function matchesCronField(
  value: number,
  expr: string,
  range: { min: number; max: number },
): boolean {
  if (expr === '*') return true;
  return expr.split(',').some((term) => {
    const [body, stepStr] = term.split('/');
    const step = stepStr === undefined ? 1 : parseInt(stepStr, 10);
    let start: number;
    let end: number;
    if (body === '*') {
      start = range.min;
      end = range.max;
    } else if (body.includes('-')) {
      const [startStr, endStr] = body.split('-');
      start = parseInt(startStr, 10);
      end = parseInt(endStr, 10);
    } else {
      start = parseInt(body, 10);
      end = stepStr === undefined ? start : range.max;
    }
    return value >= start && value <= end && (value - start) % step === 0;
  });
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
