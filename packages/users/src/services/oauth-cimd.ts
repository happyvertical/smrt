/**
 * OAuth Client ID Metadata Documents (CIMD, #5081): an HTTPS-URL `client_id`
 * whose metadata the authorization server fetches instead of requiring prior
 * registration. Opt-in like dynamic client registration; off by default.
 *
 * The SDK server resolves clients only through `storage.getClient`, so CIMD is
 * a storage decorator plus a thin server subclass that advertises support in
 * RFC 8414 metadata. Every failure resolves to "unknown client" (null) so the
 * SDK answers uniformly and no fetch detail reaches the requester.
 */
import {
  createAuthorizationServer,
  OAuthAuthorizationServer,
  type OAuthAuthorizationServerOptions,
  type OAuthAuthorizationStorage,
  type OAuthClient,
} from '@happyvertical/auth/server';
import {
  type CimdFetcher,
  type CimdFetchResult,
  createSafeCimdFetcher,
} from './oauth-cimd-fetch.js';

export type { CimdFetcher, CimdFetchResult } from './oauth-cimd-fetch.js';
export { createSafeCimdFetcher, isBlockedAddress } from './oauth-cimd-fetch.js';

/** Why a CIMD client_id resolved to "unknown client"; for operator logging only. */
export type CimdRejectionReason =
  | 'invalid_url'
  | 'origin_denied'
  | 'fetch_failed'
  | 'too_busy'
  | 'http_status'
  | 'content_type'
  | 'malformed_document'
  | 'invalid_document';

export interface ClientIdMetadataDocumentOptions {
  /**
   * REQUIRED app policy: which client origins may use CIMD. Called with the
   * client_id's origin and the full URL on every request (never cached), so a
   * policy change takes effect immediately. A throw or non-true result denies.
   * To accept any HTTPS client, pass an explicit `() => true`; the host's
   * consent screen is then the only gate. There is deliberately no implicit
   * allow-all: enabling CIMD without a policy throws at construction.
   */
  allowClientOrigin(
    origin: string,
    clientId: string,
  ): boolean | Promise<boolean>;
  /** Replace the SSRF-guarded fetcher (tests, or an egress proxy). */
  fetcher?: CimdFetcher;
  /** Observability hook; never expose the reason to the requester. */
  onRejected?(clientId: string, reason: CimdRejectionReason): void;
  /** Fetch deadline. Default 5000. */
  timeoutMs?: number;
  /** Document size cap in bytes. Default 16384. */
  maxBytes?: number;
  /** Cache floor; also applies to no-store/no-cache/max-age=0. Default 60. */
  minCacheSeconds?: number;
  /** Cache ceiling. Default 86400. */
  maxCacheSeconds?: number;
  /** Used when the response carries no cache lifetime. Default 3600. */
  defaultCacheSeconds?: number;
  /** How long a failed lookup is remembered. Default 30. */
  negativeCacheSeconds?: number;
  /** Maximum simultaneous cache-miss fetches; excess are refused. Default 8. */
  maxConcurrentFetches?: number;
  /** Maximum cached documents (oldest evicted). Default 1000. */
  maxCacheEntries?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

const maxRedirectUris = 10;
const maxStringLength = 2048;

/** True when a client_id should be resolved as a metadata document URL. */
export function isClientIdMetadataDocumentUrl(clientId: string): boolean {
  return /^https:\/\//iu.test(clientId);
}

/** CIMD client_id rules: canonical https URL, path, no credentials/fragment/dot segments. */
function parseClientIdUrl(clientId: string): URL | null {
  if (clientId.length > maxStringLength) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (
    url.href !== clientId ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    clientId.includes('?') ||
    url.port ||
    url.pathname === '/' ||
    url.pathname
      .split('/')
      .some((segment) => /^(\.|%2e){1,2}$/iu.test(segment)) ||
    // Literal IPs and single-label / local-only names are never client hosts.
    host.startsWith('[') ||
    /^[\d.]+$/u.test(host) ||
    !host.includes('.') ||
    /\.(localhost|local|internal|lan|home|corp|test|invalid|onion)$/iu.test(
      host,
    )
  )
    return null;
  return url;
}

function cacheSeconds(
  headers: Readonly<Record<string, string>>,
  options: Required<
    Pick<
      ClientIdMetadataDocumentOptions,
      'minCacheSeconds' | 'maxCacheSeconds' | 'defaultCacheSeconds'
    >
  >,
): number {
  const control = (headers['cache-control'] ?? '').toLowerCase();
  const directive = (name: string) =>
    new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*"?(\\d+)`, 'u').exec(control)?.[1];
  let seconds: number = options.defaultCacheSeconds;
  const explicit = directive('s-maxage') ?? directive('max-age');
  if (explicit !== undefined) seconds = Number(explicit);
  if (/(?:^|[\s,])(no-store|no-cache)(?:$|[\s,=])/u.test(control)) seconds = 0;
  const age = Number(headers.age);
  if (Number.isFinite(age) && age > 0) seconds -= age;
  return Math.min(
    options.maxCacheSeconds,
    Math.max(options.minCacheSeconds, seconds),
  );
}

function validRedirect(uri: unknown, allowLoopback: boolean): uri is string {
  if (typeof uri !== 'string' || uri.length > maxStringLength) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || url.search) return false;
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    allowLoopback &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  );
}

/** Validate a fetched document; returns the client or a rejection reason. */
function toClient(
  clientId: string,
  body: string,
  scopes: readonly string[],
  allowLoopback: boolean,
  issuedAt: number,
): OAuthClient | CimdRejectionReason {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return 'malformed_document';
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    return 'malformed_document';
  const value = doc as Record<string, unknown>;
  const uris = value.redirect_uris;
  const stringList = (field: string, allowed: readonly string[]) =>
    value[field] === undefined ||
    (Array.isArray(value[field]) &&
      (value[field] as unknown[]).length > 0 &&
      (value[field] as unknown[]).every(
        (entry) => typeof entry === 'string' && allowed.includes(entry),
      ));
  if (
    value.client_id !== clientId ||
    !Array.isArray(uris) ||
    !uris.length ||
    uris.length > maxRedirectUris ||
    !uris.every((uri) => validRedirect(uri, allowLoopback)) ||
    // Public clients only: no secrets, no secret-based auth.
    (value.token_endpoint_auth_method !== undefined &&
      value.token_endpoint_auth_method !== 'none') ||
    'client_secret' in value ||
    'client_secret_expires_at' in value ||
    !stringList('grant_types', ['authorization_code', 'refresh_token']) ||
    !stringList('response_types', ['code']) ||
    (value.scope !== undefined &&
      (typeof value.scope !== 'string' || value.scope.length > maxStringLength))
  )
    return 'invalid_document';
  const requested =
    typeof value.scope === 'string'
      ? value.scope.split(' ').filter(Boolean)
      : undefined;
  return {
    id: clientId,
    redirectUris: [...(uris as string[])],
    allowedScopes: requested
      ? requested.filter((scope) => scopes.includes(scope))
      : [...scopes],
    tokenEndpointAuthMethod: 'none',
    createdAt: new Date(issuedAt),
  };
}

/**
 * Wrap `storage` so https:// client_ids resolve from their metadata document.
 * Other client_ids pass through untouched; every other storage method does too.
 */
export function withClientIdMetadataDocuments(
  storage: OAuthAuthorizationStorage,
  settings: {
    scopes: readonly string[];
    allowLoopbackRedirects?: boolean;
  } & ClientIdMetadataDocumentOptions,
): OAuthAuthorizationStorage {
  if (typeof settings.allowClientOrigin !== 'function')
    throw new Error(
      'Client ID Metadata Documents require an allowClientOrigin policy.',
    );
  const now = settings.now ?? Date.now;
  const timeoutMs = settings.timeoutMs ?? 5000;
  const maxBytes = settings.maxBytes ?? 16_384;
  const cacheOptions = {
    minCacheSeconds: settings.minCacheSeconds ?? 60,
    maxCacheSeconds: settings.maxCacheSeconds ?? 86_400,
    defaultCacheSeconds: settings.defaultCacheSeconds ?? 3600,
  };
  const negativeMs = (settings.negativeCacheSeconds ?? 30) * 1000;
  const maxEntries = settings.maxCacheEntries ?? 1000;
  const fetcher = settings.fetcher ?? createSafeCimdFetcher();
  const cache = new Map<
    string,
    { client: OAuthClient | null; expiresAt: number }
  >();
  const maxConcurrent = settings.maxConcurrentFetches ?? 8;
  let active = 0;
  const inflight = new Map<string, Promise<OAuthClient | null>>();
  const reject = (clientId: string, reason: CimdRejectionReason) => {
    try {
      settings.onRejected?.(clientId, reason);
    } catch {
      // Observability must never change the outcome.
    }
    return null;
  };

  const load = async (
    clientId: string,
    url: URL,
  ): Promise<OAuthClient | null> => {
    let response: CimdFetchResult;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Enforced here as well so an injected fetcher cannot hang a lookup.
      response = await Promise.race([
        fetcher(url, { timeoutMs, maxBytes }),
        new Promise<never>((_, rejectFetch) => {
          deadline = setTimeout(
            () => rejectFetch(new Error('client metadata fetch timed out')),
            timeoutMs,
          );
        }),
      ]);
    } catch {
      return reject(clientId, 'fetch_failed');
    } finally {
      clearTimeout(deadline);
    }
    if (response.status !== 200) return reject(clientId, 'http_status');
    if (response.body.length > maxBytes)
      return reject(clientId, 'malformed_document');
    const mediaType = (response.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (
      mediaType !== 'application/json' &&
      !/^application\/[\w.+-]+\+json$/u.test(mediaType)
    )
      return reject(clientId, 'content_type');
    const issuedAt = now();
    const result = toClient(
      clientId,
      response.body,
      settings.scopes,
      settings.allowLoopbackRedirects === true,
      issuedAt,
    );
    if (typeof result === 'string') return reject(clientId, result);
    cache.set(clientId, {
      client: result,
      expiresAt: issuedAt + cacheSeconds(response.headers, cacheOptions) * 1000,
    });
    return result;
  };

  const resolve = async (clientId: string): Promise<OAuthClient | null> => {
    const url = parseClientIdUrl(clientId);
    if (!url) return reject(clientId, 'invalid_url');
    // Policy runs before the cache so a revoked origin stops immediately.
    let allowed = false;
    try {
      allowed =
        (await settings.allowClientOrigin(url.origin, clientId)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) return reject(clientId, 'origin_denied');
    const hit = cache.get(clientId);
    if (hit && hit.expiresAt > now()) return hit.client;
    cache.delete(clientId);
    const pending =
      inflight.get(clientId) ??
      (async () => {
        if (active >= maxConcurrent) return reject(clientId, 'too_busy');
        active += 1;
        let client: OAuthClient | null;
        try {
          client = await load(clientId, url);
        } finally {
          active -= 1;
        }
        if (!client)
          cache.set(clientId, { client: null, expiresAt: now() + negativeMs });
        while (cache.size > maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        return client;
      })().finally(() => inflight.delete(clientId));
    inflight.set(clientId, pending);
    return pending;
  };

  return new Proxy(storage, {
    get(target, property) {
      if (property === 'getClient')
        return (clientId: string) =>
          isClientIdMetadataDocumentUrl(clientId)
            ? resolve(clientId)
            : target.getClient(clientId);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** SDK server options plus the opt-in CIMD block (absent = disabled). */
export interface CimdAuthorizationServerOptions
  extends OAuthAuthorizationServerOptions {
  clientIdMetadataDocuments?: ClientIdMetadataDocumentOptions;
}

class ClientIdMetadataAuthorizationServer extends OAuthAuthorizationServer {
  /** RFC 8414 plus draft-ietf-oauth-client-id-metadata-document. */
  override discovery() {
    return {
      ...super.discovery(),
      client_id_metadata_document_supported: true as const,
    };
  }
}

/**
 * Create the SDK authorization server, optionally accepting Client ID Metadata
 * Documents. Without `clientIdMetadataDocuments` this is exactly the SDK server:
 * https:// client_ids stay unknown and nothing is fetched or advertised.
 */
export function createCimdAuthorizationServer(
  options: CimdAuthorizationServerOptions,
): OAuthAuthorizationServer {
  const { clientIdMetadataDocuments, ...serverOptions } = options;
  if (!clientIdMetadataDocuments)
    return createAuthorizationServer(serverOptions);
  return new ClientIdMetadataAuthorizationServer({
    ...serverOptions,
    storage: withClientIdMetadataDocuments(serverOptions.storage, {
      ...clientIdMetadataDocuments,
      scopes: serverOptions.scopes,
      allowLoopbackRedirects: serverOptions.allowLoopbackRedirects,
    }),
  });
}
