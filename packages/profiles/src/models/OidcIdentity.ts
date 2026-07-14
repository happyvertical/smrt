/**
 * OidcIdentity - Links OIDC provider identities to Profile
 *
 * Stores the mapping between external OIDC providers (Keycloak, Google, GitHub)
 * and internal Profile records. Multiple identities can link to a single profile.
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { Profile } from './Profile';

export interface OidcIdentityOptions extends SmrtObjectOptions {
  profileId?: string;
  provider?: string;
  issuer?: string;
  subject?: string;
  email?: string;
  lastUsedAt?: Date | null;
}

@smrt({
  tableName: 'oidc_identities',
  // Identity linking is an authentication authority change. Generated routes
  // authenticate callers but do not authorize Profile ownership, so mutations
  // must stay behind the trusted provisioning APIs below.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class OidcIdentity extends SmrtObject {
  /**
   * Link to the Profile (Person, Organization, Bot)
   */
  @foreignKey('Profile', { required: true })
  profileId?: string;

  /**
   * Provider name (e.g., 'keycloak', 'google', 'github')
   */
  @field({ type: 'text' })
  provider: string = '';

  /**
   * OIDC issuer URL (e.g., https://keycloak.example.com/realms/bmp)
   */
  @field({ type: 'text', indexed: true })
  issuer: string = '';

  /**
   * OIDC subject claim - unique identifier from the provider
   */
  @field({ type: 'text', indexed: true })
  subject: string = '';

  /**
   * Stable issuer+subject key used as the database race arbiter.
   *
   * Nullable for legacy rows; every newly linked or reused identity backfills
   * it. A separate unique constraint makes concurrent first login fail with a
   * retryable conflict instead of creating two identities.
   */
  @field({ type: 'text', nullable: true, unique: true, readonly: true })
  identityKey: string | null = null;

  /**
   * Cached email from the IdP (for display/lookup)
   */
  @field({ type: 'text' })
  email: string = '';

  /**
   * Last time this identity was used for authentication
   */
  @field({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null = null;

  constructor(options: OidcIdentityOptions = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.provider) this.provider = options.provider;
    if (options.issuer) this.issuer = options.issuer;
    if (options.subject) this.subject = options.subject;
    if (options.email) this.email = options.email;
    if (options.lastUsedAt !== undefined) this.lastUsedAt = options.lastUsedAt;
  }

  /**
   * Get the linked Profile
   */
  async getProfile(): Promise<Profile | null> {
    return (await this.getRelated('profileId')) as Profile | null;
  }

  /**
   * Find identity by issuer and subject
   */
  static async findBySubject(
    issuer: string,
    subject: string,
    options: SmrtObjectOptions = {},
  ): Promise<OidcIdentity | null> {
    const { OidcIdentityCollection } = await import(
      '../collections/OidcIdentityCollection'
    );
    const collection = await OidcIdentityCollection.create(options);
    return await collection.findBySubject(issuer, subject);
  }

  /** Build the collision-free natural key for one OIDC issuer subject. */
  static buildIdentityKey(issuer: string, subject: string): string {
    return JSON.stringify([issuer, subject]);
  }

  /** Keep the durable key derived from its natural-key source fields. */
  override async save(): Promise<this> {
    this.identityKey =
      this.issuer.trim() && this.subject.trim()
        ? OidcIdentity.buildIdentityKey(this.issuer, this.subject)
        : null;
    return super.save();
  }

  /**
   * Reuse an existing exact identity for its unchanged Profile.
   *
   * @deprecated Authentication links must be created through transactional
   * provisioning. This compatibility method only refreshes a unique mapping
   * that already belongs to the supplied Profile, including legacy Profile
   * types, and deliberately refuses to create or rebind authority.
   */
  static async findOrCreate(
    profile: Profile,
    oidcData: {
      provider: string;
      issuer: string;
      subject: string;
      email?: string;
    },
    options: SmrtObjectOptions = {},
  ): Promise<OidcIdentity> {
    const profileId = profile.id;
    if (typeof profileId !== 'string' || !profileId) {
      throw new Error('OidcIdentity.findOrCreate() requires a saved Profile.');
    }
    const { reuseExistingOidcIdentityForProfile } = await import(
      '../auth/resolveIdentity'
    );
    const profileOptions = profile.options ?? {};
    const result = await reuseExistingOidcIdentityForProfile(
      profileId,
      {
        email: oidcData.email,
        iss: oidcData.issuer,
        sub: oidcData.subject,
      },
      oidcData.provider,
      {
        ...profileOptions,
        ...options,
        db: options.db ?? profileOptions.db,
      },
    );
    return result.oidcIdentity;
  }

  /**
   * Record usage of this identity
   */
  async recordUsage(): Promise<void> {
    this.lastUsedAt = new Date();
    await this.save();
  }
}
