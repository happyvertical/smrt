import { isSystemContext } from '@happyvertical/smrt-tenancy';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { SubscriptionPlanVersionCollection } from '../collections/SubscriptionPlanVersionCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import type { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import type { SubscriptionPlanVersion } from '../models/SubscriptionPlanVersion.js';
import type { TenantSubscription } from '../models/TenantSubscription.js';
import type {
  EntitlementResolution,
  EntitlementResolutionContext,
  PlanThreshold,
  SmrtClassOptions,
  Subscriber,
  SubscriptionResolverOptions,
  ThresholdEvaluation,
  UsageSummary,
  UsageWindow,
} from '../types.js';
import {
  getWindowForThreshold,
  getWindowKey,
  isValidThreshold,
} from '../utils.js';
import { evaluateThreshold } from './threshold-evaluator.js';
import { TenantUsageMeter } from './usage-meter.js';

export interface SubscriptionPlanReader {
  get(criteria: { id: string }): Promise<SubscriptionPlan | null>;
}

/**
 * Reader for effective-dated plan versions (#4032). `findInForce` resolves
 * subscriptions that have no pinned version yet (rows written before
 * versioning and not yet migrated).
 */
export interface SubscriptionPlanVersionReader {
  get(criteria: { id: string }): Promise<SubscriptionPlanVersion | null>;
  findInForce?(
    planId: string,
    at: Date,
  ): Promise<SubscriptionPlanVersion | null>;
}

/**
 * Reader contract for finding the current subscription for a subscriber.
 *
 * The legacy `findCurrentForTenant(tenantId)` signature stays for backward
 * compatibility with the original tenant-only resolver. New implementations
 * should provide `findCurrentForSubscriber(subscriber)` — it's preferred when
 * present and lets the resolver work with both `'tenant'` and `'external'`
 * subscribers without callers having to pre-narrow the discriminator.
 */
export interface TenantSubscriptionReader {
  findCurrentForTenant(
    tenantId: string,
    now?: Date,
  ): Promise<TenantSubscription | null>;
  findCurrentForSubscriber?(
    subscriber: Subscriber,
    now?: Date,
  ): Promise<TenantSubscription | null>;
}

/**
 * Reader contract for summarizing usage.
 *
 * `summarize(options)` already accepts the polymorphic
 * `subscriberKind`/`subscriberExternalId` fields. When omitted the reader
 * defaults to `'tenant'`, which is what existing callers got before this
 * change — no behavior shift for them. The discriminator type is derived
 * from `Subscriber['kind']` rather than inlined so any future additions to
 * the union stay consistent across the package.
 */
export interface UsageSummaryReader {
  summarize(options: {
    tenantId: string;
    subscriberKind?: Subscriber['kind'];
    subscriberExternalId?: string;
    metricKey: string;
    window: UsageWindow;
  }): Promise<UsageSummary>;
  summarizeBatch?(options: {
    tenantId: string;
    subscriberKind?: Subscriber['kind'];
    subscriberExternalId?: string;
    metricKeys: string[];
    window: UsageWindow;
  }): Promise<UsageSummary[]>;
}

export interface SubscriptionResolverReaders {
  plans: SubscriptionPlanReader;
  subscriptions: TenantSubscriptionReader;
  usage: UsageSummaryReader;
  /**
   * Plan versions. When present, entitlements come from the version frozen
   * for the subscription's current period instead of the live plan row.
   * Omitting it keeps the pre-#4032 live-plan behavior.
   */
  planVersions?: SubscriptionPlanVersionReader;
}

export class SubscriptionResolver {
  constructor(private readonly readers: SubscriptionResolverReaders) {}

  /**
   * Build the default resolver readers once for a request or app lifecycle and
   * reuse the returned resolver across entitlement checks.
   */
  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<SubscriptionResolver> {
    const [plans, subscriptions, usage, planVersions] = await Promise.all([
      SubscriptionPlanCollection.create(classOptions),
      TenantSubscriptionCollection.create(classOptions),
      TenantUsageMeter.create(classOptions),
      SubscriptionPlanVersionCollection.create(classOptions),
    ]);
    return new SubscriptionResolver({
      plans,
      subscriptions,
      usage,
      // Pinned versions of legacy global plans stay readable under a tenant
      // context through the collection's bounded global fallback.
      planVersions: {
        get: ({ id }) => planVersions.findVisibleById(id),
        findInForce: (planId, at) => planVersions.findInForce(planId, at),
      },
    });
  }

  /**
   * Load the subscription/plan pair used by entitlement resolution. Callers
   * that need both the entitlement snapshot and the backing records can load
   * this once, then pass it back via `options.context`.
   */
  async loadEntitlementContext(
    subscriberOrTenantId: Subscriber | string,
    options: SubscriptionResolverOptions = {},
  ): Promise<EntitlementResolutionContext> {
    const subscriber = toSubscriber(subscriberOrTenantId);
    const now = options.now ?? new Date();
    const subscription = await this.resolveSubscription(
      subscriber,
      now,
      options.context,
    );
    const plan = await this.resolvePlan(subscription, options.context);
    const planVersion = await this.resolvePlanVersion(
      subscription,
      options.context,
    );
    return { subscription, plan, planVersion };
  }

  /**
   * Polymorphic entitlement resolution. Works for both `'tenant'`-kind and
   * `'external'`-kind subscribers and is the preferred surface — the
   * `resolveTenantEntitlements(tenantId)` method below is a thin wrapper.
   */
  async resolveEntitlements(
    subscriber: Subscriber,
    options: SubscriptionResolverOptions = {},
  ): Promise<EntitlementResolution> {
    const now = options.now ?? new Date();
    const { subscription, plan, planVersion } =
      await this.loadEntitlementContext(subscriber, { ...options, now });

    if (!subscription) {
      return emptyResolution(subscriber);
    }

    // With versioning the frozen version is authoritative: a later edit,
    // archive or entitlement removal on the live plan never reaches a paid
    // period. A pinned version that cannot be found fails closed; only an
    // unpinned subscription to a plan with no versions (unmigrated legacy
    // data) falls back to the live plan.
    // Without a version reader or context (custom pre-#4032 readers) the
    // live plan stays authoritative.
    const terms =
      planVersion === undefined
        ? plan
        : (planVersion ?? (subscription.planVersionId ? null : plan));
    const identity = {
      planId: plan?.id ?? planVersion?.planId ?? subscription.planId ?? null,
      planKey: plan?.planKey ?? planVersion?.planKey ?? null,
      planVersionId: terms === planVersion ? (planVersion?.id ?? null) : null,
      planVersion:
        terms === planVersion ? (planVersion?.version ?? null) : null,
      subscriptionId: subscription.id ?? null,
      status: subscription.status,
    };

    if (!terms?.isActive() || !subscription.isEntitled(now)) {
      return { ...emptyResolution(subscriber), ...identity };
    }

    const thresholds = terms.getThresholds().filter(isValidThreshold);
    const thresholdEvaluations = await this.resolveThresholdEvaluations(
      subscriber,
      thresholds,
      now,
      options,
    );

    return {
      tenantId: subscriber.tenantId,
      subscriber,
      ...identity,
      featureKeys: terms.getFeatureKeys(),
      thresholds,
      thresholdEvaluations,
      allowed: thresholdEvaluations.every((evaluation) => evaluation.allowed),
    };
  }

  /**
   * Legacy single-tenant wrapper around {@link resolveEntitlements}. Kept so
   * existing tenant-only callers don't need to update their call sites.
   */
  async resolveTenantEntitlements(
    tenantId: string,
    options: SubscriptionResolverOptions = {},
  ): Promise<EntitlementResolution> {
    return this.resolveEntitlements({ kind: 'tenant', tenantId }, options);
  }

  async isFeatureEnabled(
    subscriberOrTenantId: Subscriber | string,
    featureKey: string,
    options: SubscriptionResolverOptions = {},
  ): Promise<boolean> {
    const resolution = await this.resolveEntitlements(
      toSubscriber(subscriberOrTenantId),
      options,
    );
    return resolution.featureKeys.includes(featureKey);
  }

  async assertWithinThresholds(
    subscriberOrTenantId: Subscriber | string,
    options: SubscriptionResolverOptions = {},
  ): Promise<void> {
    const subscriber = toSubscriber(subscriberOrTenantId);
    const resolution = await this.resolveEntitlements(subscriber, options);
    const blocked = resolution.thresholdEvaluations.find(
      (evaluation) => !evaluation.allowed,
    );

    if (blocked) {
      const subject =
        subscriber.kind === 'external'
          ? `external:${subscriber.externalId}`
          : `Tenant ${subscriber.tenantId}`;
      throw new Error(
        `${subject} exceeded subscription threshold ${blocked.threshold.metricKey}`,
      );
    }
  }

  private async resolveSubscription(
    subscriber: Subscriber,
    now: Date,
    context?: EntitlementResolutionContext,
  ): Promise<TenantSubscription | null> {
    if (hasContextValue(context, 'subscription')) {
      const subscription = context?.subscription ?? null;
      assertSubscriptionMatchesSubscriber(subscription, subscriber);
      return subscription;
    }
    return this.findCurrentSubscription(subscriber, now);
  }

  private async resolvePlan(
    subscription: TenantSubscription | null,
    context?: EntitlementResolutionContext,
  ): Promise<SubscriptionPlan | null> {
    if (!subscription?.planId) {
      return null;
    }
    if (hasContextValue(context, 'plan')) {
      const plan = context?.plan ?? null;
      assertPlanMatchesSubscription(plan, subscription);
      return plan;
    }
    const plan = await this.readers.plans.get({ id: subscription.planId });
    assertPlanMatchesSubscription(plan, subscription);
    return plan;
  }

  /**
   * The version frozen for the subscription's current period: its pinned
   * `planVersionId`, or — for rows not yet pinned — the version in force at
   * its period start. Null when the subscription has no plan or a pinned
   * version is missing (the resolver then fails closed); undefined when no
   * version reader or context is available.
   */
  private async resolvePlanVersion(
    subscription: TenantSubscription | null,
    context?: EntitlementResolutionContext,
  ): Promise<SubscriptionPlanVersion | null | undefined> {
    if (!subscription?.planId) {
      return null;
    }
    if (hasContextValue(context, 'planVersion')) {
      const planVersion = context?.planVersion ?? null;
      assertPlanVersionMatchesSubscription(planVersion, subscription);
      return planVersion;
    }
    const reader = this.readers.planVersions;
    if (!reader) {
      return undefined;
    }
    const planVersion = subscription.planVersionId
      ? await reader.get({ id: subscription.planVersionId })
      : ((await reader.findInForce?.(
          subscription.planId,
          new Date(subscription.currentPeriodStart ?? subscription.startedAt),
        )) ?? null);
    assertPlanVersionMatchesSubscription(planVersion, subscription);
    return planVersion;
  }

  /**
   * Bridge the legacy and polymorphic reader contracts.
   *
   * Prefers `findCurrentForSubscriber` when the reader provides it (the
   * preferred shape). For `'tenant'` subscribers we fall back to the legacy
   * `findCurrentForTenant`. For `'external'` subscribers the reader MUST
   * implement `findCurrentForSubscriber` — otherwise we have no way to scope
   * the lookup and we throw rather than silently returning the tenant's
   * primary subscription.
   */
  private async findCurrentSubscription(
    subscriber: Subscriber,
    now: Date,
  ): Promise<TenantSubscription | null> {
    if (this.readers.subscriptions.findCurrentForSubscriber) {
      return this.readers.subscriptions.findCurrentForSubscriber(
        subscriber,
        now,
      );
    }
    if (subscriber.kind === 'tenant') {
      return this.readers.subscriptions.findCurrentForTenant(
        subscriber.tenantId,
        now,
      );
    }
    throw new Error(
      'External-subscriber resolution requires a TenantSubscriptionReader ' +
        'that implements findCurrentForSubscriber()',
    );
  }

  private async resolveThresholdEvaluations(
    subscriber: Subscriber,
    thresholds: PlanThreshold[],
    now: Date,
    options: SubscriptionResolverOptions,
  ): Promise<ThresholdEvaluation[]> {
    if (thresholds.length === 0) {
      return [];
    }

    if (!this.readers.usage.summarizeBatch) {
      const evaluations: ThresholdEvaluation[] = [];
      for (const threshold of thresholds) {
        const window =
          options.usageWindows?.[threshold.window] ??
          getWindowForThreshold(threshold.window, now);
        const usage = await this.readers.usage.summarize({
          tenantId: subscriber.tenantId,
          subscriberKind: subscriber.kind,
          subscriberExternalId:
            subscriber.kind === 'external' ? subscriber.externalId : undefined,
          metricKey: threshold.metricKey,
          window,
        });
        evaluations.push(evaluateThreshold(threshold, usage));
      }
      return evaluations;
    }

    const groups = new Map<
      string,
      {
        window: UsageWindow;
        entries: Array<{ index: number; threshold: PlanThreshold }>;
      }
    >();

    thresholds.forEach((threshold, index) => {
      const window =
        options.usageWindows?.[threshold.window] ??
        getWindowForThreshold(threshold.window, now);
      const key = getWindowKey(window);
      const group = groups.get(key) ?? { window, entries: [] };
      group.entries.push({ index, threshold });
      groups.set(key, group);
    });

    const evaluations: ThresholdEvaluation[] = new Array(thresholds.length);
    await Promise.all(
      Array.from(groups.values()).map(async ({ window, entries }) => {
        const metricKeys = uniqueMetricKeys(
          entries.map((entry) => entry.threshold.metricKey),
        );
        const summaries = await this.readers.usage.summarizeBatch?.({
          tenantId: subscriber.tenantId,
          subscriberKind: subscriber.kind,
          subscriberExternalId:
            subscriber.kind === 'external' ? subscriber.externalId : undefined,
          metricKeys,
          window,
        });
        const summaryByMetric = new Map(
          (summaries ?? []).map((summary) => [summary.metricKey, summary]),
        );

        for (const { index, threshold } of entries) {
          const usage =
            summaryByMetric.get(threshold.metricKey) ??
            emptyUsageSummary(subscriber, threshold.metricKey, window);
          evaluations[index] = evaluateThreshold(threshold, usage);
        }
      }),
    );

    return evaluations;
  }
}

function toSubscriber(input: Subscriber | string): Subscriber {
  if (typeof input === 'string') {
    return { kind: 'tenant', tenantId: input };
  }
  return input;
}

function emptyResolution(subscriber: Subscriber): EntitlementResolution {
  return {
    tenantId: subscriber.tenantId,
    subscriber,
    planId: null,
    planKey: null,
    planVersionId: null,
    planVersion: null,
    subscriptionId: null,
    status: 'none',
    featureKeys: [],
    thresholds: [],
    thresholdEvaluations: [],
    allowed: false,
  };
}

function hasContextValue<K extends keyof EntitlementResolutionContext>(
  context: EntitlementResolutionContext | undefined,
  key: K,
): boolean {
  return context?.[key] !== undefined;
}

function assertSubscriptionMatchesSubscriber(
  subscription: TenantSubscription | null,
  subscriber: Subscriber,
): void {
  if (!subscription) {
    return;
  }
  const subscriptionSubscriber = subscription.getSubscriber();
  if (
    !subscriptionSubscriber ||
    !sameSubscriber(subscriptionSubscriber, subscriber)
  ) {
    throw new Error(
      'Provided entitlement context subscription does not match requested subscriber',
    );
  }
}

function assertPlanMatchesSubscription(
  plan: SubscriptionPlan | null,
  subscription: TenantSubscription,
): void {
  if (!plan) {
    return;
  }
  if (
    !isSystemContext() &&
    plan.tenantId !== null &&
    plan.tenantId !== subscription.tenantId
  ) {
    throw new Error('Entitlement plan does not belong to subscription tenant');
  }
  if (!plan.id || plan.id !== subscription.planId) {
    throw new Error(
      'Provided entitlement context plan does not match subscription.planId',
    );
  }
}

function assertPlanVersionMatchesSubscription(
  planVersion: SubscriptionPlanVersion | null,
  subscription: TenantSubscription,
): void {
  if (!planVersion) {
    return;
  }
  if (
    !isSystemContext() &&
    planVersion.tenantId !== null &&
    planVersion.tenantId !== subscription.tenantId
  ) {
    throw new Error(
      'Entitlement plan version does not belong to subscription tenant',
    );
  }
  if (
    !planVersion.id ||
    planVersion.planId !== subscription.planId ||
    (subscription.planVersionId !== null &&
      planVersion.id !== subscription.planVersionId)
  ) {
    throw new Error(
      'Provided entitlement plan version does not match the subscription',
    );
  }
}

function sameSubscriber(left: Subscriber, right: Subscriber): boolean {
  if (left.kind !== right.kind || left.tenantId !== right.tenantId) {
    return false;
  }
  if (left.kind === 'tenant') {
    return true;
  }
  return right.kind === 'external' && left.externalId === right.externalId;
}

function uniqueMetricKeys(metricKeys: string[]): string[] {
  return Array.from(new Set(metricKeys));
}

function emptyUsageSummary(
  subscriber: Subscriber,
  metricKey: string,
  window: UsageWindow,
): UsageSummary {
  const summary: UsageSummary = {
    tenantId: subscriber.tenantId,
    metricKey,
    quantity: 0,
    windowStart: window.start,
    windowEnd: window.end,
  };
  if (subscriber.kind === 'external') {
    return {
      ...summary,
      subscriberKind: 'external',
      subscriberExternalId: subscriber.externalId,
    };
  }
  return summary;
}

export type { PlanThreshold };
