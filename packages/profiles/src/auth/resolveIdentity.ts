/**
 * resolveIdentity - Resolves authentication context to a Profile
 *
 * Used by apps (blindmanpress.com) to resolve incoming auth to a Profile.
 * Modules (aedile, praeco) should receive the resolved profile from the app.
 *
 * Resolution order:
 * 1. API key header → ApiKey → Profile
 * 2. OIDC session → OidcIdentity → Profile
 * 3. Actor header (CI pass-through) → Profile lookup
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { ApiKey } from '../models/ApiKey';
import { OidcIdentity } from '../models/OidcIdentity';
import type { Profile } from '../models/Profile';

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
  source: 'api_key' | 'oidc' | 'actor' | 'none';

  /**
   * The API key record if authenticated via API key
   */
  apiKey?: ApiKey;

  /**
   * The OIDC identity record if authenticated via OIDC
   */
  oidcIdentity?: OidcIdentity;
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

  // 3. Check actor for CI pass-through (look up by metadata)
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
 * @param claims - OIDC token claims
 * @param provider - Provider name (e.g., 'keycloak', 'google')
 * @param options - Database options
 * @returns The created or existing profile with linked OIDC identity
 */
export async function createProfileFromOidc(
  claims: {
    sub: string;
    iss: string;
    email?: string;
    name?: string;
    preferred_username?: string;
  },
  provider: string,
  options: SmrtObjectOptions,
): Promise<{ profile: Profile; oidcIdentity: OidcIdentity; created: boolean }> {
  // Check if OIDC identity already exists
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

  // Create new profile
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
