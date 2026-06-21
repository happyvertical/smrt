/**
 * Shared SSRF guard for content's outbound fetches (feed sync, mirroring).
 *
 * Any code path that fetches a caller-supplied URL — RSS/Atom feeds, the
 * `Mirror` content type, link previews — is an SSRF vector: an attacker who can
 * influence the URL can make the server fetch `169.254.169.254` cloud metadata,
 * `localhost` admin panels, or other internal services. This module rejects
 * URLs that resolve to private, loopback, link-local, CGNAT, or cloud-metadata
 * ranges before any request is made, and re-validates redirect hops.
 *
 * Unlike a literal-IP-only check, {@link assertSafeRemoteUrl} resolves hostnames
 * via DNS so a public name pointing at a private IP is also caught (S5 #1388).
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ResolvedAddress = { address: string; family?: number };
export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeRemoteUrlOptions {
  /** Skip the private-network checks (trusted callers only, e.g. local dev). */
  allowPrivateNetworkHosts?: boolean;
  /** Injectable resolver for tests; defaults to {@link defaultResolveHostname}. */
  resolveHostname?: ResolveHostname;
}

export async function defaultResolveHostname(
  hostname: string,
): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: false });
}

export function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return true;
  // Strict per-octet validation: `Number('')` is 0, so without a digit check a
  // malformed input like `1..2.3` would parse to `[1,0,2,3]` and be treated as a
  // valid (and possibly allowed) address. Anything not 1-3 digits in 0-255 is
  // unparseable → blocked (review #1562).
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

/**
 * Expand an IPv6 string to its 8 hextets (numbers), or null if unparseable.
 * Handles `::` compression, an embedded dotted-IPv4 tail, and bracketed forms.
 */
function expandIPv6(address: string): number[] | null {
  let work = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (work.includes('.')) {
    // Embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1) → convert to 2 hextets.
    const m = work.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (!m) return null;
    const o = m[1].split('.').map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    work = `${work.slice(0, work.length - m[1].length)}${hi}:${lo}`;
  }
  const halves = work.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2
      ? [
          ...head,
          ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'),
          ...tail,
        ]
      : head;
  if (groups.length !== 8) return null;
  const hextets = groups.map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  );
  return hextets.some((n) => Number.isNaN(n)) ? null : hextets;
}

export function isBlockedIPv6(address: string): boolean {
  const hextets = expandIPv6(address);
  if (hextets) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d, deprecated)
    // both embed an IPv4 in the last 2 hextets — decode and apply the IPv4
    // blocklist so a loopback/private IPv4 can't be smuggled through any IPv6
    // encoding (compressed, expanded, dotted, or hex) (review #1562, P1).
    const firstFiveZero = hextets.slice(0, 5).every((h) => h === 0);
    if (firstFiveZero && (hextets[5] === 0xffff || hextets[5] === 0)) {
      const [, , , , , , g6, g7] = hextets;
      const ipv4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
      return isBlockedIPv4(ipv4);
    }
  }

  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  );
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  // Anything that isn't a recognisable IP literal (after DNS resolution should
  // have produced one) is treated as unsafe.
  return true;
}

/**
 * Parse and validate a remote URL for outbound fetching. Rejects non-http(s)
 * schemes, embedded credentials, and hosts that resolve to non-public ranges.
 * Returns the parsed {@link URL} on success; throws a descriptive `Error`
 * otherwise.
 */
export async function assertSafeRemoteUrl(
  rawUrl: string,
  options: SafeRemoteUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Remote URL must be an absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Remote URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Remote URL must not include credentials');
  }
  if (!url.hostname) {
    throw new Error('Remote URL must include a hostname');
  }

  if (options.allowPrivateNetworkHosts) return url;

  const resolver = options.resolveHostname ?? defaultResolveHostname;
  const addresses =
    isIP(url.hostname) === 0
      ? await resolver(url.hostname)
      : [{ address: url.hostname }];

  if (
    !addresses.length ||
    addresses.some(({ address }) => isBlockedAddress(address))
  ) {
    throw new Error('Remote URL must resolve to a public network address');
  }

  return url;
}

/** Redirect status codes that reroute a request to a new Location. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_RESOLVE_TIMEOUT_MS = 10_000;

export interface SafeRedirectOptions extends SafeRemoteUrlOptions {
  /** Maximum redirect hops to follow before failing. Default 5. */
  maxRedirects?: number;
  /** Per-hop timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Injectable fetch (primarily for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a URL's redirect chain and return the final safe {@link URL}, with
 * EVERY hop re-validated through {@link assertSafeRemoteUrl}.
 *
 * Use this before handing a URL to a fetcher that follows redirects on its own
 * (e.g. `fetchDocument`): the up-front {@link assertSafeRemoteUrl} check alone
 * can't stop an allowed public host from `30x`-redirecting into an internal /
 * loopback / metadata host, which would defeat the SSRF guard (review #1562).
 *
 * Redirects are followed with `GET` + `redirect: 'manual'` to match downstream
 * GET-based fetchers; response bodies are discarded (the redirect bodies are
 * empty and the terminal body is left for the caller to re-fetch), so this does
 * not double-download content.
 */
export async function resolveSafeFinalUrl(
  rawUrl: string,
  options: SafeRedirectOptions = {},
): Promise<URL> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  let current = await assertSafeRemoteUrl(rawUrl, options);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Release the connection without downloading the body.
    try {
      await response.body?.cancel();
    } catch {
      // best-effort
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return current;
    }
    const location = response.headers.get('location');
    if (!location) return current;
    // Re-validate the resolved redirect target before following it.
    current = await assertSafeRemoteUrl(
      new URL(location, current).toString(),
      options,
    );
  }

  throw new Error('Remote URL exceeded the maximum number of redirects');
}

/**
 * Strip userinfo (`user:pass@`) from a URL so it can be safely logged or echoed
 * in an error message. Returns a placeholder for unparseable input. Never let a
 * credential-bearing URL reach logs/errors verbatim (review #1562).
 */
export function redactUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString();
    }
    return raw;
  } catch {
    return '[unparseable url]';
  }
}
