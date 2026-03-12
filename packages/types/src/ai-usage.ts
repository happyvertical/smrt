/**
 * Shared AI usage tracking types for SMRT.
 *
 * These types are intentionally provider-agnostic so SMRT can normalize
 * telemetry emitted by the underlying AI SDK into a stable internal shape.
 */

/**
 * Normalized token usage information for an AI call.
 */
export interface AiTokenUsage {
  /** Number of input tokens consumed by the request */
  promptTokens?: number;

  /** Number of output tokens produced by the response */
  completionTokens?: number;

  /** Total tokens consumed across the call */
  totalTokens?: number;
}

/**
 * Stable usage event shape emitted inside SMRT after every AI call.
 */
export interface SmrtAiUsageEvent {
  /** AI provider identifier (e.g. "openai", "anthropic") */
  provider: string;

  /** Model identifier used for the call */
  model: string;

  /** High-level operation name (e.g. "chat", "embed", "stream") */
  operation: string;

  /** Token usage reported by the provider, when available */
  usage?: AiTokenUsage;

  /** Wall-clock duration in milliseconds */
  duration: number;

  /** Event timestamp */
  timestamp: Date;

  /** Optional provider- or application-specific tags */
  tags?: Record<string, string>;

  /** SMRT class responsible for the call */
  className?: string;

  /** Tenant identifier when available */
  tenantId?: string | null;

  /** Best-effort estimated cost in USD */
  estimatedCost?: number;
}

/**
 * Persisted AI usage record returned from query helpers.
 */
export interface SmrtAiUsageRecord extends SmrtAiUsageEvent {
  /** Persistent record identifier */
  id: string;
}

/**
 * Aggregated statistics bucket for AI usage reporting.
 */
export interface AiUsageStats {
  /** Number of calls represented in the bucket */
  callCount: number;

  /** Sum of prompt/input tokens */
  promptTokens: number;

  /** Sum of completion/output tokens */
  completionTokens: number;

  /** Sum of total tokens */
  totalTokens: number;

  /** Sum of durations in milliseconds */
  totalDuration: number;

  /** Sum of estimated costs in USD */
  estimatedCost: number;

  /** Timestamp of the most recent event in epoch milliseconds */
  lastUsed: number;
}

/**
 * In-memory snapshot returned by the collector.
 */
export interface AiUsageSnapshot {
  /** Usage aggregated by "provider:model" */
  byModel: Record<string, AiUsageStats>;

  /** Usage aggregated by "className:operation" */
  byClass: Record<string, AiUsageStats>;

  /** Total number of calls observed by the collector */
  totalCalls: number;

  /** Collector start time in epoch milliseconds */
  startTime: number;
}

/**
 * Callback interface for handling normalized AI usage events.
 */
export interface AiUsageHandler {
  /**
   * Handle a normalized AI usage event.
   */
  handle(event: SmrtAiUsageEvent): Promise<void>;
}

/**
 * Grouping dimensions supported by summary helpers.
 */
export type AiUsageGroupBy =
  | 'provider'
  | 'model'
  | 'class'
  | 'tenant'
  | 'operation'
  | 'day';

/**
 * Options for listing raw AI usage records from persistence.
 */
export interface AiUsageListOptions {
  /** Only include records on or after this timestamp */
  since?: Date;

  /** Only include records before or at this timestamp */
  until?: Date;

  /** Filter by provider */
  provider?: string;

  /** Filter by model */
  model?: string;

  /** Filter by operation */
  operation?: string;

  /** Filter by SMRT class name */
  className?: string;

  /** Filter by tenant ID */
  tenantId?: string | null;

  /** Maximum number of rows to return */
  limit?: number;

  /** Number of rows to skip */
  offset?: number;

  /** Sort order */
  orderBy?: 'timestamp DESC' | 'timestamp ASC';
}

/**
 * Options for summarized AI usage queries.
 */
export interface AiUsageSummaryOptions
  extends Omit<AiUsageListOptions, 'limit' | 'offset' | 'orderBy'> {
  /** Dimension to group summary buckets by */
  groupBy?: AiUsageGroupBy;
}
