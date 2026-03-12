/**
 * Built-in Signal Adapters
 *
 * Pre-built adapters for common observability and communication patterns:
 * - AiUsageCollector: Track normalized AI usage telemetry in memory
 * - MetricsAdapter: Track execution metrics (Prometheus-compatible)
 * - PubSubAdapter: Broadcast signals to subscribers (WebSocket/SSE)
 */

export type { AiUsageSnapshot, AiUsageStats } from '@happyvertical/smrt-types';
export { AiUsageCollector, AiUsagePersistenceHandler } from './ai-usage.js';
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
