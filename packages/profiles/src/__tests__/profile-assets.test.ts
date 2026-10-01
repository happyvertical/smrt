import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Asset, AssetCollection } from '@happyvertical/smrt-assets';
import { describe, expect, it } from 'vitest';
import {
  ProfileAssetCollection,
  ProfileCollection,
  ProfileTypeCollection,
} from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function createProfileFixture(dbUrl: string) {
  const profiles = await ProfileCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  const profileTypes = await ProfileTypeCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  const assets = await AssetCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });

  const type = await profileTypes.create({
    name: 'Person',
    description: 'Test profile type',
  });
  await type.save();

  const profile = await profiles.create({
    typeId: type.id,
    name: 'Alice Example',
    email: `alice-${randomUUID()}@example.com`,
    tenantId: 'tenant-a',
  });
  await profile.save();

  return { profiles, assets, profile };
}

describe('Profile owned assets', () => {
  it('manages owned assets from the model API', async () => {
    const dbUrl = getTestDbUrl('profile-assets-model');
    const { assets, profile } = await createProfileFixture(dbUrl);

    const second = await assets.create({
      name: 'portfolio.pdf',
      sourceUri: 'file:///tmp/portfolio.pdf',
      mimeType: 'application/pdf',
      tenantId: 'tenant-a',
    });
    await second.save();

    const first = await assets.create({
      name: 'headshot.jpg',
      sourceUri: 'file:///tmp/headshot.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await first.save();

    await profile.addAsset(second, 'gallery', 2);
    await profile.addAsset(first, 'gallery', 1);
    await profile.addAsset(first, 'avatar', 0);

    const galleryAssets = await profile.getAssets('gallery');
    expect(galleryAssets.map((asset) => asset.id)).toEqual([
      first.id,
      second.id,
    ]);

    await profile.removeAsset(first.id as string, 'avatar');
    expect(await profile.getAssets('avatar')).toEqual([]);
  });

  it('stores tenant-scoped profile asset rows once per unique relationship', async () => {
    const dbUrl = getTestDbUrl('profile-assets-conflict');
    const { assets, profile } = await createProfileFixture(dbUrl);
    const profileAssets = await ProfileAssetCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const asset = await assets.create({
      name: 'avatar.png',
      sourceUri: 'file:///tmp/avatar.png',
      mimeType: 'image/png',
      tenantId: 'tenant-a',
    });
    await asset.save();

    await profile.addAsset(asset, 'avatar', 0);
    await profile.addAsset(asset, 'avatar', 0);

    const links = await profileAssets.byLeft(profile.id as string, {
      relationship: 'avatar',
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.tenantId).toBe('tenant-a');
  });

  it('supports collection-level asset wrappers', async () => {
    const dbUrl = getTestDbUrl('profile-assets-collection');
    const { profiles, assets, profile } = await createProfileFixture(dbUrl);

    const asset = await assets.create({
      name: 'resume.pdf',
      sourceUri: 'file:///tmp/resume.pdf',
      mimeType: 'application/pdf',
      tenantId: 'tenant-a',
    });
    await asset.save();

    await profiles.addAsset(profile.id as string, asset, 'attachment', 5);
    expect(
      (await profiles.getAssets(profile.id as string, 'attachment')).map(
        (item) => item.id,
      ),
    ).toEqual([asset.id]);

    await profiles.removeAsset(
      profile.id as string,
      asset.id as string,
      'attachment',
    );
    expect(
      await profiles.getAssets(profile.id as string, 'attachment'),
    ).toEqual([]);
  });

  it('includes global assets when resolving tenant-owned profile links', async () => {
    const dbUrl = getTestDbUrl('profile-assets-global');
    const { profile, assets } = await createProfileFixture(dbUrl);

    const globalAsset = await assets.create({
      name: 'global-avatar.png',
      sourceUri: 'file:///tmp/global-avatar.png',
      mimeType: 'image/png',
      tenantId: null,
    });
    await globalAsset.save();

    await profile.addAsset(globalAsset, 'avatar', 0);

    expect(
      (await profile.getAssets('avatar')).map((asset) => asset.id),
    ).toEqual([globalAsset.id]);
  });

  it("a shared (global) profile cannot link a tenant's picture", async () => {
    const dbUrl = getTestDbUrl('profile-assets-global-owner');
    const { profiles, assets, profile } = await createProfileFixture(dbUrl);
    const shared = await profiles.create({
      typeId: profile.typeId,
      name: 'Town Hall',
      email: `town-${randomUUID()}@example.com`,
      tenantId: null,
    });
    const tenantPhoto = await assets.create({
      name: 'private.jpg',
      sourceUri: 'file:///tmp/private.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await expect(shared.addAsset(tenantPhoto, 'depicts')).rejects.toThrow(
      /shared profile/,
    );
    const publicPhoto = await assets.create({
      name: 'public.jpg',
      sourceUri: 'file:///tmp/public.jpg',
      mimeType: 'image/jpeg',
      tenantId: null,
    });
    await shared.addAsset(publicPhoto, 'depicts');
    expect((await shared.getAssets('depicts')).map((a) => a.id)).toEqual([
      publicPhoto.id,
    ]);
  });

  it('refuses a picture from another tenant and drops links with the picture', async () => {
    const dbUrl = getTestDbUrl('profile-assets-tenant-cascade');
    const { assets, profile } = await createProfileFixture(dbUrl);
    const links = await ProfileAssetCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const foreign = await assets.create({
      name: 'elsewhere.jpg',
      sourceUri: 'file:///tmp/elsewhere.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-b',
    });
    await expect(profile.addAsset(foreign, 'depicts')).rejects.toThrow(
      /another tenant/,
    );
    // The check reads the stored row: a hand-built object that only carries
    // the foreign id (no tenant) is refused too.
    const forged = { id: foreign.id } as Asset;
    await expect(profile.addAsset(forged, 'depicts')).rejects.toThrow(
      /another tenant/,
    );
    await expect(
      profile.addAsset({ id: randomUUID() } as Asset, 'depicts'),
    ).rejects.toThrow(/does not exist/);

    const photo = await assets.create({
      name: 'photo.jpg',
      sourceUri: 'file:///tmp/photo.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await profile.addAsset(photo, 'depicts');
    expect((await profile.getAssets('depicts')).map((a) => a.id)).toEqual([
      photo.id,
    ]);
    const [row] = await links.list({});
    expect(row?.tenantId).toBe('tenant-a');

    await photo.delete();
    expect(await links.list({})).toEqual([]);
  });
});
