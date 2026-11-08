/**
 * Hosted AI spend policy (#4760, epic #4667).
 *
 * A plan caps platform-paid (`source: hosted`) inference with ordinary
 * `PlanThreshold`s on two reserved metric keys, so the window, amount and
 * enforcement come from the plan (and its pinned version) like every other
 * threshold:
 *
 * - {@link AI_HOSTED_SPEND_METRIC}: the tenant's hosted spend per window.
 * - {@link AI_HOSTED_USER_SPEND_METRIC}: each user's hosted spend per window
 *   (the per-user cap within the tenant's plan).
 *
 * `limit` is **integer micro-dollars** (1 USD = 1,000,000): the repo's
 * integer-minor-unit money rule at the precision per-call AI costs need.
 * `enforcement: 'block'` blocks at or over the cap; `'warn'` only warns;
 * `'observe'` never affects a call. `warningRatio` (default 0.8) warns
 * before the cap. A cap of 0 blocks every hosted call.
 *
 * Spend is read from `_smrt_ai_usage.estimated_cost` (USD, summed and
 * rounded to micro-dollars) for rows of the tenant in the threshold's
 * window whose `tags` record `source: hosted` (and, for the per-user cap,
 * the `userId` tag). Blocked rows (`operation: 'blocked'`) and
 * external-agent measurements never count. Rows without a cost rate add
 * nothing; give hosted models a cost rate.
 *
 * These keys are evaluated by {@link HostedAiSpendEvaluator} only:
 * `resolveEntitlements()` reports them with quantity 0 (the tenant usage
 * meter has no hosted or per-user meter).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import type {
  PlanThreshold,
  SmrtClassOptions,
  SubscriptionResolverOptions,
  UsageWindow,
} from '../types.js';
import { getWindowForThreshold, isValidThreshold } from '../utils.js';
import { SubscriptionResolver } from './subscription-resolver.js';

/** Plan threshold key: the tenant's hosted AI spend, micro-dollars. */
export const AI_HOSTED_SPEND_METRIC = 'ai.hosted.spend_micros';
/** Plan threshold key: each user's hosted AI spend, micro-dollars. */
export const AI_HOSTED_USER_SPEND_METRIC = 'ai.hosted.user_spend_micros';

/** Micro-dollars per US dollar. */
export const MICROS_PER_USD = 1_000_000;

/** Length of a `rolling` threshold window (as `getWindowForThreshold`). */
const ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The cap a decision names: tenant or per-user. */
export type HostedAiSpendPolicy = 'tenant-cap' | 'user-cap';

/** One evaluated hosted spend threshold. */
export interface HostedAiSpendEvaluation {
  policy: HostedAiSpendPolicy;
  threshold: PlanThreshold;
  /** The cap, integer micro-dollars. */
  cap: number;
  /** Metered hosted spend in the window, integer micro-dollars. */
  spend: number;
  window: UsageWindow;
  /**
   * When the cap lifts: the calendar window's end, or for a `rolling`
   * window the moment the oldest counted spend leaves it (null when nothing
   * is counted yet).
   */
  resetsAt: Date | null;
  state: 'ok' | 'warn' | 'blocked';
}

/** The most restrictive outcome over every hosted spend threshold. */
export interface HostedAiSpendDecision {
  state: 'ok' | 'warn' | 'blocked';
  /** False when the tenant has no current entitled subscription. */
  entitled: boolean;
  planId: string | null;
  planKey: string | null;
  /**
   * The deciding evaluation: for `blocked`, the blocking cap that lifts
   * last (the call runs again only when every blocking cap has lifted);
   * for `warn`, the warning cap closest to its limit.
   */
  decidedBy: HostedAiSpendEvaluation | null;
  evaluations: HostedAiSpendEvaluation[];
}

/** Hosted spend totals for one window. */
export interface HostedAiSpendSummary {
  /** Integer micro-dollars. */
  spend: number;
  /** Oldest counted row in the window, if any. */
  oldestAt: Date | null;
}

/** Reads hosted spend; the default reads `_smrt_ai_usage`. */
export interface HostedAiSpendReader {
  summarize(options: {
    tenantId: string;
    /** Only this user's rows (the `userId` tag); omitted: the whole tenant. */
    userId?: string;
    window: UsageWindow;
  }): Promise<HostedAiSpendSummary>;
}

/** A plan cap the gate cannot evaluate: the caller must fail closed. */
export class HostedAiSpendPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedAiSpendPolicyError';
  }
}

function rows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseFloat(value) || 0;
  return 0;
}

function dateOf(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Escape a literal for `LIKE ... ESCAPE '!'`. */
function likeLiteral(text: string): string {
  return text.replace(/[!%_]/g, (match) => `!${match}`);
}

/**
 * The `LIKE` pattern matching one tag as `JSON.stringify` writes it into
 * `_smrt_ai_usage.tags` (core's persistence handler): `"key":"value"`.
 * The value is JSON-encoded first, so quotes inside it cannot end the match
 * early; the closing quote anchors the value, so `u1` never matches `u10`.
 */
export function hostedAiTagPattern(key: string, value: string): string {
  return `%${likeLiteral(`${JSON.stringify(key)}:${JSON.stringify(value)}`)}%`;
}

/**
 * The default {@link HostedAiSpendReader}: one aggregate query over
 * `_smrt_ai_usage` by `tenant_id` and `created_at` (served by
 * `idx_smrt_ai_usage_tenant_created`), filtered on the `source` and
 * `userId` tags. A tag pattern can only over-count (a row whose tags
 * contain the fragment elsewhere), never miss a row core wrote, so the
 * error is always toward the cap.
 */
export function createHostedAiSpendReader(
  db: DatabaseInterface,
): HostedAiSpendReader {
  return {
    async summarize({ tenantId, userId, window }) {
      const params: unknown[] = [
        tenantId,
        window.start.toISOString(),
        window.end.toISOString(),
        hostedAiTagPattern('source', 'hosted'),
      ];
      let userClause = '';
      if (userId !== undefined) {
        params.push(hostedAiTagPattern('userId', userId));
        userClause = "AND tags LIKE ? ESCAPE '!'";
      }
      const result = await db.query(
        `SELECT COALESCE(SUM(estimated_cost), 0) AS cost,
                MIN(created_at) AS oldest_at
           FROM _smrt_ai_usage
          WHERE tenant_id = ?
            AND created_at >= ?
            AND created_at < ?
            AND operation <> 'blocked'
            AND NOT (operation = 'external-agent' AND id LIKE 'external-agent:%')
            AND tags LIKE ? ESCAPE '!'
            ${userClause}`,
        ...params,
      );
      const row = rows(result)[0] ?? {};
      return {
        spend: Math.round(numberOf(row.cost) * MICROS_PER_USD),
        oldestAt: dateOf(row.oldest_at),
      };
    },
  };
}

function policyFor(threshold: PlanThreshold): HostedAiSpendPolicy | null {
  if (threshold.metricKey === AI_HOSTED_SPEND_METRIC) return 'tenant-cap';
  if (threshold.metricKey === AI_HOSTED_USER_SPEND_METRIC) return 'user-cap';
  return null;
}

/**
 * The hosted spend thresholds of a plan. A hosted key whose threshold is
 * malformed (unknown window or enforcement, or a limit that is not a
 * non-negative safe integer of micro-dollars) throws
 * {@link HostedAiSpendPolicyError}: a broken cap must never read as "no cap".
 */
export function hostedAiSpendThresholds(
  thresholds: readonly PlanThreshold[],
): Array<{ policy: HostedAiSpendPolicy; threshold: PlanThreshold }> {
  const result: Array<{
    policy: HostedAiSpendPolicy;
    threshold: PlanThreshold;
  }> = [];
  for (const threshold of thresholds) {
    const policy = policyFor(threshold);
    if (!policy) continue;
    if (
      !isValidThreshold(threshold) ||
      !Number.isSafeInteger(threshold.limit)
    ) {
      throw new HostedAiSpendPolicyError(
        `Plan threshold ${threshold.metricKey} is not a valid hosted AI cap (limit must be a non-negative integer of micro-dollars).`,
      );
    }
    result.push({ policy, threshold });
  }
  return result;
}

/** Evaluate one cap against its metered spend. */
export function evaluateHostedAiSpendThreshold(
  policy: HostedAiSpendPolicy,
  threshold: PlanThreshold,
  summary: HostedAiSpendSummary,
  window: UsageWindow,
): HostedAiSpendEvaluation {
  const cap = threshold.limit;
  const spend = summary.spend;
  const over = spend >= cap;
  const warningRatio = threshold.warningRatio ?? 0.8;
  const nearing = cap === 0 ? over : spend >= cap * warningRatio;
  let state: HostedAiSpendEvaluation['state'] = 'ok';
  if (threshold.enforcement === 'block' && over) state = 'blocked';
  else if (threshold.enforcement !== 'observe' && nearing) state = 'warn';
  const resetsAt =
    threshold.window === 'rolling'
      ? summary.oldestAt
        ? new Date(summary.oldestAt.getTime() + ROLLING_WINDOW_MS)
        : null
      : window.end;
  return { policy, threshold, cap, spend, window, resetsAt, state };
}

function laterReset(
  a: HostedAiSpendEvaluation,
  b: HostedAiSpendEvaluation,
): HostedAiSpendEvaluation {
  // An unknown reset (null) sorts last: it lifts no earlier than any other.
  if (!a.resetsAt) return a;
  if (!b.resetsAt) return b;
  return b.resetsAt.getTime() > a.resetsAt.getTime() ? b : a;
}

function closerToCap(
  a: HostedAiSpendEvaluation,
  b: HostedAiSpendEvaluation,
): HostedAiSpendEvaluation {
  const ratio = (e: HostedAiSpendEvaluation) =>
    e.cap === 0 ? Number.POSITIVE_INFINITY : e.spend / e.cap;
  return ratio(b) > ratio(a) ? b : a;
}

/** Fold evaluations into the most restrictive decision. */
export function decideHostedAiSpend(
  evaluations: HostedAiSpendEvaluation[],
  plan: { entitled: boolean; planId: string | null; planKey: string | null },
): HostedAiSpendDecision {
  const blocked = evaluations.filter((e) => e.state === 'blocked');
  const warned = evaluations.filter((e) => e.state === 'warn');
  const decidedBy =
    blocked.length > 0
      ? blocked.reduce(laterReset)
      : warned.length > 0
        ? warned.reduce(closerToCap)
        : null;
  return {
    state: blocked.length > 0 ? 'blocked' : warned.length > 0 ? 'warn' : 'ok',
    entitled: plan.entitled,
    planId: plan.planId,
    planKey: plan.planKey,
    decidedBy,
    evaluations,
  };
}

/** Options for {@link HostedAiSpendEvaluator}. */
export interface HostedAiSpendEvaluatorOptions {
  resolver: Pick<SubscriptionResolver, 'resolvePlanThresholds'>;
  spend: HostedAiSpendReader;
  /**
   * How long a tenant's plan thresholds are reused, in ms (default 30 000):
   * entitlements resolve once per request burst, while spend is always read
   * fresh. 0 disables the memo.
   */
  termsTtlMs?: number;
  now?: () => Date;
}

type PlanThresholds = Awaited<
  ReturnType<SubscriptionResolver['resolvePlanThresholds']>
>;

/**
 * Evaluates a tenant's (and one user's) hosted AI spend against the plan's
 * caps. Plan thresholds come from `SubscriptionResolver` (memoized per
 * tenant for `termsTtlMs`); spend is read on every call. Errors (a resolver
 * or database outage, missing tables, a malformed cap) propagate: the gate
 * turns them into a fail-closed block.
 */
export class HostedAiSpendEvaluator {
  private readonly terms = new Map<
    string,
    { at: number; value: Promise<PlanThresholds> }
  >();
  private readonly termsTtlMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: HostedAiSpendEvaluatorOptions) {
    this.termsTtlMs = options.termsTtlMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Build the default resolver and `_smrt_ai_usage` reader over one db. */
  static async create(
    classOptions: SmrtClassOptions & { db: DatabaseInterface },
    options: Omit<HostedAiSpendEvaluatorOptions, 'resolver' | 'spend'> = {},
  ): Promise<HostedAiSpendEvaluator> {
    return new HostedAiSpendEvaluator({
      ...options,
      resolver: await SubscriptionResolver.create(classOptions),
      spend: createHostedAiSpendReader(classOptions.db),
    });
  }

  /** Drop memoized plan thresholds (all tenants, or one). */
  invalidate(tenantId?: string): void {
    if (tenantId === undefined) this.terms.clear();
    else this.terms.delete(tenantId);
  }

  private planThresholds(
    tenantId: string,
    resolverOptions: SubscriptionResolverOptions,
  ): Promise<PlanThresholds> {
    const at = Date.now();
    const cached = this.terms.get(tenantId);
    if (cached && this.termsTtlMs > 0 && at - cached.at < this.termsTtlMs) {
      return cached.value;
    }
    const value = this.options.resolver.resolvePlanThresholds(
      { kind: 'tenant', tenantId },
      resolverOptions,
    );
    if (this.termsTtlMs > 0) {
      this.terms.set(tenantId, { at, value });
      value.catch(() => {
        if (this.terms.get(tenantId)?.value === value) {
          this.terms.delete(tenantId);
        }
      });
    }
    return value;
  }

  /**
   * Evaluate the plan's hosted caps for `tenantId` and, when given, the
   * per-user caps for `userId`. Without a `userId` the per-user caps are
   * skipped (no user to meter: jobs, shared agent clients).
   */
  async evaluate(input: {
    tenantId: string;
    userId?: string;
    resolverOptions?: SubscriptionResolverOptions;
  }): Promise<HostedAiSpendDecision> {
    const now = this.now();
    const plan = await this.planThresholds(input.tenantId, {
      ...(input.resolverOptions ?? {}),
      now,
    });
    const caps = hostedAiSpendThresholds(plan.thresholds).filter(
      ({ policy }) => policy === 'tenant-cap' || input.userId !== undefined,
    );
    const evaluations = await Promise.all(
      caps.map(async ({ policy, threshold }) => {
        const window = getWindowForThreshold(threshold.window, now);
        const summary = await this.options.spend.summarize({
          tenantId: input.tenantId,
          ...(policy === 'user-cap' ? { userId: input.userId } : {}),
          window,
        });
        return evaluateHostedAiSpendThreshold(
          policy,
          threshold,
          summary,
          window,
        );
      }),
    );
    return decideHostedAiSpend(evaluations, plan);
  }
}
