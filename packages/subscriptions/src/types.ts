import type { SmrtClassOptions } from '@happyvertical/smrt-core';

export type SubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'incomplete'
  | 'past_due'
  | 'trialing'
  | 'unpaid';

export type SubscriptionPlanStatus = 'active' | 'archived' | 'draft';

export type BillingInterval = 'day' | 'week' | 'month' | 'year';

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
  subscriptionId: string | null;
  status: SubscriptionStatus | 'none';
  featureKeys: string[];
  thresholds: PlanThreshold[];
  thresholdEvaluations: ThresholdEvaluation[];
  allowed: boolean;
}

export interface SubscriptionResolverOptions {
  now?: Date;
  usageWindows?: Partial<Record<ThresholdWindow, UsageWindow>>;
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

export interface SummarizeAiUsageOptions {
  tenantId: string;
  window: UsageWindow;
}

export type JsonObject = Record<string, unknown>;

export type { SmrtClassOptions };
