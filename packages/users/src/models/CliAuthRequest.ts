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

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * CLI auth request lifecycle states.
 */
export type CliAuthRequestStatus =
  | 'pending'
  | 'approved'
  | 'consumed'
  | 'expired';

@smrt({
  tableName: 'users_cli_auth_requests',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class UsersCliAuthRequest extends SmrtObject {
  /**
   * Short, human-typeable code the user enters in the browser to approve the session.
   *
   * Indexed: `findByUserCode()` looks requests up by this column (#2364,
   * epic #2382 finding A3).
   */
  @field({ type: 'text', required: true, unique: true })
  userCode = '';

  /**
   * SHA-256 hash of the long device code the CLI keeps secret.
   *
   * Indexed: `findByDeviceCodeHash()` — the CLI's poll loop — looks requests
   * up by this column (#2364, epic #2382 finding A3).
   */
  @field({ type: 'text', required: true, unique: true })
  deviceCodeHash = '';

  /** Lifecycle state — `pending` → `approved` → `consumed`, or `expired`. */
  @field({ type: 'text' })
  status: CliAuthRequestStatus = 'pending';

  /** User id of the human who approved the request (set on approval). */
  @foreignKey('User', { nullable: true })
  userId: string | null = null;

  /** Tenant id captured from the approving session (set on approval). */
  @foreignKey('Tenant', { nullable: true })
  tenantId: string | null = null;

  /** Session id minted on approval; cleared by the winning single-use exchange. */
  @foreignKey('Session', { nullable: true })
  sessionId: string | null = null;

  /**
   * When the pending request stops accepting approvals.
   *
   * Indexed: `deleteExpired()` — and the retention sweep that now schedules
   * it (#2375) — scans this column on every pass.
   */
  @field({ type: 'datetime', indexed: true })
  expiresAt = new Date();

  /** When approval happened — null while the request is still pending. */
  @field({ type: 'datetime', nullable: true })
  approvedAt: Date | null = null;
}

export { UsersCliAuthRequest as CliAuthRequest };
