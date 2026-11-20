/**
 * Membership model - User belongs to Tenant with a Role
 * @packageDocumentation
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { Membership as MembershipContract } from '@happyvertical/smrt-types';
import { MembershipStatus } from '../types/index.js';

/**
 * Constructor options for {@link Membership}.
 */
export interface MembershipOptions extends SmrtObjectOptions {
  userId?: string;
  tenantId?: string;
  roleId?: string;
  status?: MembershipStatus;
  lastSelectedAt?: Date | string | number | null;
}

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
  // #1400: read-only generated surface — RBAC/identity writes go through
  // permission-gated services, not auth-only generated CRUD (requireRouteAuth
  // is authentication-only, so a generated POST/PUT here is privilege escalation).
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  // #3742: CLI mirrors the read-only surface; `cli` without `include` is full CRUD.
  cli: { include: ['list', 'get'] },
  // Serves the tenant-scoped membership lookup without combining the two
  // foreign-key indexes at query time (#2821).
  indexes: [
    {
      name: 'memberships_tenant_id_user_id_idx',
      columns: ['tenantId', 'userId'],
    },
  ],
})
export class Membership extends SmrtObject implements MembershipContract {
  /**
   * Foreign key to User
   */
  @foreignKey('User', { required: true, requiredFor: 'identity' })
  @field({ description: 'The person who belongs to this organization.' })
  userId?: string;

  /**
   * Foreign key to Tenant
   */
  @foreignKey('Tenant', { required: true, requiredFor: 'tenant-scope' })
  tenantId?: string;

  /**
   * Foreign key to Role - determines base permissions
   */
  @foreignKey('Role', { required: true, requiredFor: 'identity' })
  @field({ description: "The role that determines this member's permissions." })
  roleId?: string;

  /**
   * Membership status
   */
  @field({
    description: 'Whether this membership is active, pending, or inactive.',
    type: 'text',
  })
  status: MembershipStatus = MembershipStatus.ACTIVE;

  /**
   * When the user last switched a session into this tenant (#5358). Server-side
   * "resume where you left off" hint read by
   * `SessionService.lastActiveTenantFor()`. It is a hint only and never grants
   * access: the active-membership check still runs on every switch.
   */
  @field({
    description:
      'When this person last switched into this organization, used to resume it at sign-in.',
    type: 'datetime',
    nullable: true,
  })
  lastSelectedAt: Date | null = null;

  constructor(options: MembershipOptions = {}) {
    super(options);
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.roleId !== undefined) this.roleId = options.roleId;
    if (options.status !== undefined) this.status = options.status;
    if (options.lastSelectedAt != null) {
      this.lastSelectedAt =
        options.lastSelectedAt instanceof Date
          ? options.lastSelectedAt
          : new Date(options.lastSelectedAt);
    }
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
