/**
 * MagicLinkTokenCollection - Collection for managing magic link tokens
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { MagicLinkToken } from '../models/MagicLinkToken';

export class MagicLinkTokenCollection extends SmrtCollection<MagicLinkToken> {
  static readonly _itemClass = MagicLinkToken;

  /**
   * Find token by hash
   */
  async findByTokenHash(tokenHash: string): Promise<MagicLinkToken | null> {
    return await this.findOne({
      where: { tokenHash },
    });
  }

  /**
   * Find active (non-expired, non-used) tokens for an email
   */
  async findActiveForEmail(email: string): Promise<MagicLinkToken[]> {
    const tokens = await this.list({
      where: { email: email.toLowerCase() },
    });
    return tokens.filter((token) => token.isValid());
  }

  /**
   * Find tokens for a NostrIdentity
   */
  async findByIdentity(nostrIdentityId: string): Promise<MagicLinkToken[]> {
    return await this.list({
      where: { nostrIdentityId },
    });
  }

  /**
   * Count tokens created for an email within a time window (for rate limiting)
   * @param email - Email address
   * @param withinMinutes - Time window in minutes
   */
  async countRecentByEmail(
    email: string,
    withinMinutes: number,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
    const tokens = await this.list({
      where: { email: email.toLowerCase() },
    });

    // Filter tokens created after cutoff
    // Note: We use createdAt from SmrtObject base
    return tokens.filter((token) => {
      const createdAt = token.createdAt;
      return createdAt && new Date(createdAt) > cutoff;
    }).length;
  }

  /**
   * Count tokens created from an IP within a time window (for rate limiting)
   * @param ip - IP address
   * @param withinMinutes - Time window in minutes
   */
  async countRecentByIp(ip: string, withinMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
    const tokens = await this.list({
      where: { requestedFromIp: ip },
    });

    // Filter tokens created after cutoff
    return tokens.filter((token) => {
      const createdAt = token.createdAt;
      return createdAt && new Date(createdAt) > cutoff;
    }).length;
  }

  /**
   * Verify a token and return it if valid
   */
  async verify(token: string): Promise<MagicLinkToken | null> {
    const tokenHash = MagicLinkToken.hashToken(token);
    const magicLinkToken = await this.findByTokenHash(tokenHash);

    if (!magicLinkToken) {
      return null;
    }

    if (!magicLinkToken.isValid()) {
      return null;
    }

    return magicLinkToken;
  }

  /**
   * Clean up expired tokens by deleting them
   * @returns Number of tokens deleted
   */
  async cleanupExpired(): Promise<number> {
    const now = new Date();
    const allTokens = await this.list({});
    let deleted = 0;

    for (const token of allTokens) {
      if (token.isExpired() || token.isUsed()) {
        await token.delete();
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * Revoke all tokens for a NostrIdentity (e.g., when identity is deleted)
   */
  async revokeForIdentity(nostrIdentityId: string): Promise<number> {
    const tokens = await this.findByIdentity(nostrIdentityId);
    let revoked = 0;

    for (const token of tokens) {
      if (!token.isUsed()) {
        await token.markUsed(); // Mark as used to invalidate
        revoked++;
      }
    }

    return revoked;
  }

  /**
   * Check if rate limit is exceeded for email
   * @param email - Email address
   * @param maxPerHour - Maximum tokens allowed per hour (default: 5)
   */
  async isRateLimitedByEmail(
    email: string,
    maxPerHour: number = 5,
  ): Promise<boolean> {
    const count = await this.countRecentByEmail(email, 60);
    return count >= maxPerHour;
  }

  /**
   * Check if rate limit is exceeded for IP
   * @param ip - IP address
   * @param maxPerHour - Maximum tokens allowed per hour (default: 10)
   */
  async isRateLimitedByIp(
    ip: string,
    maxPerHour: number = 10,
  ): Promise<boolean> {
    const count = await this.countRecentByIp(ip, 60);
    return count >= maxPerHour;
  }
}
