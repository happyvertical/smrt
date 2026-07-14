/**
 * Canonicalize an email used as an external identity key.
 *
 * Keep this in application code: SQL `trim()` and `lower()` have
 * adapter-specific whitespace and Unicode behavior.
 */
export function normalizeIdentityEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Identity email normalization requires a non-blank email.');
  }
  return normalized;
}
