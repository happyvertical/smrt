/**
 * Collection for {@link UsersPasswordCredential} (#3274).
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { UsersPasswordCredential } from '../models/PasswordCredential.js';

export interface PasswordCredentialWrite {
  passwordHash: string;
  mustChange: boolean;
  rotatedAt: Date;
  rotatedBy: string;
}

export class UsersPasswordCredentialCollection extends SmrtCollection<UsersPasswordCredential> {
  static readonly _itemClass = UsersPasswordCredential;

  async findByUserId(userId: string): Promise<UsersPasswordCredential | null> {
    const [credential] = await this.list({ limit: 1, where: { userId } });
    return credential ?? null;
  }

  /**
   * Create or replace the one credential row for `userId`, bumping `version`
   * on replace. Save conflicts from a concurrent write are retried once by
   * re-reading; the last writer wins, which is the intended semantics for a
   * credential rotation.
   */
  async upsertForUser(
    userId: string,
    write: PasswordCredentialWrite,
  ): Promise<UsersPasswordCredential> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.findByUserId(userId);
      if (!existing) {
        const created = await this.create({
          userId,
          passwordHash: write.passwordHash,
          mustChange: write.mustChange,
          rotatedAt: write.rotatedAt,
          rotatedBy: write.rotatedBy,
          version: 1,
        });
        try {
          await created.save();
          return created;
        } catch (error) {
          if (attempt === 0) continue; // lost a concurrent first insert; replace it
          throw error;
        }
      }
      existing.passwordHash = write.passwordHash;
      existing.mustChange = write.mustChange;
      existing.rotatedAt = write.rotatedAt;
      existing.rotatedBy = write.rotatedBy;
      existing.version = (existing.version ?? 0) + 1;
      try {
        await existing.save();
        return existing;
      } catch (error) {
        if (attempt === 0) continue;
        throw error;
      }
    }
    throw new Error('Unable to persist password credential.');
  }

  /**
   * Swap the stored hash for a stronger encoding of the SAME password — the
   * parameter upgrade after a successful sign-in — only if the row still
   * holds `expectedHash`. One guarded statement, so a reset or change that
   * landed in between is never overwritten with the old password. Leaves
   * `version`, `mustChange`, and `rotatedAt` alone: this is not a rotation.
   * Returns false when the row had moved on.
   */
  async replaceHashIfUnchanged(
    userId: string,
    expectedHash: string,
    upgradedHash: string,
  ): Promise<boolean> {
    await this.db.query(
      `UPDATE ${this.tableName}
          SET password_hash = ?, updated_at = ?
        WHERE user_id = ? AND password_hash = ?`,
      upgradedHash,
      new Date().toISOString(),
      userId,
      expectedHash,
    );
    return (await this.findByUserId(userId))?.passwordHash === upgradedHash;
  }

  async deleteByUserId(userId: string): Promise<boolean> {
    const existing = await this.findByUserId(userId);
    if (!existing) return false;
    await existing.delete();
    return true;
  }
}
