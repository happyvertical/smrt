/**
 * Built-in Adapters & Usage Handlers
 *
 * Pre-built components for common observability and communication patterns:
 * - AiUsageCollector / AiUsagePersistenceHandler: AI usage handlers for
 *   normalized telemetry collection and persistence
 * - MetricsAdapter: Signal adapter for execution metrics
 *   (Prometheus-compatible)
 * - PubSubAdapter: Signal adapter to broadcast signals to subscribers
 *   (WebSocket/SSE)
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
