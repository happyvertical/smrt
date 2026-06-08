import type {
  JsonObject,
  PlanFeatureGrant,
  PlanThreshold,
  ThresholdEnforcement,
  ThresholdWindow,
  UsageWindow,
} from './types.js';

const THRESHOLD_WINDOWS: ThresholdWindow[] = [
  'day',
  'week',
  'month',
  'year',
  'rolling',
];
const THRESHOLD_ENFORCEMENTS: ThresholdEnforcement[] = [
  'observe',
  'warn',
  'block',
];

export function parseJsonArray<T>(value: string, fallback: T[] = []): T[] {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export function parseJsonObject<T extends JsonObject>(
  value: string,
  fallback: T,
): T {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function normalizeFeatureGrants(
  grants: Array<string | PlanFeatureGrant>,
): PlanFeatureGrant[] {
  return grants.map((grant) =>
    typeof grant === 'string' ? { featureKey: grant, enabled: true } : grant,
  );
}

export function getWindowForThreshold(
  thresholdWindow: ThresholdWindow,
  now = new Date(),
): UsageWindow {
  switch (thresholdWindow) {
    case 'day':
      return utcWindow(now, 'day');
    case 'week':
      return utcWindow(now, 'week');
    case 'month':
      return utcWindow(now, 'month');
    case 'year':
      return utcWindow(now, 'year');
    case 'rolling':
      return {
        start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        end: now,
      };
  }
}

export function getWindowKey(window: UsageWindow): string {
  return `${window.start.toISOString()}..${window.end.toISOString()}`;
}

export function isValidThreshold(threshold: PlanThreshold): boolean {
  return (
    typeof threshold.metricKey === 'string' &&
    threshold.metricKey.length > 0 &&
    Number.isFinite(threshold.limit) &&
    threshold.limit >= 0 &&
    isThresholdWindow(threshold.window) &&
    isThresholdEnforcement(threshold.enforcement) &&
    (threshold.warningRatio === undefined ||
      (Number.isFinite(threshold.warningRatio) &&
        threshold.warningRatio >= 0 &&
        threshold.warningRatio <= 1))
  );
}

function isThresholdWindow(value: unknown): value is ThresholdWindow {
  return (
    typeof value === 'string' &&
    THRESHOLD_WINDOWS.includes(value as ThresholdWindow)
  );
}

function isThresholdEnforcement(value: unknown): value is ThresholdEnforcement {
  return (
    typeof value === 'string' &&
    THRESHOLD_ENFORCEMENTS.includes(value as ThresholdEnforcement)
  );
}

function utcWindow(now: Date, unit: 'day' | 'week' | 'month' | 'year') {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  if (unit === 'week') {
    const day = start.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setUTCDate(start.getUTCDate() + mondayOffset);
  }

  if (unit === 'month') {
    start.setUTCDate(1);
  }

  if (unit === 'year') {
    start.setUTCMonth(0, 1);
  }

  const end = new Date(start);
  switch (unit) {
    case 'day':
      end.setUTCDate(end.getUTCDate() + 1);
      break;
    case 'week':
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    case 'month':
      end.setUTCMonth(end.getUTCMonth() + 1);
      break;
    case 'year':
      end.setUTCFullYear(end.getUTCFullYear() + 1);
      break;
  }

  return { start, end };
}
