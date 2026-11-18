/**
 * Transport kernel: principal resolution (#5158). Owned by K2.
 *
 * A principal is built once per request from host-controlled state. Request
 * bodies, query strings and tool arguments are never an identity source.
 */
import { notImplemented } from './not-implemented.js';
import type { Principal, TransportProfile } from './types.js';

/** Host context of an in-process generator (`APIContext`, `MCPContext`). */
export interface PrincipalContextSource {
  readonly user?: { readonly id: string } | null;
  readonly tenantId?: string | null;
  readonly permissions?: Iterable<string> | null;
  readonly allowCrossTenant?: boolean;
}

/**
 * Build a principal from SvelteKit `locals`.
 *
 * Contract:
 * - Authenticated only for an object-shaped `locals.user` or `locals.session`,
 *   or `locals.smrtAuth === true`. A callable `locals.auth` is not a signal.
 * - Tenant from `locals.tenantId`, then `user`, `session`, `tenantContext`.
 * - Operation permissions from `permissions`, `permissionSet`,
 *   `smrtPermissions` and `tenantContext.permissions`; a
 *   `tenantContext.superAdminBypass` of `true` yields `'all'`.
 * - Field permissions are resolved separately (see `Principal`).
 * - Sources that disagree about the tenant or user fail closed.
 * - While `profile` sections are present, reads exactly the sources that
 *   transport reads today.
 */
export function principalFromLocals(
  _locals: unknown,
  _profile?: Partial<TransportProfile>,
): Principal {
  return notImplemented('principalFromLocals', 'K2');
}

/**
 * Build a principal from a generator's construction-time context.
 *
 * Contract: authenticated when `user` is present; permissions and field
 * permissions both come from `permissions`; `allowCrossTenant` is copied only
 * when it is exactly `true`.
 */
export function principalFromContext(
  _context: PrincipalContextSource,
  _profile?: Partial<TransportProfile>,
): Principal {
  return notImplemented('principalFromContext', 'K2');
}

/**
 * Build the principal of an emitted stdio MCP server from its environment.
 *
 * Contract: tenant from `SMRT_MCP_TENANT_ID`, user from `SMRT_MCP_USER_ID`,
 * field permissions from the comma-separated `SMRT_MCP_PERMISSIONS`,
 * cross-tenant only when `SMRT_MCP_ALLOW_CROSS_TENANT` is exactly `true`. The
 * process is the trust boundary, so operation permissions are `'all'`.
 */
export function principalFromEnv(
  _env?: Readonly<Record<string, string | undefined>>,
): Principal {
  return notImplemented('principalFromEnv', 'K2');
}
