/**
 * Built-in Adapters & Usage Handlers
 *
 * Pre-built components for common observability and communication patterns:
 * - AiUsageCollector / AiUsagePersistenceHandler: AI usage handlers for
 *   normalized telemetry collection and persistence
 * - createAiUsageRecorder / attachAiUsageRecorder: the usage pipeline as an
 *   `onUsage` sink for any AI client (#3077)
 * - MetricsAdapter: Signal adapter for execution metrics
 *   (Prometheus-compatible)
 * - PubSubAdapter: Signal adapter to broadcast signals to subscribers
 *   (WebSocket/SSE)
 */

export type { AiUsageSnapshot, AiUsageStats } from '@happyvertical/smrt-types';
export {
  AI_USAGE_TAG_COLUMNS,
  AiUsageCollector,
  AiUsagePersistenceHandler,
} from './ai-usage.js';
export type {
  AiUsageRecorder,
  AiUsageTenantResolver,
  AiUsageUserResolver,
  CreateAiUsageRecorderOptions,
} from './ai-usage-recorder.js';
export {
  AI_USAGE_USER_TAG,
  attachAiUsageRecorder,
  createAiUsageRecorder,
  getAiUsageTenantResolver,
  getAiUsageUserResolver,
  resolveAiUsageTenantId,
  setAiUsageTenantResolver,
  setAiUsageUserResolver,
} from './ai-usage-recorder.js';
export {
  DEFAULT_AI_COST_RATES,
  estimateAiUsageCost,
} from './cost-rates.js';
export type {
  MethodMetrics,
  MetricsSnapshot,
} from './metrics.js';
export { MetricsAdapter } from './metrics.js';
export type {
  SignalFilter,
  SignalSubscriber,
  Subscription,
} from './pubsub.js';
export { PubSubAdapter } from './pubsub.js';
