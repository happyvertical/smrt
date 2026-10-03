/**
 * Tenant-binding permission resolution for bearer principals (#3413 review
 * F1, I1). The authentication adapter states how a principal's tenant
 * authority may be established:
 *
 * - `direct`: only the principal's own active membership row in exactly its
 *   tenant (local owner tokens, the default hosted resolver).
 * - `direct-or-inherited`: the session step's rule
 *   ({@link isSessionTenantAuthorized}): that direct row, or, when no direct
 *   row exists at all, authority inherited from an active inheritable
 *   ancestor membership (hosted application-owned mappings).
 *
 * The direct row, when it exists, is pinned into `PermissionResolver`, so
 * inheritance never substitutes for a suspended or pending direct row; in
 * `direct` mode it never substitutes for a deleted one either.
 *
 * @internal
 */

import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type {
  MembershipCollection,
  PermissionResolver,
} from '@happyvertical/smrt-users';
import { isSessionTenantAuthorized } from './deployed-runtime.js';

/** How a bound principal's tenant authority may be established. */
export type TenantBindingMode = 'direct' | 'direct-or-inherited';

/** The authorizing membership and the live permissions it grants. */
export interface BoundMembershipPermissions {
  readonly membershipId: string;
  readonly inheritedFromTenantId: string | null;
  readonly permissions: ReadonlySet<string>;
}

/**
 * Resolve `userId`'s live permissions in `tenantId` under `binding`, or
 * `null` when that mode does not authorize the principal there.
 */
export async function resolveBoundMembershipPermissions(options: {
  readonly memberships: MembershipCollection;
  readonly resolver: PermissionResolver;
  readonly userId: string;
  readonly tenantId: string;
  readonly binding: TenantBindingMode;
}): Promise<BoundMembershipPermissions | null> {
  const { memberships, resolver, userId, tenantId, binding } = options;
  // Keyed by the explicit user and tenant only; the ambient (cookie) tenant
  // filter must not hide or substitute the row.
  const direct = await withSystemContext(() =>
    memberships.findByUserAndTenant(userId, tenantId),
  );
  if (direct) {
    if (
      direct.userId !== userId ||
      direct.tenantId !== tenantId ||
      !direct.isActive()
    ) {
      return null;
    }
  } else if (binding !== 'direct-or-inherited') {
    return null;
  }
  // Pin the raw lookup: a direct row authorizes alone; `null` asserts that
  // no direct row exists and lets the resolver consider inheritance.
  const resolved = await resolver.resolvePermissions(userId, tenantId, {
    membership: direct ?? null,
  });
  const authorized = isSessionTenantAuthorized({
    membership: direct ?? null,
    tenantAuthorization: {
      membershipId: resolved.membershipId,
      inheritedFromTenantId: resolved.inheritedFromTenantId,
    },
  });
  if (!authorized || !resolved.membershipId) return null;
  return {
    membershipId: resolved.membershipId,
    inheritedFromTenantId: resolved.inheritedFromTenantId,
    permissions: resolved.permissions,
  };
}
