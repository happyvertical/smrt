/**
 * RolePermission model - Role has Permission (join table)
 * @packageDocumentation
 */

import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * Constructor options for {@link RolePermission}.
 */
export interface RolePermissionOptions extends SmrtObjectOptions {
  roleId?: string;
  permissionId?: string;
}

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
  // #1400: read-only generated REST + MCP surface — RBAC/identity writes go
  // through permission-gated services, not auth-only generated CRUD. mcp must
  // be explicit: an omitted mcp config generates the FULL tool surface.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
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

  constructor(options: RolePermissionOptions = {}) {
    super(options);
    if (options.roleId !== undefined) this.roleId = options.roleId;
    if (options.permissionId !== undefined)
      this.permissionId = options.permissionId;
  }
}
