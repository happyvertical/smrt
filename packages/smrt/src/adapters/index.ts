/**
 * Built-in Signal Adapters
 *
 * Pre-built adapters for common observability and communication patterns:
 * - MetricsAdapter: Track execution metrics (Prometheus-compatible)
 * - PubSubAdapter: Broadcast signals to subscribers (WebSocket/SSE)
 */

export { MetricsAdapter } from './metrics.js';
export type {
  MethodMetrics,
  MetricsSnapshot,
} from './metrics.js';

export { PubSubAdapter } from './pubsub.js';
export type {
  SignalFilter,
  SignalSubscriber,
  Subscription,
} from './pubsub.js';
