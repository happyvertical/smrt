/**
 * Durable per-user failed-approval budget for terminal device codes.
 *
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** Private database arbiter shared by every terminal-auth process. */
@smrt({
  tableName: 'users_cli_auth_approve_limits',
  api: false,
  cli: false,
  mcp: false,
})
export class UsersCliAuthApproveLimit extends SmrtObject {
  /** Approving browser user whose budget this row protects. */
  @foreignKey('User', { required: true, unique: true })
  userId = '';

  /** Failed attempts plus currently reserved attempts inside the window. */
  @field({ type: 'integer', required: true, default: 0 })
  attemptCount = 0;

  /** Beginning of the current failed-attempt window. */
  @field({ type: 'datetime', required: true })
  windowStartedAt = new Date();
}
