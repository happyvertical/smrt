/**
 * Per-person PIN credential, usable only on an enrolled device (#3276).
 *
 * Deliberately its own object rather than a column on `User`, so the hash is
 * never selected by the many existing user reads and never serialized by
 * accident. One row per user.
 *
 * The hash is scrypt over `pepper || pin` with a per-row random salt. A PIN is
 * a 4–8 digit secret: without a server-side pepper a leaked table would be
 * brute-forced in seconds, and even with one the PIN is only accepted behind
 * a live device bearer session and the login limiter — see
 * {@link DeviceCredentialService}.
 *
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'users_pin_credentials',
  // Credential material. Never in the change feed (#2937), never on an API.
  sensitive: true,
  api: false,
  cli: false,
  mcp: false,
})
export class UsersPinCredential extends SmrtObject {
  /** The person this PIN signs in. */
  @foreignKey('User', { required: true, unique: true })
  userId = '';

  /** Encoded hash: `scrypt$N$r$p$saltB64$hashB64`. */
  @field({ type: 'text', required: true, sensitive: true })
  pinHash = '';

  /** Bumped on every set/reset so audits and sessions can reference a generation. */
  @field({ type: 'integer', required: true, default: 1 })
  version = 1;

  /** Set by an administrative reset; the person must choose a new PIN on next use. */
  @field({ type: 'boolean', required: true, default: false })
  mustReset = false;

  /** When the current hash was written. */
  @field({ type: 'datetime', nullable: true })
  rotatedAt: Date | null = null;

  /** `self`, or the user id of the administrator who last set it. */
  @field({ type: 'text', nullable: true })
  rotatedBy: string | null = null;
}
