/**
 * Metrics Adapter for Signal System
 *
 * Tracks execution metrics for SMRT objects in Prometheus-compatible format.
 * Collects counts, durations, error rates, and success rates.
 */

import type { SignalAdapter, Signal } from '@smrt/types';

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
export class MetricsAdapter implements SignalAdapter {
  private metrics: Map<string, MethodMetrics> = new Map();
  private totalSignals = 0;
  private startTime = Date.now();

  /**
   * Handle a signal and update metrics
   *
   * @param signal - Signal to process
   */
  async handle(signal: Signal): Promise<void> {
    this.totalSignals++;

    // Only track end and error signals (they have duration)
    if (signal.type !== 'end' && signal.type !== 'error') {
      return;
    }

    const key = `${signal.className}.${signal.method}`;
    let methodMetrics = this.metrics.get(key);

    // Initialize metrics for new method
    if (!methodMetrics) {
      methodMetrics = {
        count: 0,
        successCount: 0,
        errorCount: 0,
        totalDuration: 0,
        minDuration: Number.POSITIVE_INFINITY,
        maxDuration: 0,
        lastExecuted: 0,
      };
      this.metrics.set(key, methodMetrics);
    }

    // Update counts
    methodMetrics.count++;
    if (signal.type === 'end') {
      methodMetrics.successCount++;
    } else {
      methodMetrics.errorCount++;
    }

    // Update duration statistics
    if (signal.duration !== undefined) {
      methodMetrics.totalDuration += signal.duration;
      methodMetrics.minDuration = Math.min(
        methodMetrics.minDuration,
        signal.duration,
      );
      methodMetrics.maxDuration = Math.max(
        methodMetrics.maxDuration,
        signal.duration,
      );
    }

    methodMetrics.lastExecuted = signal.timestamp.getTime();
  }

  /**
   * Get current metrics snapshot
   *
   * @returns Snapshot of all collected metrics
   */
  getMetrics(): MetricsSnapshot {
    const methods: Record<string, MethodMetrics> = {};

    for (const [key, metrics] of this.metrics.entries()) {
      methods[key] = { ...metrics };
    }

    return {
      methods,
      totalSignals: this.totalSignals,
      startTime: this.startTime,
    };
  }

  /**
   * Get metrics for a specific method
   *
   * @param className - Class name
   * @param methodName - Method name
   * @returns Metrics for the method, or undefined if not found
   */
  getMethodMetrics(
    className: string,
    methodName: string,
  ): MethodMetrics | undefined {
    const key = `${className}.${methodName}`;
    const metrics = this.metrics.get(key);
    return metrics ? { ...metrics } : undefined;
  }

  /**
   * Get average duration for a method
   *
   * @param className - Class name
   * @param methodName - Method name
   * @returns Average duration in ms, or 0 if no executions
   */
  getAverageDuration(className: string, methodName: string): number {
    const metrics = this.getMethodMetrics(className, methodName);
    if (!metrics || metrics.count === 0) {
      return 0;
    }
    return metrics.totalDuration / metrics.count;
  }

  /**
   * Get success rate for a method
   *
   * @param className - Class name
   * @param methodName - Method name
   * @returns Success rate (0-1), or 0 if no executions
   */
  getSuccessRate(className: string, methodName: string): number {
    const metrics = this.getMethodMetrics(className, methodName);
    if (!metrics || metrics.count === 0) {
      return 0;
    }
    return metrics.successCount / metrics.count;
  }

  /**
   * Get error rate for a method
   *
   * @param className - Class name
   * @param methodName - Method name
   * @returns Error rate (0-1), or 0 if no executions
   */
  getErrorRate(className: string, methodName: string): number {
    const metrics = this.getMethodMetrics(className, methodName);
    if (!metrics || metrics.count === 0) {
      return 0;
    }
    return metrics.errorCount / metrics.count;
  }

  /**
   * Export metrics in Prometheus text format
   *
   * @returns Prometheus-compatible metrics text
   */
  toPrometheusFormat(): string {
    const lines: string[] = [];

    // Add help and type declarations
    lines.push('# HELP smrt_method_executions_total Total method executions');
    lines.push('# TYPE smrt_method_executions_total counter');

    lines.push('# HELP smrt_method_duration_seconds Method execution duration');
    lines.push('# TYPE smrt_method_duration_seconds histogram');

    lines.push('# HELP smrt_method_errors_total Total method errors');
    lines.push('# TYPE smrt_method_errors_total counter');

    // Generate metrics for each method
    for (const [key, metrics] of this.metrics.entries()) {
      const [className, methodName] = key.split('.');
      const labels = `class="${className}",method="${methodName}"`;

      // Execution count
      lines.push(`smrt_method_executions_total{${labels}} ${metrics.count}`);

      // Success count
      lines.push(
        `smrt_method_executions_total{${labels},status="success"} ${metrics.successCount}`,
      );

      // Error count
      lines.push(`smrt_method_errors_total{${labels}} ${metrics.errorCount}`);

      // Duration statistics (convert to seconds for Prometheus)
      const avgDuration = metrics.totalDuration / metrics.count / 1000;
      const minDuration = metrics.minDuration / 1000;
      const maxDuration = metrics.maxDuration / 1000;

      lines.push(
        `smrt_method_duration_seconds{${labels},quantile="0.0"} ${minDuration}`,
      );
      lines.push(
        `smrt_method_duration_seconds{${labels},quantile="0.5"} ${avgDuration}`,
      );
      lines.push(
        `smrt_method_duration_seconds{${labels},quantile="1.0"} ${maxDuration}`,
      );
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Reset all metrics
   *
   * Clears all collected metrics and resets counters.
   */
  reset(): void {
    this.metrics.clear();
    this.totalSignals = 0;
    this.startTime = Date.now();
  }
}
