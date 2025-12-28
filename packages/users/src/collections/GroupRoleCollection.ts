/**
 * GroupRoleCollection - Collection manager for GroupRole objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { GroupRole } from '../models/GroupRole.js';

/**
 * Collection for managing GroupRole objects
 */
export class GroupRoleCollection extends SmrtCollection<GroupRole> {
  static readonly _itemClass = GroupRole;

  /**
   * Find all roles for a group
   */
  async findByGroup(groupId: string): Promise<GroupRole[]> {
    return await this.list({
      where: { groupId },
    });
  }

  /**
   * Find all groups that have a role
   */
  async findByRole(roleId: string): Promise<GroupRole[]> {
    return await this.list({
      where: { roleId },
    });
  }

  /**
   * Check if a group has a role
   */
  async hasRole(groupId: string, roleId: string): Promise<boolean> {
    const results = await this.list({
      where: { groupId, roleId },
      limit: 1,
    });
    return results.length > 0;
  }

  /**
   * Add role to a group
   */
  async addRole(groupId: string, roleId: string): Promise<GroupRole> {
    // Check if already has role
    const existing = await this.list({
      where: { groupId, roleId },
      limit: 1,
    });
    if (existing.length > 0) {
      return existing[0];
    }

    const groupRole = await this.create({ groupId, roleId });
    await groupRole.save();
    return groupRole;
  }

  /**
   * Remove role from a group
   */
  async removeRole(groupId: string, roleId: string): Promise<boolean> {
    const existing = await this.list({
      where: { groupId, roleId },
      limit: 1,
    });
    if (existing.length === 0) {
      return false;
    }

    await existing[0].delete();
    return true;
  }

  /**
   * Get role IDs for a group
   */
  async getRoleIds(groupId: string): Promise<string[]> {
    const groupRoles = await this.findByGroup(groupId);
    return groupRoles.map((gr) => gr.roleId as string);
  }
}
