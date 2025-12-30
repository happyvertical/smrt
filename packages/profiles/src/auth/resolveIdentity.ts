/**
 * resolveIdentity - Resolves authentication context to a Profile
 *
 * Used by apps (blindmanpress.com) to resolve incoming auth to a Profile.
 * Modules (aedile, praeco) should receive the resolved profile from the app.
 *
 * Resolution order:
 * 1. API key header → ApiKey → Profile
 * 2. OIDC session → OidcIdentity → Profile
 * 3. Nostr auth → NostrIdentity → Profile
 * 4. Actor header (CI pass-through) → Profile lookup
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { ApiKey } from '../models/ApiKey';
import { NostrIdentity } from '../models/NostrIdentity';
import { OidcIdentity } from '../models/OidcIdentity';
import type { Profile } from '../models/Profile';
import { type NostrEvent, verifyAuthEvent } from './nostrCrypto';

/**
 * Context provided to resolveIdentity
 */
export interface AuthContext {
  /**
   * API key from X-API-Key header or similar
   */
  apiKey?: string | null;

  /**
   * OIDC session data (from @auth/sveltekit or similar)
   */
  oidcSession?: {
    sub?: string;
    iss?: string;
    email?: string;
    name?: string;
  } | null;

  /**
   * Actor identifier for CI pass-through identity
   * Usually the GitHub actor (username) who triggered the workflow
   */
  actor?: string | null;

  /**
   * Nostr authentication data (NIP-42 style)
   */
  nostrAuth?: {
    /** Signed Nostr event for authentication */
    event: NostrEvent;
    /** Expected challenge (to prevent replay attacks) */
    challenge: string;
  } | null;

  /**
   * Database/persistence options
   */
  db?: SmrtObjectOptions['db'];
}

/**
 * Result of identity resolution
 */
export interface ResolveIdentityResult {
  /**
   * The resolved profile, or null if not authenticated
   */
  profile: Profile | null;

  /**
   * How the identity was resolved
   */
  source: 'api_key' | 'oidc' | 'nostr' | 'actor' | 'none';

  /**
   * The API key record if authenticated via API key
   */
  apiKey?: ApiKey;

  /**
   * The OIDC identity record if authenticated via OIDC
   */
  oidcIdentity?: OidcIdentity;

  /**
   * The Nostr identity record if authenticated via Nostr
   */
  nostrIdentity?: NostrIdentity;
}

/**
 * Resolve authentication context to a Profile
 *
 * @param context - The authentication context from the request
 * @returns The resolved profile and metadata
 *
 * @example
 * ```typescript
 * // In SvelteKit hooks.server.ts
 * import { resolveIdentity } from '@happyvertical/smrt-profiles';
 *
 * const identityMiddleware: Handle = async ({ event, resolve }) => {
 *   const session = await event.locals.auth();
 *
 *   const { profile, source } = await resolveIdentity({
 *     oidcSession: session,
 *     apiKey: event.request.headers.get('X-API-Key'),
 *     actor: event.request.headers.get('X-Actor'),
 *     db: { type: 'postgres', url: DATABASE_URL },
 *   });
 *
 *   event.locals.profile = profile;
 *   event.locals.authSource = source;
 *
 *   return resolve(event);
 * };
 * ```
 */
export async function resolveIdentity(
  context: AuthContext,
): Promise<ResolveIdentityResult> {
  const options: SmrtObjectOptions = { db: context.db };

  // 1. Check API key header first (highest priority for programmatic access)
  if (context.apiKey) {
    const apiKey = await ApiKey.verify(context.apiKey, options);
    if (apiKey) {
      const profile = await apiKey.getProfile();
      if (profile) {
        return {
          profile,
          source: 'api_key',
          apiKey,
        };
      }
    }
  }

  // 2. Check OIDC session (web users)
  if (context.oidcSession?.sub && context.oidcSession?.iss) {
    const oidcIdentity = await OidcIdentity.findBySubject(
      context.oidcSession.iss,
      context.oidcSession.sub,
      options,
    );

    if (oidcIdentity) {
      // Record usage
      await oidcIdentity.recordUsage();

      const profile = await oidcIdentity.getProfile();
      if (profile) {
        return {
          profile,
          source: 'oidc',
          oidcIdentity,
        };
      }
    }
  }

  // 3. Check Nostr auth (NIP-42 style signed event)
  if (context.nostrAuth?.event && context.nostrAuth?.challenge) {
    const { event, challenge } = context.nostrAuth;

    // Verify the auth event
    const verifyResult = verifyAuthEvent(event, challenge);
    if (verifyResult.valid) {
      // Look up identity by public key
      const nostrIdentity = await NostrIdentity.findByPubkey(
        event.pubkey,
        options,
      );

      if (nostrIdentity) {
        // Record usage
        await nostrIdentity.recordUsage();

        const profile = await nostrIdentity.getProfile();
        if (profile) {
          return {
            profile,
            source: 'nostr',
            nostrIdentity,
          };
        }
      }
    }
  }

  // 4. Check actor for CI pass-through (look up by metadata)
  if (context.actor) {
    const profile = await findProfileByExternalId(
      'github',
      context.actor,
      options,
    );
    if (profile) {
      return {
        profile,
        source: 'actor',
      };
    }
  }

  // No authentication found
  return {
    profile: null,
    source: 'none',
  };
}

/**
 * Find a profile by external ID (e.g., GitHub username)
 *
 * This looks up profiles by their linked external identities or metadata.
 *
 * @param provider - The external provider (e.g., 'github')
 * @param externalId - The external identifier (e.g., GitHub username)
 * @param options - Database options
 * @returns The profile or null
 */
async function findProfileByExternalId(
  provider: string,
  externalId: string,
  options: SmrtObjectOptions,
): Promise<Profile | null> {
  // First check OIDC identities (if they use the provider)
  const { OidcIdentityCollection } = await import(
    '../collections/OidcIdentityCollection'
  );

  const oidcCollection = await (OidcIdentityCollection as any).create(options);
  const identities = await oidcCollection.findByProvider(provider);

  for (const identity of identities) {
    // Check if the subject matches the external ID
    if (
      identity.subject === externalId ||
      identity.email?.includes(externalId)
    ) {
      const profile = await identity.getProfile();
      if (profile) return profile;
    }
  }

  // Could also check profile metadata for external IDs
  // This would require a standardized metadata field like 'github_username'
  const { ProfileCollection } = await import(
    '../collections/ProfileCollection'
  );
  const profileCollection = await (ProfileCollection as any).create(options);

  // Try to find by email that looks like a GitHub noreply
  const profiles = await profileCollection.list({
    where: {
      email: `${externalId}@users.noreply.github.com`,
    },
    limit: 1,
  });

  if (profiles.length > 0) {
    return profiles[0];
  }

  return null;
}

/**
 * Create a profile from OIDC claims if it doesn't exist
 *
 * Supports email-based account linking: if a user signs in with Google
 * and later with GitHub using the same email, they get the same profile.
 *
 * Resolution order:
 * 1. If OIDC identity (iss + sub) already exists → return linked profile
 * 2. If verified email provided, check if profile with same email exists → link new identity
 * 3. Otherwise, create new profile + identity
 *
 * Security considerations:
 * - Email-based linking only occurs when `email_verified` is true. This prevents
 *   attackers from claiming unverified emails to hijack accounts.
 * - Linking is automatic and irreversible through this API. Multiple OIDC
 *   identities from different providers sharing the same verified email will
 *   be associated to the same Profile.
 * - If an OIDC provider does not supply an email, or the email changes later,
 *   existing links are not automatically updated. New sign-ins without an email
 *   or with a different email may result in a new Profile being created.
 * - This function trusts the OIDC provider to assert correct email_verified status.
 *   Only use with trusted providers.
 *
 * @param claims - OIDC token claims
 * @param provider - Provider name (e.g., 'keycloak', 'google', 'github')
 * @param options - Database options
 * @returns The created or existing profile with linked OIDC identity
 */
export async function createProfileFromOidc(
  claims: {
    sub: string;
    iss: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    preferred_username?: string;
  },
  provider: string,
  options: SmrtObjectOptions,
): Promise<{ profile: Profile; oidcIdentity: OidcIdentity; created: boolean }> {
  // 1. If OIDC identity already exists for this issuer+subject, return linked profile
  const existingIdentity = await OidcIdentity.findBySubject(
    claims.iss,
    claims.sub,
    options,
  );

  if (existingIdentity) {
    const profile = await existingIdentity.getProfile();
    if (profile) {
      // Update identity with latest claims
      if (claims.email) existingIdentity.email = claims.email;
      existingIdentity.lastUsedAt = new Date();
      await existingIdentity.save();

      return {
        profile,
        oidcIdentity: existingIdentity,
        created: false,
      };
    }
  }

  // 2. Email-based account linking: only link if email is verified (security)
  if (claims.email && claims.email_verified) {
    const { ProfileCollection } = await import(
      '../collections/ProfileCollection'
    );

    const profileCollection = await (ProfileCollection as any).create(options);
    const existingProfile = await profileCollection.findByEmail(claims.email);

    if (existingProfile) {
      // Link new OIDC identity to existing profile (email-based linking)
      const oidcIdentity = await OidcIdentity.findOrCreate(
        existingProfile,
        {
          provider,
          issuer: claims.iss,
          subject: claims.sub,
          email: claims.email,
        },
        options,
      );

      return {
        profile: existingProfile,
        oidcIdentity,
        created: false,
      };
    }
  }

  // 3. Create new profile
  const { Person } = await import('../models/ProfileTypes');
  const { ProfileTypeCollection } = await import(
    '../collections/ProfileTypeCollection'
  );

  // Get or create the 'person' type
  const typeCollection = await (ProfileTypeCollection as any).create(options);
  let personType = await typeCollection.getBySlug('person');

  if (!personType) {
    // Create the person type if it doesn't exist
    const { ProfileType } = await import('../models/ProfileType');
    personType = new ProfileType({
      ...options,
      slug: 'person',
      name: 'Person',
      description: 'Individual person profile',
    });
    await personType.initialize();
    await personType.save();
  }

  const profile = new Person({
    ...options,
    typeId: personType.id as string,
    email: claims.email || '',
    name: claims.name || claims.preferred_username || claims.sub,
  });
  await profile.initialize();
  await profile.save();

  // Link OIDC identity
  const oidcIdentity = await OidcIdentity.findOrCreate(
    profile,
    {
      provider,
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email,
    },
    options,
  );

  return {
    profile,
    oidcIdentity,
    created: true,
  };
}

/**
 * Create a profile from Nostr identity (used by magic link service)
 *
 * This is typically called internally by the magic link service,
 * but can be used directly if needed.
 *
 * @param email - Email address for the profile
 * @param nostrData - Encrypted Nostr keypair data
 * @param options - Database options
 * @returns The created profile with linked Nostr identity
 */
export async function createProfileFromNostr(
  email: string,
  nostrData: {
    pubkey: string;
    encryptedPrivkey: string;
    encryptionIv: string;
    encryptionTag: string;
    nip05Username?: string;
  },
  options: SmrtObjectOptions,
): Promise<{
  profile: Profile;
  nostrIdentity: NostrIdentity;
  created: boolean;
}> {
  const normalizedEmail = email.toLowerCase();

  // Check if Nostr identity already exists
  const existingIdentity = await NostrIdentity.findByEmail(
    normalizedEmail,
    options,
  );

  if (existingIdentity) {
    const profile = await existingIdentity.getProfile();
    if (profile) {
      return {
        profile,
        nostrIdentity: existingIdentity,
        created: false,
      };
    }
  }

  // Create new profile
  const { Person } = await import('../models/ProfileTypes');
  const { ProfileTypeCollection } = await import(
    '../collections/ProfileTypeCollection'
  );

  // Get or create the 'person' type
  const typeCollection = await (ProfileTypeCollection as any).create(options);
  let personType = await typeCollection.getBySlug('person');

  if (!personType) {
    const { ProfileType } = await import('../models/ProfileType');
    personType = new ProfileType({
      ...options,
      slug: 'person',
      name: 'Person',
      description: 'Individual person profile',
    });
    await personType.initialize();
    await personType.save();
  }

  const profile = new Person({
    ...options,
    typeId: personType.id as string,
    email: normalizedEmail,
    name: normalizedEmail.split('@')[0], // Default name from email
  });
  await profile.initialize();
  await profile.save();

  // Create Nostr identity
  const nostrIdentity = new NostrIdentity({
    ...options,
    profileId: profile.id as string,
    pubkey: nostrData.pubkey,
    encryptedPrivkey: nostrData.encryptedPrivkey,
    encryptionIv: nostrData.encryptionIv,
    encryptionTag: nostrData.encryptionTag,
    email: normalizedEmail,
    nip05Username:
      nostrData.nip05Username?.toLowerCase() || normalizedEmail.split('@')[0],
  });
  await nostrIdentity.initialize();
  await nostrIdentity.save();

  return {
    profile,
    nostrIdentity,
    created: true,
  };
}
