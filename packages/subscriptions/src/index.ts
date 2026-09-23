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
// Major-units → integer minor-units migration (#2401)
export {
  migrateSubscriptionsMoneyToMinorUnits,
  preflightSubscriptionsMoneyMinorUnits,
  SUBSCRIPTIONS_MONEY_COLUMNS,
  SUBSCRIPTIONS_MONEY_MINOR_UNITS_BACKFILL,
} from './migrations/moneyMinorUnits.js';
export type {
  PriceBookKind,
  PricingStrategy,
  SpendingBasis,
  SpendingPeriod,
  SpendingPolicyBehavior,
} from './models/index.js';
export {
  BillingAdjustment,
  BillingAdjustmentCollection,
  ClientCharge,
  ClientChargeCollection,
  CreditGrant,
  CreditGrantCollection,
  isCurrencyCode,
  isPriceBookKind,
  PriceBook,
  PriceBookAssignment,
  PriceBookCollection,
  PricingRule,
  PricingRuleCollection,
  RetailCharge,
  RetailChargeCollection,
  SpendingPolicy,
  SpendingPolicyCollection,
  SubscriptionPlan,
  TenantSubscription,
  TenantUsageMetric,
} from './models/index.js';
export type {
  AssignPriceBooksInput,
  AutoTopUpGrant,
  AutoTopUpHook,
  AutoTopUpRequest,
  BillingRelationshipReader,
  CommercialBillingStorage,
  CommercialUsageServiceOptions,
  CustomPricingContext,
  CustomPricingStrategy,
  DefinePriceBookPriceInput,
  DelegatedSpendingPolicyInput,
  GrantChildCreditInput,
  GrantCreditInput,
  PriceBookAssignmentView,
  PriceBookLeg,
  PriceUsageOptions,
  RateUsageOptions,
  ResellerBillingAction,
  ResellerBillingErrorCode,
  ResellerBillingServiceOptions,
  SpendingDecision,
  SpendingEvaluationInput,
  SpendingPolicyEvaluatorExtensions,
  SpendingPolicyEvaluatorOptions,
  UsageRating,
} from './services/index.js';
export {
  assertCommercialBillingStorageSupported,
  CommercialBillingStorageConfigurationError,
  CommercialUsageService,
  evaluateThreshold,
  evaluateThresholds,
  ResellerBillingError,
  ResellerBillingService,
  SpendingPolicyEvaluator,
  type SubscriptionPlanReader,
  SubscriptionResolver,
  type SubscriptionResolverReaders,
  type TenantSubscriptionReader,
  TenantUsageMeter,
  UnsupportedCommercialBillingStorageError,
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
