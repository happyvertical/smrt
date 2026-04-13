import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  getAgentClassName,
  getAgentTypeAliases,
  getAgentTypeName,
} from './identity.js';

/**
 * Status of a scheduled agent
 */
export type ScheduleStatus = 'active' | 'paused' | 'disabled' | 'error';

/**
 * AgentSchedule model for cron-based agent scheduling
 *
 * This extends SmrtObject to store schedule metadata in the SMRT database.
 * Schedules are processed by the TaskRunner which creates jobs at scheduled times.
 *
 * @example
 * ```typescript
 * const schedule = new AgentSchedule({
 *   agentType: 'Praeco',
 *   agentId: 'praeco-main',
 *   cron: '0 2 * * *', // Run at 2 AM daily
 *   enabled: true,
 * });
 * await schedule.initialize();
 * await schedule.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_agent_schedules',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: {
    include: ['list', 'get', 'create', 'update', 'delete', 'enable', 'disable'],
  },
  mcp: { include: ['list', 'get'] },
})
export class AgentSchedule extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global schedules
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Canonical agent type to run (qualified name when available) */
  @field({ type: 'text' })
  agentType: string = '';

  /** Optional agent instance ID (for running specific instances) */
  @field({ type: 'text', nullable: true })
  agentId: string | null = null;

  /** Agent configuration to pass when running */
  @field({ type: 'json', sqlType: 'TEXT' })
  agentConfig: Record<string, unknown> = {};

  /** Cron expression (e.g., '0 2 * * *' for 2 AM daily) */
  @field({ type: 'text' })
  cron: string = '';

  /** Timezone for cron interpretation (default: UTC) */
  @field({ type: 'text' })
  timezone: string = 'UTC';

  /** Whether the schedule is enabled */
  @field({ type: 'boolean' })
  enabled: boolean = true;

  /** Current schedule status */
  @field({ type: 'text' })
  status: ScheduleStatus = 'active';

  /** Last time the agent was run */
  @field({ type: 'datetime', nullable: true })
  lastRun: Date | null = null;

  /** Next scheduled run time */
  @field({ type: 'datetime', nullable: true })
  nextRun: Date | null = null;

  /** Status of the last run */
  @field({ type: 'text', nullable: true })
  lastStatus: 'success' | 'failed' | null = null;

  /** Error message from last failed run */
  @field({ type: 'text', nullable: true })
  lastError: string | null = null;

  /** Total number of runs */
  @field({ type: 'integer' })
  runCount: number = 0;

  /** Total number of successful runs */
  @field({ type: 'integer' })
  successCount: number = 0;

  /** Total number of failed runs */
  @field({ type: 'integer' })
  failureCount: number = 0;

  /** Maximum concurrent runs (prevent overlapping) */
  @field({ type: 'integer' })
  maxConcurrent: number = 1;

  /** Current number of running instances */
  @field({ type: 'integer' })
  runningCount: number = 0;

  /** Timeout for agent execution in milliseconds (default: 1 hour) */
  @field({ type: 'integer' })
  timeout: number = 3600000;

  /** Method to call on the agent (default: 'run') */
  @field({ type: 'text' })
  method: string = 'run';

  /** Arguments to pass to the method */
  @field({ type: 'json', sqlType: 'TEXT' })
  methodArgs: Record<string, unknown> = {};

  /**
   * Enable the schedule
   */
  async enable(): Promise<void> {
    this.enabled = true;
    this.status = 'active';
    this.calculateNextRun();
    await this.save();
  }

  /**
   * Disable the schedule
   */
  async disable(): Promise<void> {
    this.enabled = false;
    this.status = 'disabled';
    await this.save();
  }

  /**
   * Pause the schedule temporarily
   */
  async pause(): Promise<void> {
    this.status = 'paused';
    await this.save();
  }

  /**
   * Resume a paused schedule
   */
  async resume(): Promise<void> {
    if (this.enabled) {
      this.status = 'active';
      this.calculateNextRun();
    }
    await this.save();
  }

  /**
   * Record a successful run
   */
  async recordSuccess(): Promise<void> {
    this.lastRun = new Date();
    this.lastStatus = 'success';
    this.lastError = null;
    this.runCount++;
    this.successCount++;
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.calculateNextRun();
    await this.save();
  }

  /**
   * Record a failed run
   */
  async recordFailure(error: string): Promise<void> {
    this.lastRun = new Date();
    this.lastStatus = 'failed';
    this.lastError = error;
    this.runCount++;
    this.failureCount++;
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.calculateNextRun();
    await this.save();
  }

  /**
   * Check if the schedule is due to run
   */
  isDue(): boolean {
    if (!this.enabled || this.status !== 'active') {
      return false;
    }

    if (!this.nextRun) {
      return false;
    }

    if (this.runningCount >= this.maxConcurrent) {
      return false;
    }

    return new Date() >= this.nextRun;
  }

  /**
   * Calculate the next run time based on cron expression
   */
  calculateNextRun(): void {
    if (!this.cron || !this.enabled) {
      this.nextRun = null;
      return;
    }

    try {
      const next = getNextCronDate(this.cron, this.timezone);
      this.nextRun = next;
    } catch {
      this.nextRun = null;
      this.status = 'error';
      this.lastError = `Invalid cron expression: ${this.cron}`;
    }
  }

  /**
   * Get a human-readable description of the schedule
   */
  getDescription(): string {
    const displayAgentType = getAgentClassName(this.agentType);
    const agent = this.agentId
      ? `${displayAgentType}#${this.agentId}`
      : displayAgentType;
    return `${agent}.${this.method}() @ ${this.cron}`;
  }

  /**
   * Lifecycle hook - calculate next run on save
   */
  async beforeSave(): Promise<void> {
    if (this.agentType) {
      this.agentType = getAgentTypeName(this.agentType);
    }
    if (!this.nextRun && this.enabled) {
      this.calculateNextRun();
    }
  }
}

/**
 * Collection for managing AgentSchedule objects
 */
export class AgentScheduleCollection extends SmrtCollection<AgentSchedule> {
  static readonly _itemClass = AgentSchedule;

  /**
   * Find all schedules for a specific tenant
   * @param tenantId - Tenant ID to filter by
   * @returns Array of AgentSchedule objects for the tenant
   */
  async findByTenant(tenantId: string): Promise<AgentSchedule[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global schedules (not associated with any tenant)
   * @returns Array of global AgentSchedule objects
   */
  async findGlobal(): Promise<AgentSchedule[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find schedules for a tenant including global schedules
   * @param tenantId - Tenant ID to include
   * @returns Array of AgentSchedule objects for the tenant and global schedules
   */
  async findWithGlobals(tenantId: string): Promise<AgentSchedule[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }

  /**
   * List schedules by status
   */
  async listByStatus(
    status: ScheduleStatus | ScheduleStatus[],
    options: { limit?: number } = {},
  ): Promise<AgentSchedule[]> {
    return this.list({
      where: {
        status: Array.isArray(status) ? status : [status],
      },
      orderBy: 'next_run ASC',
      limit: options.limit,
    });
  }

  /**
   * List schedules that are due to run
   */
  async listDue(options: { limit?: number } = {}): Promise<AgentSchedule[]> {
    const now = new Date().toISOString();
    return this.query(
      `SELECT * FROM _smrt_agent_schedules
       WHERE enabled = 1
       AND status = 'active'
       AND next_run <= ?
       AND running_count < max_concurrent
       ORDER BY next_run ASC
       LIMIT ?`,
      [now, options.limit || 100],
    );
  }

  /**
   * List schedules for a specific agent type
   */
  async listByAgentType(
    agentType: string,
    options: { limit?: number; includeDisabled?: boolean } = {},
  ): Promise<AgentSchedule[]> {
    const aliases = getAgentTypeAliases(agentType);
    const where: Record<string, unknown> =
      aliases.length > 1
        ? { 'agentType in': aliases }
        : { agentType: getAgentTypeName(agentType) };
    if (!options.includeDisabled) {
      where.enabled = true;
    }

    return this.list({
      where,
      orderBy: 'next_run ASC',
      limit: options.limit,
    });
  }

  /**
   * Get schedule statistics
   */
  async stats(): Promise<{
    total: number;
    active: number;
    paused: number;
    disabled: number;
    error: number;
    dueNow: number;
  }> {
    const now = new Date().toISOString();

    const result = await this._db.query(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) as disabled,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
        SUM(CASE WHEN enabled = 1 AND status = 'active' AND next_run <= ? THEN 1 ELSE 0 END) as due_now
       FROM _smrt_agent_schedules`,
      [now],
    );

    const row = result.rows[0] || {};
    return {
      total: (row.total as number) ?? 0,
      active: (row.active as number) ?? 0,
      paused: (row.paused as number) ?? 0,
      disabled: (row.disabled as number) ?? 0,
      error: (row.error as number) ?? 0,
      dueNow: (row.due_now as number) ?? 0,
    };
  }
}

// Parse a cron expression and get the next run date
// Supports standard 5-field cron format: minute hour day-of-month month day-of-week
// Examples:
// - '0 2 * * *' - 2:00 AM daily
// - '0 0 * * 0' - Midnight on Sundays
// - 'x/15 * * * *' - Every 15 minutes (where x is asterisk)
// - '0 9 1 * *' - 9:00 AM on the 1st of every month
function getNextCronDate(cron: string, _timezone: string = 'UTC'): Date {
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
  const maxIterations = 525600; // ~1 year in minutes
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
  // Wildcard matches everything
  if (expr === '*') {
    return true;
  }

  // Handle step values (*/5, 0-30/2)
  if (expr.includes('/')) {
    const [range, stepStr] = expr.split('/');
    const step = parseInt(stepStr, 10);
    if (range === '*') {
      return value % step === 0;
    }
    // Handle range with step
    if (range.includes('-')) {
      const [startStr, endStr] = range.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (value < start || value > end) return false;
      return (value - start) % step === 0;
    }
  }

  // Handle ranges (1-5)
  if (expr.includes('-')) {
    const [startStr, endStr] = expr.split('-');
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return value >= start && value <= end;
  }

  // Handle lists (1,3,5)
  if (expr.includes(',')) {
    const values = expr.split(',').map((v) => parseInt(v.trim(), 10));
    return values.includes(value);
  }

  // Exact match
  return value === parseInt(expr, 10);
}

export default AgentSchedule;
