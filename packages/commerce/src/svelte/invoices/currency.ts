/** Svelte-free currency precision shared by invoice previews and billing. */

import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Upper-case, validate, and return an ISO 4217-shaped currency code. */
export function normalizeCurrency(currency: string): string {
  const code = String(currency ?? '')
    .trim()
    .toUpperCase();
  if (!CURRENCY_PATTERN.test(code)) {
    throw new Error(`Currency '${currency}' must be a three-letter code.`);
  }
  return code;
}

/**
 * The ISO 4217 minor-unit exponent of a currency (2 for USD and RSD, 0 for
 * JPY, 3 for IQD). Unknown codes and currencies without a minor unit fail
 * closed because assigning either an inferred or invented exponent changes
 * the represented amount.
 */
export function currencyMinorUnitExponent(currency: string): number {
  const code = normalizeCurrency(currency);
  const exponent = ISO_4217_MINOR_UNITS.get(code);
  if (exponent === undefined)
    throw new Error(`Unsupported currency '${code}'.`);
  if (exponent === null)
    throw new Error(`Currency '${code}' does not define a minor unit.`);
  return exponent;
}
