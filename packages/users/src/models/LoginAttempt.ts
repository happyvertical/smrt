/**
 * Durable, shared-storage login attempt budget — one row per limiter key.
 *
 * Every credential-based sign-in (terminal approve, PIN, and any host-side
 * password or passkey flow) reserves an attempt here before doing credential
 * work, so the budget is enforced across every replica that shares the
 * database (#3273). The row is the arbiter; nothing is cached in-process.
 *
 * Keys are hashes, never raw identifiers: a subject key is derived from the
 * identifier the client *submitted* (an email key or user id), and a source
 * key from the client address or device, so the table never becomes a
 * plaintext index of emails and IPs, and an unknown subject costs exactly the
 * same row as a known one.
 *
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** The two independent budgets a sign-in attempt draws from. */
export type LoginAttemptScope = 'subject' | 'source';

/** Private database arbiter shared by every process that authenticates. */
@smrt({
  tableName: 'users_login_attempts',
  // Hashed keys only, but a row still reveals that *someone* is being
  // throttled. Keep it out of the change feed (#2937).
  sensitive: true,
  api: false,
  cli: false,
  mcp: false,
})
export class UsersLoginAttempt extends SmrtObject {
  /** `sha256(scope:normalizedKey)` — the UPSERT arbiter. */
  @field({ type: 'text', required: true, unique: true })
  limiterKey = '';

  /** Which budget this row protects. Informational; the key already encodes it. */
  @field({ type: 'text', required: true })
  scope: LoginAttemptScope = 'subject';

  /** Failed attempts plus currently reserved attempts inside the window. */
  @field({ type: 'integer', required: true, default: 0 })
  attemptCount = 0;

  /** Beginning of the current failed-attempt window. */
  @field({ type: 'datetime', required: true })
  windowStartedAt = new Date();

  /**
   * Consecutive failures that were not interrupted by a success. Drives the
   * exponential lockout: each exhausted budget lengthens the next lockout.
   */
  @field({ type: 'integer', required: true, default: 0 })
  failureStreak = 0;

  /**
   * While set and in the future, every reservation for this key is refused
   * regardless of the window. Null when the key is not locked out.
   *
   * Indexed: the retention sweep prunes idle rows by this and `retain_until`.
   */
  @field({ type: 'datetime', nullable: true, indexed: true })
  lockedUntil: Date | null = null;

  /**
   * When this key last failed. The streak is forgiven once this is older
   * than the limiter's streak horizon — measured from the last FAILURE, not
   * the last activity, so a busy shared source (a tablet, an office address)
   * still sheds old failures while it keeps being used.
   */
  @field({ type: 'datetime', nullable: true })
  lastFailedAt: Date | null = null;

  /**
   * When the limiter that last wrote this row stops reasoning about it (its
   * own window and streak-forgiveness horizon). The retention sweep deletes
   * only rows past this, so it honours each limiter's configuration rather
   * than a process-wide default.
   */
  @field({ type: 'datetime', required: true, indexed: true })
  retainUntil = new Date();
}
