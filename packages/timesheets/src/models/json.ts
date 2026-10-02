/**
 * Parse a JSON value stored as text, returning `fallback` on malformed input.
 * Stored JSON may predate a schema change, so reads never throw.
 */
export function parseTimesheetJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
