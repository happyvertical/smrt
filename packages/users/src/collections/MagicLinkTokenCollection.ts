/**
 * MagicLinkTokenCollection - Collection manager for MagicLinkToken objects
 *
 * Provides nonce lookup and single-use enforcement for magic link authentication.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { UsersMagicLinkToken } from '../models/MagicLinkToken.js';

/**
 * Collection for managing smrt-users magic link token records
 */
export class UsersMagicLinkTokenCollection extends SmrtCollection<UsersMagicLinkToken> {
  static readonly _itemClass = UsersMagicLinkToken;

  /**
   * Find a token by its nonce
   */
  async findByNonce(nonce: string): Promise<UsersMagicLinkToken | null> {
    return this.findOne({
      where: { nonce },
    }) as Promise<UsersMagicLinkToken | null>;
  }

  /**
   * Atomically mark a token as used (single-use enforcement).
   *
   * Returns true if the nonce was successfully claimed (transitioned from
   * unused to used). Returns false if the nonce was already used, expired,
   * or doesn't exist — preventing race conditions in concurrent verify() calls.
   */
  async markUsed(nonce: string): Promise<boolean> {
    const now = new Date().toISOString();
    const { rowCount } = await this.db.query(
      `UPDATE ${this.tableName}
       SET used = ?, updated_at = ?
       WHERE nonce = ? AND used = ? AND expires_at > ?`,
      true,
      now,
      nonce,
      false,
      now,
    );

    return rowCount > 0;
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

export { UsersMagicLinkTokenCollection as MagicLinkTokenCollection };
