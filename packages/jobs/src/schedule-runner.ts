import { EventEmitter } from 'node:events';
import { createLogger } from '@happyvertical/logger';
import {
  assertDatabaseMigratedForBuild,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { createId } from '@happyvertical/utils';
import type { DurableJobPayloadSigner } from './durable-payload-integrity.js';
import {
  redactErrorForPersistence,
  redactErrorMessage,
} from './error-redaction.js';
import {
  getScheduleAdmissionPayload,
  getScheduleAdmissionPolicy,
  verifyScheduleAdmission,
} from './schedule-admission.js';
import { countScheduleJobs, SmrtJobCollection } from './smrt-job.js';
import { DEFAULT_TASK_HEARTBEAT_INTERVAL_MS } from './stale-recovery.js';

/** A blocked host must not consume or alter a protected schedule. */
class ScheduleAdmissionBlockedError extends Error {}

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
  /** Trusted host signer for exact occurrence/job integrity; null preserves unsigned behavior. */
  occurrenceSigner?: DurableJobPayloadSigner | null;
  /** Exact registered agent types this host may admit; empty means none. */
  agentTypes?: readonly string[];
  /** Tenant identities this host may admit; null selects global schedules. */
  tenantIds?: readonly (string | null)[];
  /** Queue consumed by this host's task worker (default: agents). */
  queue?: string;
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
  'schedule:blocked': (diagnostic: {
    scheduleId: string;
    reason: string;
  }) => void;
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
type ResolvedScheduleRunnerConfig = Required<
  Omit<ScheduleRunnerConfig, 'agentTypes' | 'tenantIds'>
> &
  Pick<ScheduleRunnerConfig, 'agentTypes' | 'tenantIds'>;

const DEFAULT_CONFIG: ResolvedScheduleRunnerConfig = {
  id: '',
  pollInterval: 60000, // 1 minute
  batchSize: 50,
  occurrenceSigner: null,
  queue: SCHEDULED_JOB_QUEUE,
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
  /** Public contracts hosts may require before admitting enabled schedules. */
  static readonly capabilities = Object.freeze({
    atomicOccurrences: true,
    scopedAdmission: true,
    drain: true,
    occurrenceIntegrity: true,
    requiredOccurrenceIntegrity: true,
  } as const);
  readonly id: string;
  private readonly config: ResolvedScheduleRunnerConfig;
  private jobCollection: SmrtJobCollection | null = null;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
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
    const signer = this.config.occurrenceSigner;
    if (
      signer != null &&
      (typeof signer.keyId !== 'string' ||
        !signer.keyId.trim() ||
        signer.keyId.length > 256 ||
        typeof signer.sign !== 'function' ||
        typeof signer.verify !== 'function')
    ) {
      throw new TypeError(
        'occurrenceSigner must be a trusted host signer with a current keyId',
      );
    }
    if (
      !Number.isInteger(this.config.batchSize) ||
      this.config.batchSize <= 0
    ) {
      throw new TypeError('batchSize must be a positive integer');
    }
    if (
      !Number.isFinite(this.config.pollInterval) ||
      this.config.pollInterval <= 0 ||
      this.config.pollInterval > 2_147_483_647
    ) {
      throw new TypeError(
        'pollInterval must be a finite positive Node timer interval',
      );
    }
    if (typeof this.config.queue !== 'string' || !this.config.queue.trim())
      throw new TypeError('queue must be nonblank');
    for (const values of [this.config.agentTypes, this.config.tenantIds]) {
      if (
        values !== undefined &&
        (!Array.isArray(values) ||
          values.some(
            (value) =>
              value !== null && (typeof value !== 'string' || !value.trim()),
          ))
      ) {
        throw new TypeError(
          'ScheduleRunner scopes must contain nonblank identities',
        );
      }
    }
    if (this.config.agentTypes?.some((value) => value == null))
      throw new TypeError('agentTypes cannot contain null');
    if (this.config.agentTypes)
      this.config.agentTypes = [...this.config.agentTypes];
    if (this.config.tenantIds)
      this.config.tenantIds = [...this.config.tenantIds];
  }

  private scheduleScope(): { sql: string; params: unknown[] } {
    const terms: string[] = [];
    const params: unknown[] = [];
    if (this.config.agentTypes !== undefined) {
      terms.push(
        this.config.agentTypes.length
          ? `agent_type IN (${this.config.agentTypes.map(() => '?').join(', ')})`
          : '1 = 0',
      );
      params.push(...this.config.agentTypes);
    }
    if (this.config.tenantIds !== undefined) {
      const tenants = this.config.tenantIds.filter(
        (id): id is string => id !== null,
      );
      const parts: string[] = [];
      if (tenants.length)
        parts.push(`tenant_id IN (${tenants.map(() => '?').join(', ')})`);
      if (this.config.tenantIds.includes(null)) parts.push('tenant_id IS NULL');
      terms.push(parts.length ? `(${parts.join(' OR ')})` : '1 = 0');
      params.push(...tenants);
    }
    return { sql: terms.length ? ` AND ${terms.join(' AND ')}` : '', params };
  }

  /**
   * Initialize the runner with database connection
   */
  async initialize(db: DatabaseInterface): Promise<void> {
    this.db = db;
    this.jobCollection = await SmrtJobCollection.create({ db });
  }

  /**
   * Start processing schedules
   */
  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.running) return;
    if (!this.db) {
      throw new Error(
        'ScheduleRunner not initialized. Call initialize() first.',
      );
    }

    if (!this.db.transaction) {
      throw new Error('ScheduleRunner requires transaction support');
    }
    await assertDatabaseMigratedForBuild(this.db);
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
    if (this.stopping) return this.stopping;
    if (!this.running && !this.pollInFlight) return;
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopping = (async () => {
      await this.pollInFlight;
      this.emit('runner:stopped');
      this.logger.info('ScheduleRunner stopped', { id: this.id });
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
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

    const scope = this.scheduleScope();

    // `last_error` is persisted to a durable schedule row; strip secret-shaped
    // substrings the same way the job runner does (S5 audit #1402).
    const safeErrorMessage = redactErrorMessage(
      errorMessage ?? 'Unknown error',
    );

    try {
      if (success) {
        const result = await this.db.query(
          `UPDATE _smrt_agent_schedules
           SET running_count = CASE WHEN COALESCE(running_count, 0) > 0 THEN running_count - 1 ELSE 0 END,
               last_run = ?,
               last_status = 'success',
               last_error = NULL,
               run_count = COALESCE(run_count, 0) + 1,
               success_count = COALESCE(success_count, 0) + 1
           WHERE id = ?${scope.sql} RETURNING id`,
          new Date().toISOString(),
          scheduleId,
          ...scope.params,
        );
        if (result.rows.length !== 1) return;
        this.emit('schedule:completed', scheduleId);
      } else {
        const result = await this.db.query(
          `UPDATE _smrt_agent_schedules
           SET running_count = CASE WHEN COALESCE(running_count, 0) > 0 THEN running_count - 1 ELSE 0 END,
               last_run = ?,
               last_status = 'failed',
               last_error = ?,
               run_count = COALESCE(run_count, 0) + 1,
               failure_count = COALESCE(failure_count, 0) + 1
           WHERE id = ?${scope.sql} RETURNING id`,
          new Date().toISOString(),
          safeErrorMessage,
          scheduleId,
          ...scope.params,
        );
        if (result.rows.length !== 1) return;
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
        this.pollInFlight = this.poll();
        await this.pollInFlight;
      } catch (error) {
        this.emit('runner:error', error as Error);
        this.logger.error('ScheduleRunner poll error', { error });
      } finally {
        this.pollInFlight = null;
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

    const managedPoll = this.running;
    await this.recoverStaleScheduleState();
    const now = new Date().toISOString();

    const scope = this.scheduleScope();
    // Find due schedules
    const result = await this.db.query(
      `SELECT *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text, CAST(next_run AS VARCHAR) AS occurrence_time FROM _smrt_agent_schedules
       WHERE enabled = true
       AND status = 'active'
       AND next_run <= ?${scope.sql}
       AND COALESCE(running_count, 0) < COALESCE(max_concurrent, 1)
       ORDER BY next_run ASC
       LIMIT ?`,
      now,
      ...scope.params,
      this.config.batchSize,
    );

    for (const row of result.rows) {
      if (managedPoll && !this.running) break;
      await this.triggerSchedule(
        portableScheduleRow(row as ScheduleRow),
        managedPoll,
      );
    }
  }

  private assertAdmissionHost(schedule: ScheduleRow): void {
    let policy: ReturnType<typeof getScheduleAdmissionPolicy>;
    try {
      policy = getScheduleAdmissionPolicy(schedule.method_args || {});
    } catch {
      throw new ScheduleAdmissionBlockedError('INVALID_ADMISSION_POLICY');
    }
    if (!policy) return;
    if (!this.config.occurrenceSigner)
      throw new ScheduleAdmissionBlockedError('MISSING_OCCURRENCE_SIGNER');
    if (this.config.occurrenceSigner.keyId !== policy.keyId)
      throw new ScheduleAdmissionBlockedError('WRONG_OCCURRENCE_KEY');
    if (this.config.queue !== policy.queue)
      throw new ScheduleAdmissionBlockedError('WRONG_OCCURRENCE_QUEUE');
  }

  private reportBlocked(schedule: ScheduleRow, error: Error): void {
    const diagnostic = {
      scheduleId: String(schedule.id),
      reason: error.message,
    };
    this.emit('schedule:blocked', diagnostic);
    this.logger.warn(
      'Schedule admission blocked by durable policy',
      diagnostic,
    );
  }

  /** Pending retries occupy slots too; TaskRunner alone owns worker recovery. */
  private async countScheduleJobs(
    db: DatabaseInterface,
    schedule: ScheduleRow,
  ): Promise<number> {
    return countScheduleJobs(
      db,
      String(schedule.id),
      schedule.tenant_id == null ? null : String(schedule.tenant_id),
      {
        objectType: String(schedule.agent_type),
        objectId: schedule.agent_id == null ? null : String(schedule.agent_id),
        method: String(schedule.method || 'run'),
      },
    );
  }

  /** Reconcile cached slots without changing TaskRunner-owned job lifecycle. */
  private async recoverStaleScheduleState(): Promise<void> {
    const db = this.db;
    if (!db?.transaction) return;
    const scope = this.scheduleScope();
    const schedules = await db.query(
      `SELECT *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text FROM _smrt_agent_schedules WHERE 1 = 1${scope.sql}`,
      ...scope.params,
    );
    for (const row of schedules.rows) {
      const candidate = portableScheduleRow(row as ScheduleRow);
      try {
        this.assertAdmissionHost(candidate);
        await db.transaction(async (tx) => {
          const locked = await tx.query(
            `UPDATE _smrt_agent_schedules SET running_count = running_count WHERE id = ?${scope.sql} RETURNING *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text, CAST(next_run AS VARCHAR) AS occurrence_time`,
            candidate.id,
            ...scope.params,
          );
          if (locked.rows.length !== 1) return;
          const schedule = portableScheduleRow(locked.rows[0] as ScheduleRow);
          this.assertAdmissionHost(schedule);
          const occupied = await this.countScheduleJobs(tx, schedule);
          await tx.query(
            'UPDATE _smrt_agent_schedules SET running_count = ? WHERE id = ?',
            occupied,
            candidate.id,
          );
        });
      } catch (error) {
        if (!(error instanceof ScheduleAdmissionBlockedError)) throw error;
        this.reportBlocked(candidate, error);
      }
    }
  }

  /**
   * Trigger a schedule by creating a job
   */
  private async triggerSchedule(
    candidate: ScheduleRow,
    managedPoll = false,
  ): Promise<void> {
    if (!this.db || !this.jobCollection) return;
    candidate = portableScheduleRow(candidate);
    const db = this.db;
    let admission: { schedule: ScheduleInfo; error?: Error } | undefined;
    try {
      this.assertAdmissionHost(candidate);
      if (!db.transaction)
        throw new Error('ScheduleRunner requires transaction support');
      admission = await db.transaction(async (tx) => {
        if (managedPoll && !this.running) return;
        // The write locks the current row. PostgreSQL rechecks its predicate
        // after a competing writer commits; stale selected occurrences lose.
        const expected = candidate.occurrence_time ?? candidate.next_run;
        const scope = this.scheduleScope();
        const claimed = await tx.query(
          `UPDATE _smrt_agent_schedules SET running_count = running_count
           WHERE id = ? AND enabled = TRUE AND status = 'active'
             AND next_run <= ?${expected == null ? '' : ' AND next_run = ?'}${scope.sql}
           RETURNING *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text, CAST(next_run AS VARCHAR) AS occurrence_time`,
          candidate.id,
          new Date().toISOString(),
          ...(expected == null ? [] : [expected]),
          ...scope.params,
        );
        if (claimed.rows.length !== 1 || (managedPoll && !this.running)) return;
        const schedule = portableScheduleRow(claimed.rows[0] as ScheduleRow);
        this.assertAdmissionHost(schedule);
        const occupied = await this.countScheduleJobs(tx, schedule);
        await tx.query(
          'UPDATE _smrt_agent_schedules SET running_count = ? WHERE id = ?',
          occupied,
          schedule.id,
        );
        if (occupied >= Number(schedule.max_concurrent ?? 1)) return;
        const jobs = await SmrtJobCollection.create({ db: tx });
        return this.triggerLockedSchedule(schedule, tx, jobs, occupied);
      });
    } catch (error) {
      if (error instanceof ScheduleAdmissionBlockedError) {
        this.reportBlocked(candidate, error);
        return;
      }
      await db.query(
        'UPDATE _smrt_agent_schedules SET last_error = ? WHERE id = ?',
        redactErrorForPersistence(error),
        candidate.id,
      );
      this.emit(
        'schedule:error',
        {
          id: String(candidate.id),
          agentType: String(candidate.agent_type),
          agentId: candidate.agent_id as string | null,
          cron: String(candidate.cron),
        },
        error as Error,
      );
      return;
    }
    // Notify subscribers only after the occurrence and job have committed.
    if (admission?.error) {
      this.emit('schedule:error', admission.schedule, admission.error);
    } else if (admission) {
      this.emit('schedule:triggered', admission.schedule);
      this.logger.info('Schedule triggered', {
        scheduleId: admission.schedule.id,
      });
    }
  }

  private async triggerLockedSchedule(
    schedule: ScheduleRow,
    db: DatabaseInterface,
    jobs: SmrtJobCollection,
    occupied: number,
  ): Promise<{ schedule: ScheduleInfo; error?: Error } | undefined> {
    const rawAgentType = schedule.agent_type as string;
    const canonicalAgentType =
      ObjectRegistry.getClass(rawAgentType)?.qualifiedName || rawAgentType;

    const scheduleInfo: ScheduleInfo = {
      id: schedule.id as string,
      agentType: canonicalAgentType,
      agentId: schedule.agent_id as string | null,
      cron: schedule.cron as string,
    };

    // Parse method_args and agent_config from JSON strings if needed
    let methodArgs: Record<string, unknown> = {};
    if (schedule.method_args) {
      methodArgs =
        typeof schedule.method_args === 'string'
          ? JSON.parse(schedule.method_args as string)
          : (schedule.method_args as Record<string, unknown>);
    }
    if (
      !methodArgs ||
      typeof methodArgs !== 'object' ||
      Array.isArray(methodArgs)
    )
      throw new TypeError('Schedule method_args must be a JSON object');
    for (const key of [
      '_scheduleId',
      '_scheduledFor',
      '_agentConfig',
      '_scheduleAdmission',
    ]) {
      if (Object.hasOwn(methodArgs, key))
        throw new TypeError(`Schedule method_args cannot set reserved ${key}`);
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
      await db.query(
        `UPDATE _smrt_agent_schedules
           SET status = 'error', last_error = ?
           WHERE id = ?`,
        redactErrorForPersistence(error),
        schedule.id,
      );
      this.logger.error('Schedule has an invalid cron or time zone', {
        scheduleId: schedule.id,
        error,
      });
      return { schedule: scheduleInfo, error: error as Error };
    }
    const nextRun = getNextCronDate(schedule.cron as string, timezone);

    // Create a job for this schedule
    // Nest agent_config under _agentConfig so TaskRunner can pass it
    // to the agent constructor separately from method args
    const args: Record<string, unknown> = {
      ...methodArgs,
      _scheduleId: String(schedule.id),
      _scheduledFor: scheduleOccurrenceInstant(schedule),
    };
    if (Object.keys(agentConfig).length > 0) {
      args._agentConfig = agentConfig;
    }

    // The occurrence, job insert and slot update share the locked transaction.
    const job = await jobs.enqueueJob({
      tenantId:
        typeof schedule.tenant_id === 'string' && schedule.tenant_id.length > 0
          ? (schedule.tenant_id as string)
          : null,
      queue: this.config.queue,
      objectType: canonicalAgentType,
      objectId: schedule.agent_id as string | null,
      method: (schedule.method as string) || 'run',
      args,
      priority: 75, // High priority for scheduled agents
      maxAttempts: 3,
      timeout: (schedule.timeout as number) || 3600000,
    });

    if (this.config.occurrenceSigner) {
      const signer = this.config.occurrenceSigner;
      const integrity = signer.sign(
        getScheduleAdmissionPayload(job, signer.keyId),
      );
      job.args = { ...job.args, _scheduleAdmission: integrity };
      if (!verifyScheduleAdmission(job, signer)) {
        throw new Error(
          'Occurrence signer returned invalid schedule admission integrity',
        );
      }
      // This model is bound to the admission transaction. No consumer can see
      // an unsigned protected job, and no producer save follows the commit.
      await job.save();
    }

    // Only now that the job is durably enqueued do we consume the slot:
    // increment running_count and advance next_run in one update.
    await db.query(
      `UPDATE _smrt_agent_schedules
         SET agent_type = ?,
             running_count = ?,
             next_run = ?
         WHERE id = ?`,
      canonicalAgentType,
      occupied + 1,
      nextRun.toISOString(),
      schedule.id,
    );

    return { schedule: scheduleInfo };
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
  next_run?: unknown;
  occurrence_time?: unknown;
  schedule_id_text?: string;
  schedule_tenant_text?: string | null;
  max_concurrent?: unknown;
}

function portableScheduleRow(row: ScheduleRow): ScheduleRow {
  return {
    ...row,
    id: row.schedule_id_text ?? row.id,
    tenant_id: Object.hasOwn(row, 'schedule_tenant_text')
      ? row.schedule_tenant_text
      : row.tenant_id,
  };
}

/** SQL datetime columns store UTC wall clocks; never parse them in host TZ. */
function scheduleOccurrenceInstant(schedule: ScheduleRow): string {
  const raw = schedule.occurrence_time ?? schedule.next_run;
  if (raw instanceof Date) return raw.toISOString();
  let text = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    text = `${text.replace(' ', 'T')}Z`;
  }
  return new Date(text).toISOString();
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
