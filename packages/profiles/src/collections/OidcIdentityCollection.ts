/**
 * OidcIdentityCollection - Collection for managing OIDC identity records
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { OidcIdentity } from '../models/OidcIdentity';
import type { Profile } from '../models/Profile';

export class OidcIdentityCollection extends SmrtCollection<OidcIdentity> {
  static readonly _itemClass = OidcIdentity;

  /**
   * Find identities for a profile
   */
  async findByProfile(profileId: string): Promise<OidcIdentity[]> {
    return await this.list({
      where: { profileId },
    });
  }

  /**
   * Find identity by issuer and subject
   */
  async findBySubject(
    issuer: string,
    subject: string,
  ): Promise<OidcIdentity | null> {
    return await this.findOne({
      where: { issuer, subject },
    });
  }

  /**
   * Find identities by provider
   */
  async findByProvider(provider: string): Promise<OidcIdentity[]> {
    return await this.list({
      where: { provider },
    });
  }

  /**
   * Link a new OIDC identity to a profile
   */
  async linkToProfile(
    profile: Profile,
    oidcData: {
      provider: string;
      issuer: string;
      subject: string;
      email?: string;
    },
  ): Promise<OidcIdentity> {
    // Check if already exists
    const existing = await this.findBySubject(
      oidcData.issuer,
      oidcData.subject,
    );
    if (existing) {
      // Update and return existing
      existing.lastUsedAt = new Date();
      if (oidcData.email) existing.email = oidcData.email;
      await existing.save();
      return existing;
    }

    // Create new
    const identity = new OidcIdentity({
      ...this.options,
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
   * Unlink an OIDC identity from a profile
   */
  async unlinkFromProfile(
    profileId: string,
    issuer: string,
    subject: string,
  ): Promise<boolean> {
    const identity = await this.findOne({
      where: { profileId, issuer, subject },
    });

    if (identity) {
      await identity.delete();
      return true;
    }
    return false;
  }
}
