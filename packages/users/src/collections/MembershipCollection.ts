/**
 * MembershipCollection - Collection manager for Membership objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Membership } from '../models/Membership.js';
import { MembershipStatus } from '../types/index.js';

/**
 * Collection for managing Membership objects
 */
export class MembershipCollection extends SmrtCollection<Membership> {
  static readonly _itemClass = Membership;

  /**
   * Find all memberships for a user
   */
  async findByUser(userId: string): Promise<Membership[]> {
    return await this.list({
      where: { userId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all active memberships for a user
   */
  async findActiveByUser(userId: string): Promise<Membership[]> {
    return await this.list({
      where: { userId, status: MembershipStatus.ACTIVE },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all memberships in a tenant
   */
  async findByTenant(tenantId: string): Promise<Membership[]> {
    return await this.list({
      where: { tenantId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find active memberships in a tenant
   */
  async findActiveByTenant(tenantId: string): Promise<Membership[]> {
    return await this.list({
      where: { tenantId, status: MembershipStatus.ACTIVE },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find a specific user's membership in a tenant
   */
  async findByUserAndTenant(
    userId: string,
    tenantId: string,
  ): Promise<Membership | null> {
    const results = await this.list({
      where: { userId, tenantId },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find memberships by role
   */
  async findByRole(roleId: string): Promise<Membership[]> {
    return await this.list({
      where: { roleId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find memberships by status
   */
  async findByStatus(status: MembershipStatus): Promise<Membership[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }
}
