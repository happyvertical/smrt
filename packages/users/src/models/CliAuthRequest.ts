/**
 * UsersCliAuthRequest model — device-code grant for terminal/CLI logins.
 *
 * Backs the "browser approves a terminal" flow: a CLI starts a request, the
 * server returns a short user code, the user signs in on a browser and
 * approves the code, then the CLI polls and gets back a session token bound
 * to the approving user. Records are short-lived (TTL is enforced by
 * `expiresAt`) and store only a hash of the device code so the raw device
 * code is never recoverable from the database.
 *
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * CLI auth request lifecycle states.
 */
export type CliAuthRequestStatus = 'pending' | 'approved' | 'expired';

@smrt({
  tableName: 'users_cli_auth_requests',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class UsersCliAuthRequest extends SmrtObject {
  /** Short, human-typeable code the user enters in the browser to approve the session. */
  @field({ type: 'text' })
  userCode = '';

  /** SHA-256 hash of the long device code the CLI keeps secret. */
  @field({ type: 'text' })
  deviceCodeHash = '';

  /** Lifecycle state — `pending` → `approved` | `expired`. */
  @field({ type: 'text' })
  status: CliAuthRequestStatus = 'pending';

  /** User id of the human who approved the request (set on approval). */
  @field({ type: 'text' })
  userId = '';

  /** Tenant id captured from the approving session (set on approval). */
  @field({ type: 'text' })
  tenantId = '';

  /** Session id minted on approval — handed to the CLI as its bearer token. */
  @field({ type: 'text' })
  sessionId = '';

  /** When the pending request stops accepting approvals. */
  @field({ type: 'datetime' })
  expiresAt = new Date();

  /** When approval happened — null while the request is still pending. */
  @field({ type: 'datetime', nullable: true })
  approvedAt: Date | null = null;
}

export { UsersCliAuthRequest as CliAuthRequest };
