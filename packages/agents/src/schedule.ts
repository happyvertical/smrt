import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getNextCronDate } from '@happyvertical/smrt-jobs';
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

type SaveOptions = NonNullable<Parameters<SmrtObject['save']>[0]>;

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
  // ScheduleRunner.poll() scans this predicate every minute (#2364, epic
  // #2382 finding A3): `enabled = true AND status = 'active' AND
  // next_run <= ?`, ordered by `next_run ASC`. `enabled` and `status` are
  // both equality filters and lead `next_run`, the range filter: a B-tree
  // composite serves an equality prefix as a direct lookup but can only
  // range-scan its trailing column, so the two equality columns come first
  // (the composite still serves `status`-only and `(enabled, status)`-only
  // reads as leftward prefixes).
  indexes: [
    {
      name: '_smrt_agent_schedules_enabled_status_next_run_idx',
      columns: ['enabled', 'status', 'nextRun'],
    },
  ],
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

  /**
   * IANA time zone the cron is evaluated in (e.g. `America/Edmonton`),
   * DST-correct. Defaults to `UTC`; a blank value is treated as `UTC`, and
   * an unrecognized zone puts the schedule in `error` status.
   */
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
   * Calculate the next run time from the cron expression, evaluated in
   * {@link timezone} (#3859).
   */
  calculateNextRun(): void {
    if (!this.cron || !this.enabled) {
      this.nextRun = null;
      return;
    }

    try {
      this.nextRun = getNextCronDate(this.cron, this.timezone?.trim() || 'UTC');
    } catch (error) {
      this.nextRun = null;
      this.status = 'error';
      // The jobs parser names the failing part (cron field or time zone).
      this.lastError =
        error instanceof Error && error.message
          ? error.message
          : `Invalid cron expression: ${this.cron}`;
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
   * Run {@link beforeSave} before persisting: core `save()` does not call a
   * model's own `beforeSave()`, so without this an enabled schedule created
   * with `create()` + `save()` kept a NULL `next_run` and never fired (#3390).
   */
  override async save(options: SaveOptions = {}): Promise<this> {
    await this.beforeSave();
    return super.save(options);
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
 * Cron next-run calculation is owned by `@happyvertical/smrt-jobs` so the
 * model's `calculateNextRun()` and the ScheduleRunner re-arm cannot diverge
 * (#3859); re-exported here for the model's tests.
 */
export { getNextCronDate };

export default AgentSchedule;
