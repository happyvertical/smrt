/** Svelte-free currency precision shared by invoice previews and billing. */

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
 * ISO 4217 minor-unit exponents other than 2, matching
 * `@happyvertical/accounting`'s table (sdk#1269). An explicit table, not the
 * runtime's `Intl` display digits: CLDR rounds some currencies for display
 * (IQD, MGA, and ALL show 0 decimals) and its data changes between ICU
 * releases (RSD has shown both 0 and 2), which would put minor units off by a
 * power of ten against the SDK.
 */
const ISO_EXPONENTS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/**
 * The ISO 4217 minor-unit exponent of a currency (2 for USD and RSD, 0 for
 * JPY, 3 for IQD). Any code not listed as 0, 3, or 4 is 2.
 */
export function currencyMinorUnitExponent(currency: string): number {
  return ISO_EXPONENTS[normalizeCurrency(currency)] ?? 2;
}
