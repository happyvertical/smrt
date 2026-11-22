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

/** A tenant context to enter: always names its tenant. */
export interface EnterRequestTenantContext {
  tenantId: string;
  userId?: string;
  permissions?: ReadonlySet<string>;
}

/** What smrt-tenancy lends core for request-time tenancy. */
export interface RequestTenantContextHooks {
  /** Enter a tenant context for the rest of the current request. */
  enter(context: EnterRequestTenantContext): void;
  /** The active tenant context, if any. */
  current(): RequestTenantContext | undefined;
  /**
   * Run `fn` inside a tenant context that ends with it (one sync item, one
   * tool call). Without it, `fn` runs in the current context.
   */
  run?<T>(context: EnterRequestTenantContext, fn: () => Promise<T>): Promise<T>;
  /**
   * Whether an active super-admin bypass applies to reads of this class:
   * the bypass flag is set, the class opts in (`allowSuperAdminBypass`), and
   * no bounded hierarchy read scope is active — the tenancy interceptor's own
   * rule. `false` while tenancy is not enabled.
   */
  isSuperAdminBypass(className: string): boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __smrtRequestTenantContextHooks: RequestTenantContextHooks | undefined;
}

/**
 * Install (or, with `undefined`, remove) the request tenant context hooks.
 * smrt-tenancy installs them when it is loaded, enabled or not: the tenant
 * context is its context store, which a request carries for code that reads
 * it (a complete principal, `api.principalContext`) whether or not rows are
 * scoped. `enableTenancy()` adds the super-admin bypass rule.
 */
export function setRequestTenantContextHooks(
  hooks: RequestTenantContextHooks | undefined,
): void {
  globalThis.__smrtRequestTenantContextHooks = hooks;
}

/**
 * The active request tenant context, or `undefined` when none is active or
 * smrt-tenancy is not loaded.
 */
export function getRequestTenantContext(): RequestTenantContext | undefined {
  return globalThis.__smrtRequestTenantContextHooks?.current();
}

/**
 * Enter a request tenant context; does nothing when smrt-tenancy is not
 * loaded.
 *
 * Throws `TypeError`, before any context changes, unless `tenantId` is a
 * non-empty string: a context without a tenant would read as an active one,
 * so required-mode reads would be scoped to rows without an owner instead of
 * being refused.
 */
export function enterRequestTenantContext(
  context: EnterRequestTenantContext,
): void {
  const tenantId = (context as { tenantId?: unknown } | null | undefined)
    ?.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new TypeError(
      'enterRequestTenantContext requires a non-empty string tenantId',
    );
  }
  globalThis.__smrtRequestTenantContextHooks?.enter(context);
}

/**
 * Run `fn` inside a request tenant context that ends with it; `fn` runs in
 * the current context when smrt-tenancy is not loaded.
 */
export function runInRequestTenantContext<T>(
  context: EnterRequestTenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  const hooks = globalThis.__smrtRequestTenantContextHooks;
  return hooks?.run ? hooks.run(context, fn) : fn();
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
