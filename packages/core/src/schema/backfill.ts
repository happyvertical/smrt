/**
 * Per-row backfill expressions for required columns (#3008).
 *
 * A `@field({ required: true, backfill: "<sql>" })` declares the SQL
 * expression `db:migrate` evaluates once per existing row when it adds the
 * column to a populated table (or tightens a nullable column holding NULLs)
 * before enforcing NOT NULL. See `ColumnDefinition.backfill`.
 */

/**
 * Normalize a declared backfill: a non-empty trimmed string, or `undefined`
 * when absent. Anything else is a declaration error and throws, so a typo
 * such as `backfill: true` fails at schema build time instead of silently
 * falling back to "no backfill".
 */
export function normalizeBackfill(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new TypeError(
      `Field option "backfill" must be a SQL expression string, got ${typeof value}`,
    );
  }
  const trimmed = value.trim().replace(/;+\s*$/, '');
  if (trimmed.length === 0) return undefined;
  return trimmed;
}
