/**
 * Quantity precision for planning and production runs.
 *
 * Quantities are decimals held in binary floating point, so sums such as
 * `0.1 + 0.2` and products such as `2.2 * 100` carry rounding noise. Rather
 * than compare with a tolerance (which must grow with the value and so
 * eventually hides a whole unit), quantities are kept to
 * {@link QUANTITY_DECIMALS} decimal places: rounded through their decimal
 * representation, and summed and compared exactly as whole millionths.
 *
 * @packageDocumentation
 */

/** Decimal places a quantity is kept to: a millionth of a unit. */
export const QUANTITY_DECIMALS = 6;

const SCALE = 10 ** QUANTITY_DECIMALS;

/**
 * The largest quantity a production run accepts (target or report): every
 * value up to it with {@link QUANTITY_DECIMALS} places has at most 15
 * significant digits, so it survives a round trip through a double exactly
 * and sums of them stay exact.
 */
export const MAX_QUANTITY = 999_999_999;

/**
 * `value` rounded to {@link QUANTITY_DECIMALS} decimal places (correctly
 * rounded through its decimal representation, so `0.1 + 0.2` becomes
 * exactly `0.3`).
 */
export function roundQuantity(value: number): number {
  return Number(value.toFixed(QUANTITY_DECIMALS));
}

/**
 * `value` as a whole number of millionths, exactly (read from its decimal
 * representation, not multiplied). Exact for any value up to
 * {@link MAX_QUANTITY}.
 */
export function toMillionths(value: number): number {
  return Number(value.toFixed(QUANTITY_DECIMALS).replace('.', ''));
}

/** A whole number of millionths back as a quantity. */
export function fromMillionths(millionths: number): number {
  return millionths / SCALE;
}
