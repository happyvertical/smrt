/**
 * @happyvertical/smrt-subscriptions
 *
 * Tenant subscription plans, feature grants, usage thresholds, and entitlement
 * resolution for SMRT applications.
 *
 * @packageDocumentation
 */

import './__smrt-register__.js';

export {
  SubscriptionPlanCollection,
  TenantSubscriptionCollection,
  TenantUsageMetricCollection,
} from './collections/index.js';
export {
  SubscriptionPlan,
  TenantSubscription,
  TenantUsageMetric,
} from './models/index.js';
export {
  evaluateThreshold,
  evaluateThresholds,
  type SubscriptionPlanReader,
  SubscriptionResolver,
  type SubscriptionResolverReaders,
  type TenantSubscriptionReader,
  TenantUsageMeter,
  type UsageSummaryReader,
} from './services/index.js';
export type {
  AiUsageSummary,
  BillingInterval,
  EntitlementResolution,
  JsonObject,
  PlanFeatureGrant,
  PlanThreshold,
  RecordUsageOptions,
  Subscriber,
  SubscriberKind,
  SubscriptionPlanStatus,
  SubscriptionResolverOptions,
  SubscriptionStatus,
  SummarizeAiUsageOptions,
  SummarizeUsageOptions,
  ThresholdEnforcement,
  ThresholdEvaluation,
  ThresholdWindow,
  UsageMeterOptions,
  UsageMetricRecord,
  UsageSummary,
  UsageWindow,
} from './types.js';
export {
  getWindowForThreshold,
  getWindowKey,
  isValidThreshold,
  normalizeFeatureGrants,
  normalizeSubscriber,
  subscriberToColumns,
} from './utils.js';
