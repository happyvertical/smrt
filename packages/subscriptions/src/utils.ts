import type {
  JsonObject,
  PlanFeatureGrant,
  PlanThreshold,
  Subscriber,
  SubscriberKind,
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

/**
 * Coerce inputs from the legacy tenant-only API into a {@link Subscriber}.
 *
 * Existing callers that pass only `tenantId` (with optional `subscriberKind` /
 * `subscriberExternalId` fields, e.g. on `RecordUsageOptions`) get normalized
 * into the discriminated union exactly once at the boundary. This is the only
 * place that contains "if kind is omitted, default to tenant" logic — every
 * other site works with a typed `Subscriber`.
 *
 * Throws when:
 * - `subscriberKind === 'external'` is requested without a non-empty
 *   `subscriberExternalId` (the XOR invariant is the whole point), or
 * - the input carries a non-empty `subscriberExternalId` but the kind resolves
 *   to `'tenant'` (silent re-scoping would write buyer-scoped usage as tenant
 *   usage, which then disappears from external summaries).
 */
export function normalizeSubscriber(input: {
  tenantId: string;
  subscriberKind?: SubscriberKind;
  subscriberExternalId?: string;
}): Subscriber {
  const externalId = input.subscriberExternalId ?? '';
  const kind: SubscriberKind = input.subscriberKind ?? 'tenant';
  if (kind === 'tenant') {
    if (externalId !== '') {
      throw new Error(
        'subscriberExternalId is set but subscriberKind is "tenant"; ' +
          'set subscriberKind="external" explicitly or omit subscriberExternalId',
      );
    }
    return { kind: 'tenant', tenantId: input.tenantId };
  }
  if (externalId === '') {
    throw new Error(
      'subscriberKind="external" requires a non-empty subscriberExternalId',
    );
  }
  return {
    kind: 'external',
    tenantId: input.tenantId,
    externalId,
  };
}

/**
 * Project a {@link Subscriber} back onto column values for persistence or query
 * filters. Counterpart to {@link normalizeSubscriber}.
 */
export function subscriberToColumns(subscriber: Subscriber): {
  tenantId: string;
  subscriberKind: SubscriberKind;
  subscriberExternalId: string;
} {
  if (subscriber.kind === 'tenant') {
    return {
      tenantId: subscriber.tenantId,
      subscriberKind: 'tenant',
      subscriberExternalId: '',
    };
  }
  return {
    tenantId: subscriber.tenantId,
    subscriberKind: 'external',
    subscriberExternalId: subscriber.externalId,
  };
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
