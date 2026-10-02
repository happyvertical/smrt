import type { TimecardPeriod, TimecardSource } from './types.js';

export function integer(value: number, signed = false): number {
  if (!Number.isSafeInteger(value) || (!signed && value < 0))
    throw new Error('Timecard seconds must be safe integers and nonnegative.');
  return value;
}
export function instant(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Timecard timestamps must be valid dates.');
  return value.getTime();
}
export function validatePeriod(
  value: TimecardPeriod,
  at: Date,
): TimecardPeriod {
  if (
    !value ||
    instant(value.startsAt) > instant(at) ||
    instant(value.endsAt) <= instant(at) ||
    instant(value.startsAt) >= instant(value.endsAt)
  )
    throw new Error('Resolver period must contain the requested instant.');
  if (!value.timezone || !value.version?.trim())
    throw new Error('Resolver must supply a timezone and policy version.');
  new Intl.DateTimeFormat('en', { timeZone: value.timezone });
  if (
    !value.rules ||
    typeof value.rules !== 'object' ||
    Array.isArray(value.rules)
  )
    throw new Error('Resolver rules must be a JSON object.');
  // JSON round-trip detaches consumer-owned state; fail rather than silently lose non-JSON values.
  const json = JSON.stringify(value.rules, (_key, item) => {
    if (
      typeof item === 'function' ||
      typeof item === 'undefined' ||
      typeof item === 'symbol' ||
      (typeof item === 'number' && !Number.isFinite(item))
    )
      throw new Error('Resolver rules must be JSON serializable.');
    return item;
  });
  const rules: unknown = JSON.parse(json);
  if (!rules || typeof rules !== 'object' || Array.isArray(rules))
    throw new Error('Resolver rules must serialize to a JSON object.');
  return {
    startsAt: new Date(value.startsAt),
    endsAt: new Date(value.endsAt),
    timezone: value.timezone,
    version: value.version,
    rules: rules as Record<string, unknown>,
  };
}
/** Prefix allocation preserves integer seconds across adjacent half-open periods. */
export function clipSource(
  source: TimecardSource,
  period: TimecardPeriod,
): TimecardSource | null {
  const start = instant(new Date(source.startsAt));
  const end = instant(new Date(source.endsAt));
  integer(source.seconds);
  if (end < start) throw new Error('Invalid source interval.');
  const left = Math.max(start, period.startsAt.getTime());
  const right = Math.min(end, period.endsAt.getTime());
  if (start === end)
    return start >= period.startsAt.getTime() && start < period.endsAt.getTime()
      ? { ...source }
      : null;
  if (left >= right) return null;
  const span = integer(end - start);
  const prefix = (elapsed: number) =>
    Number((BigInt(source.seconds) * BigInt(integer(elapsed))) / BigInt(span));
  const seconds = prefix(right - start) - prefix(left - start);
  return {
    ...source,
    startsAt: new Date(left).toISOString(),
    endsAt: new Date(right).toISOString(),
    seconds: integer(seconds),
  };
}
