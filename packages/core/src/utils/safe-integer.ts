/**
 * Convert a database integer to JavaScript's only safe integer representation.
 *
 * PostgreSQL surfaces `int8` as a string and DuckDB can surface it as a
 * `bigint`; SQLite returns a number that may already be outside the safe
 * range. SMRT's public model and generated API contracts use `number`, so
 * preserving an out-of-range value would silently change it. Reject it at the
 * read boundary instead.
 */
export function toSafeInteger(value: unknown, context = 'integer'): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(
      `${context} must be a JavaScript safe integer; received ${String(value)}`,
    );
  }
  return parsed;
}

/**
 * Convert an integer-backed database boolean to a JavaScript boolean.
 *
 * System tables use integer flags so PostgreSQL and DuckDB surface the same
 * values as SQLite. Do not use JavaScript truthiness here: PostgreSQL returns
 * BIGINT values as strings, and `Boolean('0')` is true.
 */
export function toSafeBooleanInteger(
  value: unknown,
  context = 'boolean integer',
): boolean {
  if (value === 0 || value === '0' || value === 0n) {
    return false;
  }
  if (value === 1 || value === '1' || value === 1n) {
    return true;
  }
  throw new RangeError(
    `${context} must be an integer boolean (0 or 1); received ${String(value)}`,
  );
}
