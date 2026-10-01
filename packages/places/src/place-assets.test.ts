import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Asset, AssetCollection } from '@happyvertical/smrt-assets';
import { describe, expect, it } from 'vitest';
import {
  PLACE_MAIN_ASSET_RELATIONSHIP,
  PlaceAssetCollection,
  PlaceCollection,
} from './index.js';

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

    const links = await placeAssets.byLeft(place.id as string, {
      relationship: 'hero',
    });
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

  it('keeps one main picture per place', async () => {
    const dbUrl = getTestDbUrl('place-assets-main');
    const { assets, place } = await createPlaceFixture(dbUrl);
    const front = await assets.create({
      name: 'front.jpg',
      sourceUri: 'file:///tmp/front.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    const side = await assets.create({
      name: 'side.jpg',
      sourceUri: 'file:///tmp/side.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });

    expect(await place.getMainAsset()).toBeNull();
    await place.addAsset(front, 'depicts');
    await place.setMainAsset(front);
    await place.setMainAsset(side);

    expect((await place.getMainAsset())?.id).toBe(side.id);
    expect(
      (await place.getAssets(PLACE_MAIN_ASSET_RELATIONSHIP)).map((a) => a.id),
    ).toEqual([side.id]);
    // The other links of the old main picture stay.
    expect((await place.getAssets('depicts')).map((a) => a.id)).toEqual([
      front.id,
    ]);

    await place.setMainAsset(null);
    expect(await place.getMainAsset()).toBeNull();
  });

  it('refuses an asset from another tenant', async () => {
    const dbUrl = getTestDbUrl('place-assets-cross-tenant');
    const { assets, place } = await createPlaceFixture(dbUrl);
    const foreign = await assets.create({
      name: 'elsewhere.jpg',
      sourceUri: 'file:///tmp/elsewhere.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-b',
    });

    await expect(place.addAsset(foreign, 'depicts')).rejects.toThrow(
      /another tenant/,
    );
    await expect(place.setMainAsset(foreign)).rejects.toThrow(/another tenant/);
    // The stored row decides, not the caller's object: a hand-built asset
    // carrying only the foreign id is refused too.
    await expect(
      place.addAsset({ id: foreign.id } as Asset, 'depicts'),
    ).rejects.toThrow(/another tenant/);
    expect(await place.getAssets()).toEqual([]);
  });

  it('removes place links when the asset or the place is deleted', async () => {
    const dbUrl = getTestDbUrl('place-assets-cascade');
    const { assets, places, place } = await createPlaceFixture(dbUrl);
    const links = await PlaceAssetCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    const photo = await assets.create({
      name: 'photo.jpg',
      sourceUri: 'file:///tmp/photo.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    const other = await assets.create({
      name: 'other.jpg',
      sourceUri: 'file:///tmp/other.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await place.addAsset(photo, 'depicts');
    await place.addAsset(other, 'depicts');

    await photo.delete();
    expect((await links.list({})).map((link) => link.assetId)).toEqual([
      other.id,
    ]);

    const loaded = await places.get({ id: place.id as string });
    await loaded?.delete();
    expect(await links.list({})).toEqual([]);
  });
});
