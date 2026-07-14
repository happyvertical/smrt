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

import {
  resolveDatabase,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ApiKey } from '../models/ApiKey';
import { NostrIdentity } from '../models/NostrIdentity';
import { OidcIdentity } from '../models/OidcIdentity';
import type { Profile } from '../models/Profile';
import { normalizeIdentityEmail } from './normalizeIdentityEmail';
import { type NostrEvent, verifyAuthEvent } from './nostrCrypto';
import {
  coordinateOidcProvisioning,
  isOidcProvisioningRaceConflict,
} from './oidcProvisioningCoordinator';
import {
  createOidcProvisioningPerson,
  insertOidcProvisioningIdentity,
} from './oidcProvisioningPrimitives';

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

  const oidcCollection = await OidcIdentityCollection.create(options);
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
  const profileCollection = await ProfileCollection.create(options);

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
 * Resolution order:
 * 1. If OIDC identity (iss + sub) already exists → return linked profile
 * 2. If the email matches an existing Profile, fail closed because this
 *    package cannot prove whether a User owns it
 * 3. Otherwise, create new profile + identity
 *
 * Security considerations:
 * - Existing issuer/subject links always keep their already-linked Profile,
 *   including legacy tenant-scoped or non-Person Profiles, and refresh the
 *   cached identity email. This exact-link compatibility does not perform
 *   email-based canonical reuse.
 * - New identities never attach to an existing email match through this
 *   Profile-only helper because Profile ownership belongs to the users package.
 *   Use `UserCollection.getOrCreateFromOidc()` for owner-aware verified-email
 *   reuse and its supported pre-provision resolver hook.
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
  return coordinateProfileOidcProvisioning(claims, provider, options);
}

/**
 * @internal Transactionally reuse one exact legacy issuer/subject link.
 *
 * This path cannot create or rebind authority. It intentionally preserves
 * existing tenant-scoped and non-Person Profile links; canonical global Person
 * validation remains mandatory for every path that creates a User/session.
 */
export async function reuseExistingOidcIdentityForProfile(
  profileId: string,
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
): Promise<{ profile: Profile; oidcIdentity: OidcIdentity; created: false }> {
  const normalizedClaims = normalizeOidcProfileClaims(claims);
  const db = await resolveOidcProfileDatabase(options.db);
  return coordinateOidcProvisioning({
    db,
    lockKeys: [
      `identity:${OidcIdentity.buildIdentityKey(
        normalizedClaims.iss,
        normalizedClaims.sub,
      )}`,
    ],
    isRaceConflict: isOidcProvisioningRaceConflict,
    createTransactionError: (message, cause) =>
      new Error(message, cause === undefined ? undefined : { cause }),
    createConcurrencyError: (cause) =>
      new Error(
        'Concurrent exact OIDC identity reuse did not converge.',
        cause === undefined ? undefined : { cause },
      ),
    rebindRootResult: rebindOidcProfileResult,
    provision: (tx) =>
      withSystemContext(async () => {
        const { OidcIdentityCollection } = await import(
          '../collections/OidcIdentityCollection'
        );
        const identity = await (
          await OidcIdentityCollection.create({ db: tx })
        ).findBySubject(normalizedClaims.iss, normalizedClaims.sub);
        if (!identity) {
          throw new Error(
            'OidcIdentity.findOrCreate() no longer creates authentication links; use UserCollection.getOrCreateFromOidc() or createProfileFromOidc().',
          );
        }
        if (identity.profileId !== profileId) {
          throw new Error(
            `OIDC identity ${normalizedClaims.iss} subject ${normalizedClaims.sub} belongs to a different Profile.`,
          );
        }
        const profile = await identity.getProfile();
        if (!profile) {
          throw new Error('The exact OIDC identity has no linked Profile.');
        }
        identity.provider = provider;
        if (normalizedClaims.email) identity.email = normalizedClaims.email;
        identity.lastUsedAt = new Date();
        await identity.save();
        return { profile, oidcIdentity: identity, created: false as const };
      }),
  });
}

async function coordinateProfileOidcProvisioning(
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
  const normalizedClaims = normalizeOidcProfileClaims(claims);
  const db = await resolveOidcProfileDatabase(options.db);
  return coordinateOidcProvisioning({
    db,
    lockKeys: [
      `identity:${OidcIdentity.buildIdentityKey(
        normalizedClaims.iss,
        normalizedClaims.sub,
      )}`,
      ...(normalizedClaims.email ? [`email:${normalizedClaims.email}`] : []),
    ],
    isRaceConflict: isOidcProvisioningRaceConflict,
    createTransactionError: (message, cause) =>
      new Error(message, cause === undefined ? undefined : { cause }),
    createConcurrencyError: (cause) =>
      new Error(
        'Concurrent OIDC Profile provisioning did not converge.',
        cause === undefined ? undefined : { cause },
      ),
    rebindRootResult: rebindOidcProfileResult,
    provision: (tx) =>
      withSystemContext(() =>
        provisionOidcProfile(normalizedClaims, provider, {
          ...options,
          db: tx,
        }),
      ),
  });
}

async function provisionOidcProfile(
  claims: {
    sub: string;
    iss: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    preferred_username?: string;
  },
  provider: string,
  options: SmrtObjectOptions & { db: DatabaseInterface },
): Promise<{ profile: Profile; oidcIdentity: OidcIdentity; created: boolean }> {
  const { OidcIdentityCollection } = await import(
    '../collections/OidcIdentityCollection'
  );
  const identityCollection = await OidcIdentityCollection.create(options);
  const existingIdentity = await identityCollection.findBySubject(
    claims.iss,
    claims.sub,
  );
  if (existingIdentity) {
    const profile = await existingIdentity.getProfile();
    if (!profile) {
      throw new Error('The exact OIDC identity has no linked Profile.');
    }
    if (claims.email) existingIdentity.email = claims.email;
    existingIdentity.lastUsedAt = new Date();
    await existingIdentity.save();
    return { profile, oidcIdentity: existingIdentity, created: false };
  }

  const { ProfileCollection } = await import(
    '../collections/ProfileCollection'
  );
  const profileCollection = await ProfileCollection.create(options);
  if (claims.email) {
    const collision = await profileCollection.findUniqueGlobalPersonByEmail(
      claims.email,
    );
    if (collision) {
      if (claims.email_verified !== true) {
        throw new Error(
          `OIDC email ${claims.email} is not verified and already belongs to a Profile.`,
        );
      }
      throw new Error(
        `OIDC email ${claims.email} already belongs to a Profile; createProfileFromOidc() cannot prove that Profile is unowned. Use UserCollection.getOrCreateFromOidc() for owner-aware linking.`,
      );
    }
  }

  const profile = await createOidcProvisioningPerson(options.db, {
    email: claims.email ?? '',
    name: claims.name,
    preferredUsername: claims.preferred_username,
    subject: claims.sub,
  });
  const oidcIdentity = await insertOidcProvisioningIdentity(options.db, {
    email: claims.email,
    issuer: claims.iss,
    profileId: requireOidcProfileId(profile.id),
    provider,
    subject: claims.sub,
  });
  return { profile, oidcIdentity, created: true };
}

async function rebindOidcProfileResult<
  T extends {
    profile: Profile;
    oidcIdentity: OidcIdentity;
    created: boolean;
  },
>(result: T, rootDb: DatabaseInterface): Promise<T> {
  const { OidcIdentityCollection } = await import(
    '../collections/OidcIdentityCollection'
  );
  const { ProfileCollection } = await import(
    '../collections/ProfileCollection'
  );
  const profileId = requireOidcProfileId(result.profile.id);
  const identityId = requireOidcProfileId(result.oidcIdentity.id);
  const [profile, oidcIdentity] = await withSystemContext(async () => {
    const profiles = await ProfileCollection.create({ db: rootDb });
    const identities = await OidcIdentityCollection.create({ db: rootDb });
    return Promise.all([
      profiles.get({ id: profileId }),
      identities.get({ id: identityId }),
    ]);
  });
  if (!profile || !oidcIdentity) {
    throw new Error(
      'Committed OIDC Profile provisioning result was not found.',
    );
  }
  return { ...result, profile, oidcIdentity };
}

function normalizeOidcProfileClaims(claims: {
  sub: string;
  iss: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}) {
  const sub = claims?.sub;
  const iss = claims?.iss;
  if (
    typeof sub !== 'string' ||
    sub.trim().length === 0 ||
    typeof iss !== 'string' ||
    iss.trim().length === 0
  ) {
    throw new Error(
      'Invalid OIDC claims: both "sub" and "iss" must be non-empty strings.',
    );
  }
  const suppliedEmail = claims.email;
  return {
    ...claims,
    sub,
    iss,
    email:
      typeof suppliedEmail === 'string' && suppliedEmail.trim()
        ? normalizeIdentityEmail(suppliedEmail)
        : undefined,
  };
}

function requireOidcProfileId(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('OIDC Profile provisioning did not produce an id.');
  }
  return value;
}

async function resolveOidcProfileDatabase(
  db: SmrtObjectOptions['db'],
): Promise<DatabaseInterface> {
  if (!db) {
    throw new Error(
      'OIDC Profile provisioning requires an initialized database.',
    );
  }
  return resolveDatabase(db as Parameters<typeof resolveDatabase>[0]);
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
  const normalizedEmail = normalizeIdentityEmail(email);

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
  const typeCollection = await ProfileTypeCollection.create(options);
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
