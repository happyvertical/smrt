/**
 * User-related type definitions
 *
 * These enums and types are exported from smrt-types to allow
 * browser-safe packages (like smrt-svelte) to import them without
 * pulling in server-side dependencies from smrt-users.
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
  /** Archived tenant (soft-deleted) */
  ARCHIVED = 'archived',
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

// ============= Session Status =============

/**
 * Session status
 */
export enum SessionStatus {
  /** Active session */
  ACTIVE = 'active',
  /** Expired session (past expiresAt) */
  EXPIRED = 'expired',
  /** Revoked by user or admin */
  REVOKED = 'revoked',
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
