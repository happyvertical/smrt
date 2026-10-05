/**
 * Per-person password credential (#3274).
 *
 * Its own object rather than a column on `User`, so authentication can be
 * extended without touching the identity model, the hash is never selected by
 * the many existing user reads, and it is never serialized by accident. One
 * row per user: like the PIN credential, a password belongs to the person,
 * not to a tenant — tenant access still comes only from an active Membership,
 * which sign-in checks separately.
 *
 * The hash is scrypt with a random per-hash salt and the parameters encoded
 * in the stored string (`scrypt$N$r$p$saltB64$hashB64`). See
 * {@link PasswordCredentialService}; that service and its SvelteKit handlers
 * are the only read and write paths.
 *
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'users_password_credentials',
  // Credential material. Never in the change feed (#2937), never on an API.
  sensitive: true,
  api: false,
  cli: false,
  mcp: false,
})
export class UsersPasswordCredential extends SmrtObject {
  /** The person this password signs in. */
  @foreignKey('User', { required: true, unique: true })
  userId = '';

  /** Encoded hash: `scrypt$N$r$p$saltB64$hashB64`. */
  @field({ type: 'text', required: true, sensitive: true })
  passwordHash = '';

  /** Bumped on every set/change/reset; a parameter-upgrade rehash keeps it. */
  @field({ type: 'integer', required: true, default: 1 })
  version = 1;

  /**
   * Set by an administrative reset: the next sign-in yields a session that
   * can only change the password.
   */
  @field({ type: 'boolean', required: true, default: false })
  mustChange = false;

  /** When the current password was set. */
  @field({ type: 'datetime', nullable: true })
  rotatedAt: Date | null = null;

  /** `self`, or the user id of the administrator who last set it. */
  @field({ type: 'text', nullable: true })
  rotatedBy: string | null = null;
}
