import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  queryGlobal,
  queryWithGlobals,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
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
    // enable/disable are operator commands invoked in-process via the CLI;
    // they intentionally aren't exposed over HTTP.
    skipApiCheck: true,
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

  /**
   * Agent configuration to pass when running.
   *
   * Sensitive (#1540): may carry API keys/credentials, so it is excluded from
   * generated API/MCP responses and rejected as a `where` filter key.
   */
  @field({ type: 'json', sqlType: 'TEXT', sensitive: true })
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
   * Find all global schedules (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global AgentSchedule objects
   */
  async findGlobal(): Promise<AgentSchedule[]> {
    return queryGlobal<AgentSchedule>(this);
  }

  /**
   * Find schedules for a tenant including global schedules.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID to include
   * @returns Array of AgentSchedule objects for the tenant and global schedules
   */
  async findWithGlobals(tenantId: string): Promise<AgentSchedule[]> {
    return queryWithGlobals<AgentSchedule>(
      this,
      tenantId,
      'AgentSchedule.findWithGlobals',
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
}

/**
 * Parse a cron expression and get the next run date.
 *
 * Supports standard 5-field cron format: minute hour day-of-month month
 * day-of-week. Day-of-month / day-of-week follow POSIX OR semantics when both
 * are restricted (see the loop body). Matched against the host's local time
 * (not timezone-aware).
 *
 * Examples:
 * - '0 2 * * *' - 2:00 AM daily
 * - '0 0 * * 0' - Midnight on Sundays
 * - 'x/15 * * * *' - Every 15 minutes (where x is asterisk)
 * - '0 9 1 * *' - 9:00 AM on the 1st of every month
 *
 * Exported for unit testing of the matching logic.
 */
export function getNextCronDate(cron: string, _timezone: string = 'UTC'): Date {
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
  // a date matches if EITHER condition is met (OR logic). When only one
  // is restricted, only that field applies; when both are `*`, every day
  // matches. POSIX: `0 0 13 * 5` fires on the 13th OR any Friday.
  const dayIsWildcard = dayExpr === '*';
  const dowIsWildcard = dowExpr === '*';

  // Search for next matching date (limit to 1 year)
  const maxIterations = 525600; // ~1 year in minutes
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
