/**
 * SvelteKit Adapter for smrt-tenancy
 *
 * Provides a SvelteKit Handle that sets up tenant context for each request.
 *
 * @example
 * ```typescript
 * // hooks.server.ts
 * import { createSvelteKitHandle } from '@happyvertical/smrt-tenancy/adapters';
 *
 * export const handle = createSvelteKitHandle({
 *   resolveTenantId: async (event) => {
 *     // From subdomain
 *     const host = event.request.headers.get('host');
 *     const subdomain = host?.split('.')[0];
 *     return subdomain;
 *
 *     // Or from header
 *     // return event.request.headers.get('x-tenant-id');
 *
 *     // Or from cookie
 *     // return event.cookies.get('tenant_id');
 *   }
 * });
 * ```
 */

import { type TenantContextData, withTenant } from '../context.js';

/**
 * SvelteKit RequestEvent (minimal interface to avoid direct dependency)
 */
interface SvelteKitEvent {
  request: Request;
  url: URL;
  cookies: {
    get(name: string): string | undefined;
    set(name: string, value: string, opts?: unknown): void;
  };
  locals: Record<string, unknown>;
}

/**
 * SvelteKit resolve function
 */
type SvelteKitResolve = (event: SvelteKitEvent) => Promise<Response>;

/**
 * Options for the SvelteKit handle
 */
export interface SvelteKitHandleOptions {
  /**
   * Resolve tenant ID from the request
   *
   * Return the tenant ID string, or null/undefined if no tenant context should be set.
   */
  resolveTenantId: (
    event: SvelteKitEvent,
  ) => Promise<string | null | undefined> | string | null | undefined;

  /**
   * Resolve user ID from the request (optional)
   */
  resolveUserId?: (
    event: SvelteKitEvent,
  ) => Promise<string | null | undefined> | string | null | undefined;

  /**
   * Resolve permissions for the user in this tenant (optional)
   */
  resolvePermissions?: (
    event: SvelteKitEvent,
    tenantId: string,
    userId?: string,
  ) => Promise<Set<string>> | Set<string>;

  /**
   * Check if user is a super admin (optional)
   * If true and super admin bypass is enabled on the class, tenant filtering is skipped.
   */
  isSuperAdmin?: (
    event: SvelteKitEvent,
    tenantId: string,
    userId?: string,
  ) => Promise<boolean> | boolean;

  /**
   * Called when no tenant ID could be resolved
   * Return a Response to short-circuit, or undefined to continue without tenant context.
   */
  onNoTenant?: (
    event: SvelteKitEvent,
  ) => Promise<Response | undefined> | Response | undefined;

  /**
   * Paths to exclude from tenant context (e.g., public APIs, health checks)
   * Supports glob patterns.
   */
  excludePaths?: string[];
}

/**
 * Create a SvelteKit Handle for tenant context
 *
 * @param options - Configuration options
 * @returns SvelteKit Handle function
 */
export function createSvelteKitHandle(options: SvelteKitHandleOptions) {
  const {
    resolveTenantId,
    resolveUserId,
    resolvePermissions,
    isSuperAdmin,
    onNoTenant,
    excludePaths = [],
  } = options;

  return async function handle({
    event,
    resolve,
  }: {
    event: SvelteKitEvent;
    resolve: SvelteKitResolve;
  }): Promise<Response> {
    // Check excluded paths
    const path = event.url.pathname;
    if (excludePaths.some((pattern) => matchPath(path, pattern))) {
      return resolve(event);
    }

    // Resolve tenant ID
    const tenantId = await resolveTenantId(event);

    if (!tenantId) {
      // No tenant ID - call handler or continue without context
      if (onNoTenant) {
        const response = await onNoTenant(event);
        if (response) {
          return response;
        }
      }
      return resolve(event);
    }

    // Resolve optional context data
    const userId = resolveUserId ? await resolveUserId(event) : undefined;
    const permissions = resolvePermissions
      ? await resolvePermissions(event, tenantId, userId ?? undefined)
      : new Set<string>();
    const superAdminBypass = isSuperAdmin
      ? await isSuperAdmin(event, tenantId, userId ?? undefined)
      : false;

    // Build context
    const context: TenantContextData = {
      tenantId,
      userId: userId ?? undefined,
      permissions,
      superAdminBypass,
    };

    // Store in locals for access in load functions
    event.locals.tenantContext = context;
    event.locals.tenantId = tenantId;

    // Run request in tenant context
    return withTenant(context, () => resolve(event));
  };
}

/**
 * Simple glob pattern matching for paths
 */
function matchPath(path: string, pattern: string): boolean {
  // Convert glob to regex
  const regexPattern = pattern
    .replace(/\*/g, '.*')
    .replace(/\//g, '\\/')
    .replace(/\?/g, '.');

  return new RegExp(`^${regexPattern}$`).test(path);
}
