/**
 * Tenant entry-point gate — dependency-inversion hook for generated CLI/MCP
 * execution (#1554).
 *
 * `@happyvertical/smrt-core` cannot depend on `@happyvertical/smrt-tenancy`
 * (tenancy depends on core, not the other way around). The generated SvelteKit
 * routes establish tenant context from the request principal, but the in-process
 * CLI/MCP generators have no principal — without a gate a tenant-scoped read
 * with no active context would fall through the interceptor's optional-mode
 * pass-through and return rows across **all** tenants.
 *
 * Core exposes an injectable runner slot that tenancy fills at `enableTenancy()`
 * time (the same inversion pattern as the DispatchBus tenant resolver and
 * `GlobalInterceptors`). When tenancy is not enabled (non-tenant deployments,
 * existing tests), the slot is empty and {@link runWithTenantGate} simply runs
 * the body — identical to pre-#1554 behavior.
 *
 * Stored on `globalThis` so all module instances share one runner, which
 * matters in the monorepo where the same package can be loaded from multiple
 * paths.
 */

/** Options forwarded to the registered tenancy runner. */
export interface TenantGateOptions {
  /**
   * Class name of the target model. Tenant-scoping is resolved authoritatively
   * inside tenancy (`isTenantScopedClass`) — the same source the interceptor
   * uses, so it covers both `@TenantScoped` and `@smrt({ tenantScoped })`.
   */
  className?: string;
  /** Explicit tenant-scoping decision; overrides `className` resolution. */
  tenantScoped?: boolean;
  /** Explicit operator-provided tenant selector (`--tenant` / `context.tenantId`). */
  tenantId?: string | null;
  /** Explicit operator opt-in to cross-tenant/system access (`--all-tenants`). */
  allowCrossTenant?: boolean;
  /** Surface name for the fail-closed error message, e.g. `'CLI'` / `'MCP'`. */
  surface?: string;
}

/**
 * Runner that establishes (or fail-closes) tenant context around `fn` for a
 * tenant-scoped model. Registered by tenancy; see
 * `runTenantScopedEntryPoint` in `@happyvertical/smrt-tenancy`.
 */
export type TenantEntryPointRunner = <T>(
  options: TenantGateOptions,
  fn: () => Promise<T>,
) => Promise<T>;

declare global {
  // eslint-disable-next-line no-var
  var __smrtTenantEntryPointRunner: TenantEntryPointRunner | undefined;
}

/**
 * Register the tenant entry-point runner used by generated CLI/MCP execution.
 *
 * Called by `@happyvertical/smrt-tenancy`'s `enableTenancy()`; application code
 * never calls this directly. Passing `undefined` clears the runner (restoring
 * the no-op default), which `disableTenancy()` does.
 *
 * @param runner - The tenancy runner, or `undefined` to clear it.
 */
export function setTenantEntryPointRunner(
  runner: TenantEntryPointRunner | undefined,
): void {
  globalThis.__smrtTenantEntryPointRunner = runner;
}

/**
 * Run `fn` through the registered tenant entry-point runner (when tenancy is
 * enabled), or directly when no runner is registered.
 *
 * For tenant-scoped models the runner establishes tenant context from
 * `options.tenantId` / `options.allowCrossTenant`, or fails closed (throws) when
 * neither is available — never silently reading across tenants. Non-scoped
 * models and tenancy-off deployments pass straight through.
 *
 * @param options - {@link TenantGateOptions}.
 * @param fn - The command/tool body to execute.
 * @returns The resolved value of `fn`.
 * @throws Propagates the tenancy runner's `TenantContextError` on the
 *   fail-closed branch.
 */
export async function runWithTenantGate<T>(
  options: TenantGateOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const runner = globalThis.__smrtTenantEntryPointRunner;
  if (!runner) {
    // Tenancy not enabled → single-/no-tenant deployment, pass through.
    return fn();
  }
  return runner(options, fn);
}
