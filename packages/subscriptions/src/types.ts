import type {
  SmrtClassOptions,
  SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import type { SubscriptionPlan } from './models/SubscriptionPlan.js';
import type { SubscriptionPlanVersion } from './models/SubscriptionPlanVersion.js';
import type { TenantSubscription } from './models/TenantSubscription.js';

export type SubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'incomplete'
  | 'past_due'
  | 'trialing'
  | 'unpaid';

export type SubscriptionPlanStatus = 'active' | 'archived' | 'draft';

export type BillingInterval = 'day' | 'week' | 'month' | 'year';

/** How a subscriber agrees to pay for a plan. Amounts are integer minor units. */
export type PricingMode = 'free' | 'fixed' | 'pay_what_you_can';

/**
 * Why a subscription is bound to its current plan version (#4032).
 *
 * - `period_start`: pinned to the version in force when the period began.
 * - `renewal`: re-pinned at a renewal boundary (`currentPeriodStart` moved).
 * - `upgrade`: replaced in-period by a version whose entitlements cover the
 *   frozen one ({@link isEntitlementUpgrade}).
 * - `authorized`: replaced in-period through an explicit, reasoned
 *   `TenantSubscription.replacePlanVersion({ policy: 'authorized', reason })` call.
 * - `migration`: pinned by `migrateSubscriptionPlanVersions()`.
 */
export type PlanVersionPinReason =
  | 'period_start'
  | 'renewal'
  | 'upgrade'
  | 'authorized'
  | 'migration';

/**
 * The versioned terms of a plan: what a subscriber paid for. Editing any of
 * these on a persisted `SubscriptionPlan` publishes a new immutable
 * `SubscriptionPlanVersion` (#4032). Amounts are integer minor units.
 */
export interface PlanTerms {
  status: SubscriptionPlanStatus;
  priceAmount: number;
  currency: string;
  billingInterval: BillingInterval;
  pricingMode: PricingMode;
  minimumAmount: number;
  suggestedAmount: number;
  /** JSON-encoded `PlanFeatureGrant[]`. */
  features: string;
  /** JSON-encoded `PlanThreshold[]`. */
  thresholds: string;
}

export type ThresholdEnforcement = 'observe' | 'warn' | 'block';

export type ThresholdWindow = 'day' | 'week' | 'month' | 'year' | 'rolling';

export type SubscriberKind = 'tenant' | 'external';

/**
 * Discriminated union identifying who a subscription/usage record is for.
 *
 * - `tenant`: the subscriber IS the owning tenant — preserves the existing
 *   single-tenant SaaS shape end-to-end.
 * - `external`: the subscriber is a caller-defined identity (opaque to this
 *   package) scoped under an issuing `tenantId`. The `externalId` is a free-form
 *   string that the caller namespaces (e.g. `buyer-contact:abc123`). Use this
 *   for B2C buyers, anonymous-email subscribers, agent identities, etc.
 *
 * For both kinds, `tenantId` carries the owning/issuing tenant scope.
 */
export type Subscriber =
  | { kind: 'tenant'; tenantId: string }
  | { kind: 'external'; tenantId: string; externalId: string };

export interface PlanFeatureGrant {
  featureKey: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PlanThreshold {
  metricKey: string;
  limit: number;
  window: ThresholdWindow;
  enforcement: ThresholdEnforcement;
  label?: string;
  warningRatio?: number;
  metadata?: Record<string, unknown>;
}

export interface UsageWindow {
  start: Date;
  end: Date;
}

export interface UsageMetricRecord {
  /**
   * Owning/issuing tenant scope. For `subscriberKind: 'tenant'` records this is
   * also the subscriber. For `'external'` records this is the issuer.
   */
  tenantId: string;
  /**
   * Defaults to `'tenant'` when omitted — preserves the historical single-tenant
   * shape for existing callers.
   */
  subscriberKind?: SubscriberKind;
  /**
   * Required when `subscriberKind` is `'external'`. Caller-namespaced opaque
   * identifier (e.g. `buyer-contact:abc123`).
   */
  subscriberExternalId?: string;
  metricKey: string;
  quantity: number;
  windowStart: Date;
  windowEnd: Date;
  source?: string;
  sourceId?: string;
  projectId?: string;
  workRefType?: string;
  workRefId?: string;
  provider?: string;
  dimensions?: Record<string, unknown>;
}

export interface UsageSummary {
  /** Owning/issuing tenant scope. */
  tenantId: string;
  /** Subscriber kind this summary represents. Defaults to `'tenant'`. */
  subscriberKind?: SubscriberKind;
  /** Set when `subscriberKind === 'external'`. */
  subscriberExternalId?: string;
  metricKey: string;
  quantity: number;
  windowStart: Date;
  windowEnd: Date;
}

export interface AiUsageSummary {
  tenantId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  requestCount: number;
  windowStart: Date;
  windowEnd: Date;
}

export interface ThresholdEvaluation {
  threshold: PlanThreshold;
  usage: UsageSummary;
  ratio: number;
  state: 'ok' | 'warn' | 'blocked';
  allowed: boolean;
  remaining: number;
}

export interface EntitlementResolution {
  /** Issuing/owning tenant scope. */
  tenantId: string;
  /**
   * The subscriber identity this resolution was computed for.
   *
   * Always populated at runtime by `SubscriptionResolver.resolveEntitlements`,
   * but kept optional on the interface so downstream code that constructs
   * or mocks `EntitlementResolution` (pre-#1454) continues to typecheck
   * without code changes.
   */
  subscriber?: Subscriber;
  planId: string | null;
  planKey: string | null;
  /**
   * The immutable plan version whose terms produced this resolution, or null
   * when none applies (no subscription, or a legacy plan with no versions).
   * Optional on the interface so pre-#4032 mocks keep typechecking.
   */
  planVersionId?: string | null;
  /** Sequence number of {@link planVersionId} within its plan. */
  planVersion?: number | null;
  subscriptionId: string | null;
  status: SubscriptionStatus | 'none';
  featureKeys: string[];
  thresholds: PlanThreshold[];
  thresholdEvaluations: ThresholdEvaluation[];
  allowed: boolean;
}

export interface EntitlementResolutionContext {
  /**
   * Current subscription for the requested subscriber. Set to `null` when a
   * caller has already resolved that no current subscription exists.
   */
  subscription?: TenantSubscription | null;
  /**
   * Plan for `subscription.planId`. Set to `null` when the caller has already
   * resolved the plan as absent or inactive.
   */
  plan?: SubscriptionPlan | null;
  /**
   * Plan version frozen for the subscription's current period (#4032). Must
   * match `subscription.planVersionId` when that is set. Set to `null` when
   * the caller has already resolved the version as absent.
   */
  planVersion?: SubscriptionPlanVersion | null;
}

export interface SubscriptionResolverOptions {
  now?: Date;
  usageWindows?: Partial<Record<ThresholdWindow, UsageWindow>>;
  /**
   * Request-scoped context that lets repeated entitlement checks reuse an
   * already-loaded subscription and plan instead of re-querying readers.
   */
  context?: EntitlementResolutionContext;
}

export interface UsageMeterOptions {
  classOptions?: SmrtClassOptions;
}

export interface RecordUsageOptions extends UsageMetricRecord {}

export interface SummarizeUsageOptions {
  /** Owning/issuing tenant scope. */
  tenantId: string;
  /** Defaults to `'tenant'`. */
  subscriberKind?: SubscriberKind;
  /** Required when `subscriberKind === 'external'`. */
  subscriberExternalId?: string;
  metricKey: string;
  window: UsageWindow;
}

export interface SummarizeUsageBatchOptions {
  /** Owning/issuing tenant scope. */
  tenantId: string;
  /** Defaults to `'tenant'`. */
  subscriberKind?: SubscriberKind;
  /** Required when `subscriberKind === 'external'`. */
  subscriberExternalId?: string;
  metricKeys: string[];
  window: UsageWindow;
}

export interface SummarizeAiUsageOptions {
  tenantId: string;
  window: UsageWindow;
}

export type JsonObject = Record<string, unknown>;

/**
 * Constructor options for {@link SubscriptionPlan}. Each field mirrors a
 * persisted column and is optional; unspecified values fall back to the class
 * initializers.
 */
export interface SubscriptionPlanOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  planKey?: string;
  name?: string;
  description?: string;
  status?: SubscriptionPlanStatus;
  sortOrder?: number;
  priceAmount?: number;
  currency?: string;
  billingInterval?: BillingInterval;
  pricingMode?: PricingMode;
  minimumAmount?: number;
  suggestedAmount?: number;
  externalProvider?: string | null;
  providerProductId?: string | null;
  providerPriceId?: string | null;
  /** @deprecated Use providerProductId. Retained to read existing Stripe bindings. */
  stripeProductId?: string | null;
  /** @deprecated Use providerPriceId. Retained to read existing Stripe bindings. */
  stripePriceId?: string | null;
  features?: string;
  thresholds?: string;
  metadata?: string;
}

/**
 * Constructor options for {@link SubscriptionPlanVersion}. Versions are
 * normally published by saving a `SubscriptionPlan`; construct one directly
 * only in tests or migrations.
 */
export interface SubscriptionPlanVersionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  planId?: string;
  planKey?: string;
  version?: number;
  effectiveFrom?: Date;
  name?: string;
  status?: SubscriptionPlanStatus;
  priceAmount?: number;
  currency?: string;
  billingInterval?: BillingInterval;
  pricingMode?: PricingMode;
  minimumAmount?: number;
  suggestedAmount?: number;
  features?: string;
  thresholds?: string;
}

/**
 * Constructor options for {@link TenantSubscription}. Each field mirrors a
 * persisted column and is optional; unspecified values fall back to the class
 * initializers.
 */
export interface TenantSubscriptionOptions extends SmrtObjectOptions {
  tenantId?: string;
  subscriberKind?: SubscriberKind;
  subscriberExternalId?: string;
  planId?: string;
  status?: SubscriptionStatus;
  startedAt?: Date;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date | null;
  agreedAmount?: number | null;
  planVersionId?: string | null;
  planVersionPinnedAt?: Date | null;
  planVersionPinReason?: PlanVersionPinReason | null;
  planVersionPinNote?: string;
  retainsPaidPeriod?: boolean;
  externalProvider?: string | null;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeCheckoutSessionId?: string;
  metadata?: string;
}

/**
 * Constructor options for {@link TenantUsageMetric}. Each field mirrors a
 * persisted column and is optional; unspecified values fall back to the class
 * initializers.
 */
export interface TenantUsageMetricOptions extends SmrtObjectOptions {
  tenantId?: string;
  subscriberKind?: SubscriberKind;
  subscriberExternalId?: string;
  metricKey?: string;
  quantity?: number;
  windowStart?: Date;
  windowEnd?: Date;
  source?: string;
  sourceId?: string;
  projectId?: string;
  workRefType?: string;
  workRefId?: string;
  provider?: string;
  dimensions?: string;
}

export type { SmrtClassOptions };
