/**
 * Type definitions for smrt-users
 * @packageDocumentation
 */

// ============= User Status =============

/**
 * User account status
 */
export enum UserStatus {
  /** Active user account */
  ACTIVE = 'active',
  /** Inactive user account */
  INACTIVE = 'inactive',
  /** Suspended user account */
  SUSPENDED = 'suspended',
  /** Pending email verification */
  PENDING = 'pending',
}

// ============= Tenant Status =============

/**
 * Tenant (organization) status
 */
export enum TenantStatus {
  /** Active tenant */
  ACTIVE = 'active',
  /** Inactive tenant */
  INACTIVE = 'inactive',
  /** Suspended tenant */
  SUSPENDED = 'suspended',
}

// ============= Membership Status =============

/**
 * User membership status within a tenant
 */
export enum MembershipStatus {
  /** Active membership */
  ACTIVE = 'active',
  /** Inactive membership */
  INACTIVE = 'inactive',
  /** Pending invitation acceptance */
  PENDING = 'pending',
}

// ============= Permission Override =============

/**
 * Effect of a permission override
 */
export enum OverrideEffect {
  /** Grant the permission */
  GRANT = 'grant',
  /** Deny the permission */
  DENY = 'deny',
}

// ============= Default System Roles =============

/**
 * Default system role slugs
 */
export const DEFAULT_ROLE_SLUGS = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
  VIEWER: 'viewer',
} as const;

/**
 * Default system roles configuration
 */
export const DEFAULT_ROLES = [
  {
    slug: DEFAULT_ROLE_SLUGS.OWNER,
    name: 'Owner',
    description: 'Full access to all resources',
  },
  {
    slug: DEFAULT_ROLE_SLUGS.ADMIN,
    name: 'Administrator',
    description: 'Manage users and settings',
  },
  {
    slug: DEFAULT_ROLE_SLUGS.MEMBER,
    name: 'Member',
    description: 'Standard access',
  },
  {
    slug: DEFAULT_ROLE_SLUGS.VIEWER,
    name: 'Viewer',
    description: 'Read-only access',
  },
] as const;

export type DefaultRoleSlug =
  (typeof DEFAULT_ROLE_SLUGS)[keyof typeof DEFAULT_ROLE_SLUGS];

// ============= Tenant Policy =============

/**
 * Tenant policy mode
 *
 * - `flexible`: No tenant created on signup, user can have zero tenants
 * - `personal`: Auto-create personal tenant on first login, can delete all
 * - `required`: Auto-create personal tenant, must keep at least one
 */
export type TenantPolicyMode = 'flexible' | 'personal' | 'required';

/**
 * Tenant policy configuration
 *
 * Set in smrt.config.js to control tenant creation behavior
 */
export interface TenantPolicy {
  /** Policy mode */
  mode: TenantPolicyMode;

  /** Maximum tenants per user (0 = unlimited) */
  maxTenants: number;

  /** Name for auto-created default tenant */
  defaultName: string;
}

/**
 * Default tenant policy (flexible, unlimited)
 */
export const DEFAULT_TENANT_POLICY: TenantPolicy = {
  mode: 'flexible',
  maxTenants: 0,
  defaultName: 'Default Workspace',
};
