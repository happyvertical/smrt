/**
 * The tenant scope the AI usage readers take (#4782, #5005): a tenant, or an
 * explicit reviewed cross-tenant read. Shared by the prompt comparison, the
 * usage and run reports, the run and evaluation listings and the trajectory
 * reader. Browser-safe: no imports.
 */

/** The read was refused before any query ran: no tenant scope was given. */
export class AiUsageScopeError extends Error {
  readonly code = 'AI_USAGE_TENANT_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'AiUsageScopeError';
  }
}

/** The tenant scope every read here takes. */
export interface AiUsageTenantScope {
  /**
   * Tenant whose usage to read; `null` reads global (tenant-less) rows.
   * Required unless `allowCrossTenant` is set.
   */
  tenantId?: string | null;
  /**
   * Reviewed cross-tenant read (operators, the CLI's `--all-tenants`):
   * without `tenantId`, rows of every tenant are read. Joins stay within each
   * row's tenant.
   */
  allowCrossTenant?: boolean;
}

export function requireAiUsageScope(
  fn: string,
  scope: AiUsageTenantScope,
): void {
  if (scope.tenantId === undefined && scope.allowCrossTenant !== true) {
    throw new AiUsageScopeError(
      `${fn}: pass tenantId (null for global rows), or allowCrossTenant: true for a reviewed cross-tenant read`,
    );
  }
  if (scope.tenantId !== undefined && scope.tenantId !== null) {
    if (typeof scope.tenantId !== 'string') {
      throw new TypeError(`${fn}: tenantId must be a string or null`);
    }
  }
}
