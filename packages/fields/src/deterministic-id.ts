/**
 * Deterministic row ids for this package's idempotent writes (the
 * `TenantUsageMetric.recordUsage` precedent).
 *
 * A leaf module (no package-internal imports) so both consumers — usage counter
 * buckets and the global learning schedules — share one implementation. The
 * output is formatted as a v5-shaped UUID so id columns stay native UUID on
 * PostgreSQL/DuckDB.
 */

/**
 * SHA-256 over the namespaced parts, formatted as a v5-style UUID.
 *
 * The same parts always produce the same id, which is what turns
 * "check then create" into a race-free write: concurrent creators converge on
 * one primary key instead of inserting near-duplicate rows.
 */
export async function deterministicFieldsUuid(
  parts: readonly string[],
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const uuid = digest.slice(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const hex = Array.from(uuid, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
