/**
 * UserCollection - Collection manager for User objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import type { OidcIdentity, Profile } from '@happyvertical/smrt-profiles';
import { User } from '../models/User.js';
import { UserStatus } from '../types/index.js';

/**
 * OIDC claims used for identity resolution
 */
export interface OidcClaims {
  /** Subject identifier from IdP */
  sub: string;
  /** Issuer URL */
  iss: string;
  /** User's email address */
  email?: string;
  /** Whether the IdP verified the email address */
  email_verified?: boolean;
  /** User's display name */
  name?: string;
  /** Preferred username */
  preferred_username?: string;
}

/**
 * Result of OIDC identity resolution
 */
export interface OidcIdentityResult {
  /** The User record */
  user: User;
  /** The linked Profile */
  profile: Profile;
  /** The OidcIdentity linking profile to IdP */
  oidcIdentity: OidcIdentity;
  /** Whether the profile was newly created */
  created: boolean;
}

/**
 * Options for getOrCreateFromOidc
 */
export interface GetOrCreateFromOidcOptions {
  /** If false, skip recording login timestamp (default: true) */
  recordLogin?: boolean;
}

/**
 * Collection for managing User objects
 */
export class UserCollection extends SmrtCollection<User> {
  static readonly _itemClass = User;

  /**
   * Find user by email address
   */
  async findByEmail(email: string): Promise<User | null> {
    const results = await this.list({
      where: { email },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find user by profile ID
   */
  async findByProfile(profileId: string): Promise<User | null> {
    const results = await this.list({
      where: { profileId },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find users by status
   */
  async findByStatus(status: UserStatus): Promise<User[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all active users
   */
  async findActive(): Promise<User[]> {
    return await this.findByStatus(UserStatus.ACTIVE);
  }

  /**
   * Find all pending users
   */
  async findPending(): Promise<User[]> {
    return await this.findByStatus(UserStatus.PENDING);
  }

  /**
   * Get or create user for a profile
   */
  async getOrCreateForProfile(
    profileId: string,
    email: string,
    defaults: Partial<{ status: UserStatus }> = {},
  ): Promise<User> {
    const existing = await this.findByProfile(profileId);
    if (existing) {
      return existing;
    }

    const user = await this.create({
      profileId,
      email,
      status: defaults.status ?? UserStatus.ACTIVE,
    });
    await user.save();
    return user;
  }

  /**
   * Get or create user from OIDC claims
   *
   * This is the primary method for resolving identity from an OIDC login.
   * It handles the full flow:
   * 1. Find or create Profile from OIDC claims (via smrt-profiles)
   * 2. Link OidcIdentity to the Profile
   * 3. Find or create User linked to the Profile
   *
   * @param claims - OIDC token claims (sub, iss, email, name)
   * @param provider - Provider name (e.g., 'kanidm', 'keycloak', 'google')
   * @param options - Optional settings (recordLogin)
   * @returns User, Profile, OidcIdentity, and whether profile was created
   *
   * @example
   * ```typescript
   * const userCollection = await UserCollection.create({ db: dbConfig });
   *
   * // In your OIDC callback handler:
   * const { user, profile } = await userCollection.getOrCreateFromOidc(
   *   {
   *     sub: tokenClaims.sub,
   *     iss: tokenClaims.iss,
   *     email: tokenClaims.email,
   *     name: tokenClaims.name,
   *   },
   *   'kanidm'
   * );
   *
   * // User and profile are now available
   * // Login was auto-recorded; pass { recordLogin: false } to skip
   * ```
   */
  async getOrCreateFromOidc(
    claims: OidcClaims,
    provider: string,
    options?: GetOrCreateFromOidcOptions,
  ): Promise<OidcIdentityResult> {
    // Validate required OIDC claims at runtime
    const sub = claims?.sub?.trim();
    const iss = claims?.iss?.trim();
    if (!sub || !iss) {
      throw new Error(
        'Invalid OIDC claims: both "sub" and "iss" must be non-empty strings.',
      );
    }

    // Email is required for user creation
    if (!claims.email) {
      throw new Error(
        'OIDC claims missing required "email" for user creation.',
      );
    }

    // Dynamic import to avoid circular dependency between smrt-users and smrt-profiles.
    // Both packages need to reference each other's types, so we defer the import.
    const { createProfileFromOidc } = await import(
      '@happyvertical/smrt-profiles'
    );

    // Get database options from this collection
    const dbOptions = { db: this.options.db };

    // Create or find profile with linked OIDC identity
    const { profile, oidcIdentity, created } = await createProfileFromOidc(
      claims,
      provider,
      dbOptions,
    );

    const shouldRecordLogin = options?.recordLogin !== false;

    // Get or create user for this profile. SmrtCollection.create() persists, so
    // pass lastLoginAt during creation to avoid an extra first-login write.
    const existingUser = await this.findByProfile(profile.id as string);
    const user =
      existingUser ??
      (await this.create({
        email: claims.email,
        ...(shouldRecordLogin ? { lastLoginAt: new Date() } : {}),
        profileId: profile.id as string,
        status: UserStatus.ACTIVE,
      }));

    if (existingUser && shouldRecordLogin) {
      existingUser.recordLogin();
      await existingUser.save();
    }

    return {
      user,
      profile,
      oidcIdentity,
      created,
    };
  }
}
