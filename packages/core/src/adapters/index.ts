/**
 * Built-in Signal Adapters
 *
 * Pre-built adapters for common observability and communication patterns:
 * - MetricsAdapter: Track execution metrics (Prometheus-compatible)
 * - PubSubAdapter: Broadcast signals to subscribers (WebSocket/SSE)
 */

// JSON adapter with SMRT schema injection
export type { SchemaProvider } from './json.js';
export { getGenericJSONDatabase, getSmrtJSONDatabase } from './json.js';
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
