/**
 * RolePermissionCollection - Collection manager for RolePermission objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { RolePermission } from '../models/RolePermission.js';

/**
 * Collection for managing RolePermission objects
 */
export class RolePermissionCollection extends SmrtCollection<RolePermission> {
  static readonly _itemClass = RolePermission;

  /**
   * Find all permissions for a role
   */
  async findByRole(roleId: string): Promise<RolePermission[]> {
    return await this.list({
      where: { roleId },
    });
  }

  /**
   * Find all roles that have a permission
   */
  async findByPermission(permissionId: string): Promise<RolePermission[]> {
    return await this.list({
      where: { permissionId },
    });
  }

  /**
   * Check if a role has a specific permission
   */
  async hasPermission(roleId: string, permissionId: string): Promise<boolean> {
    const results = await this.list({
      where: { roleId, permissionId },
      limit: 1,
    });
    return results.length > 0;
  }

  /**
   * Add a permission to a role
   */
  async addPermission(
    roleId: string,
    permissionId: string,
  ): Promise<RolePermission> {
    // Check if already exists
    const existing = await this.list({
      where: { roleId, permissionId },
      limit: 1,
    });
    if (existing.length > 0) {
      return existing[0];
    }

    const rolePermission = await this.create({ roleId, permissionId });
    await rolePermission.save();
    return rolePermission;
  }

  /**
   * Remove a permission from a role
   */
  async removePermission(
    roleId: string,
    permissionId: string,
  ): Promise<boolean> {
    const existing = await this.list({
      where: { roleId, permissionId },
      limit: 1,
    });
    if (existing.length === 0) {
      return false;
    }

    await existing[0].delete();
    return true;
  }

  /**
   * Get permission IDs for a role
   */
  async getPermissionIds(roleId: string): Promise<string[]> {
    const rolePermissions = await this.findByRole(roleId);
    return rolePermissions.map((rp) => rp.permissionId as string);
  }
}
