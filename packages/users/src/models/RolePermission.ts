/**
 * RolePermission model - Role has Permission (join table)
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * RolePermission is a join table linking Roles to Permissions.
 *
 * This enables many-to-many relationship between roles and permissions.
 * A role can have multiple permissions, and a permission can belong to multiple roles.
 *
 * @example
 * ```typescript
 * // Assign a permission to a role
 * const rolePermission = await rolePermissions.create({
 *   roleId: adminRole.id,
 *   permissionId: createArticlePermission.id
 * });
 * await rolePermission.save();
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'delete'] },
  cli: true,
})
export class RolePermission extends SmrtObject {
  /**
   * Foreign key to Role
   */
  @foreignKey('Role', { required: true })
  roleId?: string;

  /**
   * Foreign key to Permission
   */
  @foreignKey('Permission', { required: true })
  permissionId?: string;

  constructor(options: any = {}) {
    super(options);
    if (options.roleId !== undefined) this.roleId = options.roleId;
    if (options.permissionId !== undefined)
      this.permissionId = options.permissionId;
  }
}
