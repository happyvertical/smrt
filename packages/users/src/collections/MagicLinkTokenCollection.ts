/**
 * MagicLinkTokenCollection - Collection manager for MagicLinkToken objects
 *
 * Provides nonce lookup and single-use enforcement for magic link authentication.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { MagicLinkToken } from '../models/MagicLinkToken.js';

/**
 * Collection for managing MagicLinkToken objects (replay protection)
 */
export class MagicLinkTokenCollection extends SmrtCollection<MagicLinkToken> {
  static readonly _itemClass = MagicLinkToken;

  /**
   * Find a token by its nonce
   */
  async findByNonce(nonce: string): Promise<MagicLinkToken | null> {
    return this.findOne({ where: { nonce } }) as Promise<MagicLinkToken | null>;
  }

  /**
   * Mark a token as used (single-use enforcement)
   */
  async markUsed(nonce: string): Promise<void> {
    const token = await this.findByNonce(nonce);
    if (token) {
      token.used = true;
      await token.save();
    }
  }

  /**
   * Delete expired tokens (cleanup job)
   */
  async deleteExpired(): Promise<number> {
    const now = new Date();
    const tokens = await this.list({
      where: {
        'expiresAt <': now.toISOString(),
      },
    });

    let count = 0;
    for (const token of tokens) {
      await token.delete();
      count++;
    }

    return count;
  }
}
