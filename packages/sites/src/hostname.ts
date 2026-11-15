/**
 * Hostname parsing and zone-membership helpers for owned domains.
 *
 * Pure, dependency-free functions with no tenant or persistence concerns, so
 * hosts can validate what an owner types before creating `DnsZone` and
 * `Domain` records.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalise a typed hostname: trim, lowercase, drop one trailing dot. Returns
 * null unless it is a plain multi-label DNS name (no scheme, path, port,
 * wildcard, underscore, or numeric-only TLD, which also rules out IPv4
 * literals). IDN input must already be punycode (`xn--`); Unicode labels are
 * rejected, not converted.
 */
export function parseHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return null;
  }
  if (/^\d+$/.test(labels[labels.length - 1] as string)) return null;
  return host;
}

/**
 * The zone apex a hostname sits under when the owner does not name one: its
 * last two labels. Multi-part public suffixes (`example.co.uk`) are not
 * guessed; the caller names the zone for those. Expects a normalised hostname
 * (see {@link parseHostname}).
 */
export function defaultZoneFor(hostname: string): string {
  return hostname.split('.').slice(-2).join('.');
}

/**
 * A hostname belongs under a zone when it is the apex or a subdomain of it.
 * Label-aware: `evilexample.com` is not under `example.com`. Expects
 * normalised inputs (see {@link parseHostname}).
 */
export function hostnameBelongsToZone(hostname: string, zone: string): boolean {
  return hostname === zone || hostname.endsWith(`.${zone}`);
}
