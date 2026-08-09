/**
 * Dormant `AgentSchedule` installation for the #2051 learning loop.
 *
 * `@happyvertical/smrt-agents` is an OPTIONAL dependency of this package
 * (the smrt-users seam): agents sits ABOVE fields in the dependency DAG (it
 * hard-depends on smrt-users, ai, and secrets — exactly the packages fields
 * keeps optional), so the installer dynamic-imports it and degrades
 * gracefully (`installed: false`) when it is not present. The schedule TARGET
 * (`FieldUsageLearningAgent`) needs no agents import at all — smrt-jobs
 * resolves `agentType` through the `ObjectRegistry`.
 *
 * DORMANT BY DEFAULT (the epic's suggestion-first posture): schedules are
 * created with `enabled: false` / `status: 'disabled'` unless the caller
 * explicitly opts in with `enabled: true` (or later runs the AgentSchedule
 * `enable()` operator command / flips the row). Activation is a deliberate
 * per-deployment decision documented in this package's AGENTS.md.
 */

import { importWorkspaceModule } from '@happyvertical/smrt-core/utils/import-workspace-module';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { deterministicFieldsUuid } from './deterministic-id.js';
import type {
  FieldUsageMaintenanceConfig,
  FieldUsageSuggestionConfig,
} from './usage-learning.js';
import { isMissingWorkspaceDependency } from './users-module.js';

/** Registry-qualified schedule target (`AgentSchedule.agentType`). */
export const FIELD_USAGE_LEARNING_AGENT_TYPE =
  '@happyvertical/smrt-fields:FieldUsageLearningAgent';

/** Method the aggregation/retention schedule invokes. */
export const FIELD_USAGE_MAINTENANCE_METHOD = 'runUsageMaintenance';

/** Method the suggestion-generation schedule invokes. */
export const FIELD_USAGE_SUGGESTION_METHOD = 'runSuggestionGeneration';

/**
 * Default cadence for counter maintenance: daily at 02:30 — in the SCHEDULER
 * HOST'S LOCAL TIME. See {@link ensureFieldUsageLearningSchedules} for why no
 * timezone can be selected here.
 */
export const DEFAULT_FIELD_USAGE_MAINTENANCE_CRON = '30 2 * * *';

/** Default cadence for suggestion generation: weekly, Monday 03:00 host-local. */
export const DEFAULT_FIELD_USAGE_SUGGESTION_CRON = '0 3 * * 1';

/**
 * Stable id for a global learning schedule, derived from the agent type and
 * method (the `TenantUsageMetric.recordUsage` precedent).
 *
 * `_smrt_agent_schedules` has no natural-key uniqueness on
 * `(agent_type, method)`, so a check-then-create would let two replicas
 * starting against an empty database each insert their own random-id row —
 * and with `enabled: true` every job would then run twice. A deterministic id
 * makes the insert converge on ONE primary key instead.
 */
export function fieldUsageScheduleId(method: string): Promise<string> {
  return deterministicFieldsUuid([
    'field-usage-learning-schedule',
    FIELD_USAGE_LEARNING_AGENT_TYPE,
    method,
  ]);
}

/**
 * Structural surface of the agents module the installer consumes (no static
 * import — mirrors `FieldPolicyUsersModule`). `create`/`list`/`save` are the
 * standard SmrtCollection/SmrtObject shapes.
 */
export interface FieldUsageAgentsScheduleRow {
  id?: string | null;
  enabled?: boolean;
  /**
   * Owning tenant; `null`/absent marks the GLOBAL schedules this installer
   * manages. Read so the existence check cannot mistake a tenant-specific
   * schedule for the global one.
   */
  tenantId?: string | null;
  save?: () => Promise<unknown>;
}

export interface FieldUsageAgentsModule {
  AgentScheduleCollection: {
    create(options: { db: DatabaseInterface }): Promise<{
      list(options: {
        where: Record<string, unknown>;
      }): Promise<FieldUsageAgentsScheduleRow[]>;
      create(
        data: Record<string, unknown>,
      ): Promise<FieldUsageAgentsScheduleRow>;
    }>;
  };
}

export interface EnsureFieldUsageLearningSchedulesOptions {
  db: DatabaseInterface;
  /**
   * Whether the schedules start enabled. DEFAULT FALSE — the learning loop
   * ships dormant; enabling it is an explicit deployment opt-in.
   */
  enabled?: boolean;
  maintenanceCron?: string;
  suggestionCron?: string;
  /** Threshold/retention overrides persisted into the schedules' methodArgs. */
  maintenanceArgs?: Partial<FieldUsageMaintenanceConfig>;
  suggestionArgs?: Partial<FieldUsageSuggestionConfig>;
  /** Injection seam for tests / hosts that already loaded the agents module. */
  agentsModule?: FieldUsageAgentsModule;
}

export interface EnsureFieldUsageLearningSchedulesResult {
  /** False when `@happyvertical/smrt-agents` is not installed (no-op). */
  installed: boolean;
  /** Schedules created by THIS call (existing rows are left untouched). */
  created: number;
}

/**
 * Idempotently create the two GLOBAL (tenant-null) `AgentSchedule` rows for
 * the learning loop — the aggregation/retention roll-up and the
 * suggestion-generation job. An existing GLOBAL row for the agent type +
 * method is never modified (operator state like enable/disable is preserved).
 *
 * The existence check is scoped to the GLOBAL rows deliberately: a deployment
 * may also run tenant-specific schedules for the same agent type and method
 * (the ambient-context runs the jobs support), and matching one of those would
 * silently skip installing the global schedule this function promises. Tenant
 * rows are read but never touched.
 *
 * Concurrency: each schedule is written under a DETERMINISTIC id
 * ({@link fieldUsageScheduleId}) with insert-only semantics, so two replicas
 * installing at once converge on one row — the pre-check is only the cheap
 * path, and a primary-key collision is treated as "already installed" rather
 * than an error. Insert-only also means an existing row's operator state
 * (enabled/disabled, edited cron) is never overwritten by a later install.
 *
 * **No timezone option, deliberately.** `AgentSchedule` carries a `timezone`
 * column, but `getNextCronDate(cron, _timezone)` ignores the argument and
 * matches against host-local `getHours()`/`getDate()`, and smrt-jobs'
 * `ScheduleRunner` recalculates with the same host-local parser. Accepting a
 * timezone here would advertise control this stack does not have, so these
 * schedules fire in the SCHEDULER HOST'S LOCAL TIME — pick crons accordingly
 * (see `agents/usage-learning.md`). Fixing the agents-side parser is out of
 * scope for this package.
 *
 * System operation: global schedules are platform state, so a non-bypass
 * ambient tenant context is rejected (fail closed) — call this from trusted
 * startup/migration code.
 */
export async function ensureFieldUsageLearningSchedules(
  options: EnsureFieldUsageLearningSchedulesOptions,
): Promise<EnsureFieldUsageLearningSchedulesResult> {
  const context = getCurrentTenant();
  if (context && !isSuperAdminBypass()) {
    throw new TenantIsolationError(
      'ensureFieldUsageLearningSchedules installs GLOBAL schedules and must ' +
        'run from trusted execution (no ambient tenant context, or ' +
        'super-admin bypass)',
      { tenantId: context.tenantId },
    );
  }

  let agentsModule = options.agentsModule;
  if (!agentsModule) {
    try {
      agentsModule = await importWorkspaceModule<FieldUsageAgentsModule>({
        packageName: '@happyvertical/smrt-agents',
        sourceEntry: 'packages/agents/src/index.ts',
        purpose: 'field usage learning schedule installation',
      });
    } catch (error) {
      if (isMissingWorkspaceDependency(error, '@happyvertical/smrt-agents')) {
        return { installed: false, created: 0 };
      }
      throw error;
    }
  }

  const schedules = await agentsModule.AgentScheduleCollection.create({
    db: options.db,
  });
  const enabled = options.enabled ?? false;
  let created = 0;

  const definitions = [
    {
      method: FIELD_USAGE_MAINTENANCE_METHOD,
      cron: options.maintenanceCron ?? DEFAULT_FIELD_USAGE_MAINTENANCE_CRON,
      methodArgs: options.maintenanceArgs ?? {},
    },
    {
      method: FIELD_USAGE_SUGGESTION_METHOD,
      cron: options.suggestionCron ?? DEFAULT_FIELD_USAGE_SUGGESTION_CRON,
      methodArgs: options.suggestionArgs ?? {},
    },
  ];

  for (const definition of definitions) {
    const existing = await schedules.list({
      where: {
        agentType: FIELD_USAGE_LEARNING_AGENT_TYPE,
        method: definition.method,
      },
    });
    // Filter to the GLOBAL scope in memory rather than adding
    // `tenantId: null` to the where clause: an explicit `tenant_id IS NULL`
    // filter is what the tenancy interceptor flags as an isolation violation
    // (the reason `queryGlobal` exists), and this must also work under the
    // bypass context the guard above allows.
    if (existing.some(isGlobalScheduleRow)) {
      continue;
    }

    const id = await fieldUsageScheduleId(definition.method);
    let row: FieldUsageAgentsScheduleRow;
    try {
      row = await schedules.create({
        id,
        tenantId: null,
        agentType: FIELD_USAGE_LEARNING_AGENT_TYPE,
        agentId: null,
        cron: definition.cron,
        method: definition.method,
        agentConfig: {},
        methodArgs: definition.methodArgs,
        enabled,
        status: enabled ? 'active' : 'disabled',
        // Strict insert: a concurrent replica that already created this row
        // must NOT be adopted-and-overwritten (that would resurrect a
        // deliberately disabled schedule or clobber an edited cron).
        _insertOnly: true,
      });
    } catch (error) {
      // ONLY a confirmed collision may be swallowed. Constraint-error text is
      // not portable across sqlite/PostgreSQL/DuckDB (and core wraps driver
      // errors), so the evidence is the ROW ITSELF: re-read the deterministic
      // id and treat "it exists now" as proof another installer won the race.
      // Anything else — schema drift, validation, a dropped connection — must
      // propagate, or the installer would report success with the schedule
      // missing.
      const raced = await schedules.list({ where: { id } });
      if (raced.length === 0) {
        throw error;
      }
      continue;
    }
    // The schedulePersonaInstance precedent: an explicit save() runs the
    // model's beforeSave (next-run calculation) even if create() already
    // persisted the row.
    await row.save?.();
    created += 1;
  }

  return { installed: true, created };
}

/** Whether a schedule row is one of the GLOBAL (tenant-null) rows. */
function isGlobalScheduleRow(row: FieldUsageAgentsScheduleRow): boolean {
  return row.tenantId === null || row.tenantId === undefined;
}
