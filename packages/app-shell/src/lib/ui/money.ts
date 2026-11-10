// Money is stored as an integer count of minor units (cents). The definition
// carries no currency, so one default is used for display.

export const DEFAULT_CURRENCY = 'USD';
const MINOR_DIGITS = 2;

/** Minor units -> "1,234.50" style currency text. */
export function formatMoney(
  minor: unknown,
  currency = DEFAULT_CURRENCY,
  locale?: string,
): string {
  if (minor === null || minor === undefined || minor === '') return '';
  const n = Number(minor);
  if (!Number.isFinite(n)) return String(minor);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: MINOR_DIGITS,
    maximumFractionDigits: MINOR_DIGITS,
  }).format(n / 10 ** MINOR_DIGITS);
}

/** Minor units -> editable major-unit text ("1250" -> "12.50"). */
export function minorToInput(minor: unknown): string {
  if (minor === null || minor === undefined || minor === '') return '';
  const n = Number(minor);
  if (!Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  const whole = Math.floor(abs / 10 ** MINOR_DIGITS);
  const frac = String(abs % 10 ** MINOR_DIGITS).padStart(MINOR_DIGITS, '0');
  return `${sign}${whole}.${frac}`;
}

/**
 * Typed major-unit text -> minor units, or null when it is not an amount.
 * Done on the digits, never through floating point.
 */
export function inputToMinor(text: string): number | null {
  const cleaned = text.trim().replace(/^([-+]?)\s*[$€£¥]\s*/, '$1');
  const s = cleaned.replace(/,/g, '');
  const m = /^([-+]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(MINOR_DIGITS, '0');
  const value = Number(m[2]) * 10 ** MINOR_DIGITS + Number(frac);
  if (!Number.isSafeInteger(value)) return null;
  return m[1] === '-' ? -value : value;
}
