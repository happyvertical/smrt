/**
 * The #2051 learning loop: scheduled aggregation/retention over
 * `_smrt_field_usage_counters` and threshold-driven generation of
 * `_smrt_field_policy_suggestions`.
 *
 * Scheduling substrate: there is NO generic cron package API — the de-facto
 * convention is an `AgentSchedule` row (`@happyvertical/smrt-agents`)
 * dispatched by smrt-jobs' `ScheduleRunner`, which resolves `agentType`
 * through the `ObjectRegistry` and invokes the method on the registered
 * class. {@link FieldUsageLearningAgent} is that schedule target. It is a
 * registered `@smrt()` SmrtObject — deliberately NOT a subclass of the agents
 * package's `Agent` base: smrt-agents sits above smrt-fields in the
 * dependency DAG (it hard-depends on smrt-users/ai/secrets, all of which this
 * package keeps optional), and the dispatch machinery only requires registry
 * resolution plus the jobs package's `backgroundEligibleMethods` allowlist
 * contract (a static property, no import needed). Schedule rows are created
 * DORMANT by `ensureFieldUsageLearningSchedules` (see `usage-schedules.ts`).
 *
 * Both jobs are tenant-safe by construction: in trusted execution (no ambient
 * tenant context, or super-admin bypass) they operate across all tenants;
 * inside a non-bypass tenant context they restrict themselves to the ambient
 * tenant (fail closed), so per-tenant schedule rows are also valid.
 */

import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { FieldPolicySuggestionCollection } from './collections/FieldPolicySuggestionCollection.js';
import {
  decodeHistogramKey,
  FieldUsageCounterCollection,
  isHistogramEligibleField,
} from './collections/FieldUsageCounterCollection.js';
import {
  type FieldDefinitionMap,
  getFieldReadPermission,
  getObjectFieldMap,
  isSensitiveField,
  isTransientField,
} from './field-definitions.js';
import {
  ACTIVE_SUGGESTION_KEY,
  type FieldPolicySuggestion,
} from './models/FieldPolicySuggestion.js';
import type { FieldUsageCounter } from './models/FieldUsageCounter.js';
import {
  emptyHistogram,
  fieldUsagePeriodForDate,
} from './models/FieldUsageCounter.js';
import type {
  FieldPolicySuggestionKind,
  ResolvedFieldPolicy,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config (documented defaults; overridable per run through the schedule's
// `methodArgs` payload)
// ---------------------------------------------------------------------------

export interface FieldUsageMaintenanceConfig {
  /** Drop counter buckets older than this (by `period`). Default 90 days. */
  counterMaxAgeMs: number;
  /** Keep at most this many counter rows (oldest pruned first). Default 100k. */
  counterMaxRows: number;
  /** Drop ACCEPTED suggestions decided longer ago than this. Default 180 days. */
  suggestionAcceptedMaxAgeMs: number;
}

export const FIELD_USAGE_MAINTENANCE_DEFAULTS: FieldUsageMaintenanceConfig = {
  counterMaxAgeMs: 90 * DAY_MS,
  counterMaxRows: 100_000,
  suggestionAcceptedMaxAgeMs: 180 * DAY_MS,
};

export interface FieldUsageSuggestionConfig {
  /** Usage window the thresholds evaluate over. Default 30 days. */
  windowDays: number;
  /** Distinct users required for a `promote` suggestion. Default 5. */
  minDistinctUsers: number;
  /** Submissions required before a `default` suggestion. Default 10. */
  minSetCount: number;
  /**
   * Share of windowed submissions a single value must reach for a `default`
   * suggestion (denominator is TOTAL setCount, so histogram overflow can only
   * make this more conservative). Default 0.8.
   */
  defaultDominanceRatio: number;
}

export const FIELD_USAGE_SUGGESTION_DEFAULTS: FieldUsageSuggestionConfig = {
  windowDays: 30,
  minDistinctUsers: 5,
  minSetCount: 10,
  defaultDominanceRatio: 0.8,
};

export interface FieldUsageMaintenanceSummary {
  countersPruned: number;
  suggestionsPruned: number;
}

export interface FieldUsageSuggestionRunSummary {
  /**
   * Suggestions this run wrote. Under overlapping runs both may report a
   * create for the same candidate while the model's active-slot unique index
   * converges them onto ONE row (see `FieldPolicySuggestion.activeKey`) — the
   * tally is per-run work, not a row count.
   */
  created: number;
  /** Candidates suppressed by a pending or cooling-down suggestion. */
  suppressed: number;
  /** Distinct (tenant, objectRef, fieldName) groups evaluated. */
  groupsConsidered: number;
  /**
   * Groups whose evaluation threw and was skipped. A failing group never
   * aborts the run — a global pass must keep serving every other tenant.
   */
  groupsFailed: number;
  /**
   * Bounded sample of failure messages (`MAX_REPORTED_GROUP_FAILURES`) so an
   * operator can see WHY without the summary growing with the queue.
   */
  failures: string[];
}

/** Cap on {@link FieldUsageSuggestionRunSummary.failures} entries. */
export const MAX_REPORTED_GROUP_FAILURES = 5;

// ---------------------------------------------------------------------------
// Retention (the pruneChangeFeed shape: {maxAgeMs?, maxRows?}, oldest-first)
// ---------------------------------------------------------------------------

export interface FieldUsageCounterRetention {
  maxAgeMs?: number;
  maxRows?: number;
  /** Restrict pruning to one tenant (ambient-context runs). */
  tenantId?: string | null;
}

/**
 * Prune counter rows to bound growth. Applies whichever bounds are provided
 * (at least one required): `maxAgeMs` drops buckets whose `period` day is
 * older than the cutoff; `maxRows` keeps only the newest N rows by
 * `(period, id)`, deleting oldest-first. Mirrors core's `pruneChangeFeed`.
 */
export async function pruneFieldUsageCounters(
  db: DatabaseInterface,
  retention: FieldUsageCounterRetention,
): Promise<{ pruned: number }> {
  const { maxAgeMs, maxRows } = retention;
  if (maxAgeMs == null && maxRows == null) {
    throw new Error('pruneFieldUsageCounters requires maxAgeMs and/or maxRows');
  }
  if (maxAgeMs != null && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)) {
    throw new Error(
      `pruneFieldUsageCounters maxAgeMs must be >= 0, got ${maxAgeMs}`,
    );
  }
  if (maxRows != null && (!Number.isFinite(maxRows) || maxRows < 0)) {
    throw new Error(
      `pruneFieldUsageCounters maxRows must be >= 0, got ${maxRows}`,
    );
  }

  const tenantCondition = retention.tenantId ? ' AND tenant_id = ?' : '';
  const tenantParams = retention.tenantId ? [retention.tenantId] : [];
  let pruned = 0;

  if (maxAgeMs != null) {
    const cutoffDay = fieldUsagePeriodForDate(new Date(Date.now() - maxAgeMs));
    pruned += await deleteCounted(db, `period < ?${tenantCondition}`, [
      cutoffDay,
      ...tenantParams,
    ]);
  }

  if (maxRows != null) {
    const countRows = getQueryRows(
      await db.query(
        `SELECT COUNT(*) AS total FROM _smrt_field_usage_counters` +
          `${retention.tenantId ? ' WHERE tenant_id = ?' : ''}`,
        ...tenantParams,
      ),
    );
    const total = numberFromRow(countRows[0] ?? {}, 'total');
    const excess = total - Math.floor(maxRows);
    if (excess > 0) {
      await db.query(
        `DELETE FROM _smrt_field_usage_counters
          WHERE id IN (
            SELECT id FROM _smrt_field_usage_counters
            ${retention.tenantId ? 'WHERE tenant_id = ?' : ''}
            ORDER BY period ASC, id ASC
            LIMIT ${excess}
          )`,
        ...tenantParams,
      );
      pruned += excess;
    }
  }

  return { pruned };
}

export interface FieldPolicySuggestionRetention {
  /** Drop ACCEPTED suggestions decided longer ago than this. */
  acceptedMaxAgeMs: number;
  /** Restrict pruning to one tenant (ambient-context runs). */
  tenantId?: string | null;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/**
 * Prune settled suggestion rows ONLY (#2051 pin): a dismissed suggestion once
 * its cool-down has fully elapsed (its suppression job is done), and an
 * accepted suggestion once it is old. Pending suggestions are NEVER pruned.
 */
export async function pruneFieldPolicySuggestions(
  db: DatabaseInterface,
  retention: FieldPolicySuggestionRetention,
): Promise<{ pruned: number }> {
  const { acceptedMaxAgeMs } = retention;
  if (!Number.isFinite(acceptedMaxAgeMs) || acceptedMaxAgeMs < 0) {
    throw new Error(
      `pruneFieldPolicySuggestions acceptedMaxAgeMs must be >= 0, got ` +
        `${acceptedMaxAgeMs}`,
    );
  }
  const now = retention.now ?? new Date();
  const acceptedCutoff = new Date(now.getTime() - acceptedMaxAgeMs);
  const tenantCondition = retention.tenantId ? ' AND tenant_id = ?' : '';
  const tenantParams = retention.tenantId ? [retention.tenantId] : [];

  const pruned = await deleteCounted(
    db,
    `((status = 'dismissed' AND cooldown_until IS NOT NULL ` +
      `AND cooldown_until <= ?) ` +
      `OR (status = 'accepted' AND decided_at IS NOT NULL ` +
      `AND decided_at <= ?))${tenantCondition}`,
    [now.toISOString(), acceptedCutoff.toISOString(), ...tenantParams],
    '_smrt_field_policy_suggestions',
  );
  return { pruned };
}

// ---------------------------------------------------------------------------
// Job entry points (pure functions; the agent methods delegate here)
// ---------------------------------------------------------------------------

export interface RunFieldUsageMaintenanceOptions
  extends Partial<FieldUsageMaintenanceConfig> {
  db: DatabaseInterface;
}

/**
 * The "aggregation" schedule's work. Ingestion pre-aggregates into period
 * buckets, so the roll-up job's real job is retention: prune counter buckets
 * per `{maxAgeMs, maxRows}` and settle old suggestion rows.
 */
export async function runFieldUsageMaintenance(
  options: RunFieldUsageMaintenanceOptions,
): Promise<FieldUsageMaintenanceSummary> {
  const config = normalizeMaintenanceConfig(options);
  const ambientTenantId = restrictingTenantId();

  const counters = await pruneFieldUsageCounters(options.db, {
    maxAgeMs: config.counterMaxAgeMs,
    maxRows: config.counterMaxRows,
    tenantId: ambientTenantId,
  });
  const suggestions = await pruneFieldPolicySuggestions(options.db, {
    acceptedMaxAgeMs: config.suggestionAcceptedMaxAgeMs,
    tenantId: ambientTenantId,
  });

  return {
    countersPruned: counters.pruned,
    suggestionsPruned: suggestions.pruned,
  };
}

export interface RunFieldPolicySuggestionGenerationOptions
  extends Partial<FieldUsageSuggestionConfig> {
  db: DatabaseInterface;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/**
 * The threshold job: evaluate windowed counters per
 * `(tenantId, objectRef, fieldName)` and create PENDING suggestions with
 * human-readable evidence.
 *
 * - `promote`: at least `minDistinctUsers` distinct users set the field to a
 *   non-default value in the window AND the org-resolved visibility is not
 *   already `basic`.
 * - `default`: at least `minSetCount` TOTAL submissions, a single recorded
 *   value covers `defaultDominanceRatio` of those TOTAL submissions (not of
 *   the deviations — see `FieldUsageCounter.submissionCount`), and it differs
 *   from the org-resolved default. Only histogram-eligible fields
 *   (low-cardinality, non-sensitive, non-gated) can ever qualify, and a group
 *   containing a legacy bucket with no recorded total is skipped rather than
 *   ratioed against the wrong denominator.
 *
 * Dedup: a candidate is suppressed while the same
 * `(tenantId, objectRef, fieldName, kind)` has a PENDING suggestion or a
 * DISMISSED one still inside its cool-down. Accepted history never blocks —
 * once accepted, the resolved policy itself stops regeneration (visibility is
 * basic / the default matches). The pre-check is an optimization only: the
 * single-active guarantee is STRUCTURAL (`FieldPolicySuggestion.activeKey` in
 * `conflictColumns`), so overlapping runs upsert onto one row instead of
 * duplicating.
 *
 * Sensitive, read-permission-gated, and transient fields are skipped
 * entirely: their usage rows are count-only observability data and never
 * produce suggestions.
 */
export async function runFieldPolicySuggestionGeneration(
  options: RunFieldPolicySuggestionGenerationOptions,
): Promise<FieldUsageSuggestionRunSummary> {
  const config = normalizeSuggestionConfig(options);
  const now = options.now ?? new Date();
  const ambientTenantId = restrictingTenantId();

  const counters = await FieldUsageCounterCollection.create({
    db: options.db,
  });
  const suggestions = await FieldPolicySuggestionCollection.create({
    db: options.db,
  });

  const fromPeriod = fieldUsagePeriodForDate(
    new Date(now.getTime() - (config.windowDays - 1) * DAY_MS),
  );
  const toPeriod = fieldUsagePeriodForDate(now);
  const rows = await counters.listWindow({
    fromPeriod,
    toPeriod,
    tenantId: ambientTenantId,
  });

  const groups = groupCounters(rows);
  const fieldMaps = new Map<string, FieldDefinitionMap | null>();
  const resolvedPolicies = new Map<
    string,
    Record<string, ResolvedFieldPolicy>
  >();

  const summary: FieldUsageSuggestionRunSummary = {
    created: 0,
    suppressed: 0,
    groupsConsidered: 0,
    groupsFailed: 0,
    failures: [],
  };

  for (const group of groups) {
    summary.groupsConsidered += 1;

    // One bad group must NEVER abort the run: a global (cross-tenant) pass
    // processes every tenant, so an unprocessable group — a since-changed
    // field, a rejected proposal payload, a transient db error — would
    // otherwise starve every group after it for as long as its buckets live.
    // Failures are counted (with a bounded sample of messages) and the run
    // continues.
    try {
      await evaluateGroup(group);
    } catch (error) {
      summary.groupsFailed += 1;
      if (summary.failures.length < MAX_REPORTED_GROUP_FAILURES) {
        summary.failures.push(
          `${group.tenantId} ${group.objectRef}.${group.fieldName}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return summary;

  async function evaluateGroup(group: CounterGroup): Promise<void> {
    let fieldMap = fieldMaps.get(group.objectRef);
    if (fieldMap === undefined) {
      try {
        fieldMap = await getObjectFieldMap(group.objectRef);
      } catch {
        fieldMap = null; // stale counters for a since-removed class
      }
      fieldMaps.set(group.objectRef, fieldMap);
    }
    if (!fieldMap) {
      return;
    }
    const fieldDef = fieldMap.get(group.fieldName);
    if (
      !fieldDef ||
      isSensitiveField(fieldDef) ||
      getFieldReadPermission(fieldDef) !== undefined ||
      isTransientField(fieldDef)
    ) {
      return;
    }

    const stats = mergeGroupStats(group.buckets);

    const policyKey = `${group.tenantId}\0${group.objectRef}`;
    let orgFields = resolvedPolicies.get(policyKey);
    if (!orgFields) {
      // Org-tier resolution (code → app → tenant chain; no user tier). The
      // resolver's own context assertion keeps ambient-context runs honest.
      const { resolveFieldPolicy } = await import('./field-policy-resolver.js');
      const resolved = await resolveFieldPolicy(group.objectRef, {
        tenantId: group.tenantId,
        db: options.db,
      });
      orgFields = resolved.fields;
      resolvedPolicies.set(policyKey, orgFields);
    }
    const fieldPolicy = orgFields[group.fieldName];
    if (!fieldPolicy) {
      return;
    }

    // -- promote ---------------------------------------------------------
    if (
      stats.distinctUsers >= config.minDistinctUsers &&
      fieldPolicy.visibility !== 'basic'
    ) {
      const created = await createUnlessSuppressed(suggestions, {
        tenantId: group.tenantId,
        objectRef: group.objectRef,
        fieldName: group.fieldName,
        kind: 'promote',
        proposedValue: null,
        evidence: buildFieldUsageEvidence({
          kind: 'promote',
          fieldName: group.fieldName,
          objectRef: group.objectRef,
          windowStart: fromPeriod,
          windowEnd: toPeriod,
          distinctUsers: stats.distinctUsers,
          distinctUsersAtLeast: stats.distinctUsersOverflowed,
          setCount: stats.setCount,
          submissionCount: stats.submissionTotalKnown
            ? stats.submissionCount
            : undefined,
          threshold: config.minDistinctUsers,
        }),
        now,
      });
      if (created) {
        summary.created += 1;
      } else {
        summary.suppressed += 1;
      }
    }

    // -- default ---------------------------------------------------------
    // Dominance is measured against TOTAL submissions, never against
    // deviations alone: a value seen only in deviations would otherwise look
    // 100% dominant even when the default it would replace is what almost
    // everyone submits. Legacy buckets (no recorded total) make the
    // denominator unknown, so the group is skipped rather than guessed.
    if (
      isHistogramEligibleField(fieldDef) &&
      stats.submissionTotalKnown &&
      stats.submissionCount >= config.minSetCount
    ) {
      const top = topHistogramEntry(stats.histogram);
      if (top) {
        const share = top.count / stats.submissionCount;
        const proposed = decodeHistogramKey(fieldDef, top.key);
        const currentDefault = fieldPolicy.hasDefault
          ? fieldPolicy.defaultValue
          : undefined;
        if (
          share >= config.defaultDominanceRatio &&
          !sameProposedValue(proposed, currentDefault)
        ) {
          const created = await createUnlessSuppressed(suggestions, {
            tenantId: group.tenantId,
            objectRef: group.objectRef,
            fieldName: group.fieldName,
            kind: 'default',
            proposedValue: JSON.stringify(proposed),
            evidence: buildFieldUsageEvidence({
              kind: 'default',
              fieldName: group.fieldName,
              objectRef: group.objectRef,
              windowStart: fromPeriod,
              windowEnd: toPeriod,
              distinctUsers: stats.distinctUsers,
              distinctUsersAtLeast: stats.distinctUsersOverflowed,
              setCount: stats.setCount,
              submissionCount: stats.submissionCount,
              threshold: config.minSetCount,
              topValue: proposed,
              topValueShare: share,
            }),
            now,
          });
          if (created) {
            summary.created += 1;
          } else {
            summary.suppressed += 1;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The schedule target
// ---------------------------------------------------------------------------

/**
 * The registered schedule target for the #2051 learning loop (see the module
 * doc for why it is NOT an smrt-agents `Agent` subclass). Rows of its system
 * table are never written — the class exists so `AgentSchedule.agentType`
 * resolves through the `ObjectRegistry` and smrt-jobs can construct it and
 * invoke the two allowlisted methods.
 */
@smrt({
  tableName: '_smrt_field_usage_learning_agents',
  api: { include: [] },
  cli: false,
  mcp: { include: [] },
})
export class FieldUsageLearningAgent extends SmrtObject {
  /**
   * The smrt-jobs opt-in background allowlist (S5 contract): ONLY these two
   * methods are reachable from a persisted job/schedule row.
   */
  static backgroundEligibleMethods: ReadonlyArray<string> = [
    'runUsageMaintenance',
    'runSuggestionGeneration',
  ];

  constructor(options: SmrtObjectOptions = {}) {
    super(options);
  }

  /** Schedule entry point for {@link runFieldUsageMaintenance}. */
  async runUsageMaintenance(
    args: Record<string, unknown> = {},
  ): Promise<FieldUsageMaintenanceSummary> {
    return runFieldUsageMaintenance({
      db: this.db,
      ...pickFiniteNumbers(args, [
        'counterMaxAgeMs',
        'counterMaxRows',
        'suggestionAcceptedMaxAgeMs',
      ]),
    });
  }

  /** Schedule entry point for {@link runFieldPolicySuggestionGeneration}. */
  async runSuggestionGeneration(
    args: Record<string, unknown> = {},
  ): Promise<FieldUsageSuggestionRunSummary> {
    return runFieldPolicySuggestionGeneration({
      db: this.db,
      ...pickFiniteNumbers(args, [
        'windowDays',
        'minDistinctUsers',
        'minSetCount',
        'defaultDominanceRatio',
      ]),
    });
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface FieldUsageEvidenceInput {
  kind: FieldPolicySuggestionKind;
  objectRef: string;
  fieldName: string;
  windowStart: string;
  windowEnd: string;
  distinctUsers: number;
  /** True when the distinct-user set overflowed (count is a lower bound). */
  distinctUsersAtLeast: boolean;
  /** Submissions that DIFFERED from the resolved default. */
  setCount: number;
  /**
   * TOTAL submissions observed in the window (the dominance denominator).
   * `undefined` only for legacy buckets that never recorded a total, in which
   * case the summary states the deviation count alone.
   */
  submissionCount?: number;
  /** The threshold the candidate cleared (documented in the evidence). */
  threshold: number;
  topValue?: unknown;
  topValueShare?: number;
}

/**
 * Human-readable evidence for a suggestion: a `summary` sentence a reviewer
 * can read as-is, plus the structured numbers behind it.
 *
 * The sentence always states BOTH numbers when known — deviations and total
 * submissions — so a reviewer can see the base rate a dominance percentage was
 * computed against instead of trusting a bare ratio.
 */
export function buildFieldUsageEvidence(
  input: FieldUsageEvidenceInput,
): Record<string, unknown> {
  const users = `${input.distinctUsersAtLeast ? 'at least ' : ''}${
    input.distinctUsers
  } user${input.distinctUsers === 1 && !input.distinctUsersAtLeast ? '' : 's'}`;
  const deviations =
    `${input.setCount} of ` +
    (input.submissionCount === undefined
      ? 'an unrecorded number of submissions'
      : `${input.submissionCount} submission${
          input.submissionCount === 1 ? '' : 's'
        }`);
  const base =
    `${users} set "${input.fieldName}" to a non-default value in ` +
    `${deviations} between ${input.windowStart} and ${input.windowEnd}.`;
  const summary =
    input.kind === 'default'
      ? `${base} ${Math.round((input.topValueShare ?? 0) * 100)}% of all ` +
        `${input.submissionCount ?? 0} submissions used the value ` +
        `${JSON.stringify(input.topValue)}.`
      : base;

  return {
    summary,
    objectRef: input.objectRef,
    fieldName: input.fieldName,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    distinctUsers: input.distinctUsers,
    ...(input.distinctUsersAtLeast ? { distinctUsersAtLeast: true } : {}),
    setCount: input.setCount,
    ...(input.submissionCount !== undefined
      ? { submissionCount: input.submissionCount }
      : { submissionCountUnknown: true }),
    threshold: input.threshold,
    ...(input.topValue !== undefined ? { topValue: input.topValue } : {}),
    ...(input.topValueShare !== undefined
      ? { topValueShare: Number(input.topValueShare.toFixed(4)) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface CounterGroup {
  tenantId: string;
  objectRef: string;
  fieldName: string;
  buckets: FieldUsageCounter[];
}

function groupCounters(rows: FieldUsageCounter[]): CounterGroup[] {
  const byKey = new Map<string, CounterGroup>();
  for (const row of rows) {
    if (!row.tenantId) {
      continue;
    }
    const key = `${row.tenantId}\0${row.objectRef}\0${row.fieldName}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        tenantId: row.tenantId,
        objectRef: row.objectRef,
        fieldName: row.fieldName,
        buckets: [],
      };
      byKey.set(key, group);
    }
    group.buckets.push(row);
  }
  return [...byKey.values()];
}

interface GroupStats {
  /** Total submissions in the window (the dominance denominator). */
  submissionCount: number;
  /**
   * False when ANY bucket in the window predates the `submissionCount` column
   * (or is corrupt): the total is then unknown, so `default` suggestions are
   * skipped for the group rather than computed against a wrong denominator.
   */
  submissionTotalKnown: boolean;
  /** Submissions that differed from the resolved default. */
  setCount: number;
  distinctUsers: number;
  distinctUsersOverflowed: boolean;
  histogram: Record<string, number>;
}

/**
 * Merge a group's buckets: sum counts, UNION the capped distinct-user sets
 * (an overflowed bucket makes the union an honest lower bound), and sum
 * histogram buckets.
 */
function mergeGroupStats(buckets: FieldUsageCounter[]): GroupStats {
  let submissionCount = 0;
  let submissionTotalKnown = true;
  let setCount = 0;
  let overflowed = false;
  const users = new Set<string>();
  // Null-prototype: histogram keys are user-supplied ids, so `constructor` /
  // `toString` / `__proto__` must accumulate as plain data (see
  // `emptyHistogram`). The `hasOwn` read below is the matching own-key test.
  const histogram = emptyHistogram();

  for (const bucket of buckets) {
    submissionCount += bucket.submissionCount;
    if (bucket.isLegacyBucket()) {
      submissionTotalKnown = false;
    }
    setCount += bucket.setCount;
    overflowed = overflowed || bucket.distinctUsersOverflowed;
    for (const id of bucket.getDistinctUserIds()) {
      users.add(id);
    }
    for (const [key, count] of Object.entries(bucket.getValueHistogram())) {
      histogram[key] =
        (Object.hasOwn(histogram, key) ? histogram[key] : 0) + count;
    }
  }

  return {
    submissionCount,
    submissionTotalKnown,
    setCount,
    distinctUsers: users.size,
    distinctUsersOverflowed: overflowed,
    histogram,
  };
}

function topHistogramEntry(
  histogram: Record<string, number>,
): { key: string; count: number } | null {
  let top: { key: string; count: number } | null = null;
  for (const [key, count] of Object.entries(histogram)) {
    if (!top || count > top.count) {
      top = { key, count };
    }
  }
  return top;
}

function sameProposedValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function createUnlessSuppressed(
  suggestions: FieldPolicySuggestionCollection,
  candidate: {
    tenantId: string;
    objectRef: string;
    fieldName: string;
    kind: FieldPolicySuggestionKind;
    proposedValue: string | null;
    evidence: Record<string, unknown>;
    now: Date;
  },
): Promise<boolean> {
  const existing = await suggestions.list({
    where: {
      tenantId: candidate.tenantId,
      objectRef: candidate.objectRef,
      fieldName: candidate.fieldName,
      kind: candidate.kind,
    },
  });
  // Suppression keys off the ACTIVE SLOT, not `status`: a row holding
  // `activeKey === 'active'` is either pending or mid-decision (the
  // non-transactional accept holds the slot across its policy write). Keying
  // off `status` alone would let generation insert a competing pending row in
  // that window — which would then resolve against the pre-acceptance policy
  // and collide with the decision's compensation. Cooling-down dismissals
  // suppress too, even though they have released the slot.
  const suppressed = existing.some(
    (row) =>
      row.activeKey === ACTIVE_SUGGESTION_KEY ||
      (row.status === 'dismissed' && isWithinCoolDown(row, candidate.now)),
  );
  if (suppressed) {
    return false;
  }

  await suggestions.create({
    tenantId: candidate.tenantId,
    objectRef: candidate.objectRef,
    fieldName: candidate.fieldName,
    kind: candidate.kind,
    proposedValue: candidate.proposedValue,
    evidence: JSON.stringify(candidate.evidence),
    status: 'pending',
  });
  return true;
}

function isWithinCoolDown(row: FieldPolicySuggestion, now: Date): boolean {
  const raw = row.cooldownUntil as Date | string | null;
  if (raw === null || raw === undefined) {
    return false;
  }
  const until = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(until) && until > now.getTime();
}

/** Ambient-context restriction: non-bypass runs stay inside their tenant. */
function restrictingTenantId(): string | null {
  const context = getCurrentTenant();
  if (!context || isSuperAdminBypass()) {
    return null;
  }
  return context.tenantId;
}

/**
 * Retention bounds are NON-NEGATIVE, not strictly positive: `0` is a meaningful
 * value the prune functions explicitly accept (`maxRows: 0` purges every row,
 * `maxAgeMs: 0` every bucket before today), so silently swapping it for the
 * 100k/90d default would ignore an operator's explicit "purge everything".
 * Only `undefined` (and non-finite junk) falls back to the default.
 */
function normalizeMaintenanceConfig(
  options: Partial<FieldUsageMaintenanceConfig>,
): FieldUsageMaintenanceConfig {
  return {
    counterMaxAgeMs: nonNegativeOrDefault(
      options.counterMaxAgeMs,
      FIELD_USAGE_MAINTENANCE_DEFAULTS.counterMaxAgeMs,
    ),
    counterMaxRows: nonNegativeOrDefault(
      options.counterMaxRows,
      FIELD_USAGE_MAINTENANCE_DEFAULTS.counterMaxRows,
    ),
    suggestionAcceptedMaxAgeMs: nonNegativeOrDefault(
      options.suggestionAcceptedMaxAgeMs,
      FIELD_USAGE_MAINTENANCE_DEFAULTS.suggestionAcceptedMaxAgeMs,
    ),
  };
}

function normalizeSuggestionConfig(
  options: Partial<FieldUsageSuggestionConfig>,
): FieldUsageSuggestionConfig {
  const ratio = positiveOrDefault(
    options.defaultDominanceRatio,
    FIELD_USAGE_SUGGESTION_DEFAULTS.defaultDominanceRatio,
  );
  return {
    windowDays: Math.max(
      1,
      Math.floor(
        positiveOrDefault(
          options.windowDays,
          FIELD_USAGE_SUGGESTION_DEFAULTS.windowDays,
        ),
      ),
    ),
    minDistinctUsers: Math.max(
      1,
      Math.floor(
        positiveOrDefault(
          options.minDistinctUsers,
          FIELD_USAGE_SUGGESTION_DEFAULTS.minDistinctUsers,
        ),
      ),
    ),
    minSetCount: Math.max(
      1,
      Math.floor(
        positiveOrDefault(
          options.minSetCount,
          FIELD_USAGE_SUGGESTION_DEFAULTS.minSetCount,
        ),
      ),
    ),
    defaultDominanceRatio: Math.min(Math.max(ratio, 0.01), 1),
  };
}

/** Strictly positive knobs (thresholds, windows): `0` is not meaningful. */
function positiveOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** Retention bounds: `0` is meaningful ("purge everything"), so keep it. */
function nonNegativeOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function pickFiniteNumbers(
  args: Record<string, unknown>,
  keys: string[],
): Record<string, number> {
  const picked: Record<string, number> = {};
  if (!args || typeof args !== 'object') {
    return picked;
  }
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      picked[key] = value;
    }
  }
  return picked;
}

async function deleteCounted(
  db: DatabaseInterface,
  condition: string,
  params: unknown[],
  table = '_smrt_field_usage_counters',
): Promise<number> {
  const countRows = getQueryRows(
    await db.query(
      `SELECT COUNT(*) AS total FROM ${table} WHERE ${condition}`,
      ...params,
    ),
  );
  const total = numberFromRow(countRows[0] ?? {}, 'total');
  if (total > 0) {
    await db.query(`DELETE FROM ${table} WHERE ${condition}`, ...params);
  }
  return total;
}

function getQueryRows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);
}

function numberFromRow(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    return Number.parseFloat(value) || 0;
  }
  return 0;
}
