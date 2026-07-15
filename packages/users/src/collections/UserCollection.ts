/**
 * UserCollection - Collection manager for User objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
import {
  AmbiguousOidcIdentityError,
  normalizeIdentityEmail,
  OidcIdentity,
  OidcIdentityCollection,
  type Profile,
  type ProfileCollection,
} from '@happyvertical/smrt-profiles';
import {
  coordinateOidcProvisioning,
  createOidcProvisioningPerson,
  insertOidcProvisioningIdentity,
  isOidcProvisioningRaceConflict,
  saveOidcRaceArbiter,
} from '@happyvertical/smrt-profiles/internal/oidc-provisioning';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { getDatabase } from '@happyvertical/sql';
import { USER_EMAIL_KEY_BACKFILL_NAME } from '../migrations/backfillUserEmailKeys.js';
import { User } from '../models/User.js';
import { UserStatus } from '../types/index.js';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

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

/** OIDC claims after the provisioning boundary validates and normalizes email. */
export type NormalizedOidcClaims = Readonly<OidcClaims & { email: string }>;

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

/** Context passed after OIDC claims are validated and before provisioning. */
export interface OidcProfileResolverContext {
  /** Transaction-bound database; use this for every resolver read/write. */
  db: DatabaseInterface;
  /**
   * Frozen normalized claim snapshot. OidcLoginService supplies
   * protocol-validated claims; direct collection callers must provide claims
   * from a trusted boundary.
   */
  claims: NormalizedOidcClaims;
  /** Configured provider key. */
  provider: string;
  /** Transaction-bound User collection. */
  users: UserCollection;
}

/**
 * Resolve a consumer-owned canonical Profile before User/session creation.
 *
 * Return `undefined` for the secure default, `null` to reject login, or a
 * Profile to select it explicitly. For a new issuer/subject, a supplied Profile
 * is still required to be the unique, unowned global Person for the verified
 * email. For an exact existing issuer/subject, `null` still rejects login and a
 * supplied Profile must be the already-linked Profile; the hook cannot rebind
 * identity authority. Stable-link owner and canonical-Person checks still
 * apply. The hook may be retried after a concurrent unique-key race and must
 * therefore be idempotent.
 */
export type OidcProfileResolver = (
  context: OidcProfileResolverContext,
) => Profile | null | undefined | Promise<Profile | null | undefined>;

/** Application authorization for binding a new OIDC identity to an owner. */
export interface OidcProfileOwnerAuthorization {
  /** Canonical global Person selected by the application. */
  profile: Profile;
  /** Existing User the application authorizes as that Profile's owner. */
  user: User;
}

/** Transaction-bound context supplied to the owner authorization callback. */
export type OidcProfileOwnerAuthorizerContext = OidcProfileResolverContext;

/**
 * Explicitly authorize first OIDC binding to a pre-provisioned Profile/User.
 *
 * Return `undefined` to preserve SMRT's secure default, `null` to reject the
 * login, or both the canonical Profile and its existing owning User. SMRT
 * reloads and verifies both records inside the provisioning transaction; the
 * returned objects are never trusted as proof of ownership. The callback may
 * be retried after a concurrent unique-key race and must be idempotent.
 */
export type OidcProfileOwnerAuthorizer = (
  context: OidcProfileOwnerAuthorizerContext,
) =>
  | OidcProfileOwnerAuthorization
  | null
  | undefined
  | Promise<OidcProfileOwnerAuthorization | null | undefined>;

export type OidcProvisioningErrorCode =
  | 'ambiguous_identity'
  | 'concurrency_conflict'
  | 'profile_owned'
  | 'rejected'
  | 'transaction_required'
  | 'user_email_backfill_required'
  | 'user_email_conflict';

/** Fail-closed OIDC identity provisioning error. */
export class OidcProvisioningError extends Error {
  constructor(
    readonly code: OidcProvisioningErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OidcProvisioningError';
  }
}

/**
 * Options for getOrCreateFromOidc
 */
export interface GetOrCreateFromOidcOptions {
  /** If false, skip recording login timestamp (default: true) */
  recordLogin?: boolean;
  /**
   * Provision a user even when the IdP explicitly reported the email as
   * unverified (`email_verified: false`). Default false (#1400): refuse to
   * create/resolve a user from a known-unverified address. Has no effect when
   * the claim is absent — an IdP that omits `email_verified` makes no
   * assertion, so it cannot be enforced.
   */
  allowUnverifiedEmail?: boolean;
  /**
   * Optional application resolver invoked inside the provisioning transaction
   * after token/claim validation and before OIDC identity, User, or session
   * creation. Return a canonical Profile, `null` to reject, or `undefined` to
   * use SMRT's secure default.
   */
  resolveProfile?: OidcProfileResolver;
  /**
   * Explicitly authorize a first issuer/subject binding to a pre-provisioned
   * canonical Profile and its existing owner. A successful authorization
   * requires `email_verified === true` and is revalidated atomically by SMRT.
   */
  authorizeProfileOwner?: OidcProfileOwnerAuthorizer;
}

/**
 * Collection for managing User objects
 */
export class UserCollection extends SmrtCollection<User> {
  static readonly _itemClass = User;
  private userEmailKeysReadyPromise: Promise<void> | null = null;

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
   * Direct callers must supply claims from a trusted, already validated token
   * boundary. OidcLoginService performs discovery, token exchange, issuer and
   * subject validation, and verified-email source pairing before calling this
   * collection method.
   *
   * @param claims - Trusted OIDC token claims (sub, iss, email, name)
   * @param provider - Provider name (e.g., 'kanidm', 'keycloak', 'google')
   * @param options - Login recording, unverified-email compatibility, Profile
   * resolution, and explicit owner authorization. Hooks run inside the
   * provisioning transaction, may be retried, and must be idempotent. A
   * resolver result must still be the unique, global, unowned Person. An owner
   * authorization must select both the canonical Person and its existing sole
   * approved User owner. Existing identities can only be confirmed, never
   * rebound.
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

    // Email is required for user creation and is canonicalized before any
    // resolver or persistence operation.
    const suppliedEmail = claims.email;
    if (typeof suppliedEmail !== 'string' || !suppliedEmail.trim()) {
      throw new Error(
        'OIDC claims missing required "email" for user creation.',
      );
    }
    const email = normalizeIdentityEmail(suppliedEmail);

    // #1400: refuse an email the IdP explicitly marked unverified. Only an
    // explicit `email_verified === false` hard-fails; an absent claim makes no
    // assertion and cannot be enforced. Opt out with allowUnverifiedEmail.
    const allowUnverified = options?.allowUnverifiedEmail === true;
    if (claims.email_verified === false && !allowUnverified) {
      throw new Error(
        'OIDC claims report an unverified email; refusing to provision a user.',
      );
    }

    const normalizedClaims: NormalizedOidcClaims = Object.freeze({
      ...claims,
      sub,
      iss,
      email,
    });
    const db = this.requireProvisioningDatabase();
    return coordinateOidcProvisioning({
      db,
      lockKeys: [
        `identity:${OidcIdentity.buildIdentityKey(iss, sub)}`,
        `email:${email}`,
      ],
      isRaceConflict: isUserOidcRaceConflict,
      createTransactionError: (message, cause) =>
        new OidcProvisioningError('transaction_required', message, {
          cause,
        }),
      createConcurrencyError: (cause) =>
        new OidcProvisioningError(
          'concurrency_conflict',
          'Concurrent OIDC provisioning did not converge on one identity.',
          { cause },
        ),
      rebindRootResult: (result, rootDb) =>
        this.rebindOidcProvisioningResult(result, rootDb),
      provision: (tx) =>
        withSystemContext(async () => {
          const users =
            tx === db ? this : await UserCollection.create({ db: tx });
          return users.provisionOidcIdentity(
            normalizedClaims,
            provider,
            options,
            tx,
          );
        }),
    });
  }

  private requireProvisioningDatabase(): DatabaseInterface {
    const db = this.options.db;
    if (!db || typeof db !== 'object' || !('query' in db)) {
      throw new OidcProvisioningError(
        'transaction_required',
        'OIDC provisioning requires an initialized database.',
      );
    }
    return db as DatabaseInterface;
  }

  private async provisionOidcIdentity(
    claims: NormalizedOidcClaims,
    provider: string,
    options: GetOrCreateFromOidcOptions | undefined,
    db: DatabaseInterface,
  ): Promise<OidcIdentityResult> {
    const { ProfileCollection } = await import('@happyvertical/smrt-profiles');
    const profileCollection = await ProfileCollection.create({ db });
    const identityCollection = await OidcIdentityCollection.create({ db });
    const existingIdentity = await this.findUniqueOidcIdentity(
      identityCollection,
      claims,
    );
    const createResolverContext = (): OidcProfileResolverContext => ({
      // Never expose the internal snapshot used for retry locks and
      // persistence. A frozen copy keeps an application callback from
      // changing the authenticated identity across attempts.
      claims: Object.freeze({ ...claims }),
      db,
      provider,
      users: this,
    });
    const resolvedProfile = options?.resolveProfile
      ? await options.resolveProfile(createResolverContext())
      : undefined;
    if (resolvedProfile === null) {
      throw new OidcProvisioningError(
        'rejected',
        'OIDC provisioning was rejected by the application resolver.',
      );
    }
    const ownerAuthorization = options?.authorizeProfileOwner
      ? await options.authorizeProfileOwner(createResolverContext())
      : undefined;
    if (ownerAuthorization === null) {
      throw new OidcProvisioningError(
        'rejected',
        'OIDC provisioning was rejected by the application owner authorizer.',
      );
    }
    const validatedOwnerAuthorization = ownerAuthorization
      ? await this.validateProfileOwnerAuthorization(
          ownerAuthorization,
          claims,
          profileCollection,
        )
      : undefined;
    if (
      validatedOwnerAuthorization &&
      resolvedProfile &&
      requireId(resolvedProfile.id, 'Resolved Profile') !==
        requireId(validatedOwnerAuthorization.profile.id, 'Authorized Profile')
    ) {
      throw new OidcProvisioningError(
        'rejected',
        'Application Profile resolution and owner authorization selected different Profiles.',
      );
    }

    if (existingIdentity) {
      const profileId = requireId(
        existingIdentity.profileId,
        'OIDC identity Profile',
      );
      if (
        resolvedProfile &&
        requireId(resolvedProfile.id, 'Resolved Profile') !== profileId
      ) {
        throw new OidcProvisioningError(
          'rejected',
          'An application resolver cannot rebind an existing OIDC identity.',
        );
      }
      if (
        validatedOwnerAuthorization &&
        requireId(
          validatedOwnerAuthorization.profile.id,
          'Authorized Profile',
        ) !== profileId
      ) {
        throw new OidcProvisioningError(
          'rejected',
          'An application owner authorizer cannot rebind an existing OIDC identity.',
        );
      }
      const owners = validatedOwnerAuthorization
        ? [validatedOwnerAuthorization.user]
        : await this.findProfileOwners(profileId);
      if (owners.length > 1) {
        throw new OidcProvisioningError(
          'profile_owned',
          `Profile ${profileId} belongs to multiple Users.`,
        );
      }
      const profile = validatedOwnerAuthorization
        ? validatedOwnerAuthorization.profile
        : await profileCollection.reserveCanonicalIdentityEmail(
            profileId,
            owners[0] ? undefined : claims.email,
          );

      const user = await this.finishUserProvisioning(
        profile,
        owners[0],
        claims.email,
        options,
      );
      existingIdentity.email = claims.email;
      existingIdentity.lastUsedAt = new Date();
      await existingIdentity.save();
      return {
        user,
        profile,
        oidcIdentity: existingIdentity,
        created: false,
      };
    }

    let profile: Profile | null | undefined =
      validatedOwnerAuthorization?.profile ?? resolvedProfile;
    let created = false;

    if (profile && !validatedOwnerAuthorization) {
      if (claims.email_verified !== true) {
        throw new OidcProvisioningError(
          'rejected',
          'An application resolver cannot reuse a Profile without a verified OIDC email.',
        );
      }
      profile = await profileCollection.reserveCanonicalIdentityEmail(
        requireId(profile.id, 'Resolved Profile'),
        claims.email,
      );
    } else if (claims.email_verified === true) {
      profile = await profileCollection.findUniqueGlobalPersonByEmail(
        claims.email,
      );
      if (profile) {
        profile = await profileCollection.reserveCanonicalIdentityEmail(
          requireId(profile.id, 'Matched Profile'),
          claims.email,
        );
      }
    } else {
      // Never link an unverified/unspecified email to an existing identity.
      const collision = await profileCollection.findUniqueGlobalPersonByEmail(
        claims.email,
      );
      if (collision) {
        throw new OidcProvisioningError(
          'rejected',
          `OIDC email ${claims.email} is not verified and already belongs to a Profile.`,
        );
      }
    }

    if (!profile) {
      profile = await createOidcProvisioningPerson<Profile>(db, {
        email: claims.email,
        name: claims.name,
        preferredUsername: claims.preferred_username,
        subject: claims.sub,
      });
      created = true;
    }

    const profileId = requireId(profile.id, 'OIDC Profile');
    const owners = validatedOwnerAuthorization
      ? [validatedOwnerAuthorization.user]
      : await this.findProfileOwners(profileId);
    if (owners.length > 0) {
      if (validatedOwnerAuthorization) {
        const oidcIdentity = await insertOidcProvisioningIdentity<OidcIdentity>(
          db,
          {
            email: claims.email,
            issuer: claims.iss,
            profileId,
            provider,
            subject: claims.sub,
          },
        );
        const user = await this.finishUserProvisioning(
          profile,
          validatedOwnerAuthorization.user,
          claims.email,
          options,
        );
        return { user, profile, oidcIdentity, created: false };
      }
      // A concurrent first login can commit the exact issuer+subject mapping
      // after this transaction's initial identity lookup but before its
      // profile ownership check. Re-read the durable identity arbiter before
      // rejecting the now-owned Profile so the same identity converges while
      // every different identity still fails closed.
      const concurrentIdentity = await this.findUniqueOidcIdentity(
        identityCollection,
        claims,
      );
      if (owners.length === 1 && concurrentIdentity?.profileId === profileId) {
        const user = await this.finishUserProvisioning(
          profile,
          owners[0],
          claims.email,
          options,
        );
        concurrentIdentity.email = claims.email;
        concurrentIdentity.lastUsedAt = new Date();
        await concurrentIdentity.save();
        return {
          user,
          profile,
          oidcIdentity: concurrentIdentity,
          created: false,
        };
      }
      throw new OidcProvisioningError(
        'profile_owned',
        `Profile ${profileId} already belongs to another User.`,
      );
    }

    // Initial lookup already proved this issuer+subject absent. Insert only:
    // a concurrent winner must surface the unique identity-key conflict so the
    // whole transaction rolls back and retries against the committed winner.
    const oidcIdentity = await insertOidcProvisioningIdentity<OidcIdentity>(
      db,
      {
        email: claims.email,
        issuer: claims.iss,
        profileId,
        provider,
        subject: claims.sub,
      },
    );
    const user = await this.finishUserProvisioning(
      profile,
      undefined,
      claims.email,
      options,
    );

    return { user, profile, oidcIdentity, created };
  }

  private async findProfileOwners(profileId: string): Promise<User[]> {
    const db = this.requireProvisioningDatabase();
    const lockClause = /^postgres(?:ql)?:/iu.test(db.url ?? '')
      ? ' FOR UPDATE'
      : '';
    const result = await db.query(
      `SELECT id
       FROM users
       WHERE profile_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 2${lockClause}`,
      profileId,
    );
    const owners = await Promise.all(
      result.rows.map((row) =>
        typeof row.id === 'string' ? this.get({ id: row.id }) : null,
      ),
    );
    return owners.filter((owner): owner is User => owner !== null);
  }

  private async validateProfileOwnerAuthorization(
    authorization: OidcProfileOwnerAuthorization,
    claims: NormalizedOidcClaims,
    profiles: ProfileCollection,
  ): Promise<OidcProfileOwnerAuthorization> {
    if (claims.email_verified !== true) {
      throw new OidcProvisioningError(
        'rejected',
        'Owner-authorized OIDC binding requires email_verified to be exactly true.',
      );
    }
    if (
      !authorization ||
      typeof authorization !== 'object' ||
      !authorization.profile ||
      !authorization.user
    ) {
      throw new OidcProvisioningError(
        'rejected',
        'Owner-authorized OIDC binding requires both a Profile and User.',
      );
    }

    const profileId = requireId(authorization.profile.id, 'Authorized Profile');
    const authorizedUserId = requireId(
      authorization.user.id,
      'Authorized User',
    );
    const profile = await profiles.reserveCanonicalIdentityEmail(
      profileId,
      claims.email,
    );
    const owners = await this.findProfileOwners(profileId);
    if (owners.length !== 1) {
      throw new OidcProvisioningError(
        'profile_owned',
        `Owner-authorized Profile ${profileId} must belong to exactly one User.`,
      );
    }
    const owner = owners[0];
    const ownerId = requireId(owner.id, 'Profile owner');
    if (ownerId !== authorizedUserId) {
      throw new OidcProvisioningError(
        'profile_owned',
        `Authorized User ${authorizedUserId} is not the owner of Profile ${profileId}.`,
      );
    }

    const emailUsers = await this.findUsersByNormalizedEmail(claims.email);
    if (
      emailUsers.length !== 1 ||
      requireId(emailUsers[0]?.id, 'Authorized email User') !== ownerId
    ) {
      throw new OidcProvisioningError(
        'user_email_conflict',
        'The authorized Profile owner does not have the verified OIDC email.',
      );
    }
    return { profile, user: owner };
  }

  private async rebindOidcProvisioningResult(
    result: OidcIdentityResult,
    rootDb: DatabaseInterface,
  ): Promise<OidcIdentityResult> {
    const profileId = requireId(result.profile.id, 'OIDC Profile');
    const identityId = requireId(result.oidcIdentity.id, 'OIDC identity');
    const userId = requireId(result.user.id, 'OIDC User');
    return withSystemContext(async () => {
      const { ProfileCollection } = await import(
        '@happyvertical/smrt-profiles'
      );
      const users = await UserCollection.create({ db: rootDb });
      const profiles = await ProfileCollection.create({ db: rootDb });
      const identities = await OidcIdentityCollection.create({ db: rootDb });
      const [user, profile, oidcIdentity] = await Promise.all([
        users.get({ id: userId }),
        profiles.get({ id: profileId }),
        identities.get({ id: identityId }),
      ]);
      if (!user || !profile || !oidcIdentity) {
        throw new OidcProvisioningError(
          'concurrency_conflict',
          'Committed OIDC provisioning result was not found.',
        );
      }
      return { ...result, user, profile, oidcIdentity };
    });
  }

  private async findUniqueOidcIdentity(
    identities: OidcIdentityCollection,
    claims: Pick<NormalizedOidcClaims, 'iss' | 'sub'>,
  ): Promise<OidcIdentity | undefined> {
    try {
      return (
        (await identities.findBySubject(claims.iss, claims.sub)) ?? undefined
      );
    } catch (error) {
      if (error instanceof AmbiguousOidcIdentityError) {
        throw new OidcProvisioningError(
          'ambiguous_identity',
          `Multiple OIDC identities exist for ${claims.iss} subject ${claims.sub}.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async finishUserProvisioning(
    profile: Profile,
    existingOwner: User | undefined,
    email: string,
    options: GetOrCreateFromOidcOptions | undefined,
  ): Promise<User> {
    const shouldRecordLogin = options?.recordLogin !== false;
    if (existingOwner) {
      if (shouldRecordLogin) {
        existingOwner.recordLogin();
        await existingOwner.save();
      }
      return existingOwner;
    }

    const emailUsers = await this.findUsersByNormalizedEmail(email);
    if (emailUsers.length > 0) {
      throw new OidcProvisioningError(
        'user_email_conflict',
        `A User already exists for ${email} without the selected Profile.`,
      );
    }

    return saveOidcRaceArbiter(() =>
      this.create({
        email,
        ...(shouldRecordLogin ? { lastLoginAt: new Date() } : {}),
        profileId: requireId(profile.id, 'OIDC Profile'),
        status: UserStatus.ACTIVE,
      }),
    );
  }

  private async findUsersByNormalizedEmail(email: string): Promise<User[]> {
    const db = this.requireProvisioningDatabase();
    await this.ensureUserEmailKeysReady(db);
    const result = await db.query(
      `SELECT id, email, email_key
       FROM users
       WHERE email_key = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 2`,
      email,
    );
    for (const row of result.rows) {
      this.assertUserEmailKeyCurrent(row, email);
    }
    const users = await Promise.all(
      result.rows.map((row) =>
        typeof row.id === 'string' ? this.get({ id: row.id }) : null,
      ),
    );
    return users.filter((user): user is User => user !== null);
  }

  /** Require the deploy-time backfill marker before indexed identity reads. */
  private async ensureUserEmailKeysReady(db: DatabaseInterface): Promise<void> {
    if (!this.userEmailKeysReadyPromise) {
      this.userEmailKeysReadyPromise = this.checkUserEmailKeysReady(db).catch(
        (error) => {
          this.userEmailKeysReadyPromise = null;
          throw error;
        },
      );
    }
    return this.userEmailKeysReadyPromise;
  }

  private async checkUserEmailKeysReady(db: DatabaseInterface): Promise<void> {
    if (
      await new BackfillTracker({ db }).isApplied(USER_EMAIL_KEY_BACKFILL_NAME)
    )
      return;
    throw new OidcProvisioningError(
      'user_email_backfill_required',
      'User email keys are not marked ready; run backfillUserEmailKeys() before OIDC provisioning.',
    );
  }

  private assertUserEmailKeyCurrent(
    row: Record<string, unknown>,
    normalizedEmail?: string,
  ): void {
    const storedEmail = typeof row.email === 'string' ? row.email : '';
    const expectedKey = storedEmail.trim()
      ? normalizeIdentityEmail(storedEmail)
      : null;
    const storedKey = typeof row.email_key === 'string' ? row.email_key : null;
    if (
      storedKey !== expectedKey ||
      (normalizedEmail !== undefined && expectedKey !== normalizedEmail)
    ) {
      throw new OidcProvisioningError(
        'user_email_backfill_required',
        `User ${String(row.id ?? '<unknown>')} has a missing or stale email key; run backfillUserEmailKeys() before OIDC provisioning.`,
      );
    }
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} did not produce an id.`);
  }
  return value;
}

function isUserOidcRaceConflict(error: unknown): boolean {
  return isOidcProvisioningRaceConflict(error, {
    messagePatterns: [/users[._].*profile_id|users_profile_id/iu],
  });
}
