/**
 * Direct-membership permission resolution for bearer principals (#3413
 * review F1). A bearer bound to a tenant is authorized only by its own
 * active membership row in exactly that tenant. The row is pinned into
 * `PermissionResolver`, so ancestor-membership inheritance (which the
 * resolver considers only when no direct row exists) can never stand in for
 * a deleted or missing membership.
 *
 * @internal
 */

import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type {
  MembershipCollection,
  PermissionResolver,
} from '@happyvertical/smrt-users';

/** The pinned direct membership and the live permissions it grants. */
export interface DirectMembershipPermissions {
  readonly membershipId: string;
  readonly permissions: ReadonlySet<string>;
}

/**
 * Resolve `userId`'s live permissions in `tenantId` from its active direct
 * membership, or `null` when there is no such row (deleted, suspended,
 * pending, or only inherited authority).
 */
export async function resolveDirectMembershipPermissions(options: {
  readonly memberships: MembershipCollection;
  readonly resolver: PermissionResolver;
  readonly userId: string;
  readonly tenantId: string;
}): Promise<DirectMembershipPermissions | null> {
  const { memberships, resolver, userId, tenantId } = options;
  // Keyed by the explicit user and tenant only; the ambient (cookie) tenant
  // filter must not hide or substitute the row.
  const membership = await withSystemContext(() =>
    memberships.findByUserAndTenant(userId, tenantId),
  );
  if (
    !membership?.id ||
    membership.userId !== userId ||
    membership.tenantId !== tenantId ||
    !membership.isActive()
  ) {
    return null;
  }
  const resolved = await resolver.resolvePermissions(userId, tenantId, {
    membership,
  });
  if (
    resolved.membershipId !== membership.id ||
    resolved.inheritedFromTenantId !== null
  ) {
    return null;
  }
  return { membershipId: membership.id, permissions: resolved.permissions };
}
