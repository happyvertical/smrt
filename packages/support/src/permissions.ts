/**
 * Custom permission slugs contributed by `@happyvertical/smrt-support` to the
 * runtime permission catalog (the `personas.activate-directive` pattern).
 *
 * The privileged operations are permission splits, not bespoke checks:
 * - `support.reassign-case` — manual reassignment despite routing (FR-30).
 * - `support.approve-time-entry` — accept a Service Time Entry and derive its
 *   commercial snapshots (FR-36) via the operator path.
 * - `support.manage-plans` — administer Managed Support Plans and Support
 *   Compensation Plans.
 */

import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';

/** Authorizes manual case reassignment overriding automatic routing. */
export const REASSIGN_CASE_PERMISSION = 'support.reassign-case';

/** Authorizes operator approval/rejection of Service Time Entries. */
export const APPROVE_TIME_ENTRY_PERMISSION = 'support.approve-time-entry';

/** Authorizes plan administration (support + compensation plans). */
export const MANAGE_PLANS_PERMISSION = 'support.manage-plans';

export const SUPPORT_PERMISSION_DEFS: PermissionDefinition[] = [
  {
    slug: REASSIGN_CASE_PERMISSION,
    category: 'support',
    name: 'Reassign Support Case',
    description:
      'Manually reassign a Support Case to a specialist, overriding automatic routing',
  },
  {
    slug: APPROVE_TIME_ENTRY_PERMISSION,
    category: 'support',
    name: 'Approve Service Time Entry',
    description:
      'Approve or reject submitted Service Time Entries and finalize their charge/compensation snapshots',
  },
  {
    slug: MANAGE_PLANS_PERMISSION,
    category: 'support',
    name: 'Manage Support Plans',
    description:
      'Create and edit Managed Support Plans and Support Compensation Plans',
  },
];

/**
 * An actor whose authority is expressed as held permission slugs. Minimal on
 * purpose — the gate depends on the permission model only (personas idiom).
 */
export interface SupportPrincipal {
  /** Stable id recorded as the acting reviewer/assigner. */
  readonly id?: string;
  /** Tenant the authority was resolved for (cross-tenant acts are refused). */
  readonly tenantId?: string;
  can(slug: string): boolean;
}

/** Build a {@link SupportPrincipal} from explicit granted slugs. */
export function supportPrincipalFromPermissions(
  permissions: Iterable<string>,
  options: { id?: string; tenantId?: string } = {},
): SupportPrincipal {
  const granted = new Set(permissions);
  return {
    id: options.id,
    tenantId: options.tenantId,
    can: (slug: string) => granted.has(slug),
  };
}

let supportPermissionsRegistered = false;

/** Register the support permissions (returns an unregister fn for tests). */
export function registerSupportPermissions(): () => void {
  return registerPermissionDefinitions(SUPPORT_PERMISSION_DEFS);
}

/**
 * Register the support permissions once per process. Called as a package
 * entry side effect so any consumer sees the slugs in the catalog.
 */
export function ensureSupportPermissionsRegistered(): void {
  if (supportPermissionsRegistered) {
    return;
  }
  supportPermissionsRegistered = true;
  registerSupportPermissions();
}
