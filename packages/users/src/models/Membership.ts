/**
 * Membership model - User belongs to Tenant with a Role
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { MembershipStatus } from '../types/index.js';

/**
 * Membership represents a user's membership in a tenant with an assigned role.
 *
 * A user can have only one membership per tenant (UNIQUE userId + tenantId).
 * The role determines the base permissions for the user in that tenant.
 *
 * @example
 * ```typescript
 * const membership = await memberships.create({
 *   userId: user.id,
 *   tenantId: tenant.id,
 *   roleId: role.id,
 *   status: MembershipStatus.ACTIVE
 * });
 * await membership.save();
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Membership extends SmrtObject {
  /**
   * Foreign key to User
   */
  @foreignKey('User', { required: true })
  userId?: string;

  /**
   * Foreign key to Tenant
   */
  @foreignKey('Tenant', { required: true })
  tenantId?: string;

  /**
   * Foreign key to Role - determines base permissions
   */
  @foreignKey('Role', { required: true })
  roleId?: string;

  /**
   * Membership status
   */
  @field({ type: 'text' })
  status: MembershipStatus = MembershipStatus.ACTIVE;

  constructor(options: any = {}) {
    super(options);
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.roleId !== undefined) this.roleId = options.roleId;
    if (options.status !== undefined) this.status = options.status;
  }

  /**
   * Check if membership is active
   */
  isActive(): boolean {
    return this.status === MembershipStatus.ACTIVE;
  }

  /**
   * Check if membership is pending (invitation not yet accepted)
   */
  isPending(): boolean {
    return this.status === MembershipStatus.PENDING;
  }
}
