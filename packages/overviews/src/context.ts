/**
 * The request principal an overview read or write acts as.
 *
 * Identity always comes from the ambient context, never from a request body:
 * the tenancy ALS (`withTenant`, the SvelteKit/Express adapters) first, and
 * the authenticated users session-permission ALS (`createSessionHandler()`
 * without `enterTenantContext`) as the fallback, the smrt-fields precedent.
 */
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { getCurrentSessionPermissionContext } from '@happyvertical/smrt-users';

export interface OverviewPrincipal {
  tenantId: string;
  /** Absent for service principals, API keys and background jobs. */
  userId?: string;
  permissions: ReadonlySet<string>;
  superAdminBypass: boolean;
  /** True when the tenancy ALS already carries this principal. */
  fromTenancy: boolean;
}

/** The overview principal of the current async context, if any. */
export function getOverviewPrincipal(): OverviewPrincipal | undefined {
  const tenant = getCurrentTenant();
  if (tenant?.tenantId) {
    return {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      permissions: tenant.permissions,
      superAdminBypass: isSuperAdminBypass(),
      fromTenancy: true,
    };
  }
  const session = getCurrentSessionPermissionContext();
  if (!session?.tenantId) return undefined;
  return {
    tenantId: session.tenantId,
    userId: session.userId ?? undefined,
    permissions: session.permissionSet,
    superAdminBypass: session.superAdminBypass,
    fromTenancy: false,
  };
}

/** Bounded, identifier-free denial; generated transports serialize it as 403. */
export class OverviewAccessError extends TenantIsolationError {
  readonly status = 403;
  readonly publicMessage: string;

  constructor(message: string) {
    super(message);
    this.name = 'OverviewAccessError';
    this.publicMessage = message;
  }
}

/** The principal, or a fail-closed error when there is no tenant identity. */
export function requireOverviewPrincipal(): OverviewPrincipal {
  const principal = getOverviewPrincipal();
  if (!principal) {
    throw new OverviewAccessError(
      'Overview layouts need an authenticated tenant context',
    );
  }
  return principal;
}

/**
 * Run `fn` with the tenancy ALS carrying `principal`. A session-only
 * principal is entered as a tenant context with the same tenant, user and
 * permissions, so the tenancy interceptor scopes the table exactly as it would
 * under the tenancy adapter. Nothing is widened.
 */
export async function withPrincipal<T>(
  principal: OverviewPrincipal,
  fn: () => Promise<T>,
): Promise<T> {
  if (principal.fromTenancy) return fn();
  return withTenant(
    {
      tenantId: principal.tenantId,
      userId: principal.userId,
      permissions: new Set(principal.permissions),
    },
    fn,
  );
}
