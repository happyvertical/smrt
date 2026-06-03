/**
 * Shared helpers for capping `IN (?, ?, ...)` placeholder lists so a single
 * query never exceeds the backend's bind-variable limit.
 *
 * Used by the relationship/junction loaders in `collection.ts` and by the
 * BFS frontier in `SmrtHierarchical.getDescendants()` — any code path that
 * expands an unbounded array of ids into one `column IN (...)` clause.
 */

/**
 * Maximum size of an `IN (?, ?, ...)` placeholder list per query.
 *
 * `SQLITE_MAX_VARIABLE_NUMBER` is 999 on SQLite builds older than 3.32 and
 * 32766 on newer ones; Postgres allows up to 65535 bind parameters. Capping
 * at a conservative 900 stays under the legacy SQLite limit AND keeps planner
 * time predictable across every backend, so callers don't have to know which
 * build they're talking to. Exceeding the cap throws
 * `SQLITE_RANGE: bind or column index out of range` (or
 * `SQLITE_ERROR: too many SQL variables`) before the query runs, which is why
 * every loader that builds an IN-list from caller- or data-sized arrays must
 * chunk through this value.
 */
export const IN_LIST_CHUNK_SIZE = 900;

/**
 * Split `items` into contiguous batches of at most `size` elements.
 *
 * - Empty input yields `[]` (no empty batch).
 * - A non-positive `size` is treated as "no chunking" and returns a single
 *   batch containing every item, matching the previous inline behavior in
 *   `collection.ts`.
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
