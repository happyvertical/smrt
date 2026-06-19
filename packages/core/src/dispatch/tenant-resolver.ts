/**
 * DispatchBus tenant resolver — dependency-inversion hook
 *
 * `@happyvertical/smrt-core` cannot depend on `@happyvertical/smrt-tenancy`
 * (tenancy depends on core, not the other way around). To let the DispatchBus
 * stamp and filter dispatches by the active tenant without creating a circular
 * dependency, core exposes an injectable resolver slot that tenancy fills at
 * `enableTenancy()` time — the same inversion pattern used by
 * {@link GlobalInterceptors}.
 *
 * When tenancy is not enabled (non-tenant deployments, existing tests), the
 * resolver defaults to a no-op that returns `undefined`, so the DispatchBus
 * behaves exactly as before: no tenant column is stamped and no tenant filter
 * is applied.
 *
 * Stored on `globalThis` so all module instances share one resolver, which is
 * critical in the monorepo where the same package can be loaded from multiple
 * paths (mirrors {@link ObjectRegistry} / {@link GlobalInterceptors}).
 */

/**
 * Resolver function that returns the active tenant id for the current async
 * execution scope, or `undefined`/`null` when there is no tenant context
 * (system/global scope).
 */
export type DispatchTenantResolver = () => string | null | undefined;

declare global {
  // eslint-disable-next-line no-var
  var __smrtDispatchTenantResolver: DispatchTenantResolver | undefined;
}

/**
 * Register the tenant resolver the DispatchBus uses to derive the active
 * tenant id on emit/subscribe/process.
 *
 * Called by `@happyvertical/smrt-tenancy`'s `enableTenancy()`; application
 * code never needs to call this directly. Passing `undefined` clears the
 * resolver (restoring the no-op default), which `disableTenancy()` does.
 *
 * @param resolver - Function returning the active tenant id, or `undefined` to
 *   clear and fall back to the no-op default.
 */
export function setDispatchTenantResolver(
  resolver: DispatchTenantResolver | undefined,
): void {
  globalThis.__smrtDispatchTenantResolver = resolver;
}

/**
 * Resolve the active tenant id for the current async execution scope.
 *
 * Returns `undefined` when no resolver is registered (tenancy disabled) or when
 * the resolver reports no active tenant. The DispatchBus treats `undefined` as
 * "no tenant context" and skips all tenant stamping/filtering, preserving the
 * pre-tenancy behavior for non-tenant deployments.
 *
 * @returns The active tenant id, or `undefined`/`null` when there is no tenant
 *   scope.
 */
export function resolveDispatchTenantId(): string | null | undefined {
  const resolver = globalThis.__smrtDispatchTenantResolver;
  if (!resolver) {
    return undefined;
  }
  try {
    return resolver();
  } catch {
    // A misbehaving resolver must never break dispatch emission; treat a
    // throwing resolver as "no tenant context".
    return undefined;
  }
}
