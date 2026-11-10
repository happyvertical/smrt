// Shared by the two engines and old-thread replay. Tool payloads belong to
// the model, never to a chat chip (or its title attribute).
function summaryOf(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof value === 'string') {
    try {
      return summaryOf(JSON.parse(value), depth + 1);
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (typeof result.summary === 'string') return result.summary;
  for (const key of ['data', 'result', 'structuredContent']) {
    const found = summaryOf(result[key], depth + 1);
    if (found) return found;
  }
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const found = summaryOf(block?.text, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** A short human result, with generic fallbacks for unstructured payloads. */
export function toolSummary(name: string, result: unknown, ok = true): string {
  if (!ok) return 'Could not complete this action';
  if (name === 'app_describe') return 'Checked the app structure';
  if (name === 'app_history') return 'Checked app history';
  if (name === 'approval_pending') return 'Checked pending approvals';
  if (/(?:_list|_search|_get)$/.test(name)) return 'Checked records';
  const summary = summaryOf(result)?.replace(/\s+/g, ' ').trim();
  // Old threads may contain clipped JSON. Never show SQL or machine paths,
  // even when a tool's free-form text or summary contains them.
  if (
    summary &&
    !/[{}[\]]|(?:\/|[A-Z]:\\)\S+|\b(?:ALTER TABLE|CREATE TABLE|DROP TABLE|SELECT .* FROM|INSERT INTO|DELETE FROM)\b/i.test(
      summary,
    )
  )
    return summary.length > 160 ? `${summary.slice(0, 159)}…` : summary;
  return 'Completed this action';
}
