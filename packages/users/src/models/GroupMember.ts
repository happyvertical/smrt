/**
 * GroupMember model - User belongs to Group (join table)
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * GroupMember is a join table linking Users to Groups.
 *
 * A user can belong to multiple groups within a tenant.
 * Group membership grants additional permissions via GroupRole.
 *
 * @example
 * ```typescript
 * // Add user to a group
 * const groupMember = await groupMembers.create({
 *   groupId: editorsGroup.id,
 *   userId: user.id
 * });
 * await groupMember.save();
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'delete'] },
  cli: true,
})
export class GroupMember extends SmrtObject {
  /**
   * Foreign key to Group
   */
  @foreignKey('Group', { required: true })
  groupId?: string;

  /**
   * Foreign key to User
   */
  @foreignKey('User', { required: true })
  userId?: string;

  constructor(options: any = {}) {
    super(options);
    if (options.groupId !== undefined) this.groupId = options.groupId;
    if (options.userId !== undefined) this.userId = options.userId;
  }
}
