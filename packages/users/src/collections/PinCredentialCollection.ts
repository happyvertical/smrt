/**
 * Collection for {@link UsersPinCredential} (#3276).
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { UsersPinCredential } from '../models/PinCredential.js';

export interface PinCredentialWrite {
  pinHash: string;
  mustReset: boolean;
  rotatedAt: Date;
  rotatedBy: string;
}

export class UsersPinCredentialCollection extends SmrtCollection<UsersPinCredential> {
  static readonly _itemClass = UsersPinCredential;

  async findByUserId(userId: string): Promise<UsersPinCredential | null> {
    const [credential] = await this.list({ limit: 1, where: { userId } });
    return credential ?? null;
  }

  /**
   * Create or replace the one credential row for `userId`, bumping `version`
   * on replace. Save conflicts from a concurrent set are retried once by
   * re-reading; the last writer wins, which is the intended semantics for a
   * credential rotation.
   */
  async upsertForUser(
    userId: string,
    write: PinCredentialWrite,
  ): Promise<UsersPinCredential> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.findByUserId(userId);
      if (!existing) {
        const created = await this.create({
          userId,
          pinHash: write.pinHash,
          mustReset: write.mustReset,
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
      existing.pinHash = write.pinHash;
      existing.mustReset = write.mustReset;
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
    throw new Error('Unable to persist PIN credential.');
  }

  async deleteByUserId(userId: string): Promise<boolean> {
    const existing = await this.findByUserId(userId);
    if (!existing) return false;
    await existing.delete();
    return true;
  }
}
