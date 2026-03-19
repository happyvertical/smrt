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
   * Atomically mark a token as used (single-use enforcement).
   *
   * Returns true if the nonce was successfully claimed (transitioned from
   * unused to used). Returns false if the nonce was already used, expired,
   * or doesn't exist — preventing race conditions in concurrent verify() calls.
   */
  async markUsed(nonce: string): Promise<boolean> {
    const token = (await this.findOne({
      where: {
        nonce,
        used: false,
        'expiresAt >': new Date().toISOString(),
      },
    })) as MagicLinkToken | null;

    if (!token) return false;

    token.used = true;
    await token.save();
    return true;
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
