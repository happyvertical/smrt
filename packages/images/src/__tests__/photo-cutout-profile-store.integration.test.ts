import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import type { DatabaseInterface } from '@happyvertical/sql';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { PhotoCutoutProfileStore } from '../photo-cutout-profile-store.js';
import { assembleCanadianSplitRig } from '../photo-cutout-setup.js';

const rig = assembleCanadianSplitRig({
  outline: {
    points: [
      { x: 200, y: 100 },
      { x: 800, y: 100 },
      { x: 940, y: 500 },
      { x: 760, y: 900 },
      { x: 240, y: 900 },
      { x: 60, y: 500 },
    ],
  },
  landmarks: {
    mouthLeft: { x: 350, y: 550 },
    mouthRight: { x: 650, y: 550 },
    chin: { x: 500, y: 850 },
  },
  assetId: 'transient-source',
  width: 100,
  height: 120,
});

describe('PhotoCutoutProfileStore SQLite integration', () => {
  let db: DatabaseInterface | undefined;
  let storageDir: string | undefined;

  afterEach(async () => {
    await db?.close?.();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  it('uses one SQLite transaction executor for owner-bound asset/link persistence and reload', async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    storageDir = mkdtempSync(join(tmpdir(), 'photo-cutout-profile-'));
    const png = await sharp({
      create: {
        width: 100,
        height: 120,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    if (!storageDir) throw new Error('Missing temporary asset storage');
    const storage = storageDir;

    let profileId = '';
    let assetId = '';
    await db.transaction(async (tx) => {
      const types = await ProfileTypeCollection.create({ db: tx });
      const profiles = await ProfileCollection.create({ db: tx });
      const type = await types.create({ name: 'Person' });
      await type.save();
      const profile = await profiles.create({
        typeId: type.id,
        name: 'Owner',
        tenantId: 'tenant-a',
      });
      await profile.save();
      profileId = profile.id as string;

      const runtime = await createAssetRuntime({
        db: tx,
        storage,
      });
      const store = new PhotoCutoutProfileStore({
        runtime,
        getProfile: async (id) => profiles.get({ id }),
        authorize: ({ actorProfileId, profile: target }) =>
          actorProfileId === target.id,
      });
      const saved = await store.save({
        actorProfileId: profileId,
        profileId,
        tenantId: 'tenant-a',
        png,
        rig,
      });
      assetId = saved.assetId;
      expect(
        (await profile.getAssets('character_cutout')).map((asset) => asset.id),
      ).toEqual([assetId]);
      expect(
        await store.load({
          actorProfileId: profileId,
          profileId,
          tenantId: 'tenant-a',
        }),
      ).toMatchObject({
        assetId,
        png,
      });
    });

    const profiles = await ProfileCollection.create({ db });
    const persisted = await profiles.get({ id: profileId });
    expect((await persisted?.getAssets('character_cutout'))?.[0]?.id).toBe(
      assetId,
    );
  });

  it('denies another actor and another tenant before the transaction writes an asset', async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    storageDir = mkdtempSync(join(tmpdir(), 'photo-cutout-profile-deny-'));
    const profiles = await ProfileCollection.create({ db });
    const types = await ProfileTypeCollection.create({ db });
    const type = await types.create({ name: 'Person' });
    await type.save();
    const profile = await profiles.create({
      typeId: type.id,
      name: 'Owner',
      tenantId: 'tenant-a',
    });
    await profile.save();
    const runtime = await createAssetRuntime({ db, storage: storageDir });
    const store = new PhotoCutoutProfileStore({
      runtime,
      getProfile: async (id) => profiles.get({ id }),
      authorize: ({ actorProfileId, profile: target }) =>
        actorProfileId === target.id,
    });
    const png = await sharp({
      create: {
        width: 100,
        height: 120,
        channels: 4,
        background: 'transparent',
      },
    })
      .png()
      .toBuffer();

    await expect(
      store.save({
        actorProfileId: 'other-profile',
        profileId: profile.id as string,
        tenantId: 'tenant-a',
        png,
        rig,
      }),
    ).rejects.toThrow('authorization denied');
    await expect(
      store.save({
        actorProfileId: profile.id as string,
        profileId: profile.id as string,
        tenantId: 'tenant-b',
        png,
        rig,
      }),
    ).rejects.toThrow('active tenant');
    expect(await profile.getAssets('character_cutout')).toEqual([]);
  });
});
