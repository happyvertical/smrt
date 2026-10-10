/**
 * Number formatting for overview widgets (#3727). Deterministic for a given
 * locale so a server render and the client hydrate to the same text. Money is
 * integer minor units end to end (never a decimal in data).
 */
import { currencyMinorDigits } from '../screens/values.js';

export type WidgetValueFormat = 'integer' | 'decimal' | 'percent' | 'money';

export interface FormatWidgetValueOptions {
  format?: WidgetValueFormat;
  /** ISO 4217 code for `money` (default USD). */
  currency?: string;
  locale: string;
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
  { format = 'integer', currency = 'USD', locale }: FormatWidgetValueOptions,
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return EN_DASH;
  const tag = safeLocale(locale);
  switch (format) {
    case 'money': {
      const code = /^[A-Za-z]{3}$/.test(currency)
        ? currency.toUpperCase()
        : 'USD';
      const digits = currencyMinorDigits(code);
      return new Intl.NumberFormat(tag, {
        style: 'currency',
        currency: code,
      }).format(value / 10 ** digits);
    }
    case 'percent':
      return new Intl.NumberFormat(tag, {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(value);
    case 'decimal':
      return new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(
        value,
      );
    default:
      return new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(
        value,
      );
  }
}
