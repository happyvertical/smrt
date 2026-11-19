/**
 * Request tenant context hooks: what smrt-tenancy lends core so request-facing
 * code can enter the caller's tenant and read the super-admin bypass without
 * importing smrt-tenancy. Import-free, so both entries (and browser bundles
 * that include smrt-tenancy) carry it.
 */

/** The request tenant context as smrt-tenancy reports it. */
export interface RequestTenantContext {
  tenantId?: string | null;
  userId?: string | null;
  permissions?: ReadonlySet<string>;
}

/** What smrt-tenancy lends core for request-time tenancy. */
export interface RequestTenantContextHooks {
  /** Enter a tenant context for the rest of the current request. */
  enter(context: RequestTenantContext): void;
  /** The active tenant context, if any. */
  current(): RequestTenantContext | undefined;
  /**
   * Whether an active super-admin bypass applies to reads of this class:
   * the bypass flag is set, the class opts in (`allowSuperAdminBypass`), and
   * no bounded hierarchy read scope is active — the tenancy interceptor's own
   * rule.
   */
  isSuperAdminBypass(className: string): boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __smrtRequestTenantContextHooks: RequestTenantContextHooks | undefined;
}

/**
 * Install (or, with `undefined`, remove) the request tenant context hooks.
 * Called by smrt-tenancy's `enableTenancy()` / `disableTenancy()`.
 */
export function setRequestTenantContextHooks(
  hooks: RequestTenantContextHooks | undefined,
): void {
  globalThis.__smrtRequestTenantContextHooks = hooks;
}

/** The active request tenant context, or `undefined` without tenancy. */
export function getRequestTenantContext(): RequestTenantContext | undefined {
  return globalThis.__smrtRequestTenantContextHooks?.current();
}

/** Enter a request tenant context; does nothing without tenancy. */
export function enterRequestTenantContext(context: RequestTenantContext): void {
  globalThis.__smrtRequestTenantContextHooks?.enter(context);
}

/**
 * Whether an active super-admin bypass applies to reads of this class, as
 * smrt-tenancy decides it for the class (`false` without tenancy).
 */
export function isRequestSuperAdminBypass(className: string): boolean {
  return (
    globalThis.__smrtRequestTenantContextHooks?.isSuperAdminBypass(
      className,
    ) === true
  );
}
