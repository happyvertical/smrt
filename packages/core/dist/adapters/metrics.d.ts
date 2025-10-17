import { SignalAdapter, Signal } from '@smrt/types';
/**
 * Execution metrics for a specific method
 */
export interface MethodMetrics {
    /** Total number of executions */
    count: number;
    /** Number of successful executions */
    successCount: number;
    /** Number of failed executions */
    errorCount: number;
    /** Total execution time across all calls (ms) */
    totalDuration: number;
    /** Minimum execution time (ms) */
    minDuration: number;
    /** Maximum execution time (ms) */
    maxDuration: number;
    /** Last execution timestamp */
    lastExecuted: number;
}
/**
 * Aggregated metrics storage
 */
export interface MetricsSnapshot {
    /** Metrics per class.method combination */
    methods: Record<string, MethodMetrics>;
    /** Total signals processed */
    totalSignals: number;
    /** Metrics collection start time */
    startTime: number;
}
/**
 * Metrics Adapter - Tracks execution metrics for observability
 *
 * Provides Prometheus-style metrics for SMRT method executions:
 * - Execution counts (total, success, error)
 * - Duration statistics (min, max, avg)
 * - Success/error rates
 *
 * @example
 * ```typescript
 * const metrics = new MetricsAdapter();
 * signalBus.register(metrics);
 *
 * // Later, get metrics snapshot
 * const snapshot = metrics.getMetrics();
 * console.log(snapshot.methods['Product.analyze']);
 * ```
 */
export declare class MetricsAdapter implements SignalAdapter {
    private metrics;
    private totalSignals;
    private startTime;
    /**
     * Handle a signal and update metrics
     *
     * @param signal - Signal to process
     */
    handle(signal: Signal): Promise<void>;
    /**
     * Get current metrics snapshot
     *
     * @returns Snapshot of all collected metrics
     */
    getMetrics(): MetricsSnapshot;
    /**
     * Get metrics for a specific method
     *
     * @param className - Class name
     * @param methodName - Method name
     * @returns Metrics for the method, or undefined if not found
     */
    getMethodMetrics(className: string, methodName: string): MethodMetrics | undefined;
    /**
     * Get average duration for a method
     *
     * @param className - Class name
     * @param methodName - Method name
     * @returns Average duration in ms, or 0 if no executions
     */
    getAverageDuration(className: string, methodName: string): number;
    /**
     * Get success rate for a method
     *
     * @param className - Class name
     * @param methodName - Method name
     * @returns Success rate (0-1), or 0 if no executions
     */
    getSuccessRate(className: string, methodName: string): number;
    /**
     * Get error rate for a method
     *
     * @param className - Class name
     * @param methodName - Method name
     * @returns Error rate (0-1), or 0 if no executions
     */
    getErrorRate(className: string, methodName: string): number;
    /**
     * Export metrics in Prometheus text format
     *
     * @returns Prometheus-compatible metrics text
     */
    toPrometheusFormat(): string;
    /**
     * Reset all metrics
     *
     * Clears all collected metrics and resets counters.
     */
    reset(): void;
}
//# sourceMappingURL=metrics.d.ts.map