import type {
  PlanThreshold,
  ThresholdEvaluation,
  UsageSummary,
} from '../types.js';

export function evaluateThreshold(
  threshold: PlanThreshold,
  usage: UsageSummary,
): ThresholdEvaluation {
  const ratio =
    threshold.limit === 0
      ? usage.quantity > 0
        ? Infinity
        : 0
      : usage.quantity / threshold.limit;
  const warningRatio = threshold.warningRatio ?? 0.8;
  const blocked =
    threshold.enforcement === 'block' && usage.quantity >= threshold.limit;
  const warned = !blocked && ratio >= warningRatio;

  return {
    threshold,
    usage,
    ratio,
    state: blocked ? 'blocked' : warned ? 'warn' : 'ok',
    allowed: !blocked,
    remaining: Math.max(0, threshold.limit - usage.quantity),
  };
}

export function evaluateThresholds(
  thresholds: PlanThreshold[],
  usage: UsageSummary[],
): ThresholdEvaluation[] {
  const usageByMetric = new Map(
    usage.map((summary) => [summary.metricKey, summary]),
  );

  return thresholds.map((threshold) => {
    const summary =
      usageByMetric.get(threshold.metricKey) ??
      emptyUsageSummary(threshold.metricKey);
    return evaluateThreshold(threshold, summary);
  });
}

function emptyUsageSummary(metricKey: string): UsageSummary {
  const now = new Date();
  return {
    tenantId: '',
    metricKey,
    quantity: 0,
    windowStart: now,
    windowEnd: now,
  };
}
