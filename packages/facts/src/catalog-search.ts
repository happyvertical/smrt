/**
 * Encode JavaScript lowercase UTF-16 units as aligned ASCII tokens. SQL's
 * Unicode/collation rules never participate in substring matching. The `x`
 * separator cannot occur inside a hex unit, so matches cannot start mid-unit.
 */
export function encodeCatalogSearch(value: string): string {
  const normalized = value.toLowerCase();
  let encoded = '';
  for (let index = 0; index < normalized.length; index++) {
    encoded += `x${normalized.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }
  return encoded;
}
