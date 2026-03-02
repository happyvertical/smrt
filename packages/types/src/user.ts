/**
 * User-related type definitions
 *
 * These enums and types are exported from smrt-types to allow
 * browser-safe packages (like smrt-svelte) to import them without
 * pulling in server-side dependencies from smrt-users.
 */

// ============= User Status =============

/**
 * Lifecycle status of a user account.
 *
 * @example
 * ```typescript
 * if (user.status === UserStatus.SUSPENDED) {
 *   throw new ForbiddenError('Account is suspended');
 * }
 * ```
 *
 * @see {@link MembershipStatus} for a user's status within a specific tenant
 * @see {@link SessionStatus} for the status of an active session
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
 * Lifecycle status of a tenant (organization) within the platform.
 *
 * @example
 * ```typescript
 * if (tenant.status === TenantStatus.ARCHIVED) {
 *   return; // skip soft-deleted tenants
 * }
 * ```
 *
 * @see {@link MembershipStatus} for a user's membership status within a tenant
 * @see {@link TenantPermissionEffect} for permission inheritance across tenant hierarchies
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
 * Status of a user's membership within a specific tenant.
 *
 * A user may hold memberships in multiple tenants simultaneously, each with an
 * independent `MembershipStatus`.
 *
 * @example
 * ```typescript
 * const active = memberships.filter(m => m.status === MembershipStatus.ACTIVE);
 * ```
 *
 * @see {@link UserStatus} for the global account-level status
 * @see {@link TenantStatus} for the status of the tenant itself
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
 * Status of an authenticated session.
 *
 * Sessions transition from `ACTIVE` to either `EXPIRED` (time-based) or
 * `REVOKED` (explicit action by the user or an administrator).
 *
 * @example
 * ```typescript
 * if (session.status !== SessionStatus.ACTIVE) {
 *   redirect(302, '/login');
 * }
 * ```
 *
 * @see {@link UserStatus} for the account-level status checked before session creation
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
 * Effect applied by a user-level permission override.
 *
 * Overrides target a specific user + permission combination and always win
 * over role-based grants. `DENY` overrides are checked before `GRANT` in
 * the 4-level permission cascade.
 *
 * @example
 * ```typescript
 * await override.create({
 *   userId,
 *   permission: 'billing.view',
 *   effect: OverrideEffect.DENY,
 * });
 * ```
 *
 * @see {@link TenantPermissionEffect} for the tenant-level equivalent that supports inheritance
 */
export enum OverrideEffect {
  /** Grant the permission */
  GRANT = 'grant',
  /** Deny the permission */
  DENY = 'deny',
}

// ============= Tenant Permission Override =============

/**
 * Effect of a tenant-level permission setting in a hierarchical tenant tree.
 *
 * Unlike `OverrideEffect`, tenant-level effects support `INHERIT` — the default
 * behaviour where a child tenant walks up to its parent to resolve the permission.
 * `DENY` blocks inheritance, preventing child tenants from acquiring the permission
 * even if a grandparent grants it.
 *
 * @example
 * ```typescript
 * // Sub-tenant explicitly blocks billing access regardless of parent settings
 * await tenantPermission.create({
 *   tenantId: subTenantId,
 *   permission: 'billing.manage',
 *   effect: TenantPermissionEffect.DENY,
 * });
 * ```
 *
 * @see {@link OverrideEffect} for user-level overrides (no inheritance step)
 * @see {@link TenantStatus} for the tenant lifecycle status
 */
export enum TenantPermissionEffect {
  /** Inherit from parent tenant (default behavior) */
  INHERIT = 'inherit',
  /** Explicitly grant at this tenant level */
  GRANT = 'grant',
  /** Explicitly deny at this tenant level (blocks inheritance) */
  DENY = 'deny',
}
