import type { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import type { TenantSubscription } from '../models/TenantSubscription.js';
import type {
  EntitlementResolution,
  PlanThreshold,
  SubscriptionResolverOptions,
  ThresholdEvaluation,
  UsageSummary,
  UsageWindow,
} from '../types.js';
import { getWindowForThreshold, isValidThreshold } from '../utils.js';
import { evaluateThreshold } from './threshold-evaluator.js';

export interface SubscriptionPlanReader {
  get(criteria: { id: string }): Promise<SubscriptionPlan | null>;
}

export interface TenantSubscriptionReader {
  findCurrentForTenant(
    tenantId: string,
    now?: Date,
  ): Promise<TenantSubscription | null>;
}

export interface UsageSummaryReader {
  summarize(options: {
    tenantId: string;
    metricKey: string;
    window: UsageWindow;
  }): Promise<UsageSummary>;
}

export interface SubscriptionResolverReaders {
  plans: SubscriptionPlanReader;
  subscriptions: TenantSubscriptionReader;
  usage: UsageSummaryReader;
}

export class SubscriptionResolver {
  constructor(private readonly readers: SubscriptionResolverReaders) {}

  async resolveTenantEntitlements(
    tenantId: string,
    options: SubscriptionResolverOptions = {},
  ): Promise<EntitlementResolution> {
    const now = options.now ?? new Date();
    const subscription = await this.readers.subscriptions.findCurrentForTenant(
      tenantId,
      now,
    );

    if (!subscription) {
      return emptyResolution(tenantId);
    }

    const plan = subscription.planId
      ? await this.readers.plans.get({ id: subscription.planId })
      : null;

    if (!plan || !plan.isActive() || !subscription.isEntitled(now)) {
      return {
        ...emptyResolution(tenantId),
        planId: plan?.id ?? subscription.planId ?? null,
        planKey: plan?.planKey ?? null,
        subscriptionId: subscription.id ?? null,
        status: subscription.status,
      };
    }

    const thresholds = plan.getThresholds().filter(isValidThreshold);
    const thresholdEvaluations: ThresholdEvaluation[] = [];

    for (const threshold of thresholds) {
      const window =
        options.usageWindows?.[threshold.window] ??
        getWindowForThreshold(threshold.window, now);
      const usage = await this.readers.usage.summarize({
        tenantId,
        metricKey: threshold.metricKey,
        window,
      });
      thresholdEvaluations.push(evaluateThreshold(threshold, usage));
    }

    return {
      tenantId,
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

  async isFeatureEnabled(
    tenantId: string,
    featureKey: string,
    options: SubscriptionResolverOptions = {},
  ): Promise<boolean> {
    const resolution = await this.resolveTenantEntitlements(tenantId, options);
    return resolution.featureKeys.includes(featureKey);
  }

  async assertWithinThresholds(
    tenantId: string,
    options: SubscriptionResolverOptions = {},
  ): Promise<void> {
    const resolution = await this.resolveTenantEntitlements(tenantId, options);
    const blocked = resolution.thresholdEvaluations.find(
      (evaluation) => !evaluation.allowed,
    );

    if (blocked) {
      throw new Error(
        `Tenant ${tenantId} exceeded subscription threshold ${blocked.threshold.metricKey}`,
      );
    }
  }
}

function emptyResolution(tenantId: string): EntitlementResolution {
  return {
    tenantId,
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

export type { PlanThreshold };
