/**
 * ApiKey - API keys for CLI and CI authentication
 *
 * Provides secure API key management with hashing, scopes, and expiration.
 * Keys are stored as hashes - the plaintext is only returned on creation.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { Profile } from './Profile';

export interface ApiKeyOptions extends SmrtObjectOptions {
  profileId?: string;
  name?: string;
  scopes?: string[];
  expiresAt?: Date | null;
}

export interface GenerateKeyResult {
  key: string;
  apiKey: ApiKey;
}

@smrt({
  tableName: 'api_keys',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  // create/revoke are admin operations invoked in-process via the CLI; only
  // read-only list/get are exposed over HTTP.
  cli: { include: ['list', 'get', 'create', 'revoke'], skipApiCheck: true },
})
export class ApiKey extends SmrtObject {
  /**
   * Link to the Profile (Person, Organization, Bot)
   */
  @foreignKey('Profile', { required: true })
  profileId?: string;

  /**
   * SHA-256 hash of the API key
   */
  keyHash: string = '';

  /**
   * First 8 characters of the key for identification (e.g., "sk_live_a1b2...")
   */
  keyPrefix: string = '';

  /**
   * Human-readable name for the key (e.g., "CI Bot", "Local CLI")
   */
  name: string = '';

  /**
   * Scopes/permissions for this key
   */
  scopes: string[] = [];

  /**
   * Last time this key was used
   */
  lastUsedAt: Date | null = null;

  /**
   * When this key expires (null = never)
   */
  expiresAt: Date | null = null;

  /**
   * When this key was revoked (null = active)
   */
  revokedAt: Date | null = null;

  constructor(options: ApiKeyOptions = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.name) this.name = options.name;
    if (options.scopes) this.scopes = options.scopes;
    if (options.expiresAt !== undefined) this.expiresAt = options.expiresAt;
  }

  /**
   * Get the linked Profile
   */
  async getProfile(): Promise<Profile | null> {
    return (await this.getRelated('profileId')) as Profile | null;
  }

  /**
   * Check if this key is valid (not expired, not revoked)
   */
  isValid(): boolean {
    if (this.revokedAt) return false;
    if (this.expiresAt && this.expiresAt < new Date()) return false;
    return true;
  }

  /**
   * Check if this key has a specific scope
   */
  hasScope(scope: string): boolean {
    return this.scopes.includes(scope) || this.scopes.includes('*');
  }

  /**
   * Revoke this key
   */
  async revoke(): Promise<void> {
    this.revokedAt = new Date();
    await this.save();
  }

  /**
   * Record usage of this key
   */
  async recordUsage(): Promise<void> {
    this.lastUsedAt = new Date();
    await this.save();
  }

  /**
   * Hash an API key
   */
  static hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  /**
   * Generate a new API key for a profile
   */
  static async generate(
    profile: Profile,
    options: {
      name: string;
      scopes?: string[];
      expiresAt?: Date | null;
      db?: SmrtObjectOptions['db'];
    },
  ): Promise<GenerateKeyResult> {
    // Generate a random key: sk_live_<32 random bytes as hex>
    const randomPart = randomBytes(32).toString('hex');
    const key = `sk_live_${randomPart}`;
    const keyPrefix = key.substring(0, 16);
    const keyHash = ApiKey.hashKey(key);

    const apiKey = new ApiKey({
      db: options.db || profile.options?.db,
      profileId: profile.id as string,
      name: options.name,
      scopes: options.scopes || ['*'],
      expiresAt: options.expiresAt ?? null,
    });
    apiKey.keyHash = keyHash;
    apiKey.keyPrefix = keyPrefix;

    await apiKey.initialize();
    await apiKey.save();

    return { key, apiKey };
  }

  /**
   * Verify an API key and return the ApiKey record if valid
   */
  static async verify(
    key: string,
    options: SmrtObjectOptions = {},
  ): Promise<ApiKey | null> {
    const keyHash = ApiKey.hashKey(key);

    const { ApiKeyCollection } = await import(
      '../collections/ApiKeyCollection'
    );
    const collection = await ApiKeyCollection.create(options);

    const apiKey = await collection.findOne({
      where: { keyHash },
    });

    if (!apiKey) return null;
    if (!apiKey.isValid()) return null;

    // Record usage
    await apiKey.recordUsage();

    return apiKey;
  }
}
