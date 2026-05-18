/**
 * Tenant resolution for SvelteKit requests.
 *
 * This file is intentionally pluggable — consumers can swap the strategy
 * function without forking. The shipped default is subdomain-based:
 *
 *   acme.demo.local       → tenantId='acme'
 *   www.demo.local        → tenantId=null
 *   demo.local            → tenantId=null
 *   localhost / 127.0.0.1 → tenantId=null
 *
 * The resolver's signature is intentionally minimal — it accepts a
 * SvelteKit-like `RequestEvent` (typed structurally so this module has zero
 * `@sveltejs/kit` runtime dependency) and returns a synchronous result.
 *
 * @example Swap to path-prefix resolution
 * ```ts
 * // src/lib/server/tenancy.ts (your project)
 * import { createTenantResolver, pathPrefixStrategy } from './tenancy';
 *
 * export const resolveTenant = createTenantResolver(pathPrefixStrategy);
 * ```
 *
 * @example Swap to header-based resolution
 * ```ts
 * import { createTenantResolver, headerStrategy } from './tenancy';
 *
 * export const resolveTenant = createTenantResolver(
 *   headerStrategy({ headerName: 'x-tenant-id' }),
 * );
 * ```
 *
 * @example Compose your own
 * ```ts
 * import { createTenantResolver, subdomainStrategy } from './tenancy';
 *
 * export const resolveTenant = createTenantResolver((event) => {
 *   // Try subdomain first, then fall back to a header
 *   const fromSubdomain = subdomainStrategy(event);
 *   if (fromSubdomain.tenantId) return fromSubdomain;
 *   return { tenantId: event.request.headers.get('x-tenant-id') };
 * });
 * ```
 */

/**
 * Structural SvelteKit RequestEvent — only the bits we need for tenant
 * resolution. Keeping this minimal means the module has no @sveltejs/kit
 * runtime import, which keeps tests + non-SvelteKit consumers happy.
 */
export interface TenantResolverEvent {
  url: URL;
  request: { headers: Headers };
  params?: Record<string, string | undefined>;
}

/**
 * Resolution result. `null` means "no tenant for this request".
 */
export interface TenantResolution {
  tenantId: string | null;
}

/**
 * A resolver strategy is just a function from event → resolution. Sync or
 * async — the dispatcher awaits the return value.
 */
export type TenantResolverStrategy = (
  event: TenantResolverEvent,
) => TenantResolution | Promise<TenantResolution>;

/**
 * Hostnames that should never produce a tenant id, regardless of how many
 * dots they contain. Treats `localhost`, `127.0.0.1`, and `::1` as
 * tenant-less so local dev "just works" until you set up a wildcard DNS
 * entry like `*.demo.local → 127.0.0.1`.
 */
const ROOT_LIKE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Subdomain labels that are *never* tenant slugs even if they appear in the
 * leading position. Consumers can pass their own list to
 * {@link subdomainStrategyWith} if they need to extend this.
 */
const DEFAULT_RESERVED_SUBDOMAINS = new Set(['www', 'api', 'app']);

/**
 * Strategy: extract the tenant id from the leading subdomain.
 *
 * Behavior:
 *   - `acme.demo.local`            → `{ tenantId: 'acme' }`
 *   - `acme.beta.demo.local`       → `{ tenantId: 'acme' }`  (only leading label)
 *   - `www.demo.local`             → `{ tenantId: null }`    (reserved)
 *   - `demo.local`                 → `{ tenantId: null }`    (no leading subdomain)
 *   - `localhost`                  → `{ tenantId: null }`
 *   - `127.0.0.1` or any IPv4/IPv6 → `{ tenantId: null }`
 */
export const subdomainStrategy: TenantResolverStrategy = (event) => {
  return subdomainStrategyWith()(event);
};

/**
 * Customizable subdomain strategy. Use this if you need to extend the
 * reserved-subdomain list (e.g. to also reject `admin.demo.local`).
 *
 * The supplied `reservedSubdomains` are merged with the defaults
 * (`www`, `api`, `app`) — so adding `admin` still leaves `www` reserved.
 * Pass an empty iterable to start from a fresh set, or pass the value
 * you want via {@link DEFAULT_RESERVED_SUBDOMAINS} after filtering.
 */
export function subdomainStrategyWith(opts?: {
  reservedSubdomains?: Iterable<string>;
}): TenantResolverStrategy {
  const reserved = new Set<string>(DEFAULT_RESERVED_SUBDOMAINS);
  if (opts?.reservedSubdomains) {
    for (const s of opts.reservedSubdomains) {
      reserved.add(s.toLowerCase());
    }
  }

  return (event) => {
    const hostname = event.url.hostname.toLowerCase();

    if (ROOT_LIKE_HOSTS.has(hostname)) {
      return { tenantId: null };
    }

    // Reject bare IPv4 (e.g. `192.168.1.10`) — never a tenant subdomain.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      return { tenantId: null };
    }

    const labels = hostname.split('.');

    // Need at least 3 labels for a tenant subdomain: <tenant>.<root>.<tld>.
    // `demo.local` (2 labels) has no subdomain.
    if (labels.length < 3) {
      return { tenantId: null };
    }

    const candidate = labels[0];
    if (!candidate || reserved.has(candidate)) {
      return { tenantId: null };
    }

    return { tenantId: candidate };
  };
}

/**
 * Strategy: extract the tenant id from a path prefix like `/t/<slug>/...`.
 * The prefix is configurable; default is `/t/`.
 *
 * @example
 * ```ts
 * // matches  /t/acme/dashboard  → tenantId='acme'
 * createTenantResolver(pathPrefixStrategy());
 *
 * // matches  /tenant/acme/...   → tenantId='acme'
 * createTenantResolver(pathPrefixStrategy({ prefix: '/tenant/' }));
 * ```
 */
export function pathPrefixStrategy(opts?: {
  prefix?: string;
}): TenantResolverStrategy {
  const prefix = opts?.prefix ?? '/t/';
  return (event) => {
    const path = event.url.pathname;
    if (!path.startsWith(prefix)) {
      return { tenantId: null };
    }
    const rest = path.slice(prefix.length);
    const slug = rest.split('/')[0];
    return { tenantId: slug && slug.length > 0 ? slug : null };
  };
}

/**
 * Strategy: read the tenant id from a request header.
 *
 * @example
 * ```ts
 * createTenantResolver(headerStrategy({ headerName: 'x-tenant-id' }));
 * ```
 */
export function headerStrategy(opts?: {
  headerName?: string;
}): TenantResolverStrategy {
  const headerName = opts?.headerName ?? 'x-tenant-id';
  return (event) => {
    const value = event.request.headers.get(headerName);
    return { tenantId: value && value.length > 0 ? value : null };
  };
}

/**
 * Wrap any strategy into a resolver. This is a thin factory — its purpose
 * is to give consumers a single, stable entry point (`resolveTenant`) they
 * can swap by changing only the argument.
 */
export function createTenantResolver(
  strategy: TenantResolverStrategy,
): (event: TenantResolverEvent) => Promise<TenantResolution> {
  return async (event) => {
    return await strategy(event);
  };
}

/**
 * Default resolver used by `hooks.server.ts`. Swap the argument to
 * `createTenantResolver()` (or replace this export) to change strategies.
 */
export const resolveTenant = createTenantResolver(subdomainStrategy);
