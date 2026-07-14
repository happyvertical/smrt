/**
 * ProfileCollection - Collection manager for Profile objects
 *
 * Provides advanced querying and batch operations for Profile entities.
 */

import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  getOwnedAssetsFromCollection,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import { SmrtCollection, ValidationError } from '@happyvertical/smrt-core';
import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
import {
  queryGlobal,
  queryWithGlobals,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import type { getDatabase } from '@happyvertical/sql';
import { normalizeIdentityEmail } from '../auth/normalizeIdentityEmail';
import { isOidcAbortedTransactionError } from '../auth/oidcProvisioningCoordinator';
import { PROFILE_EMAIL_KEY_BACKFILL_NAME } from '../migrations/backfillProfileEmailKeys.js';
import { OidcProfileEmailReservation } from '../models/OidcProfileEmailReservation';
import { Profile } from '../models/Profile';
import { OidcProfileEmailReservationCollection } from './OidcProfileEmailReservationCollection';

const PERSON_META_TYPES = new Set([
  '@happyvertical/smrt-profiles:Person',
  'Person',
]);

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

export type CanonicalPersonProfileErrorCode =
  | 'ambiguous_email'
  | 'email_key_backfill_required'
  | 'email_mismatch'
  | 'missing_profile'
  | 'non_person'
  | 'reservation_conflict'
  | 'tenant_scoped';

/** A Profile cannot safely represent one global human identity. */
export class CanonicalPersonProfileError extends Error {
  constructor(
    readonly code: CanonicalPersonProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalPersonProfileError';
  }
}

interface CanonicalProfileRow extends Record<string, unknown> {
  _meta_type?: unknown;
  email?: unknown;
  email_key?: unknown;
  id?: unknown;
  tenant_id?: unknown;
}

export class ProfileCollection extends SmrtCollection<Profile> {
  static readonly _itemClass = Profile;
  private emailKeysReadyPromise: Promise<void> | null = null;

  /**
   * Find a profile by email address
   *
   * @param email - The email address to search for
   * @returns The matching profile or null
   */
  async findByEmail(email: string): Promise<Profile | null> {
    const normalizedEmail = normalizeIdentityEmail(email);
    const profiles = await this.list({
      where: { email: normalizedEmail },
      limit: 1,
    });
    return profiles[0] ?? null;
  }

  /**
   * Resolve one unambiguous global Person by normalized email.
   *
   * Unlike `findByEmail()`, this identity-boundary helper deliberately reads
   * across tenant scopes and fails closed when any matching row is
   * tenant-scoped, is not a Person STI row, or when more than one row matches
   * case-insensitively. It is intended for verified external identities.
   */
  async findUniqueGlobalPersonByEmail(email: string): Promise<Profile | null> {
    const normalizedEmail = normalizeIdentityEmail(email);
    const rows = await this.loadCanonicalEmailRows(normalizedEmail);

    if (rows.length === 0) return null;
    this.assertCanonicalRows(rows, normalizedEmail);
    return this.requireHydratedProfile(readRequiredString(rows[0], 'id'));
  }

  /**
   * Validate and hydrate a supplied canonical Profile.
   *
   * The Profile must be the sole case-insensitive match for its stored email.
   * When `email` is provided, that address must also match the stored email.
   */
  async requireCanonicalGlobalPerson(
    profileId: string,
    email?: string,
  ): Promise<Profile> {
    const db = this.requireDatabase();
    await this.ensureEmailKeysReady();
    const result = await withSystemContext(() =>
      db.query(
        `SELECT id, tenant_id, _meta_type, email, email_key
         FROM profiles
         WHERE id = ?
         LIMIT 1`,
        profileId,
      ),
    );
    const row = result.rows[0] as CanonicalProfileRow | undefined;

    if (!row) {
      throw new CanonicalPersonProfileError(
        'missing_profile',
        `Profile ${profileId} does not exist.`,
      );
    }

    this.assertRowEmailKeyCurrent(row);
    this.assertCanonicalRows([row]);

    const storedEmail = readString(row, 'email');
    const normalizedEmail =
      email !== undefined
        ? normalizeIdentityEmail(email)
        : storedEmail
          ? normalizeIdentityEmail(storedEmail)
          : undefined;
    if (normalizedEmail !== undefined) {
      const matches = await this.loadCanonicalEmailRows(normalizedEmail);
      this.assertCanonicalRows(matches, normalizedEmail);
      if (
        matches.length !== 1 ||
        readRequiredString(matches[0], 'id') !== profileId
      ) {
        throw new CanonicalPersonProfileError(
          'email_mismatch',
          `Profile ${profileId} is not the unique global Person for ${normalizedEmail}.`,
        );
      }
    }

    return this.requireHydratedProfile(profileId);
  }

  /**
   * Reserve the normalized email for a previously validated canonical Person.
   *
   * The unique stored key turns a concurrent OIDC first-login race into a
   * retryable database conflict. Legacy Profiles remain unaffected until an
   * identity boundary safely claims them.
   */
  async reserveCanonicalIdentityEmail(
    profileId: string,
    email?: string,
  ): Promise<Profile> {
    const profile = await this.requireCanonicalGlobalPerson(profileId, email);
    const normalizedEmail =
      email !== undefined
        ? normalizeIdentityEmail(email)
        : profile.email?.trim()
          ? normalizeIdentityEmail(profile.email)
          : null;
    const db = this.requireDatabase();
    const reservations = await OidcProfileEmailReservationCollection.create({
      db,
    });
    const byProfile = await reservations.list({
      where: { profileId },
      limit: 2,
    });
    if (byProfile.length > 1) {
      throw new CanonicalPersonProfileError(
        'ambiguous_email',
        `Multiple canonical identity reservations exist for Profile ${profileId}.`,
      );
    }
    if (normalizedEmail === null) {
      await byProfile[0]?.delete();
      return profile;
    }

    const byEmail = await reservations.list({
      where: { emailKey: normalizedEmail },
      limit: 2,
    });
    const activeEmailReservations: typeof byEmail = [];
    for (const reservation of byEmail) {
      if (
        reservation.profileId !== profileId &&
        (await this.isStaleEmailReservation(reservation, normalizedEmail))
      ) {
        await reservation.delete();
      } else {
        activeEmailReservations.push(reservation);
      }
    }
    const conflictingEmail = activeEmailReservations.find(
      (reservation) => reservation.profileId !== profileId,
    );
    if (conflictingEmail) {
      throw new CanonicalPersonProfileError(
        'reservation_conflict',
        `${normalizedEmail} is already reserved for a different canonical Person.`,
      );
    }
    if (activeEmailReservations.length > 1) {
      throw new CanonicalPersonProfileError(
        'ambiguous_email',
        `Multiple canonical identity reservations exist for ${normalizedEmail}.`,
      );
    }

    const existing = byProfile[0];
    if (existing) {
      if (existing.emailKey !== normalizedEmail) {
        existing.emailKey = normalizedEmail;
        await saveIdentityEmailReservation(existing, normalizedEmail);
      }
      return profile;
    }
    if (!activeEmailReservations[0]) {
      const reservation = new OidcProfileEmailReservation({
        db,
        emailKey: normalizedEmail,
        profileId,
      });
      await reservation.initialize();
      await saveIdentityEmailReservation(reservation, normalizedEmail);
    }
    return profile;
  }

  /**
   * Find profiles by type slug
   *
   * @param typeSlug - The profile type slug to filter by
   * @returns Array of matching profiles
   */
  async findByType(typeSlug: string): Promise<Profile[]> {
    // Will use eager loading when available
    const allProfiles = await this.list({});

    const filtered: Profile[] = [];
    for (const profile of allProfiles) {
      const slug = await profile.getTypeSlug();
      if (slug === typeSlug) {
        filtered.push(profile);
      }
    }

    return filtered;
  }

  private requireDatabase(): DatabaseInterface {
    const db = this.options.db;
    if (!db || typeof db !== 'object' || !('query' in db)) {
      throw new Error(
        'Canonical Profile identity resolution requires an initialized database.',
      );
    }
    return db as DatabaseInterface;
  }

  private async loadCanonicalEmailRows(
    normalizedEmail: string,
  ): Promise<CanonicalProfileRow[]> {
    const db = this.requireDatabase();
    await this.ensureEmailKeysReady();
    const result = await withSystemContext(async () => {
      return db.query(
        `SELECT id, tenant_id, _meta_type, email, email_key
         FROM profiles
         WHERE email_key = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 2`,
        normalizedEmail,
      );
    });
    const rows = result.rows as CanonicalProfileRow[];
    for (const row of rows) this.assertRowEmailKeyCurrent(row, normalizedEmail);
    return rows;
  }

  /** Require the deploy-time backfill marker before indexed identity reads. */
  private async ensureEmailKeysReady(): Promise<void> {
    if (!this.emailKeysReadyPromise) {
      this.emailKeysReadyPromise = this.checkEmailKeysReady().catch((error) => {
        this.emailKeysReadyPromise = null;
        throw error;
      });
    }
    return this.emailKeysReadyPromise;
  }

  private async checkEmailKeysReady(): Promise<void> {
    const db = this.requireDatabase();
    if (
      await new BackfillTracker({ db }).isApplied(
        PROFILE_EMAIL_KEY_BACKFILL_NAME,
      )
    )
      return;
    throw new CanonicalPersonProfileError(
      'email_key_backfill_required',
      'Profile identity email keys are not marked ready; run backfillProfileEmailKeys() before identity lookup.',
    );
  }

  private async isStaleEmailReservation(
    reservation: OidcProfileEmailReservation,
    reservedEmail: string,
  ): Promise<boolean> {
    const profileId = reservation.profileId;
    if (!profileId) return true;
    const result = await this.requireDatabase().query(
      'SELECT email FROM profiles WHERE id = ? LIMIT 1',
      profileId,
    );
    const row = result.rows[0] as CanonicalProfileRow | undefined;
    if (!row) return true;
    const email = readString(row, 'email');
    return !email?.trim() || normalizeIdentityEmail(email) !== reservedEmail;
  }

  private assertRowEmailKeyCurrent(
    row: CanonicalProfileRow,
    normalizedEmail?: string,
  ): void {
    const email = readString(row, 'email') ?? '';
    const expectedKey = email.trim() ? normalizeIdentityEmail(email) : null;
    const storedKey = readString(row, 'email_key') ?? null;
    if (
      storedKey !== expectedKey ||
      (normalizedEmail !== undefined && expectedKey !== normalizedEmail)
    ) {
      throw new CanonicalPersonProfileError(
        'email_key_backfill_required',
        `Profile ${String(row.id ?? '<unknown>')} has a missing or stale identity email key; run backfillProfileEmailKeys() before identity lookup.`,
      );
    }
  }

  private assertCanonicalRows(
    rows: CanonicalProfileRow[],
    normalizedEmail?: string,
  ): void {
    const tenantScoped = rows.find((row) => readString(row, 'tenant_id'));
    if (tenantScoped) {
      throw new CanonicalPersonProfileError(
        'tenant_scoped',
        `Profile ${readRequiredString(tenantScoped, 'id')} for ${normalizedEmail ?? 'the supplied identity'} is tenant-scoped.`,
      );
    }

    const nonPerson = rows.find(
      (row) => !PERSON_META_TYPES.has(readString(row, '_meta_type') ?? ''),
    );
    if (nonPerson) {
      throw new CanonicalPersonProfileError(
        'non_person',
        `Profile ${readRequiredString(nonPerson, 'id')} for ${normalizedEmail ?? 'the supplied identity'} is not a Person.`,
      );
    }

    if (rows.length > 1) {
      throw new CanonicalPersonProfileError(
        'ambiguous_email',
        `Multiple Profiles use ${normalizedEmail ?? 'the supplied identity email'}.`,
      );
    }
  }

  private async requireHydratedProfile(profileId: string): Promise<Profile> {
    const profile = await withSystemContext(() => this.get({ id: profileId }));
    if (!profile) {
      throw new CanonicalPersonProfileError(
        'missing_profile',
        `Profile ${profileId} could not be hydrated.`,
      );
    }
    return profile;
  }

  /**
   * Batch get metadata for multiple profiles
   *
   * @param profileIds - Array of profile UUIDs
   * @returns Map of profile ID to metadata object
   */
  async batchGetMetadata(
    profileIds: string[],
  ): Promise<Map<string, Record<string, string>>> {
    const result = new Map<string, Record<string, string>>();

    for (const profileId of profileIds) {
      const profile = await this.get({ id: profileId });
      if (profile) {
        const metadata = await profile.getMetadata();
        result.set(profileId, metadata);
      }
    }

    return result;
  }

  /**
   * Batch update metadata for multiple profiles
   *
   * @param updates - Array of { profileId, data } objects
   */
  async batchUpdateMetadata(
    updates: Array<{ profileId: string; data: Record<string, unknown> }>,
  ): Promise<void> {
    for (const update of updates) {
      const profile = await this.get({ id: update.profileId });
      if (profile) {
        await profile.updateMetadata(update.data);
      }
    }
  }

  /**
   * Find related profiles for a given profile
   *
   * @param profileId - The profile UUID
   * @param relationshipSlug - Optional filter by relationship type
   * @returns Array of related profiles
   */
  async findRelated(
    profileId: string,
    relationshipSlug?: string,
  ): Promise<Profile[]> {
    const profile = await this.get({ id: profileId });
    if (!profile) return [];

    return await profile.getRelatedProfiles(relationshipSlug);
  }

  async getAssets(profileId: string, relationship?: string): Promise<Asset[]> {
    return getOwnedAssetsFromCollection(this, profileId, relationship);
  }

  async addAsset(
    profileId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    await addOwnedAssetFromCollection(
      this,
      'Profile',
      profileId,
      asset,
      relationship,
      sortOrder,
    );
  }

  async removeAsset(
    profileId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await removeOwnedAssetFromCollection(
      this,
      'Profile',
      profileId,
      assetId,
      relationship,
    );
  }

  /**
   * Get the relationship network for a profile up to a maximum depth
   *
   * @param profileId - The starting profile UUID
   * @param options - Configuration options
   * @returns Map of profile ID to depth level
   */
  async getRelationshipNetwork(
    profileId: string,
    options: { maxDepth?: number } = {},
  ): Promise<Map<string, number>> {
    const maxDepth = options.maxDepth || 2;
    const network = new Map<string, number>();
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [
      { id: profileId, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      if (visited.has(current.id) || current.depth > maxDepth) {
        continue;
      }

      visited.add(current.id);
      network.set(current.id, current.depth);

      if (current.depth < maxDepth) {
        const related = await this.findRelated(current.id);
        for (const profile of related) {
          if (profile.id && !visited.has(profile.id)) {
            queue.push({ id: profile.id, depth: current.depth + 1 });
          }
        }
      }
    }

    return network;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant-scoped helper methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find all profiles belonging to a specific tenant
   *
   * @param tenantId - The tenant UUID to filter by
   * @returns Array of profiles for this tenant
   */
  async findByTenant(tenantId: string): Promise<Profile[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global profiles (no tenant association).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of profiles with null tenantId
   */
  async findGlobal(): Promise<Profile[]> {
    return queryGlobal<Profile>(this);
  }

  /**
   * Find profiles belonging to a tenant plus all global profiles.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - The tenant UUID to include
   * @returns Array of tenant-specific and global profiles
   */
  async findWithGlobals(tenantId: string): Promise<Profile[]> {
    return queryWithGlobals<Profile>(this, tenantId, 'Profile.findWithGlobals');
  }
}

async function saveIdentityEmailReservation(
  reservation: OidcProfileEmailReservation,
  normalizedEmail: string,
): Promise<void> {
  try {
    await reservation.save();
  } catch (error) {
    if (
      (error instanceof ValidationError &&
        error.code === 'VALIDATION_UNIQUE_CONSTRAINT') ||
      isOidcAbortedTransactionError(error)
    ) {
      throw new CanonicalPersonProfileError(
        'reservation_conflict',
        `${normalizedEmail} was concurrently reserved for another canonical Person.`,
      );
    }
    throw error;
  }
}

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRequiredString(row: Record<string, unknown>, key: string): string {
  const value = readString(row, key);
  if (!value) {
    throw new Error(`Canonical Profile identity row is missing ${key}.`);
  }
  return value;
}
