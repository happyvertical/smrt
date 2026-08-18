/**
 * Money is exact: integer minor units, checked at the model boundary (#2401).
 *
 * Every money column in this package is INTEGER minor units — cents,
 * satoshis — so `$19.99` is `1999`. Before #2401 the models carried
 * `EPSILON = 0.01` tolerances on every comparison, because the values really
 * were floats and `0.1 * 3` really is `0.30000000000000004`. With exact
 * integers those tolerances are not merely unnecessary, they are wrong: a
 * one-cent discrepancy is a one-cent discrepancy, not rounding fuzz.
 *
 * Dropping the tolerances is only safe if the values are *actually* integers,
 * which is what this guard establishes. A fractional major-unit write (`19.99`
 * into a cents column) is the bug the whole convention exists to prevent;
 * PostgreSQL catches it with a `22P02` and SQLite's type affinity does not
 * catch it at all, so the model catches it first, on every engine and every
 * write surface.
 */

/**
 * Throw unless every named value is a finite integer.
 *
 * @param context - Model name for the error message, e.g. `Invoice`.
 * @param label - Row identifier used in the error, e.g. an invoice number.
 * @param entries - `[fieldName, value]` pairs to check.
 * @throws When any value is non-finite or has a fractional part.
 */
export function assertIntegerMinorUnits(
  context: string,
  label: string,
  entries: ReadonlyArray<readonly [string, number]>,
): void {
  for (const [field, value] of entries) {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(
        `${context} ${label}: ${field} must be an integer number of minor ` +
          `units (cents, satoshis) — got ${value}. Money is exact: $19.99 is ` +
          '1999, not 19.99.',
      );
    }
  }
}
