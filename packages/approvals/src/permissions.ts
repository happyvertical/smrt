/**
 * Permission slugs contributed by `@happyvertical/smrt-approvals` to the
 * runtime permission catalog. Deciding a request is gated by the per-kind
 * slug a package passes to `defineApprovalKind`; these slugs cover the
 * package-wide operations.
 *
 * @packageDocumentation
 */

import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';

/** Cancel a pending request someone else made. */
export const CANCEL_ANY_APPROVAL_PERMISSION = 'approvals.cancel-any';

/** Write tenant approval policy rows (tighten-only). */
export const MANAGE_APPROVAL_POLICY_PERMISSION = 'approvals.manage-policy';

/** Catalog definitions for the package-wide slugs. */
export const APPROVAL_PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    slug: CANCEL_ANY_APPROVAL_PERMISSION,
    category: 'approvals',
    name: 'Cancel Any Approval Request',
    description:
      'Cancel a pending approval request made by someone else in the tenant',
  },
  {
    slug: MANAGE_APPROVAL_POLICY_PERMISSION,
    category: 'approvals',
    name: 'Manage Approval Policy',
    description:
      "Tighten an approval kind's quorum, expiry, or required permission for the tenant",
  },
];

let registered = false;

/** Register the package slugs (returns an unregister function for tests). */
export function registerApprovalPermissions(): () => void {
  return registerPermissionDefinitions(APPROVAL_PERMISSION_DEFINITIONS);
}

/** Register the package slugs once per process (package entry side effect). */
export function ensureApprovalPermissionsRegistered(): void {
  if (registered) return;
  registered = true;
  registerApprovalPermissions();
}
