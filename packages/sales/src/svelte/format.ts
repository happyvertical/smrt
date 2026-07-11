/**
 * Render-time formatting helpers for the sales Svelte surfaces.
 *
 * All monetary values across `@happyvertical/smrt-sales` are integer cents
 * (`*Cents` fields); these helpers convert to display strings at the render
 * boundary only — view models keep the raw cents. Every helper is pure and
 * locale-parameterised so it stays deterministic under test.
 *
 * @module
 */

/** Placeholder rendered for absent/unparseable values. */
export const EMPTY_VALUE_PLACEHOLDER = '—';

/**
 * Format integer cents as a localized currency string in major units.
 *
 * Negative-safe (clawbacks/adjustments render as negative amounts) and
 * tolerant of accidental float inputs (rounded to whole cents first,
 * half-away-from-zero — the module's `roundCents()` contract). Unknown
 * currency codes fall back to `"<major-units> <code>"` instead of throwing.
 *
 * @param amountCents - Amount in integer cents (may be negative).
 * @param currency - ISO 4217 currency code, e.g. `'USD'`.
 * @param locale - BCP 47 locale; defaults to the runtime locale.
 */
export function formatCents(
  amountCents: number,
  currency: string,
  locale?: string,
): string {
  if (!Number.isFinite(amountCents)) return EMPTY_VALUE_PLACEHOLDER;
  const sign = amountCents < 0 ? -1 : 1;
  const wholeCents = sign * Math.round(Math.abs(amountCents));
  const major = wholeCents / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).format(major);
  } catch {
    // Unknown/invalid currency code — keep the surface rendering.
    return `${major.toFixed(2)} ${currency}`.trim();
  }
}

/**
 * Format a date-ish value as a localized medium date (e.g. `Mar 5, 2026`).
 *
 * `null`/`undefined`/empty/unparseable inputs render the shared
 * {@link EMPTY_VALUE_PLACEHOLDER} so optional lifecycle timestamps
 * (`qualifiedAt`, `paidAt`, …) can be passed straight through.
 *
 * @param d - A `Date`, an ISO-8601 string, or `null`/`undefined`.
 * @param locale - BCP 47 locale; defaults to the runtime locale.
 */
export function formatDate(
  d: Date | string | null | undefined,
  locale?: string,
): string {
  if (d == null || d === '') return EMPTY_VALUE_PLACEHOLDER;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE_PLACEHOLDER;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

/**
 * Format a 0–1 fraction as a localized percentage with at most one decimal
 * (e.g. `0.5` → `50%`, `0.333` → `33.3%`). Used for credit fractions, split
 * shares, plan rates, and win rates.
 *
 * @param fraction - Fraction in the 0–1 range (values outside still format).
 * @param locale - BCP 47 locale; defaults to the runtime locale.
 */
export function formatPercent(fraction: number, locale?: string): string {
  if (!Number.isFinite(fraction)) return EMPTY_VALUE_PLACEHOLDER;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(fraction);
}
