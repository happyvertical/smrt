// Money is stored as integer minor units. Older definitions default to USD cents.

export const DEFAULT_CURRENCY = 'USD';

/** Minor units -> "1,234.50" style currency text. */
export function formatMoney(
  minor: unknown,
  currency = DEFAULT_CURRENCY,
  locale?: string,
  scale = 2,
): string {
  if (minor === null || minor === undefined || minor === '') return '';
  const n = Number(minor);
  if (!Number.isFinite(n)) return String(minor);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(n / 10 ** scale);
}

/** Minor units -> editable major-unit text ("1250" -> "12.50"). */
export function minorToInput(minor: unknown, scale = 2): string {
  if (minor === null || minor === undefined || minor === '') return '';
  const n = Number(minor);
  if (!Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  const whole = Math.floor(abs / 10 ** scale);
  const frac = String(abs % 10 ** scale).padStart(scale, '0');
  return scale ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

/**
 * Typed major-unit text -> minor units, or null when it is not an amount.
 * Done on the digits, never through floating point.
 */
export function inputToMinor(text: string, scale = 2): number | null {
  const cleaned = text.trim().replace(/^([-+]?)\s*[$€£¥]\s*/, '$1');
  const s = cleaned.replace(/,/g, '');
  const m = new RegExp(
    `^([-+]?)(\\d+)${scale ? `(?:\\.(\\d{1,${scale}}))?` : ''}$`,
  ).exec(s);
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(scale, '0');
  const value = Number(
    BigInt(m[2]) * 10n ** BigInt(scale) + BigInt(frac || '0'),
  );
  if (!Number.isSafeInteger(value)) return null;
  return m[1] === '-' ? -value : value;
}
