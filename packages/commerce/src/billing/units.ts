/**
 * Money-unit and identity helpers for billing-period close (#3060).
 *
 * Commerce stores money as integer minor units. `@happyvertical/accounting`
 * takes and returns currency *major* units and converts to the provider's own
 * representation itself, so the only conversion this package performs is the
 * ISO 4217 one: minor units ÷ 10^exponent.
 */

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

/** The ISO 4217 minor-unit exponent of a currency (2 for USD, 0 for JPY). */
export function currencyMinorUnitExponent(currency: string): number {
  const code = normalizeCurrency(currency);
  const digits = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
  }).resolvedOptions().maximumFractionDigits;
  return typeof digits === 'number' ? digits : 2;
}

/** Integer minor units → major units (`1999` USD → `19.99`). */
export function minorToMajorUnits(amount: number, currency: string): number {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(
      `Amount ${amount} must be a safe integer number of minor units.`,
    );
  }
  return amount / 10 ** currencyMinorUnitExponent(currency);
}

/**
 * Major units → integer minor units. Rejects a value that is not a whole
 * number of minor units instead of rounding it: a provider amount that does
 * not round-trip exactly means the two sides disagree about the currency.
 */
export function majorToMinorUnits(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`Provider amount ${amount} is not a finite number.`);
  }
  const scaled = amount * 10 ** currencyMinorUnitExponent(currency);
  const minor = Math.round(scaled);
  if (Math.abs(scaled - minor) > 1e-6 || !Number.isSafeInteger(minor)) {
    throw new Error(
      `Provider amount ${amount} ${normalizeCurrency(currency)} is not a whole number of minor units.`,
    );
  }
  return minor;
}

/**
 * A stable UUID derived from its parts (SHA-256, version/variant bits set).
 * Deterministic ids are what make every period-close write replay-safe: a
 * retry recomputes the same identity instead of creating a second row.
 */
export async function deterministicId(parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const uuid = digest.slice(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const hex = Array.from(uuid, (byte) => byte.toString(16).padStart(2, '0'));
  const joined = hex.join('');
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20),
  ].join('-');
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate and lower-case a tenant UUID. */
export function canonicalTenantId(id: string, label = 'Tenant ID'): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return id.toLowerCase();
}

/** Lower-case a possibly-empty tenant id for comparison. */
export function tenantKey(id: string | null | undefined): string {
  return id ? String(id).toLowerCase() : '';
}
