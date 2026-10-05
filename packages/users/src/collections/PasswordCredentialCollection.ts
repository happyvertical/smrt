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
   * Insert the first credential row for `userId`. Returns null, writing
   * nothing, when one already exists or a concurrent insert won (the unique
   * `user_id` decides): a first password never replaces another.
   */
  async insertIfAbsent(
    userId: string,
    write: PasswordCredentialWrite,
  ): Promise<UsersPasswordCredential | null> {
    if (await this.findByUserId(userId)) return null;
    try {
      return await this.create({
        userId,
        passwordHash: write.passwordHash,
        mustChange: write.mustChange,
        rotatedAt: write.rotatedAt,
        rotatedBy: write.rotatedBy,
        version: 1,
        _insertOnly: true,
      });
    } catch (error) {
      if (await this.findByUserId(userId)) return null;
      throw error;
    }
  }

  /**
   * Create or replace the one credential row for `userId`, bumping `version`
   * on replace — the administrative write, where the last writer wins.
   * Losing a concurrent first insert is retried once as a replace.
   */
  async upsertForUser(
    userId: string,
    write: PasswordCredentialWrite,
  ): Promise<UsersPasswordCredential> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.findByUserId(userId);
      if (!existing) {
        const created = await this.insertIfAbsent(userId, write);
        if (created) return created;
        continue; // lost a concurrent first insert; replace it
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
   * Replace the password only if the row is still exactly `expected` — the
   * credential whose current password the person just proved. One guarded
   * statement, so a reset (or any other write) that landed after the proof
   * is never overwritten with a password chosen under the old one. Clears
   * `mustChange` and bumps `version`. Returns false when the row had moved on.
   */
  async replaceIfCurrent(
    expected: UsersPasswordCredential,
    write: Omit<PasswordCredentialWrite, 'mustChange'>,
  ): Promise<boolean> {
    await this.db.query(
      `UPDATE ${this.tableName}
          SET password_hash = ?, must_change = FALSE, version = version + 1,
              rotated_at = ?, rotated_by = ?, updated_at = ?
        WHERE id = ? AND password_hash = ?`,
      write.passwordHash,
      write.rotatedAt.toISOString(),
      write.rotatedBy,
      new Date().toISOString(),
      expected.id,
      expected.passwordHash,
    );
    return (
      (await this.findByUserId(expected.userId))?.passwordHash ===
      write.passwordHash
    );
  }

  /**
   * Delete the row only if it is still exactly `expected` (see
   * {@link replaceIfCurrent}). Returns false when it had moved on.
   */
  async deleteIfCurrent(expected: UsersPasswordCredential): Promise<boolean> {
    await this.db.query(
      `DELETE FROM ${this.tableName} WHERE id = ? AND password_hash = ?`,
      expected.id,
      expected.passwordHash,
    );
    const current = await this.findByUserId(expected.userId);
    return current === null || current.id !== expected.id;
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
