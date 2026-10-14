import type { DatedLabourRate } from './dated-labour-commercial-resolver.js';

export type Rational = { numerator: bigint; denominator: bigint };
export const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export function decimal(value: string, label: string): Rational {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !/^\d+(?:\.\d{1,18})?$/.test(value)
  )
    throw new Error(`${label} must be nonnegative plain decimal text.`);
  const [whole, fraction = ''] = value.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction);
  if (numerator > MAX * denominator)
    throw new Error(`${label} exceeds the safe numeric range.`);
  return { numerator, denominator };
}

export function date(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith('0000-')
  )
    throw new Error('Expected a valid YYYY-MM-DD calendar date.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error('Expected a valid YYYY-MM-DD calendar date.');
}

export function identity(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} is required.`);
}

export function rate(value: DatedLabourRate): DatedLabourRate {
  if (!value || typeof value !== 'object') throw new Error('Rate is required.');
  identity(value.id, 'Rate id');
  identity(value.version, 'Rate version');
  decimal(value.rateMinor, 'Hourly rate');
  // Whitelist fields: never copy arbitrary host/private facts to client terms.
  return { id: value.id, version: value.version, rateMinor: value.rateMinor };
}

export function amount(hours: Rational, hourly: DatedLabourRate): number {
  const value = decimal(hourly.rateMinor, 'Hourly rate');
  const numerator = hours.numerator * value.numerator;
  const denominator = hours.denominator * value.denominator;
  // Exact nonnegative half-up rounding, once per independent component.
  return rounded({ numerator, denominator });
}

/** Exact arithmetic only; this internal module does not select host policy. */
export function multiply(a: Rational, b: Rational): Rational {
  return {
    numerator: a.numerator * b.numerator,
    denominator: a.denominator * b.denominator,
  };
}
export function add(a: Rational, b: Rational): Rational {
  const numerator = a.numerator * b.denominator + b.numerator * a.denominator;
  const denominator = a.denominator * b.denominator;
  let x = numerator;
  let y = denominator;
  while (y) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return { numerator: numerator / x, denominator: denominator / x };
}
export function rounded(value: Rational): number {
  const result =
    (2n * value.numerator + value.denominator) / (2n * value.denominator);
  if (result > MAX)
    throw new Error('Labour amount exceeds safe integer minor units.');
  return Number(result);
}
export function quantity(value: unknown): Rational {
  if (!value || typeof value !== 'object')
    throw new Error('Labour quantity is required.');
  const q = value as Record<string, unknown>;
  if (Object.keys(q).length !== 1)
    throw new Error('Ambiguous labour quantity.');
  if ('hours' in q) {
    const result = decimal(q.hours as string, 'Duration hours');
    if (result.numerator <= 0n)
      throw new Error('Duration hours must be positive.');
    return result;
  }
  if (!Number.isSafeInteger(q.seconds) || (q.seconds as number) <= 0)
    throw new Error('Duration seconds must be a positive safe integer.');
  return { numerator: BigInt(q.seconds as number), denominator: 3600n };
}
