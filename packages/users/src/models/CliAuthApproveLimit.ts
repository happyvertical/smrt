/**
 * Durable per-user failed-approval budget for terminal device codes.
 *
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Private database arbiter shared by every terminal-auth process.
 *
 * @deprecated Since #3273 `TerminalAuthService` draws from the shared
 * {@link UsersLoginAttempt} budget instead; this table is no longer written.
 * The class stays exported so existing schemas and cleanup scripts keep
 * resolving; it will be removed in a future major.
 */
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
