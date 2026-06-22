import type { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import type { TenantSubscription } from '../models/TenantSubscription.js';
import type {
  EntitlementResolution,
  PlanThreshold,
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

export interface SubscriptionPlanReader {
  get(criteria: { id: string }): Promise<SubscriptionPlan | null>;
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
}

export class SubscriptionResolver {
  constructor(private readonly readers: SubscriptionResolverReaders) {}

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
    const subscription = await this.findCurrentSubscription(subscriber, now);

    if (!subscription) {
      return emptyResolution(subscriber);
    }

    const plan = subscription.planId
      ? await this.readers.plans.get({ id: subscription.planId })
      : null;

    if (!plan || !plan.isActive() || !subscription.isEntitled(now)) {
      return {
        ...emptyResolution(subscriber),
        planId: plan?.id ?? subscription.planId ?? null,
        planKey: plan?.planKey ?? null,
        subscriptionId: subscription.id ?? null,
        status: subscription.status,
      };
    }

    const thresholds = plan.getThresholds().filter(isValidThreshold);
    const thresholdEvaluations = await this.resolveThresholdEvaluations(
      subscriber,
      thresholds,
      now,
      options,
    );

    return {
      tenantId: subscriber.tenantId,
      subscriber,
      planId: plan.id ?? null,
      planKey: plan.planKey,
      subscriptionId: subscription.id ?? null,
      status: subscription.status,
      featureKeys: plan.getFeatureKeys(),
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
    subscriptionId: null,
    status: 'none',
    featureKeys: [],
    thresholds: [],
    thresholdEvaluations: [],
    allowed: false,
  };
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
