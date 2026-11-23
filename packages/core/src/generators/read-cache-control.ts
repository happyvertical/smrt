/**
 * Cache-Control policy for generated read routes (#1757). Pure and
 * dependency-free: see `./conditional-get.ts` for the policy description.
 */

/** Default Cache-Control for generated reads: private conditional revalidation. */
export const PRIVATE_READ_CACHE_CONTROL = 'private, no-cache';

export interface ApiCacheShape {
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
  /**
   * Whether the response body varies with caller permissions because at least
   * one field has `@field({ readPermission })`. Shared caches key on URL, not
   * user permission sets, so this also fails private regardless of `sMaxage`.
   */
  permissionScoped?: boolean;
}

/**
 * The shared Cache-Control string the `api` config asks for, or null when the
 * config does not (validly) opt into shared caching. Config-only — the
 * tenant-scoped restriction is applied by `resolveReadCacheControl`.
 */
export function requestedSharedCacheControl(apiConfig: unknown): string | null {
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
 * Tenant-scoped and permission-scoped models are ALWAYS `private, no-cache`
 * regardless of config: their response bodies vary with request identity
 * (tenant or permissions, invisible to URL-keyed shared caches), so shared
 * caching would leak one caller's representation to another caller.
 */
export function resolveReadCacheControl(
  apiConfig: unknown,
  options: ReadCacheControlOptions = {},
): string {
  if (options.tenantScoped || options.permissionScoped) {
    return PRIVATE_READ_CACHE_CONTROL;
  }

  return requestedSharedCacheControl(apiConfig) ?? PRIVATE_READ_CACHE_CONTROL;
}
