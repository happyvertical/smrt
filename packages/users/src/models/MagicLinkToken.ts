/**
 * MagicLinkToken model - replay protection for magic link authentication
 *
 * Stores nonces embedded in magic link JWTs to prevent replay attacks.
 * Each nonce can only be used once within its expiry window.
 *
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Default magic link token expiry: 10 minutes in seconds
 */
export const DEFAULT_TOKEN_EXPIRY_SECONDS = 10 * 60;

@smrt({
  tableName: 'users_magic_link_tokens',
  // Magic link tokens are security-sensitive — no public API
  api: { include: [] },
  mcp: { include: [] },
  cli: true,
})
export class UsersMagicLinkToken extends SmrtObject {
  /** Unique nonce embedded in the signed JWT */
  nonce: string = '';

  /** Email address this token was generated for */
  email: string = '';

  /** Whether this token has been used */
  used: boolean = false;

  /** When this token expires */
  expiresAt: Date = new Date(Date.now() + DEFAULT_TOKEN_EXPIRY_SECONDS * 1000);

  constructor(options: any = {}) {
    super(options);
    if (options.nonce !== undefined) this.nonce = options.nonce;
    if (options.email !== undefined) this.email = options.email;
    if (options.used !== undefined) this.used = options.used;
    if (options.expiresAt !== undefined) {
      this.expiresAt =
        options.expiresAt instanceof Date
          ? options.expiresAt
          : new Date(options.expiresAt);
    }
  }

  /** Check if the token has expired */
  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  /** Check if the token is still valid (unused and not expired) */
  isValid(): boolean {
    return !this.used && !this.isExpired();
  }
}

export { UsersMagicLinkToken as MagicLinkToken };
