/**
 * MagicLinkToken - Temporary tokens for email verification
 *
 * Stores hashed magic link tokens with expiration. Tokens are single-use
 * and automatically invalidated after verification or expiration.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { NostrIdentity } from './NostrIdentity';

export interface MagicLinkTokenOptions extends SmrtObjectOptions {
  nostrIdentityId?: string;
  tokenHash?: string;
  email?: string;
  expiresAt?: Date;
  usedAt?: Date | null;
  requestedFromIp?: string;
  createdAt?: Date;
}

export interface GenerateTokenResult {
  /** The plaintext token (only available at creation time) */
  token: string;
  /** The MagicLinkToken record */
  magicLinkToken: MagicLinkToken;
}

/** Default token expiration: 15 minutes */
const DEFAULT_EXPIRATION_MINUTES = 15;

@smrt({
  tableName: 'magic_link_tokens',
  api: { exclude: ['*'] }, // No API access - internal only
  mcp: { exclude: ['*'] },
  cli: { include: ['list'] }, // Admin visibility only
})
export class MagicLinkToken extends SmrtObject {
  /**
   * Link to the NostrIdentity this token is for
   */
  @foreignKey('NostrIdentity', { required: true })
  nostrIdentityId?: string;

  /**
   * SHA-256 hash of the token (never store plaintext)
   */
  tokenHash: string = '';

  /**
   * Email this token was sent to
   */
  email: string = '';

  /**
   * When this token expires
   */
  expiresAt: Date = new Date(
    Date.now() + DEFAULT_EXPIRATION_MINUTES * 60 * 1000,
  );

  /**
   * When this token was used (null = unused)
   */
  usedAt: Date | null = null;

  /**
   * IP address that requested the token (for rate limiting)
   */
  requestedFromIp: string = '';

  /**
   * When this token was created (for rate limiting)
   */
  createdAt: Date = new Date();

  constructor(options: MagicLinkTokenOptions = {}) {
    super(options);
    if (options.nostrIdentityId) this.nostrIdentityId = options.nostrIdentityId;
    if (options.tokenHash) this.tokenHash = options.tokenHash;
    if (options.email) this.email = options.email;
    if (options.expiresAt) this.expiresAt = options.expiresAt;
    if (options.usedAt !== undefined) this.usedAt = options.usedAt;
    if (options.requestedFromIp) this.requestedFromIp = options.requestedFromIp;
    if (options.createdAt) this.createdAt = options.createdAt;
  }

  /**
   * Hash a token using SHA-256
   */
  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generate a new magic link token
   * @param nostrIdentity - The identity this token is for
   * @param email - The email address to send to
   * @param options - Additional options
   */
  static async generate(
    nostrIdentity: NostrIdentity,
    email: string,
    options: {
      expiresInMinutes?: number;
      requestedFromIp?: string;
      db?: SmrtObjectOptions['db'];
    } = {},
  ): Promise<GenerateTokenResult> {
    // Generate 32 bytes of random data (256 bits of entropy)
    const tokenBytes = randomBytes(32);
    const token = tokenBytes.toString('base64url');
    const tokenHash = MagicLinkToken.hashToken(token);

    const expiresInMinutes =
      options.expiresInMinutes ?? DEFAULT_EXPIRATION_MINUTES;
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

    const magicLinkToken = new MagicLinkToken({
      db: options.db ?? nostrIdentity.options?.db,
      nostrIdentityId: nostrIdentity.id as string,
      tokenHash,
      email: email.toLowerCase(),
      expiresAt,
      requestedFromIp: options.requestedFromIp || '',
    });

    await magicLinkToken.initialize();
    await magicLinkToken.save();

    return { token, magicLinkToken };
  }

  /**
   * Verify a token and return the MagicLinkToken if valid
   * @param token - The plaintext token to verify
   * @param options - Database options
   * @returns The MagicLinkToken if valid, null otherwise
   */
  static async verify(
    token: string,
    options: SmrtObjectOptions = {},
  ): Promise<MagicLinkToken | null> {
    const tokenHash = MagicLinkToken.hashToken(token);

    const { MagicLinkTokenCollection } = await import(
      '../collections/MagicLinkTokenCollection'
    );
    const collection = await MagicLinkTokenCollection.create(options);

    const magicLinkToken = await collection.findOne({
      where: { tokenHash },
    });

    if (!magicLinkToken) {
      return null;
    }

    // Check if valid
    if (!magicLinkToken.isValid()) {
      return null;
    }

    return magicLinkToken;
  }

  /**
   * Check if this token is valid (not expired and not used)
   */
  isValid(): boolean {
    if (this.usedAt !== null) {
      return false;
    }
    if (new Date() > this.expiresAt) {
      return false;
    }
    return true;
  }

  /**
   * Check if this token has expired
   */
  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  /**
   * Check if this token has been used
   */
  isUsed(): boolean {
    return this.usedAt !== null;
  }

  /**
   * Mark this token as used
   */
  async markUsed(): Promise<void> {
    this.usedAt = new Date();
    await this.save();
  }

  /**
   * Get the NostrIdentity this token is for
   */
  async getNostrIdentity(): Promise<NostrIdentity | null> {
    return (await this.getRelated('nostrIdentityId')) as NostrIdentity | null;
  }

  /**
   * Get time remaining until expiration in seconds
   */
  getTimeRemainingSeconds(): number {
    const now = new Date();
    const diff = this.expiresAt.getTime() - now.getTime();
    return Math.max(0, Math.floor(diff / 1000));
  }
}
