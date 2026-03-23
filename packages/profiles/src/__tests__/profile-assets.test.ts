import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCollection } from '@happyvertical/smrt-assets';
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

    const links = await profileAssets.getForProfile(
      profile.id as string,
      'avatar',
    );
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
});
