/**
 * ApiKeyCollection - Collection for managing API keys
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ApiKey, type GenerateKeyResult } from '../models/ApiKey';
import type { Profile } from '../models/Profile';

export class ApiKeyCollection extends SmrtCollection<ApiKey> {
  static readonly _itemClass = ApiKey;

  /**
   * Find all keys for a profile
   */
  async findByProfile(profileId: string): Promise<ApiKey[]> {
    return await this.list({
      where: { profileId },
    });
  }

  /**
   * Find active (non-revoked, non-expired) keys for a profile
   */
  async findActiveByProfile(profileId: string): Promise<ApiKey[]> {
    const keys = await this.findByProfile(profileId);
    return keys.filter((key) => key.isValid());
  }

  /**
   * Find key by hash
   */
  async findByHash(keyHash: string): Promise<ApiKey | null> {
    return await this.findOne({
      where: { keyHash },
    });
  }

  /**
   * Verify an API key string and return the record if valid
   */
  async verify(key: string): Promise<ApiKey | null> {
    const keyHash = ApiKey.hashKey(key);
    const apiKey = await this.findByHash(keyHash);

    if (!apiKey) return null;
    if (!apiKey.isValid()) return null;

    // Record usage
    await apiKey.recordUsage();

    return apiKey;
  }

  /**
   * Generate a new key for a profile
   */
  async generateForProfile(
    profile: Profile,
    options: {
      name: string;
      scopes?: string[];
      expiresAt?: Date | null;
    },
  ): Promise<GenerateKeyResult> {
    return await ApiKey.generate(profile, {
      ...options,
      db: this.options.db,
    });
  }

  /**
   * Revoke all keys for a profile
   */
  async revokeAllForProfile(profileId: string): Promise<number> {
    const keys = await this.findActiveByProfile(profileId);
    for (const key of keys) {
      await key.revoke();
    }
    return keys.length;
  }

  /**
   * Revoke a specific key by prefix
   */
  async revokeByPrefix(keyPrefix: string): Promise<boolean> {
    const key = await this.findOne({
      where: { keyPrefix },
    });

    if (key && key.isValid()) {
      await key.revoke();
      return true;
    }
    return false;
  }

  /**
   * Clean up expired keys (soft delete by setting revokedAt)
   */
  async cleanupExpired(): Promise<number> {
    const now = new Date();
    const allKeys = await this.list({});
    let cleaned = 0;

    for (const key of allKeys) {
      if (key.expiresAt && key.expiresAt < now && !key.revokedAt) {
        key.revokedAt = now;
        await key.save();
        cleaned++;
      }
    }

    return cleaned;
  }
}
