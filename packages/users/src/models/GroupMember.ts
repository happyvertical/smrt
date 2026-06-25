/**
 * GroupMember model - User belongs to Group (join table)
 * @packageDocumentation
 */

import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * Constructor options for {@link GroupMember}.
 */
export interface GroupMemberOptions extends SmrtObjectOptions {
  groupId?: string;
  userId?: string;
}

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
  // #1400: read-only generated REST + MCP surface — RBAC/identity writes go
  // through permission-gated services, not auth-only generated CRUD. mcp must
  // be explicit: an omitted mcp config generates the FULL tool surface.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
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

  constructor(options: GroupMemberOptions = {}) {
    super(options);
    if (options.groupId !== undefined) this.groupId = options.groupId;
    if (options.userId !== undefined) this.userId = options.userId;
  }
}
