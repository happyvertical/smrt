import {
  ProfileCollection,
  ProfileMetadataCollection,
  ProfileMetafieldCollection,
} from '@happyvertical/smrt-profiles';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  HELPER_PREFERENCES_VERSION,
  type HelperContext,
  type HelperPreferenceStore,
  type HelperPreferences,
} from './helper-preferences.js';

export class HelperProfileStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperProfileStoreError';
  }
}

export interface HelperProfilePreferenceStoreOptions {
  db: DatabaseInterface;
  /** Trusted application binding; one app must never read another app's field. */
  applicationId: string;
  /** Pre-provisioned per-application ProfileMetafield slug. */
  metafieldSlug: string;
}

/**
 * Canonical Profile metadata adapter. It deliberately does not authorize an
 * actor: `HelperPreferencesService` owns that policy decision. This adapter
 * binds every read and write to the requested profile and tenant, detects
 * duplicate metadata rows, and stores one versioned JSON value.
 */
export class ProfileHelperPreferenceStore implements HelperPreferenceStore {
  readonly #db: DatabaseInterface;
  readonly #metafieldSlug: string;
  readonly #applicationId: string;

  constructor(options: HelperProfilePreferenceStoreOptions) {
    this.#db = options.db;
    this.#metafieldSlug = options.metafieldSlug;
    this.#applicationId = options.applicationId;
  }

  async load(context: HelperContext): Promise<unknown | null> {
    const { profile, metafield, metadata } = await this.#boundRecords(context);
    const rows = await metadata.list({
      where: { profileId: profile.id, metafieldId: metafield.id },
    });
    if (rows.length > 1) {
      throw new HelperProfileStoreError(
        'Duplicate helper preference metadata rows.',
      );
    }
    const row = rows[0];
    if (!row) return null;
    if ((row.tenantId ?? null) !== (profile.tenantId ?? null)) {
      throw new HelperProfileStoreError(
        'Helper preference metadata tenant mismatch.',
      );
    }
    return row.value;
  }

  async save(context: HelperContext, value: HelperPreferences): Promise<void> {
    const { profile, metafield, metadata } = await this.#boundRecords(context);
    const rows = await metadata.list({
      where: { profileId: profile.id, metafieldId: metafield.id },
    });
    if (rows.length > 1) {
      throw new HelperProfileStoreError(
        'Duplicate helper preference metadata rows.',
      );
    }
    const serialized = JSON.stringify(value);
    const row = rows[0];
    if (row) {
      if ((row.tenantId ?? null) !== (profile.tenantId ?? null)) {
        throw new HelperProfileStoreError(
          'Helper preference metadata tenant mismatch.',
        );
      }
      row.value = serialized;
      await row.save();
      return;
    }
    const created = await metadata.create({
      profileId: profile.id as string,
      metafieldId: metafield.id as string,
      value: serialized,
      tenantId: profile.tenantId ?? null,
    });
    await created.save();
  }

  async clear(context: HelperContext): Promise<void> {
    const { profile, metafield, metadata } = await this.#boundRecords(context);
    const rows = await metadata.list({
      where: { profileId: profile.id, metafieldId: metafield.id },
    });
    if (rows.length > 1)
      throw new HelperProfileStoreError(
        'Duplicate helper preference metadata rows.',
      );
    const serialized = JSON.stringify({
      version: HELPER_PREFERENCES_VERSION,
      cleared: true,
    });
    const row = rows[0];
    if (row) {
      if ((row.tenantId ?? null) !== (profile.tenantId ?? null)) {
        throw new HelperProfileStoreError(
          'Helper preference metadata tenant mismatch.',
        );
      }
      row.value = serialized;
      await row.save();
      return;
    }
    const created = await metadata.create({
      profileId: profile.id as string,
      metafieldId: metafield.id as string,
      value: serialized,
      tenantId: profile.tenantId ?? null,
    });
    await created.save();
  }

  async #boundRecords(context: HelperContext) {
    if (context.applicationId !== this.#applicationId) {
      throw new HelperProfileStoreError(
        'Helper preference application mismatch.',
      );
    }
    const profiles = await ProfileCollection.create({ db: this.#db });
    const profile = await profiles.get({ id: context.profileId });
    if (!profile || (profile.tenantId ?? null) !== context.tenantId) {
      throw new HelperProfileStoreError(
        'Helper preference profile is unavailable.',
      );
    }
    const metafields = await ProfileMetafieldCollection.create({
      db: this.#db,
    });
    const candidates = await metafields.list({
      where: { slug: this.#metafieldSlug },
    });
    const matching = candidates.filter(
      (field) => (field.tenantId ?? null) === (profile.tenantId ?? null),
    );
    const global = candidates.filter((field) => field.tenantId === null);
    const chosen = matching[0] ?? global[0];
    if (
      !chosen ||
      matching.length > 1 ||
      (matching.length === 0 && global.length > 1)
    ) {
      throw new HelperProfileStoreError(
        'The pre-provisioned helper preference metafield is unavailable or ambiguous.',
      );
    }
    return {
      profile,
      metafield: chosen,
      metadata: await ProfileMetadataCollection.create({ db: this.#db }),
    };
  }
}

export function createHelperProfilePreferenceStore(
  options: HelperProfilePreferenceStoreOptions,
): ProfileHelperPreferenceStore {
  return new ProfileHelperPreferenceStore(options);
}
