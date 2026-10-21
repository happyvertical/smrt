/**
 * Collection for {@link UsersPasskeyChallenge} (#3275).
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  type PasskeyChallengePurpose,
  UsersPasskeyChallenge,
} from '../models/PasskeyChallenge.js';

export class UsersPasskeyChallengeCollection extends SmrtCollection<UsersPasskeyChallenge> {
  static readonly _itemClass = UsersPasskeyChallenge;

  /**
   * Consume a challenge: insert its hash. Returns false, writing nothing,
   * when the hash was already consumed — a replay. One
   * `INSERT … ON CONFLICT DO NOTHING` against the unique `challenge_hash`
   * decides between concurrent consumers, so of any number of simultaneous
   * uses exactly one gets true. A constraint error is deliberately never the
   * arbiter: a failed statement on a shared connection can be reported to the
   * wrong caller, and a database failure must not read as "consumed" or
   * "fresh".
   */
  async consume(
    challengeHash: string,
    purpose: PasskeyChallengePurpose,
    expiresAt: Date,
  ): Promise<boolean> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { rowCount } = await this.db.query(
      `INSERT INTO ${this.tableName} (
         id, slug, context, challenge_hash, purpose, expires_at,
         created_at, updated_at
       ) VALUES (?, ?, '', ?, ?, ?, ?, ?)
       ON CONFLICT (challenge_hash) DO NOTHING`,
      id,
      id,
      challengeHash,
      purpose,
      expiresAt.toISOString(),
      now,
      now,
    );
    return rowCount > 0;
  }

  /**
   * Delete consumed challenges whose ceremonies no longer verify. One
   * statement (see `UsersMagicLinkTokenCollection.deleteExpired`); `expiresAt`
   * carries an index for this predicate.
   *
   * @param options.dryRun - Count the rows the predicate selects without
   *   deleting them.
   */
  async deleteExpired(options: { dryRun?: boolean } = {}): Promise<number> {
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
