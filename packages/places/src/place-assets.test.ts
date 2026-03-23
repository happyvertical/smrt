import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCollection } from '@happyvertical/smrt-assets';
import { describe, expect, it } from 'vitest';
import { PlaceAssetCollection, PlaceCollection } from './index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function createPlaceFixture(dbUrl: string) {
  const places = await PlaceCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  const assets = await AssetCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });

  const place = await places.create({
    name: 'Main Hall',
    description: 'Testing owned place assets',
    tenantId: 'tenant-a',
  });
  await place.save();

  return { places, assets, place };
}

describe('Place owned assets', () => {
  it('manages owned assets from the model API', async () => {
    const dbUrl = getTestDbUrl('place-assets-model');
    const { assets, place } = await createPlaceFixture(dbUrl);

    const second = await assets.create({
      name: 'details.pdf',
      sourceUri: 'file:///tmp/details.pdf',
      mimeType: 'application/pdf',
      tenantId: 'tenant-a',
    });
    await second.save();

    const first = await assets.create({
      name: 'floorplan.png',
      sourceUri: 'file:///tmp/floorplan.png',
      mimeType: 'image/png',
      tenantId: 'tenant-a',
    });
    await first.save();

    await place.addAsset(second, 'gallery', 2);
    await place.addAsset(first, 'gallery', 1);
    await place.addAsset(first, 'floorplan', 0);

    const galleryAssets = await place.getAssets('gallery');
    expect(galleryAssets.map((asset) => asset.id)).toEqual([
      first.id,
      second.id,
    ]);

    await place.removeAsset(first.id as string, 'floorplan');
    expect(await place.getAssets('floorplan')).toEqual([]);
  });

  it('stores tenant-scoped place asset rows once per unique relationship', async () => {
    const dbUrl = getTestDbUrl('place-assets-conflict');
    const { assets, place } = await createPlaceFixture(dbUrl);
    const placeAssets = await PlaceAssetCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const asset = await assets.create({
      name: 'hero.jpg',
      sourceUri: 'file:///tmp/hero.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await asset.save();

    await place.addAsset(asset, 'hero', 0);
    await place.addAsset(asset, 'hero', 0);

    const links = await placeAssets.getForPlace(place.id as string, 'hero');
    expect(links).toHaveLength(1);
    expect(links[0]?.tenantId).toBe('tenant-a');
  });

  it('supports collection-level asset wrappers', async () => {
    const dbUrl = getTestDbUrl('place-assets-collection');
    const { places, assets, place } = await createPlaceFixture(dbUrl);

    const asset = await assets.create({
      name: 'attachment.pdf',
      sourceUri: 'file:///tmp/attachment.pdf',
      mimeType: 'application/pdf',
      tenantId: 'tenant-a',
    });
    await asset.save();

    await places.addAsset(place.id as string, asset, 'attachment', 5);
    expect(
      (await places.getAssets(place.id as string, 'attachment')).map(
        (item) => item.id,
      ),
    ).toEqual([asset.id]);

    await places.removeAsset(
      place.id as string,
      asset.id as string,
      'attachment',
    );
    expect(await places.getAssets(place.id as string, 'attachment')).toEqual(
      [],
    );
  });

  it('includes global assets when resolving tenant-owned place links', async () => {
    const dbUrl = getTestDbUrl('place-assets-global');
    const { place, assets } = await createPlaceFixture(dbUrl);

    const globalAsset = await assets.create({
      name: 'global-floorplan.png',
      sourceUri: 'file:///tmp/global-floorplan.png',
      mimeType: 'image/png',
      tenantId: null,
    });
    await globalAsset.save();

    await place.addAsset(globalAsset, 'floorplan', 0);

    expect(
      (await place.getAssets('floorplan')).map((asset) => asset.id),
    ).toEqual([globalAsset.id]);
  });
});
