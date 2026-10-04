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
import { Agent, fetch as undiciFetch } from 'undici';

export type ResolvedAddress = { address: string; family?: number };
export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeRemoteUrlOptions {
  /** Skip the private-network checks (trusted callers only, e.g. local dev). */
  allowPrivateNetworkHosts?: boolean;
  /** Injectable resolver for tests; defaults to {@link defaultResolveHostname}. */
  resolveHostname?: ResolveHostname;
}

export interface ValidatedRemoteUrlOptions extends SafeRemoteUrlOptions {
  /** Resolve even when private hosts are explicitly allowed, for pinned fetches. */
  resolveHostnameWhenPrivateAllowed?: boolean;
}

/** A URL together with the exact addresses accepted by its DNS validation. */
export interface ValidatedRemoteUrl {
  url: URL;
  addresses: ResolvedAddress[];
}

/** Options for bounded, SSRF-safe HTTPS retrieval. */
export interface SafeRemoteFetchOptions {
  /** Only Accept, Accept-Language, If-Modified-Since, If-None-Match, and User-Agent. */
  headers?: Record<string, string>;
  /** Total DNS, request, redirect, and response-body deadline. Defaults to 10s. */
  timeoutMs?: number;
  /** Maximum returned response-body bytes. Defaults to 2 MB (2,000,000 bytes). */
  maxBytes?: number;
  /** Maximum validated redirect hops. Defaults to 5. Set 0 to reject redirects. */
  maxRedirects?: number;
  /** Injectable DNS resolver. Its results are still validated and pinned. */
  resolveHostname?: ResolveHostname;
}

/** A fully buffered response from {@link fetchSafeRemoteUrl}. */
export interface SafeRemoteFetchResult {
  /** Final URL after validated redirects. */
  url: URL;
  status: number;
  statusText: string;
  ok: boolean;
  /** Lower-cased response header names. */
  headers: Readonly<Record<string, string>>;
  /** Bounded response bytes. */
  body: Uint8Array;
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

  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
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

  // Conservatively allow global unicast only, excluding IETF special-purpose,
  // documentation, and transition ranges. Compare parsed hextets so expanded
  // spellings cannot bypass the guard. IPv4-mapped addresses are checked above.
  // https://www.iana.org/assignments/iana-ipv6-special-registry/
  if (!hextets) return true;
  return (
    (hextets[0] & 0xe000) !== 0x2000 ||
    (hextets[0] === 0x2001 && hextets[1] < 0x0200) ||
    (hextets[0] === 0x2001 && hextets[1] === 0x0db8) ||
    hextets[0] === 0x2002 ||
    (hextets[0] === 0x3fff && hextets[1] < 0x1000)
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
 * Returns the parsed URL and the exact accepted addresses so callers can bind
 * their connection without resolving the hostname again.
 */
export async function validateSafeRemoteUrl(
  rawUrl: string,
  options: ValidatedRemoteUrlOptions = {},
): Promise<ValidatedRemoteUrl> {
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

  if (
    options.allowPrivateNetworkHosts &&
    !options.resolveHostnameWhenPrivateAllowed
  ) {
    return { url, addresses: [] };
  }

  const resolver = options.resolveHostname ?? defaultResolveHostname;
  const addresses =
    isIP(url.hostname) === 0
      ? await resolver(url.hostname)
      : [{ address: url.hostname }];

  if (
    !addresses.length ||
    (!options.allowPrivateNetworkHosts &&
      addresses.some(({ address }) => isBlockedAddress(address)))
  ) {
    throw new Error('Remote URL must resolve to a public network address');
  }

  return { url, addresses };
}

export async function assertSafeRemoteUrl(
  rawUrl: string,
  options: SafeRemoteUrlOptions = {},
): Promise<URL> {
  return (await validateSafeRemoteUrl(rawUrl, options)).url;
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

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const SAFE_REQUEST_HEADER_NAMES = new Set([
  'accept',
  'accept-language',
  'if-modified-since',
  'if-none-match',
  'user-agent',
]);

function assertSafeRequestHeaders(headers: Record<string, string> | undefined) {
  for (const name of Object.keys(headers ?? {})) {
    if (!SAFE_REQUEST_HEADER_NAMES.has(name.toLowerCase())) {
      throw new Error(
        `Safe remote fetch does not allow request header ${name}`,
      );
    }
  }
}

type RemoteResponse = {
  status: number;
  statusText: string;
  ok: boolean;
  headers: {
    get: (name: string) => string | null;
    forEach: (callback: (value: string, key: string) => void) => void;
  };
  body: {
    locked: boolean;
    cancel: (reason?: unknown) => Promise<void>;
    getReader: () => {
      cancel: (reason?: unknown) => Promise<void>;
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
      releaseLock: () => void;
    };
  } | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type RemoteFetchResult = {
  response: RemoteResponse;
  close: () => Promise<void>;
};

interface InternalSafeRemoteFetchOptions extends SafeRemoteFetchOptions {
  allowHttp?: boolean;
  allowPrivateNetworkHosts?: boolean;
  fetchImpl?: typeof fetch;
}

function createPinnedDispatcher(addresses: ResolvedAddress[]): Agent {
  const pinnedAddresses = addresses.map(({ address, family }) => {
    const resolvedFamily = family ?? isIP(address);
    if (resolvedFamily !== 4 && resolvedFamily !== 6) {
      throw new Error('Remote URL resolved to an unrecognised network address');
    }
    return { address, family: resolvedFamily };
  });

  return new Agent({
    connect: {
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, pinnedAddresses);
          return;
        }
        const selected =
          pinnedAddresses.find(
            ({ family }) =>
              !lookupOptions.family || family === lookupOptions.family,
          ) ?? pinnedAddresses[0];
        callback(null, selected.address, selected.family);
      },
    },
  });
}

async function fetchPinnedRemoteUrl(
  url: ValidatedRemoteUrl,
  options: InternalSafeRemoteFetchOptions,
  signal: AbortSignal | undefined,
): Promise<RemoteFetchResult> {
  const init = {
    headers: options.headers,
    redirect: 'manual' as const,
    signal,
  };
  // This is an internal trusted test/embedding seam. Public callers use the
  // Undici transport below, which cannot resolve the hostname a second time.
  if (options.fetchImpl) {
    return {
      response: await options.fetchImpl(url.url, init),
      close: async () => {},
    };
  }
  const dispatcher = createPinnedDispatcher(url.addresses);
  try {
    return {
      response: await undiciFetch(url.url, { ...init, dispatcher }),
      close: () => dispatcher.close(),
    };
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
}

async function closeRemoteResponse({ response, close }: RemoteFetchResult) {
  try {
    if (response.body && !response.body.locked) await response.body.cancel();
  } catch {
    // A failed stream may reject cancellation; the dispatcher still closes.
  } finally {
    await close();
  }
}

async function readBoundedResponseBytes(
  response: RemoteResponse,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Remote response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes)
      throw new Error(`Remote response exceeds ${maxBytes} bytes`);
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Remote response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function copyResponseHeaders(
  headers: RemoteResponse['headers'],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return Object.freeze(result);
}

function removeCrossOriginSensitiveHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !['authorization', 'cookie', 'proxy-authorization'].includes(
          name.toLowerCase(),
        ),
    ),
  );
  return safeHeaders;
}

function assertFetchLimits(options: InternalSafeRemoteFetchOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new Error(
      'Remote fetch timeout must be a non-negative finite number',
    );
  if (!Number.isInteger(maxBytes) || maxBytes < 0)
    throw new Error('Remote fetch maxBytes must be a non-negative integer');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0)
    throw new Error('Remote fetch maxRedirects must be a non-negative integer');
  return { timeoutMs, maxBytes, maxRedirects };
}

/**
 * Fetch an untrusted remote HTTPS URL through a DNS-pinned transport.
 * Redirect targets are independently validated, and returned bodies are fully
 * buffered within `maxBytes`; callers never receive a live response stream.
 */
export async function fetchSafeRemoteUrl(
  rawUrl: string,
  options: SafeRemoteFetchOptions = {},
): Promise<SafeRemoteFetchResult> {
  if (options.timeoutMs === 0) {
    throw new Error('Safe remote fetch timeout must be greater than zero');
  }
  assertSafeRequestHeaders(options.headers);
  return fetchSafeRemoteUrlInternal(rawUrl, options);
}

/** @internal Shared feed transport; its HTTP/private/test seams are not exported from the package barrel. */
export async function fetchSafeRemoteUrlInternal(
  rawUrl: string,
  options: InternalSafeRemoteFetchOptions = {},
): Promise<SafeRemoteFetchResult> {
  const { timeoutMs, maxBytes, maxRedirects } = assertFetchLimits(options);
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout =
    timeoutMs > 0
      ? new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            controller?.abort();
            reject(new Error(`Remote fetch timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      : undefined;
  const run = async (): Promise<SafeRemoteFetchResult> => {
    let current = await validateSafeRemoteUrl(rawUrl, {
      allowPrivateNetworkHosts: options.allowPrivateNetworkHosts,
      resolveHostnameWhenPrivateAllowed: true,
      resolveHostname: options.resolveHostname,
    });
    let requestHeaders = options.headers;
    if (!options.allowHttp && current.url.protocol !== 'https:') {
      throw new Error('Remote fetch URL must use https');
    }
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const result = await fetchPinnedRemoteUrl(
        current,
        {
          ...options,
          headers: requestHeaders,
        },
        controller?.signal,
      );
      const { response } = result;
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          await closeRemoteResponse(result);
          throw new Error('Remote redirect response missing Location header');
        }
        try {
          const previousOrigin = current.url.origin;
          current = await validateSafeRemoteUrl(
            new URL(location, current.url).toString(),
            {
              allowPrivateNetworkHosts: options.allowPrivateNetworkHosts,
              resolveHostnameWhenPrivateAllowed: true,
              resolveHostname: options.resolveHostname,
            },
          );
          if (!options.allowHttp && current.url.protocol !== 'https:') {
            throw new Error('Remote fetch URL must use https');
          }
          if (current.url.origin !== previousOrigin) {
            requestHeaders = removeCrossOriginSensitiveHeaders(requestHeaders);
          }
        } finally {
          await closeRemoteResponse(result);
        }
        continue;
      }
      try {
        return {
          url: current.url,
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: copyResponseHeaders(response.headers),
          body: await readBoundedResponseBytes(response, maxBytes),
        };
      } finally {
        await closeRemoteResponse(result);
      }
    }
    throw new Error('Remote URL exceeded the maximum number of redirects');
  };
  try {
    return timeout ? await Promise.race([run(), timeout]) : await run();
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
