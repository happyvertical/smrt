/**
 * OidcIdentityCollection - Collection for managing OIDC identity records
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { OidcIdentity } from '../models/OidcIdentity';
import type { Profile } from '../models/Profile';

/** More than one legacy row maps the same opaque OIDC issuer and subject. */
export class AmbiguousOidcIdentityError extends Error {
  constructor(
    readonly issuer: string,
    readonly subject: string,
  ) {
    super('Multiple OIDC identities match the same issuer and subject.');
    this.name = 'AmbiguousOidcIdentityError';
  }
}

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
    const matches = await this.list({
      where: { issuer, subject },
      limit: 2,
    });
    if (matches.length > 1) {
      throw new AmbiguousOidcIdentityError(issuer, subject);
    }
    return matches[0] ?? null;
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
   * Reuse an existing exact OIDC identity for its unchanged Profile.
   *
   * @deprecated New authentication links require the owner-aware,
   * transactional provisioning APIs. This compatibility helper may refresh a
   * legacy Profile type, but refuses to create or rebind authority.
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
    return OidcIdentity.findOrCreate(profile, oidcData, this.options);
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
