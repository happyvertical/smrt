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
   * - `'proxy'` (default): fetch the bytes via `globalThis.fetch` and
   *   return them inline. Keeps the origin URL hidden from the client
   *   and preserves the same tenant/access checks the local path gets.
   * - `'redirect'`: return a `302` to `sourceUri` instead of fetching.
   *   Skips the byte round-trip but exposes the origin URL.
   * - `'error'`: treat a remote URI as an error (`500`). Use this when
   *   you expect every asset to live in the local store.
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
   * Custom `Response`-like constructor, for runtimes that don't have
   * a global `Response` (pre-Node-18, workers with a custom shim).
   * Defaults to `globalThis.Response`.
   */
  responseCtor?: ResponseConstructor;
}

type ResponseConstructor = typeof Response;

function isRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
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

  const remoteMode = options.remoteMode ?? 'proxy';
  let data: Buffer;
  let remoteContentType: string | undefined;

  if (isRemoteUri(asset.sourceUri)) {
    if (remoteMode === 'error') {
      throw new AssetServeError('Remote asset not supported', 500);
    }
    if (remoteMode === 'redirect') {
      throw new RedirectToSourceUri(asset.sourceUri);
    }
    // Proxy — fetch the bytes from the origin URL.
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new AssetServeError(
        'No fetch implementation available for remote asset',
        500,
      );
    }
    try {
      const response = await fetchImpl(asset.sourceUri);
      if (!response.ok) {
        throw new AssetServeError(
          `Remote asset returned ${response.status}`,
          502,
        );
      }
      data = Buffer.from(await response.arrayBuffer());
      remoteContentType = response.headers.get('content-type') ?? undefined;
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

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Content-Disposition': buildContentDisposition(
        options.disposition ?? 'inline',
        filename,
      ),
      ...options.headers,
    };

    // new Response(body) requires Uint8Array / ArrayBuffer / string in most
    // runtimes; Buffer is a Uint8Array subclass so this is safe in Node.
    return new Ctor(data as unknown as BodyInit, { status: 200, headers });
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
