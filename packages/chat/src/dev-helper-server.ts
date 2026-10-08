import { createAssetRuntime } from '@happyvertical/smrt-assets';
import {
  type PhotoCutoutProfileOwner,
  PhotoCutoutProfileStore,
} from '@happyvertical/smrt-images';
import { ProfileCollection } from '@happyvertical/smrt-profiles';
import { getDatabase } from '@happyvertical/sql';
import type {
  HelperContext,
  HelperOffering,
  HelperPolicy,
} from './helper-preferences.js';
import { HelperPreferencesService } from './helper-preferences-service.js';
import { createHelperProfilePreferenceStore } from './helper-profile-store.js';
import type { DevCharacterPersistenceConfig } from './routes/api/dev-character-persistence/config.js';

export const DEV_HELPER_APPLICATION_ID = 'smrt-chat-dev-helper';
export const DEV_HELPER_PREFERENCES_METAFIELD =
  'smrt-chat-dev-helper-preferences';

const DEFAULT_PREFERENCES = {
  version: 1 as const,
  offeringId: 'happy',
  name: 'Happy',
  voiceId: 'marin',
  placement: 'bottom-right' as const,
  heardSubtitles: true,
  spokenSubtitles: true,
};
// The opt-in workbench is one local process. Profile metadata offers
// whole-value last-successful-write-wins, so serialize its first-write window
// here; this is intentionally not a distributed locking claim.
const localWrites = new Map<string, Promise<void>>();

export async function serializeDevHelperWrite<T>(
  config: DevCharacterPersistenceConfig,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${config.databaseUrl}\u0000${config.profileId}\u0000${DEV_HELPER_APPLICATION_ID}`;
  const previous = localWrites.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => current);
  localWrites.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localWrites.get(key) === tail) localWrites.delete(key);
  }
}

function asOwner(
  profile: {
    id?: string | null;
    tenantId?: string | null;
    getAssets: PhotoCutoutProfileOwner['getAssets'];
    addAsset: PhotoCutoutProfileOwner['addAsset'];
  } | null,
): PhotoCutoutProfileOwner | null {
  if (!profile || typeof profile.id !== 'string') return null;
  return {
    id: profile.id,
    tenantId: profile.tenantId ?? null,
    getAssets: profile.getAssets.bind(profile),
    addAsset: profile.addAsset.bind(profile),
  };
}

/**
 * Builds the deliberately local workbench policy. Production hosts must pass
 * authenticated context and their own policy resolver instead of using this.
 */
export async function openDevHelperService(
  config: DevCharacterPersistenceConfig,
) {
  const db = await getDatabase({ type: 'sqlite', url: config.databaseUrl });
  const profiles = await ProfileCollection.create({ db });
  const runtime = await createAssetRuntime({
    db,
    storage: config.assetDirectory,
  });
  const photos = new PhotoCutoutProfileStore({
    runtime,
    getProfile: async (id) => asOwner(await profiles.get({ id })),
    authorize: ({ actorProfileId, profile, tenantId }) =>
      actorProfileId === config.profileId &&
      profile.id === config.profileId &&
      tenantId === config.tenantId,
  });
  const context: HelperContext = {
    actorProfileId: config.profileId,
    profileId: config.profileId,
    tenantId: config.tenantId,
    applicationId: DEV_HELPER_APPLICATION_ID,
  };
  const policy = async (): Promise<HelperPolicy> => {
    const saved = await photos.list({
      actorProfileId: context.actorProfileId,
      profileId: context.profileId,
      tenantId: context.tenantId,
    });
    return {
      selection: 'app-default-with-personal-override',
      defaultPreferences: DEFAULT_PREFERENCES,
      offerings: [
        { id: 'happy', label: 'Happy', styleId: 'happy', source: 'ready-made' },
        ...saved.map((entry, index) => ({
          id: `photo:${entry.assetId}`,
          label: entry.name
            ? `${entry.name} (${new Date(entry.savedAt).toLocaleDateString('en-CA')}, ${saved.length - index})`
            : `Saved photo helper ${saved.length - index}`,
          styleId: 'photo-cutout',
          source: 'saved' as const,
          assetId: entry.assetId,
        })),
      ],
      voices: [
        { id: 'marin', label: 'Marin' },
        { id: 'cedar', label: 'Cedar' },
      ],
      customizable: [
        'offeringId',
        'name',
        'voiceId',
        'placement',
        'heardSubtitles',
        'spokenSubtitles',
      ],
      customStyleIds: ['photo-cutout'],
    };
  };
  const service = new HelperPreferencesService({
    store: createHelperProfilePreferenceStore({
      db,
      applicationId: DEV_HELPER_APPLICATION_ID,
      metafieldSlug: DEV_HELPER_PREFERENCES_METAFIELD,
    }),
    authorize: (candidate) =>
      candidate.actorProfileId === context.actorProfileId &&
      candidate.profileId === context.profileId &&
      candidate.tenantId === context.tenantId &&
      candidate.applicationId === context.applicationId,
    resolvePolicy: policy,
    styleIds: ['happy', 'photo-cutout'],
    validateOffering: async (_candidate, offering: HelperOffering) => {
      if (offering.source !== 'saved' || !offering.assetId) return;
      const selected = await photos.load({
        actorProfileId: context.actorProfileId,
        profileId: context.profileId,
        tenantId: context.tenantId,
        assetId: offering.assetId,
      });
      if (!selected) throw new Error('Saved helper is unavailable.');
    },
  });
  return {
    context,
    photos,
    service,
    close: async () => db.close?.(),
  };
}
