import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProfileCollection,
  ProfileMetadataCollection,
  ProfileMetafieldCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { describe, expect, it } from 'vitest';
import type { HelperContext, HelperPreferences } from './helper-preferences.js';
import {
  createHelperProfilePreferenceStore,
  HelperProfileStoreError,
} from './helper-profile-store.js';

const preferences: HelperPreferences = {
  version: 1,
  offeringId: 'happy',
  name: 'Happy',
  voiceId: 'marin',
  placement: 'bottom-right',
  heardSubtitles: true,
  spokenSubtitles: true,
};

async function setup() {
  const db = {
    type: 'sqlite' as const,
    url: `file:${join(tmpdir(), `helper-preferences-${randomUUID()}.db`)}`,
  };
  const types = await ProfileTypeCollection.create({ db });
  const type = await types.create({ name: 'Person' });
  await type.save();
  const profiles = await ProfileCollection.create({ db });
  const profile = await profiles.create({
    typeId: type.id,
    name: 'Ada',
    tenantId: 'tenant-a',
  });
  await profile.save();
  const fields = await ProfileMetafieldCollection.create({ db });
  const field = await fields.create({
    slug: 'app-helper-preferences',
    name: 'App helper preferences',
    tenantId: 'tenant-a',
  });
  await field.save();
  const context: HelperContext = {
    actorProfileId: 'actor-a',
    profileId: profile.id as string,
    tenantId: 'tenant-a',
    applicationId: 'app-a',
  };
  return { db, profile, field, context };
}

describe('ProfileHelperPreferenceStore (SQLite)', () => {
  it('durably replaces one complete preference value and writes an explicit clear marker', async () => {
    const { db, context } = await setup();
    const store = createHelperProfilePreferenceStore({
      db: await (await import('@happyvertical/sql')).getDatabase(db),
      applicationId: 'app-a',
      metafieldSlug: 'app-helper-preferences',
    });
    await store.save(context, preferences);
    await expect(store.load(context)).resolves.toBe(
      JSON.stringify(preferences),
    );
    await store.clear(context);
    await expect(store.load(context)).resolves.toBe(
      JSON.stringify({ version: 1, cleared: true }),
    );
  });

  it('rejects a profile/tenant mismatch and duplicate metadata rows', async () => {
    const { db, profile, field, context } = await setup();
    const database = await (await import('@happyvertical/sql')).getDatabase(db);
    const store = createHelperProfilePreferenceStore({
      db: database,
      applicationId: 'app-a',
      metafieldSlug: 'app-helper-preferences',
    });
    await expect(
      store.load({ ...context, tenantId: 'tenant-b' }),
    ).rejects.toBeInstanceOf(HelperProfileStoreError);
    await expect(
      store.load({ ...context, applicationId: 'app-b' }),
    ).rejects.toBeInstanceOf(HelperProfileStoreError);
    const metadata = await ProfileMetadataCollection.create({ db: database });
    for (let i = 0; i < 2; i++) {
      const row = await metadata.create({
        profileId: profile.id,
        metafieldId: field.id,
        tenantId: 'tenant-a',
        value: JSON.stringify(preferences),
      });
      await row.save();
    }
    await expect(store.load(context)).rejects.toBeInstanceOf(
      HelperProfileStoreError,
    );
  });
});
