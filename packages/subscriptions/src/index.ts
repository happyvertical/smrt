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
export type {
  PricingStrategy,
  SpendingPeriod,
  SpendingPolicyBehavior,
} from './models/index.js';
export {
  BillingAdjustment,
  BillingAdjustmentCollection,
  ClientCharge,
  ClientChargeCollection,
  PricingRule,
  PricingRuleCollection,
  SpendingPolicy,
  SpendingPolicyCollection,
  SubscriptionPlan,
  TenantSubscription,
  TenantUsageMetric,
} from './models/index.js';
export type {
  CustomPricingContext,
  CustomPricingStrategy,
  PriceUsageOptions,
  SpendingDecision,
} from './services/index.js';
export {
  CommercialUsageService,
  evaluateThreshold,
  evaluateThresholds,
  SpendingPolicyEvaluator,
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
  EntitlementResolutionContext,
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
  SummarizeUsageBatchOptions,
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
  assertSubscriberInvariant,
  getWindowForThreshold,
  getWindowKey,
  isValidThreshold,
  normalizeFeatureGrants,
  normalizeSubscriber,
  subscriberToColumns,
} from './utils.js';
