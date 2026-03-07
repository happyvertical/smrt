/**
 * GroupMemberCollection - Collection manager for GroupMember objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { GroupMember } from '../models/GroupMember.js';

/**
 * Collection for managing GroupMember objects
 */
export class GroupMemberCollection extends SmrtCollection<GroupMember> {
  static readonly _itemClass = GroupMember;

  /**
   * Find all members of a group
   */
  async findByGroup(groupId: string): Promise<GroupMember[]> {
    return await this.list({
      where: { groupId },
    });
  }

  /**
   * Find all groups a user belongs to
   */
  async findByUser(userId: string): Promise<GroupMember[]> {
    return await this.list({
      where: { userId },
    });
  }

  /**
   * Check if a user is in a group
   */
  async isMember(groupId: string, userId: string): Promise<boolean> {
    const results = await this.list({
      where: { groupId, userId },
      limit: 1,
    });
    return results.length > 0;
  }

  /**
   * Add user to a group
   */
  async addMember(groupId: string, userId: string): Promise<GroupMember> {
    // Check if already a member
    const existing = await this.list({
      where: { groupId, userId },
      limit: 1,
    });
    if (existing.length > 0) {
      return existing[0];
    }

    const member = await this.create({ groupId, userId });
    await member.save();
    return member;
  }

  /**
   * Remove user from a group
   */
  async removeMember(groupId: string, userId: string): Promise<boolean> {
    const existing = await this.list({
      where: { groupId, userId },
      limit: 1,
    });
    if (existing.length === 0) {
      return false;
    }

    await existing[0].delete();
    return true;
  }

  /**
   * Get group IDs for a user
   * @deprecated Use getGroupIdsForTenant to prevent cross-tenant leakage
   */
  async getGroupIds(userId: string): Promise<string[]> {
    const memberships = await this.findByUser(userId);
    return memberships.map((m) => m.groupId as string);
  }

  /**
   * Get group IDs for a user within a specific tenant
   * This prevents cross-tenant permission leakage by filtering groups by tenant
   */
  async getGroupIdsForTenant(
    userId: string,
    tenantId: string,
  ): Promise<string[]> {
    // Query group_members joined with groups to filter by tenant
    // Use raw database query to get unhydrated results
    const sql = `
      SELECT gm.group_id
      FROM ${this.tableName} gm
      INNER JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = ? AND g.tenant_id = ?
    `;
    const result = await this.db.query(sql, userId, tenantId);
    return result.rows.map((r: any) => r.group_id as string);
  }

  /**
   * Get user IDs in a group
   */
  async getUserIds(groupId: string): Promise<string[]> {
    const members = await this.findByGroup(groupId);
    return members.map((m) => m.userId as string);
  }
}
