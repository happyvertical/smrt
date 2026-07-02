/**
 * Conditional GET v1 for generated read routes (#1757).
 *
 * Generated `list`/`get` responses carry a strong ETag computed from the
 * serialized JSON body, and a matching `If-None-Match` answers
 * `304 Not Modified` with an empty body. v1 deliberately still runs the query
 * — the win is transfer, parse, and re-render, not the database round trip
 * (a later slice upgrades the ETag source to the change-feed table version).
 *
 * Cache-Control policy (fail-private, mirroring the #1540 posture):
 * - Default reads: `private, no-cache` — responses may be stored by the
 *   browser but MUST be revalidated before reuse, and shared caches never
 *   store them.
 * - `@smrt({ api: { public: true | 'read', cache: { sMaxage } } })` reads:
 *   `public, max-age=0, s-maxage=<n>` — CDNs/shared caches may serve the
 *   response for `n` seconds while browsers still revalidate (cheap 304s).
 *   Models without the public flag NEVER emit shared-cache headers, even when
 *   `cache.sMaxage` is configured.
 * - Tenant-scoped models (`@smrt({ tenantScoped })` / `@TenantScoped()`, any
 *   mode) NEVER emit shared-cache headers: their bodies vary with the tenant
 *   context, which URL-keyed shared caches cannot see. `sMaxage` is ignored
 *   with a one-time warning.
 *
 * Consumed by both the runtime REST generator (`./rest.ts`) and — as an
 * emitted code snippet — the SvelteKit route generator
 * (`../vite-plugin/sveltekit-generator.ts`). Keeping every piece here keeps
 * the two generators' diffs minimal and the policy in one place.
 */

import { createHash } from 'node:crypto';

/** Default Cache-Control for generated reads: private conditional revalidation. */
export const PRIVATE_READ_CACHE_CONTROL = 'private, no-cache';

/**
 * Compute the strong ETag for a serialized response body.
 *
 * SHA-256 of the exact JSON text, base64url-encoded and quoted per RFC 9110.
 * Deterministic for a given body, so any change to the underlying data (which
 * changes the serialized JSON) changes the ETag.
 */
export function computeBodyEtag(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url')}"`;
}

/**
 * Whether an `If-None-Match` request header matches the response ETag.
 *
 * Implements RFC 9110 §13.1.2 weak comparison: `*` matches anything, the
 * header may carry a comma-separated list, and a `W/` prefix is ignored.
 */
export function ifNoneMatchSatisfied(
  header: string | null | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    const opaque = tag.startsWith('W/') ? tag.slice(2) : tag;
    return opaque === etag;
  });
}

interface ApiCacheShape {
  cache?: { sMaxage?: unknown };
  public?: unknown;
}

/** Model-level context that constrains the cache policy beyond `api` config. */
export interface ReadCacheControlOptions {
  /**
   * Whether the model is tenant-scoped (`@smrt({ tenantScoped })` or the
   * `@TenantScoped()` decorator, ANY mode including `'optional'`). Tenant
   * scoping keys the response body on request identity (session cookie), which
   * shared caches cannot see — they key on the URL alone — so honoring
   * `sMaxage` would serve one tenant's rows to other tenants or to anonymous
   * visitors. Fail-closed: tenant-scoped models NEVER emit shared-cache
   * headers (#1757 review finding).
   */
  tenantScoped?: boolean;
}

/**
 * The shared Cache-Control string the `api` config asks for, or null when the
 * config does not (validly) opt into shared caching. Config-only — the
 * tenant-scoped restriction is applied by `resolveReadCacheControl`.
 */
function requestedSharedCacheControl(apiConfig: unknown): string | null {
  if (!apiConfig || typeof apiConfig !== 'object') {
    return null;
  }

  const config = apiConfig as ApiCacheShape;
  const publicRead = config.public === true || config.public === 'read';
  const sMaxage = config.cache?.sMaxage;

  if (
    publicRead &&
    typeof sMaxage === 'number' &&
    Number.isFinite(sMaxage) &&
    sMaxage > 0
  ) {
    // Shared caches serve for sMaxage seconds; browsers (max-age=0) always
    // revalidate, so end users see edits immediately via cheap 304s.
    return `public, max-age=0, s-maxage=${Math.floor(sMaxage)}`;
  }

  return null;
}

/**
 * Resolve the Cache-Control header for a generated read response from a
 * model's `@smrt({ api })` config (defensively typed — the config arrives as
 * `unknown` from the registry at runtime and from the manifest at build time).
 *
 * Only models that opted out of auth via `public: true` (or `'read'`, which
 * makes reads public) may emit shared-cache headers, and only when they also
 * configure a positive `cache.sMaxage`. Everything else — including a
 * non-public model that configures `sMaxage` — stays `private, no-cache`.
 *
 * Tenant-scoped models are ALWAYS `private, no-cache` regardless of config:
 * their response bodies vary with the tenant context (resolved from session
 * cookies, invisible to URL-keyed shared caches), so shared caching would
 * leak one tenant's rows to other tenants or anonymous visitors.
 */
export function resolveReadCacheControl(
  apiConfig: unknown,
  options: ReadCacheControlOptions = {},
): string {
  if (options.tenantScoped) {
    return PRIVATE_READ_CACHE_CONTROL;
  }

  return requestedSharedCacheControl(apiConfig) ?? PRIVATE_READ_CACHE_CONTROL;
}

// One warning per model — both transports resolve the same model repeatedly
// (per route template at generation time, per request at runtime).
const sharedCacheNeutralizedWarned = new Set<string>();

/**
 * Warn (once per model) when a tenant-scoped model configures
 * `api.cache.sMaxage`: the knob is deliberately neutralized to private
 * caching, and silently ignoring it would leave developers wondering why no
 * CDN caching happens. Called from both the REST runtime and the SvelteKit
 * route generator so the message surfaces wherever the model is served.
 */
export function warnIfSharedCacheNeutralized(
  modelName: string,
  apiConfig: unknown,
  tenantScoped: boolean,
): void {
  if (!tenantScoped) return;
  if (requestedSharedCacheControl(apiConfig) === null) return;
  if (sharedCacheNeutralizedWarned.has(modelName)) return;
  sharedCacheNeutralizedWarned.add(modelName);
  console.warn(
    `[smrt] api.cache.sMaxage ignored for tenant-scoped model ${modelName}: ` +
      'shared caches cannot key on tenant context — serving ' +
      `'${PRIVATE_READ_CACHE_CONTROL}' instead (#1757).`,
  );
}

/**
 * Build the JSON response for a generated read, honoring `If-None-Match`.
 *
 * Returns `304 Not Modified` with an EMPTY body when the request's
 * `If-None-Match` matches the body ETag; otherwise a 200 with the serialized
 * payload. Both carry the ETag and the resolved Cache-Control so clients can
 * revalidate the representation they hold.
 */
export function conditionalJsonResponse(
  request: Request,
  payload: unknown,
  cacheControl: string,
): Response {
  const body = JSON.stringify(payload);
  const etag = computeBodyEtag(body);

  if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        'Cache-Control': cacheControl,
        ETag: etag,
      },
    });
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Cache-Control': cacheControl,
      'Content-Type': 'application/json',
      ETag: etag,
    },
  });
}

/** Generation-time context for the emitted SvelteKit route helper. */
export interface ConditionalGetRouteHelperOptions
  extends ReadCacheControlOptions {
  /** Model name used for the one-time sMaxage-neutralized warning. */
  modelName?: string;
}

/**
 * Emit the conditional-GET helper inlined into generated SvelteKit route
 * files, following the generator's existing inline-helper convention
 * (auth guard, tenant context, writable policy). The Cache-Control policy is
 * resolved at generation time from the object's `@smrt({ api })` config plus
 * the model's tenant scoping, and baked in as a constant.
 *
 * Kept textually in lockstep with the runtime helpers above — the `.spec`
 * suite drives both through the same HTTP semantics.
 */
export function generateConditionalGetRouteHelper(
  apiConfig: unknown,
  options: ConditionalGetRouteHelperOptions = {},
): string {
  // All branches of resolveReadCacheControl return fixed framework-owned
  // strings (no user text), so interpolating into a single-quoted literal is
  // safe and matches the generated-code quoting style.
  const cacheControl = resolveReadCacheControl(apiConfig, options);
  if (options.modelName) {
    warnIfSharedCacheNeutralized(
      options.modelName,
      apiConfig,
      options.tenantScoped === true,
    );
  }

  return `
// Conditional GET (#1757): strong body-hash ETag + If-None-Match → 304 with an
// empty body. Reads stay private unless the model is public AND opts into
// shared caching via @smrt({ api: { cache: { sMaxage } } }).
import { createHash } from 'node:crypto';

const READ_CACHE_CONTROL = '${cacheControl}';

function bodyEtag(body: string): string {
  return \`"\${createHash('sha256').update(body).digest('base64url')}"\`;
}

function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    const opaque = tag.startsWith('W/') ? tag.slice(2) : tag;
    return opaque === etag;
  });
}

function conditionalJson(request: Request, payload: unknown): Response {
  const body = JSON.stringify(payload);
  const etag = bodyEtag(body);
  if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: { 'cache-control': READ_CACHE_CONTROL, etag },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      'cache-control': READ_CACHE_CONTROL,
      'content-type': 'application/json',
      etag,
    },
  });
}
`;
}
