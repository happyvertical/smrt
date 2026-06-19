/**
 * Generic asset-serving contract
 *
 * Framework-agnostic helpers that turn a `smrt-assets` runtime plus
 * an asset id (or asset instance) into a standard `Response`. Apps
 * (SvelteKit, Hono, plain Node) can wire this once and stop inventing
 * agent-specific routes.
 *
 * `serveAsset()` returns a Web `Response` built against the global
 * `Response` available in Node 18+. If a runtime needs an older Node,
 * pass its own Response constructor via `responseCtor`.
 */

import type { Asset } from './asset';
import type { AssetRuntimeLike } from './asset-runtime';

/**
 * Result of `resolveAssetForServing()` — lets advanced callers
 * stream bytes themselves while still reusing the access check.
 */
export interface ResolvedAssetBytes {
  asset: Asset;
  data: Buffer;
  contentType: string;
  filename: string;
  size: number;
}

/**
 * Options for `serveAsset()` and `resolveAssetForServing()`.
 */
export interface ServeAssetOptions {
  /** Shared asset runtime (collection + store). */
  runtime: AssetRuntimeLike;

  /**
   * Either an asset id to look up or a fully-loaded `Asset`
   * instance. Passing the instance skips the `collection.get()` call.
   */
  asset: string | Asset;

  /**
   * Tenant of the caller. When provided, the asset must either
   * belong to this tenant or be a global asset (`tenantId = null`)
   * or a 403 is returned.
   */
  tenantId?: string | null;

  /**
   * Optional `Content-Disposition` — `'inline'` (default) or
   * `'attachment'`. Use `'attachment'` for download links.
   */
  disposition?: 'inline' | 'attachment';

  /**
   * Extra headers merged into the 200 response. Does not affect
   * 403/404/500 responses.
   */
  headers?: Record<string, string>;

  /**
   * Optional override for the filename used in `Content-Disposition`.
   * Defaults to the basename of the asset's `sourceUri` or `name`.
   */
  filename?: string;

  /**
   * Optional access-check hook. Return `false` to short-circuit with a
   * 403 before bytes are loaded. Runs after the built-in tenant check.
   */
  canAccess?: (asset: Asset) => boolean | Promise<boolean>;

  /**
   * How to handle assets whose `sourceUri` is an `http(s)` URL rather
   * than a store-backed path.
   *
   * - `'error'` (default): treat a remote URI as an error (`500`). This
   *   is the safe default — `sourceUri` is attacker-settable on many
   *   asset-creation paths, so proxying it blindly is an SSRF vector
   *   (fetching `169.254.169.254` cloud metadata, internal services,
   *   etc.). Opt into `'proxy'` only for trusted sources.
   * - `'proxy'`: fetch the bytes via `globalThis.fetch` and return them
   *   inline. Keeps the origin URL hidden from the client and preserves
   *   the same tenant/access checks the local path gets. Guarded against
   *   SSRF: the host must resolve to a public IP (private, loopback,
   *   link-local, and cloud-metadata ranges are rejected), only
   *   `http(s)` is allowed, and redirects are re-validated.
   * - `'redirect'`: return a `302` to `sourceUri` instead of fetching.
   *   Skips the byte round-trip but exposes the origin URL.
   *
   * Anything that does not look like `http://` or `https://` is read
   * through the store as usual.
   */
  remoteMode?: 'proxy' | 'redirect' | 'error';

  /**
   * Custom `fetch` implementation for the `remoteMode: 'proxy'` path.
   * Defaults to `globalThis.fetch` (Node 18+).
   */
  fetchImpl?: typeof fetch;

  /**
   * Maximum number of bytes to buffer when `remoteMode: 'proxy'` fetches
   * a remote asset. Protects against memory-exhaustion DoS from a hostile
   * (or compromised) origin streaming an unbounded body. Defaults to
   * {@link DEFAULT_REMOTE_MAX_BYTES} (50 MiB).
   */
  remoteMaxBytes?: number;

  /**
   * Timeout in milliseconds for the `remoteMode: 'proxy'` fetch. Defaults
   * to {@link DEFAULT_REMOTE_TIMEOUT_MS} (10s). Prevents a slow/hung
   * origin from pinning the request indefinitely.
   */
  remoteTimeoutMs?: number;

  /**
   * Custom `Response`-like constructor, for runtimes that don't have
   * a global `Response` (pre-Node-18, workers with a custom shim).
   * Defaults to `globalThis.Response`.
   */
  responseCtor?: ResponseConstructor;
}

type ResponseConstructor = typeof Response;

/** Default cap (50 MiB) on bytes buffered from a proxied remote asset. */
export const DEFAULT_REMOTE_MAX_BYTES = 50 * 1024 * 1024;

/** Default timeout (10s) for a proxied remote-asset fetch. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 10_000;

/** Maximum number of redirects to follow during a proxied fetch. */
const MAX_REMOTE_REDIRECTS = 5;

/**
 * MIME types safe to serve `inline`. Anything else is forced to
 * `attachment` so a browser won't render attacker-controlled content
 * (HTML/SVG/XML) in the serving origin's context (stored XSS).
 */
const INLINE_SAFE_MIME_TYPES = new Set<string>([
  'application/json',
  'application/pdf',
  'audio/aac',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain',
  'video/mp4',
  'video/ogg',
  'video/webm',
]);

/** Parse the bare type (drop parameters like `; charset=...`) and lowercase. */
function normalizeMimeType(raw: string): string {
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

/** Whether a MIME type is on the inline-safe safelist. */
function isInlineSafeMimeType(contentType: string): boolean {
  return INLINE_SAFE_MIME_TYPES.has(normalizeMimeType(contentType));
}

function isRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/**
 * Reject hostnames/IPs that point at private, loopback, link-local, or
 * cloud-metadata ranges — the core SSRF guard for proxied fetches.
 *
 * This is a literal-IP check; it does NOT perform DNS resolution, so a
 * hostname that resolves to a private IP is not caught here. Treat
 * `remoteMode: 'proxy'` as trusted-source-only and keep the default at
 * `'error'`; this guard is defense-in-depth for the literal-IP and obvious
 * cloud-metadata cases that make up the bulk of real SSRF payloads.
 */
function isBlockedHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  // Strip IPv6 brackets if present (URL.hostname keeps them off, but be safe).
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  // Cloud metadata endpoints (AWS/GCP/Azure/OpenStack link-local + alibaba).
  if (
    host === '169.254.169.254' ||
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === '100.100.100.200'
  ) {
    return true;
  }

  // IPv4 literal?
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((o) => Number(o));
    if (octets.some((o) => o > 255)) return true; // malformed → block
    return isBlockedIpv4(octets as [number, number, number, number]);
  }

  // IPv6 literal?
  if (host.includes(':')) {
    return isBlockedIpv6(host);
  }

  return false;
}

function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true; // unspecified + loopback
  if (h.startsWith('fe80')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique-local
  if (h.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4 address.
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped?.[1]) {
    const octets = mapped[1].split('.').map((o) => Number(o));
    if (octets.some((o) => o > 255)) return true;
    return isBlockedIpv4(octets as [number, number, number, number]);
  }
  return false;
}

/**
 * Validate a remote URL for proxying: only `http(s)` and only public hosts.
 * Throws `AssetServeError(502)` on a rejected target (kept opaque so the
 * client can't probe internal reachability via status differences).
 */
function assertSafeRemoteUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AssetServeError('Invalid remote asset URL', 502);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AssetServeError('Unsupported remote asset scheme', 502);
  }
  if (isBlockedHost(url.hostname)) {
    throw new AssetServeError('Remote asset host not allowed', 502);
  }
  return url;
}

/**
 * Fetch a remote asset with SSRF protection, a byte cap, and a timeout.
 *
 * Redirects are followed manually (`redirect: 'manual'`) so each hop's
 * `Location` is re-validated through {@link assertSafeRemoteUrl} — otherwise
 * a public host could 302 to `169.254.169.254`.
 */
async function fetchRemoteAsset(
  startUrl: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ data: Buffer; contentType: string | undefined }> {
  let current = assertSafeRemoteUrl(startUrl);

  for (let hop = 0; hop <= MAX_REMOTE_REDIRECTS; hop++) {
    const response = await fetchImpl(current.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Manual redirect handling — re-validate each Location hop.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new AssetServeError(
          'Remote asset redirect missing Location',
          502,
        );
      }
      current = assertSafeRemoteUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) {
      throw new AssetServeError(
        `Remote asset returned ${response.status}`,
        502,
      );
    }

    const data = await readBodyWithCap(response, maxBytes);
    return {
      data,
      contentType: response.headers.get('content-type') ?? undefined,
    };
  }

  throw new AssetServeError('Too many remote asset redirects', 502);
}

/**
 * Read a response body into a Buffer, aborting if it exceeds `maxBytes`.
 * Streams when possible so an oversized body is rejected without first
 * buffering the whole thing; falls back to a post-hoc length check when the
 * response exposes no readable stream (e.g. test doubles).
 */
async function readBodyWithCap(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new AssetServeError('Remote asset exceeds size limit', 502);
  }

  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new AssetServeError('Remote asset exceeds size limit', 502);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  // No stream available — buffer then enforce the cap.
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new AssetServeError('Remote asset exceeds size limit', 502);
  }
  return buf;
}

/**
 * Resolve an asset + bytes for serving, enforcing the same tenant
 * and access checks as `serveAsset()` but returning the parts so
 * callers can render their own framework response.
 *
 * Throws `AssetServeError` with a status on any error so callers can
 * map to their HTTP layer.
 */
export async function resolveAssetForServing(
  options: ServeAssetOptions,
): Promise<ResolvedAssetBytes> {
  const {
    runtime,
    asset: assetOrId,
    tenantId,
    canAccess,
    disposition: _disposition,
  } = options;

  const asset =
    typeof assetOrId === 'string'
      ? ((await runtime.collection.get({ id: assetOrId })) as Asset | null)
      : assetOrId;

  if (!asset) {
    throw new AssetServeError('Asset not found', 404);
  }

  if (
    tenantId !== undefined &&
    asset.tenantId !== null &&
    asset.tenantId !== tenantId
  ) {
    throw new AssetServeError('Asset not visible to this tenant', 403);
  }

  if (canAccess) {
    const allowed = await canAccess(asset);
    if (!allowed) {
      throw new AssetServeError('Asset access denied', 403);
    }
  }

  // Default to 'error': `sourceUri` is attacker-settable on many
  // asset-creation paths, so proxying it blindly is an SSRF vector. Callers
  // serving trusted sources opt into 'proxy' explicitly (S5 #1396).
  const remoteMode = options.remoteMode ?? 'error';
  let data: Buffer;
  let remoteContentType: string | undefined;

  if (isRemoteUri(asset.sourceUri)) {
    if (remoteMode === 'error') {
      throw new AssetServeError('Remote asset not supported', 500);
    }
    if (remoteMode === 'redirect') {
      throw new RedirectToSourceUri(asset.sourceUri);
    }
    // Proxy — fetch the bytes from the origin URL with SSRF guards,
    // a byte cap, and a timeout.
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new AssetServeError(
        'No fetch implementation available for remote asset',
        500,
      );
    }
    const maxBytes = options.remoteMaxBytes ?? DEFAULT_REMOTE_MAX_BYTES;
    const timeoutMs = options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
    try {
      const result = await fetchRemoteAsset(
        asset.sourceUri,
        fetchImpl,
        maxBytes,
        timeoutMs,
      );
      data = result.data;
      remoteContentType = result.contentType;
    } catch (err) {
      if (err instanceof AssetServeError) throw err;
      // Log the underlying error so operators can debug without
      // leaking paths/bucket names to the HTTP client.
      console.error('serveAsset: remote fetch failed', err);
      throw new AssetServeError('Failed to fetch remote asset', 502);
    }
  } else {
    try {
      data = await runtime.store.read(asset);
    } catch (err) {
      console.error('serveAsset: store read failed', err);
      throw new AssetServeError('Failed to read asset bytes', 500);
    }
  }

  const contentType =
    asset.mimeType || remoteContentType || 'application/octet-stream';
  const filename = options.filename ?? deriveFilename(asset);

  return {
    asset,
    data,
    contentType,
    filename,
    size: data.byteLength,
  };
}

/**
 * Internal signal for `remoteMode: 'redirect'`. Caught by `serveAsset`
 * and turned into a 302; `resolveAssetForServing` re-throws so direct
 * callers can inspect it via `err.location`.
 */
class RedirectToSourceUri extends Error {
  constructor(public readonly location: string) {
    super('Asset stored at remote URL');
    this.name = 'RedirectToSourceUri';
  }
}

/**
 * Serve an asset as a standard Web `Response`.
 *
 * Returns:
 *  - `404` when the asset id doesn't resolve
 *  - `403` when the tenant mismatches or `canAccess` denies
 *  - `302` when `remoteMode: 'redirect'` and the asset's `sourceUri`
 *    is an `http(s)` URL
 *  - `502` when `remoteMode: 'proxy'` and the origin fetch fails
 *  - `500` when bytes fail to read (file missing, provider error)
 *  - `200` with the raw bytes, `Content-Type`, `Content-Length`, and
 *    `Content-Disposition` set otherwise.
 *
 * The resulting `Response` is framework-agnostic: SvelteKit `+server.ts`
 * endpoints, Hono, and plain Node HTTP all accept it via their Web
 * interop layer.
 */
export async function serveAsset(
  options: ServeAssetOptions,
): Promise<Response> {
  const Ctor =
    options.responseCtor ?? (globalThis.Response as ResponseConstructor);
  if (!Ctor) {
    throw new Error(
      'serveAsset: no Response constructor available. Pass options.responseCtor or run on Node 18+.',
    );
  }

  try {
    const { data, contentType, filename, size } =
      await resolveAssetForServing(options);

    // Force `attachment` for any type not on the inline-safe safelist so a
    // browser won't render attacker-controlled HTML/SVG/XML in the serving
    // origin's context (stored XSS). An explicit `disposition: 'attachment'`
    // is always honoured; a requested `'inline'` is downgraded for unsafe
    // types. Pair with `X-Content-Type-Options: nosniff` so the browser
    // can't MIME-sniff a safelisted type into something executable (S5 #1396).
    const requestedDisposition = options.disposition ?? 'inline';
    const disposition =
      requestedDisposition === 'attachment' || isInlineSafeMimeType(contentType)
        ? requestedDisposition
        : 'attachment';

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Content-Disposition': buildContentDisposition(disposition, filename),
      'X-Content-Type-Options': 'nosniff',
      ...options.headers,
    };

    // `new Response(body)` accepts Buffer at runtime (it's a Uint8Array
    // subclass), but the strongly-typed `BodyInit` name lives in
    // `lib.dom.d.ts`, which the package-build tsconfig doesn't pull in.
    // Cast through `unknown` instead of referencing a DOM type so `.d.ts`
    // generation works without needing DOM lib.
    return new Ctor(
      data as unknown as ConstructorParameters<ResponseConstructor>[0],
      {
        status: 200,
        headers,
      },
    );
  } catch (err) {
    if (err instanceof RedirectToSourceUri) {
      return new Ctor(null, {
        status: 302,
        headers: { Location: err.location },
      });
    }
    if (err instanceof AssetServeError) {
      return new Ctor(err.message, {
        status: err.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    // Don't surface the underlying error to clients — it can leak
    // paths/bucket names/provider details. Log for operators.
    console.error('serveAsset: unexpected error', err);
    return new Ctor('Internal error serving asset', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * Error raised by `resolveAssetForServing()` with the HTTP status
 * callers should use when rendering their own response.
 */
export class AssetServeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AssetServeError';
  }
}

function deriveFilename(asset: Asset): string {
  if (asset.name) return asset.name;
  const fromUri = extractBasename(asset.sourceUri);
  if (fromUri) return fromUri;
  return asset.id ?? 'asset';
}

function extractBasename(uri: string): string {
  if (!uri) return '';
  const noScheme = uri.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, '');
  const last = noScheme.split('/').pop() ?? '';
  return last;
}

function sanitizeDispositionFilename(filename: string): string {
  // Strip control characters (C0 + DEL) first — they make the header
  // invalid in Node's Response constructor and could enable CRLF
  // injection. Then replace quotes, backslashes, and path separators
  // so the quoted-string form is safe.
  let stripped = '';
  for (const ch of filename) {
    const code = ch.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) {
      stripped += ch;
    }
  }
  const safe = stripped.replace(/["\\/]/g, '_').trim();
  return safe || 'asset';
}

function buildContentDisposition(
  disposition: 'inline' | 'attachment',
  filename: string,
): string {
  const sanitized = sanitizeDispositionFilename(filename);
  const encoded = encodeURIComponent(sanitized);
  return `${disposition}; filename="${sanitized}"; filename*=UTF-8''${encoded}`;
}
