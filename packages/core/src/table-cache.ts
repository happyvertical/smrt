/**
 * Cache for verified table existence checks.
 *
 * Prevents redundant `tableExists()` round-trips in `Collection.create()` and
 * `SmrtObject.save()`. On high-latency connections (e.g. Postgres over Tailscale),
 * each check adds ~100ms — this eliminates all but the first check per table per DB.
 *
 * Scoped per database URL to prevent cross-database contamination in multi-DB
 * scenarios. For :memory: and JSON databases (which share URLs), the cache can
 * be cleared via `resetVerifiedTables()` in test setup.
 *
 * @see https://github.com/happyvertical/smrt/issues/970
 * @packageDocumentation
 */

/**
 * Map of dbUrl → Set<tableName>.
 * Keyed by table name (not class name) so STI classes sharing a table only check once.
 */
const verifiedTablesByUrl = new Map<string, Set<string>>();

/**
 * Check if a table has been verified for a given database.
 */
export function isTableVerified(dbUrl: string, tableName: string): boolean {
  return verifiedTablesByUrl.get(dbUrl)?.has(tableName) ?? false;
}

/**
 * Mark a table as verified for a given database.
 */
export function markTableVerified(dbUrl: string, tableName: string): void {
  let tables = verifiedTablesByUrl.get(dbUrl);
  if (!tables) {
    tables = new Set();
    verifiedTablesByUrl.set(dbUrl, tables);
  }
  tables.add(tableName);
}

/**
 * Clear all verified table caches.
 * Call this in test setup to ensure isolation between test files.
 */
export function resetVerifiedTables(): void {
  verifiedTablesByUrl.clear();
}
