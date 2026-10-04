/**
 * Quantity precision for planning and production runs.
 *
 * Quantities are decimals held in binary floating point, so sums such as
 * `0.1 + 0.2` and products such as `2.2 * 100` carry rounding noise. Rather
 * than compare with a tolerance (which must grow with the value and so
 * eventually hides a whole unit), quantities are rounded to
 * {@link QUANTITY_DECIMALS} decimal places wherever they are stored or
 * compared, and then compared exactly.
 *
 * @packageDocumentation
 */

/** Decimal places a quantity is kept to: a millionth of a unit. */
export const QUANTITY_DECIMALS = 6;

/**
 * `value` rounded to {@link QUANTITY_DECIMALS} decimal places (correctly
 * rounded through its decimal representation, so `0.1 + 0.2` becomes
 * exactly `0.3` and a whole number stays exact up to
 * `Number.MAX_SAFE_INTEGER`).
 */
export function roundQuantity(value: number): number {
  return Number(value.toFixed(QUANTITY_DECIMALS));
}
