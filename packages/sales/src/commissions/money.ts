/**
 * Integer-cents money helpers for the commissions module.
 *
 * Every monetary field in this module is stored as integer cents (`*Cents`
 * suffix). Rounding happens exactly once per calculation step via
 * {@link roundCents} using half-away-from-zero semantics, and every
 * Commission persists a `calculationTrace` naming that rounding mode so
 * amounts stay reproducible.
 *
 * @packageDocumentation
 */

/**
 * Round to the nearest integer cent, half away from zero.
 *
 * `Math.round` alone rounds -2.5 to -2 (half toward +∞); financial
 * conventions want symmetric behaviour, so the sign is factored out first:
 * `Math.sign(v) * Math.round(Math.abs(v))` → `roundCents(2.5) === 3` and
 * `roundCents(-2.5) === -3`.
 */
export function roundCents(value: number): number {
  const rounded = Math.sign(value) * Math.round(Math.abs(value));
  // Normalize -0 to 0 so strict equality (Object.is) comparisons behave.
  return rounded === 0 ? 0 : rounded;
}

/** Convert integer cents to a decimal major-unit amount (`/ 100`). */
export function centsToAmount(cents: number): number {
  return cents / 100;
}

/**
 * Convert a decimal major-unit amount to integer cents, rounding half away
 * from zero (`roundCents(amount * 100)`).
 */
export function amountToCents(amount: number): number {
  return roundCents(amount * 100);
}

/**
 * Calculate a commission amount in integer cents:
 * `roundCents(baseCents * rate * (shareFraction ?? 1))`.
 *
 * Rounding is applied once, on the final product, so split siblings each
 * round independently and their sum can differ from the unsplit amount by at
 * most one cent per sibling — the calculation trace records the inputs so any
 * such drift is auditable.
 *
 * @param baseCents - Base amount in integer cents
 * @param rate - Commission rate (0–1)
 * @param shareFraction - Optional split share (0–1); defaults to 1
 */
export function calculateCommissionAmountCents(
  baseCents: number,
  rate: number,
  shareFraction?: number,
): number {
  return roundCents(baseCents * rate * (shareFraction ?? 1));
}
