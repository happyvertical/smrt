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
  // eslint-disable-next-line no-var
  var __smrtTenantScopedClassResolver:
    | ((className: string) => boolean)
    | undefined;
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
 * Resolved tenant scope for a DispatchBus operation.
 *
 * The DispatchBus must distinguish three states, because they have different
 * read/write semantics (S5 #1398):
 *
 * - **Tenancy disabled** (`enforced: false`): no resolver is registered. The bus
 *   applies no tenant filter and stamps no tenant id — identical to pre-tenancy
 *   behavior. This is the backward-compatibility path for non-tenant
 *   deployments and existing tests.
 * - **Tenancy enabled, active tenant** (`enforced: true`, `tenantId: T`): reads
 *   are restricted to `(tenant_id = T OR tenant_id IS NULL)` and emits stamp
 *   `tenant_id = T`.
 * - **Tenancy enabled, no active tenant** (`enforced: true`, `tenantId: null`):
 *   reads are restricted to `tenant_id IS NULL` only (global rows). This is a
 *   *fail-closed* state — when tenancy is on but no tenant context is active
 *   (e.g. processing outside `withTenant()`), reads MUST NOT leak other
 *   tenants' rows. Emits stamp `tenant_id = NULL` (global).
 *
 * Critically, `enforced: true` + `tenantId: null` is NOT collapsed into the
 * disabled state: when tenancy is enabled, a missing tenant context restricts
 * reads to global rows rather than opening up all tenants.
 */
export interface DispatchTenantScope {
  /**
   * Whether tenant enforcement is active (a resolver is registered). When
   * `false`, the bus applies no tenant filter at all (pre-tenancy behavior).
   */
  enforced: boolean;
  /**
   * The active tenant id, or `null` when there is no active tenant context.
   * Only meaningful when `enforced` is `true`.
   */
  tenantId: string | null;
}

/**
 * Resolve the active tenant scope for the current async execution scope.
 *
 * This is the trust anchor for DispatchBus tenant isolation. It distinguishes
 * "tenancy disabled" (no resolver registered → no filtering) from "tenancy
 * enabled but no active tenant" (resolver registered, returns null/undefined →
 * fail-closed to global-only reads). See {@link DispatchTenantScope}.
 *
 * @returns The resolved tenant scope.
 */
export function resolveDispatchTenantScope(): DispatchTenantScope {
  const resolver = globalThis.__smrtDispatchTenantResolver;
  if (!resolver) {
    // No resolver registered → tenancy is off. No filtering, no stamping.
    return { enforced: false, tenantId: null };
  }
  try {
    const resolved = resolver();
    return { enforced: true, tenantId: resolved ?? null };
  } catch {
    // A misbehaving resolver must never break dispatch processing. Tenancy is
    // still considered enforced (a resolver IS registered), so fail closed to
    // global-only reads rather than leaking all tenants.
    return { enforced: true, tenantId: null };
  }
}

/**
 * Resolve only the active tenant id for the current async execution scope.
 *
 * Returns `undefined` when no resolver is registered (tenancy disabled) or when
 * the resolver reports no active tenant. Prefer {@link resolveDispatchTenantScope}
 * for read-filtering decisions, which need to distinguish those two cases.
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

/**
 * Register the resolver that reports whether a class is tenant-scoped, covering
 * BOTH registration forms (S #1782). Core's `ObjectRegistry.isTenantScoped`
 * recognizes `@smrt({ tenantScoped })` and the manifest-merged `@TenantScoped()`
 * config, but the standalone `@TenantScoped()` decorator (smrt-tenancy) records
 * its config only in the tenancy registry at decoration time — invisible to core
 * until/unless a manifest carries it. Tenancy fills this slot at
 * `enableTenancy()` so core-side fail-closed guards (the generated REST read
 * scope) recognize tenant-scoped classes regardless of registration form or
 * manifest timing. Mirrors {@link setDispatchTenantResolver}.
 *
 * @param resolver - Predicate returning `true` for tenant-scoped class names, or
 *   `undefined` to clear (which `disableTenancy()` does).
 */
export function setTenantScopedClassResolver(
  resolver: ((className: string) => boolean) | undefined,
): void {
  globalThis.__smrtTenantScopedClassResolver = resolver;
}

/**
 * Whether the tenancy layer reports `className` as tenant-scoped. Returns
 * `false` when tenancy is disabled (no resolver) or the resolver throws.
 *
 * @param className - Class name (simple or qualified) to check.
 */
export function isTenantScopedClassResolved(className: string): boolean {
  const resolver = globalThis.__smrtTenantScopedClassResolver;
  if (!resolver) {
    return false;
  }
  try {
    return resolver(className) === true;
  } catch {
    return false;
  }
}
