/**
 * GroupRole model - Group has Role (join table)
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * GroupRole is a join table linking Groups to Roles.
 *
 * Groups can have multiple roles assigned, and members of the group
 * inherit the permissions from all assigned roles.
 *
 * @example
 * ```typescript
 * // Assign a role to a group
 * const groupRole = await groupRoles.create({
 *   groupId: editorsGroup.id,
 *   roleId: editorRole.id
 * });
 * await groupRole.save();
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'delete'] },
  cli: true,
})
export class GroupRole extends SmrtObject {
  /**
   * Foreign key to Group
   */
  @foreignKey('Group', { required: true })
  groupId?: string;

  /**
   * Foreign key to Role
   */
  @foreignKey('Role', { required: true })
  roleId?: string;

  constructor(options: any = {}) {
    super(options);
    if (options.groupId !== undefined) this.groupId = options.groupId;
    if (options.roleId !== undefined) this.roleId = options.roleId;
  }
}
