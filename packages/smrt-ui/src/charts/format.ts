/**
 * Number formatting for overview widgets (#3727). Deterministic for a given
 * locale so a server render and the client hydrate to the same text. Money is
 * integer minor units end to end (never a decimal in data).
 */
import { ISO_4217_MINOR_UNITS } from '../currency.js';

function currencyMinorDigits(currency: string): number {
  return ISO_4217_MINOR_UNITS.get(currency.trim().toUpperCase()) ?? 2;
}

export type WidgetValueFormat = 'integer' | 'decimal' | 'percent' | 'money';

export interface FormatWidgetValueOptions {
  format?: WidgetValueFormat;
  /** ISO 4217 code for `money` (default USD). */
  currency?: string;
  locale: string;
  /** Short form for tight spaces such as an axis (`$83K`, `1.2M`). */
  compact?: boolean;
}

const EN_DASH = '–';

function safeLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/**
 * Format a metric value. `money` takes integer minor units, `percent` takes a
 * fraction (0.25 is 25%). Non-finite input renders as an en dash.
 */
export function formatWidgetValue(
  value: unknown,
  {
    format = 'integer',
    currency = 'USD',
    locale,
    compact = false,
  }: FormatWidgetValueOptions,
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return EN_DASH;
  const tag = safeLocale(locale);
  const short: Intl.NumberFormatOptions = compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : {};
  switch (format) {
    case 'money': {
      const code = /^[A-Za-z]{3}$/.test(currency)
        ? currency.toUpperCase()
        : 'USD';
      const digits = currencyMinorDigits(code);
      return new Intl.NumberFormat(tag, {
        style: 'currency',
        currency: code,
        ...short,
      }).format(value / 10 ** digits);
    }
    case 'percent':
      return new Intl.NumberFormat(tag, {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(value);
    case 'decimal':
      return new Intl.NumberFormat(tag, {
        maximumFractionDigits: 2,
        ...short,
      }).format(value);
    default:
      return new Intl.NumberFormat(tag, {
        maximumFractionDigits: 0,
        ...short,
      }).format(value);
  }
}

/** Time bucket granularities `formatTimeBucket` names. */
export type TimeBucketUnit =
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'year';

/**
 * A time bucket's start (an ISO-8601 instant, or a SQL `YYYY-MM-DD HH:MM:SS`)
 * as a short label for its granularity, in UTC, so buckets read the same
 * everywhere: `Jan 2025` for a month, `Q1 2025`, `2025`, `Jan 6` for a day or
 * week, `Jan 6, 14:00` for an hour or minute. Unparseable input is returned
 * unchanged.
 */
export function formatTimeBucket(
  value: string,
  unit: TimeBucketUnit,
  locale: string,
): string {
  const date = new Date(
    /^\d{4}-\d{2}-\d{2} \d/.test(value) ? `${value.replace(' ', 'T')}Z` : value,
  );
  if (Number.isNaN(date.getTime())) return value;
  const tag = safeLocale(locale);
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(tag, { timeZone: 'UTC', ...options }).format(date);
  switch (unit) {
    case 'year':
      return format({ year: 'numeric' });
    case 'quarter':
      return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
    case 'month':
      return format({ month: 'short', year: 'numeric' });
    case 'week':
    case 'day':
      return format({ month: 'short', day: 'numeric' });
    default:
      return format({
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
  }
}
