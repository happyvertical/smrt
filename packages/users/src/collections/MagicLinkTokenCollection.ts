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
   *
   * Scheduled by the framework retention sweep (#2375); `expiresAt` carries an
   * index for this predicate.
   *
   * @param options.dryRun - Count the tokens the predicate selects without
   *   deleting them.
   * @returns Number of tokens deleted (or, under `dryRun`, matched)
   */
  async deleteExpired(options: { dryRun?: boolean } = {}): Promise<number> {
    // One statement, for the same reason `SessionCollection.deleteExpired()`
    // is one (#1400): this runs unattended on the retention sweep's timer, and
    // a per-row delete that throws part-way leaves the rest of the expired
    // tokens un-reaped. It also avoids hydrating every row just to delete it.
    const now = new Date().toISOString();
    const predicate = 'expires_at < ?';

    const counted = await this.db.query(
      `SELECT COUNT(*) AS total FROM ${this.tableName} WHERE ${predicate}`,
      now,
    );
    const total = Number(counted.rows?.[0]?.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) return 0;

    if (!options.dryRun) {
      await this.db.query(
        `DELETE FROM ${this.tableName} WHERE ${predicate}`,
        now,
      );
    }

    return total;
  }
}

export { UsersMagicLinkTokenCollection as MagicLinkTokenCollection };
