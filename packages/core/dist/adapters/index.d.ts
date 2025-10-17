/**
 * Built-in Signal Adapters
 *
 * Pre-built adapters for common observability and communication patterns:
 * - MetricsAdapter: Track execution metrics (Prometheus-compatible)
 * - PubSubAdapter: Broadcast signals to subscribers (WebSocket/SSE)
 */
export type { MethodMetrics, MetricsSnapshot, } from './metrics.js';
export { MetricsAdapter } from './metrics.js';
export type { SignalFilter, SignalSubscriber, Subscription, } from './pubsub.js';
export { PubSubAdapter } from './pubsub.js';
//# sourceMappingURL=index.d.ts.map