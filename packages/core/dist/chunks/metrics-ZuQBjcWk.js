class MetricsAdapter {
  metrics = /* @__PURE__ */ new Map();
  totalSignals = 0;
  startTime = Date.now();
  /**
   * Handle a signal and update metrics
   *
   * @param signal - Signal to process
   */
  async handle(signal) {
    this.totalSignals++;
    if (signal.type !== "end" && signal.type !== "error") {
      return;
    }
    const key = `${signal.className}.${signal.method}`;
    let methodMetrics = this.metrics.get(key);
    if (!methodMetrics) {
      methodMetrics = {
        count: 0,
        successCount: 0,
        errorCount: 0,
        totalDuration: 0,
        minDuration: Number.POSITIVE_INFINITY,
        maxDuration: 0,
        lastExecuted: 0
      };
      this.metrics.set(key, methodMetrics);
    }
    methodMetrics.count++;
    if (signal.type === "end") {
      methodMetrics.successCount++;
    } else {
      methodMetrics.errorCount++;
    }
    if (signal.duration !== void 0) {
      methodMetrics.totalDuration += signal.duration;
      methodMetrics.minDuration = Math.min(
        methodMetrics.minDuration,
        signal.duration
      );
      methodMetrics.maxDuration = Math.max(
        methodMetrics.maxDuration,
        signal.duration
      );
    }
    methodMetrics.lastExecuted = signal.timestamp.getTime();
  }
  /**
   * Get current metrics snapshot
   *
   * @returns Snapshot of all collected metrics
   */
  getMetrics() {
    const methods = {};
    for (const [key, metrics] of this.metrics.entries()) {
      methods[key] = { ...metrics };
    }
    return {
      methods,
      totalSignals: this.totalSignals,
      startTime: this.startTime
    };
  }
  /**
   * Get metrics for a specific method
   *
   * @param className - Class name
   * @param methodName - Method name
   * @returns Metrics for the method, or undefined if not found
   */
  getMethodMetrics(className, methodName) {
    const key = `${className}.${methodName}`;
    const metrics = this.metrics.get(key);
    return metrics ? { ...metrics } : void 0;
  }
  /**
   * Get average duration for a method
   *
   * @param className - Class name
   * @param methodName - Method name
   * @returns Average duration in ms, or 0 if no executions
   */
  getAverageDuration(className, methodName) {
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
  getSuccessRate(className, methodName) {
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
  getErrorRate(className, methodName) {
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
  toPrometheusFormat() {
    const lines = [];
    lines.push("# HELP smrt_method_executions_total Total method executions");
    lines.push("# TYPE smrt_method_executions_total counter");
    lines.push("# HELP smrt_method_duration_seconds Method execution duration");
    lines.push("# TYPE smrt_method_duration_seconds histogram");
    lines.push("# HELP smrt_method_errors_total Total method errors");
    lines.push("# TYPE smrt_method_errors_total counter");
    for (const [key, metrics] of this.metrics.entries()) {
      const [className, methodName] = key.split(".");
      const labels = `class="${className}",method="${methodName}"`;
      lines.push(`smrt_method_executions_total{${labels}} ${metrics.count}`);
      lines.push(
        `smrt_method_executions_total{${labels},status="success"} ${metrics.successCount}`
      );
      lines.push(`smrt_method_errors_total{${labels}} ${metrics.errorCount}`);
      const avgDuration = metrics.totalDuration / metrics.count / 1e3;
      const minDuration = metrics.minDuration / 1e3;
      const maxDuration = metrics.maxDuration / 1e3;
      lines.push(
        `smrt_method_duration_seconds{${labels},quantile="0.0"} ${minDuration}`
      );
      lines.push(
        `smrt_method_duration_seconds{${labels},quantile="0.5"} ${avgDuration}`
      );
      lines.push(
        `smrt_method_duration_seconds{${labels},quantile="1.0"} ${maxDuration}`
      );
    }
    return `${lines.join("\n")}
`;
  }
  /**
   * Reset all metrics
   *
   * Clears all collected metrics and resets counters.
   */
  reset() {
    this.metrics.clear();
    this.totalSignals = 0;
    this.startTime = Date.now();
  }
}
export {
  MetricsAdapter
};
//# sourceMappingURL=metrics-ZuQBjcWk.js.map
