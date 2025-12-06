/**
 * OidcIdentity - Links OIDC provider identities to Profile
 *
 * Stores the mapping between external OIDC providers (Keycloak, Google, GitHub)
 * and internal Profile records. Multiple identities can link to a single profile.
 */

import {
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
}

@smrt({
  tableName: 'oidc_identities',
  api: { exclude: ['delete'] },
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
  provider: string = '';

  /**
   * OIDC issuer URL (e.g., https://keycloak.example.com/realms/bmp)
   */
  issuer: string = '';

  /**
   * OIDC subject claim - unique identifier from the provider
   */
  subject: string = '';

  /**
   * Cached email from the IdP (for display/lookup)
   */
  email: string = '';

  /**
   * Last time this identity was used for authentication
   */
  lastUsedAt: Date | null = null;

  constructor(options: OidcIdentityOptions = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.provider) this.provider = options.provider;
    if (options.issuer) this.issuer = options.issuer;
    if (options.subject) this.subject = options.subject;
    if (options.email) this.email = options.email;
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
    const collection = await (OidcIdentityCollection as any).create(options);
    return await collection.findOne({
      where: { issuer, subject },
    });
  }

  /**
   * Find or create identity for a profile
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
    const existing = await OidcIdentity.findBySubject(
      oidcData.issuer,
      oidcData.subject,
      options,
    );

    if (existing) {
      // Update last used
      existing.lastUsedAt = new Date();
      if (oidcData.email) existing.email = oidcData.email;
      await existing.save();
      return existing;
    }

    // Create new
    const identity = new OidcIdentity({
      ...options,
      profileId: profile.id as string,
      provider: oidcData.provider,
      issuer: oidcData.issuer,
      subject: oidcData.subject,
      email: oidcData.email || '',
    });
    await identity.initialize();
    await identity.save();
    return identity;
  }

  /**
   * Record usage of this identity
   */
  async recordUsage(): Promise<void> {
    this.lastUsedAt = new Date();
    await this.save();
  }
}
