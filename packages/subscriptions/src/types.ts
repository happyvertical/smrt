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
  tenantId: string;
  metricKey: string;
  quantity: number;
  windowStart: Date;
  windowEnd: Date;
  source?: string;
  sourceId?: string;
  dimensions?: Record<string, unknown>;
}

export interface UsageSummary {
  tenantId: string;
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
  tenantId: string;
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
  tenantId: string;
  metricKey: string;
  window: UsageWindow;
}

export interface SummarizeAiUsageOptions {
  tenantId: string;
  window: UsageWindow;
}

export type JsonObject = Record<string, unknown>;

export type { SmrtClassOptions };
