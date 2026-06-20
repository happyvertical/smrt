/**
 * Fail-closed tenant-context establishment for non-web entry points (#1554).
 *
 * The SvelteKit/Express adapters establish tenant context from the authenticated
 * request principal, so the web surface of a `@TenantScoped({ mode: 'optional' })`
 * model never reads across tenants without an active context. The generated
 * **CLI** and **MCP** entry points have no request principal, so an invocation
 * with no active context would fall through the interceptor's optional-mode
 * pass-through and return rows across **all** tenants.
 *
 * `runTenantScopedEntryPoint()` closes that gap. It is the single fail-closed
 * gate both generated surfaces wrap their per-command/per-tool execution in.
 *
 * @see createCliContext for the richer CLI runner (resolveTenantId, super-admin).
 */

import {
  hasTenantContext,
  TenantContextError,
  withSystemContext,
  withTenant,
} from './context.js';
import { isTenancyEnabled } from './interceptor.js';
import { isTenantScopedClass } from './registry.js';

/**
 * Inputs for {@link runTenantScopedEntryPoint}.
 *
 * Provide **either** `className` (the gate resolves tenant-scoping from the
 * authoritative tenancy registry — the same source the interceptor uses, so it
 * covers both `@TenantScoped` and `@smrt({ tenantScoped })` registrations) or an
 * explicit `tenantScoped` boolean (when the caller already resolved it, e.g. a
 * build-time generated surface). An explicit boolean wins when both are given.
 */
export interface TenantEntryPointOptions {
  /**
   * Class name of the target model. When provided, tenant-scoping is resolved
   * via `isTenantScopedClass(className)`.
   */
  className?: string;

  /**
   * Explicit tenant-scoping decision. Overrides `className` resolution when set.
   * Non-scoped models always pass through unchanged — the gate is a no-op.
   */
  tenantScoped?: boolean;

  /**
   * Explicit operator-provided tenant selector (CLI `--tenant <id>`, MCP
   * `context.tenantId`). When present (and no context is already active) the
   * function runs inside this tenant's context.
   */
  tenantId?: string | null;

  /**
   * Explicit operator opt-in to cross-tenant / system access (CLI
   * `--all-tenants`, an MCP host that trusts the caller as an operator). When
   * set the function runs in system context, bypassing tenant filtering.
   *
   * @default false
   */
  allowCrossTenant?: boolean;

  /**
   * Human-facing surface name used in the fail-closed error message, e.g.
   * `'CLI'` or `'MCP'`.
   *
   * @default 'entry point'
   */
  surface?: string;
}

/**
 * Run `fn` inside an appropriate tenant context for a generated CLI/MCP entry
 * point, failing closed for tenant-scoped models when no authorized context can
 * be established.
 *
 * Resolution order (tenant-scoped models only):
 * 1. A context is already active (e.g. an upstream tenancy handle) → reuse it.
 * 2. `allowCrossTenant` was explicitly set → run in system context. Checked
 *    before `tenantId` so an explicit cross-tenant opt-in wins over a default
 *    principal/host tenant rather than being silently scoped.
 * 3. An explicit `tenantId` was provided → run inside that tenant.
 * 4. Tenancy is enabled but none of the above → **throw** `TenantContextError`
 *    (the fail-closed branch — never silently read across tenants).
 * 5. Tenancy is disabled (single-/no-tenant deployment) → pass through.
 *
 * Non-tenant-scoped models always pass straight through.
 *
 * @param options - {@link TenantEntryPointOptions}.
 * @param fn - The command/tool body to execute.
 * @returns The resolved value of `fn`.
 * @throws {TenantContextError} When a tenant-scoped model is reached with
 *   tenancy enabled and no tenant/cross-tenant selector.
 */
export async function runTenantScopedEntryPoint<T>(
  options: TenantEntryPointOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const {
    className,
    tenantScoped,
    tenantId,
    allowCrossTenant = false,
    surface = 'entry point',
  } = options;

  // Resolve tenant-scoping: an explicit boolean wins; otherwise consult the
  // authoritative tenancy registry by class name (matches the interceptor).
  const scoped =
    typeof tenantScoped === 'boolean'
      ? tenantScoped
      : className
        ? isTenantScopedClass(className)
        : false;

  // Non-scoped models, or an already-established context, run as-is.
  if (!scoped) return fn();
  if (hasTenantContext()) return fn();

  // Explicit operator opt-in to cross-tenant access. Checked before the tenant
  // selector so a deliberate `--all-tenants` / `allowCrossTenant` overrides a
  // default host/principal tenant instead of being silently scoped to it.
  if (allowCrossTenant) {
    return withSystemContext(fn);
  }

  // Explicit tenant selector.
  if (typeof tenantId === 'string' && tenantId) {
    return withTenant({ tenantId }, fn);
  }

  // Fail closed: tenancy is on but the caller gave us nothing to scope by.
  if (isTenancyEnabled()) {
    throw new TenantContextError(
      `Tenant context required for tenant-scoped access via ${surface}. ` +
        'Pass an explicit tenant (e.g. --tenant <id> / a tenantId) or opt into ' +
        'cross-tenant access (e.g. --all-tenants) to read across all tenants.',
    );
  }

  // Tenancy disabled → single-tenant deployment, pass through.
  return fn();
}
