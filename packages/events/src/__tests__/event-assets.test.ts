import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCollection } from '@happyvertical/smrt-assets';
import { describe, expect, it } from 'vitest';
import { EventAssetCollection, EventCollection } from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function createEventFixture(dbUrl: string) {
  const events = await EventCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  const assets = await AssetCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });

  const event = await events.create({
    name: 'Launch Event',
    description: 'Testing owned event assets',
    tenantId: 'tenant-a',
  });
  await event.save();

  return { events, assets, event };
}

describe('Event owned assets', () => {
  it('manages owned assets from the model API', async () => {
    const dbUrl = getTestDbUrl('event-assets-model');
    const { assets, event } = await createEventFixture(dbUrl);

    const second = await assets.create({
      name: 'poster.pdf',
      sourceUri: 'file:///tmp/poster.pdf',
      mimeType: 'application/pdf',
      tenantId: 'tenant-a',
    });
    await second.save();

    const first = await assets.create({
      name: 'hero.jpg',
      sourceUri: 'file:///tmp/hero.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await first.save();

    await event.addAsset(second, 'gallery', 2);
    await event.addAsset(first, 'gallery', 1);
    await event.addAsset(first, 'hero', 0);

    const galleryAssets = await event.getAssets('gallery');
    expect(galleryAssets.map((asset) => asset.id)).toEqual([
      first.id,
      second.id,
    ]);

    await event.removeAsset(first.id as string, 'hero');
    expect(await event.getAssets('hero')).toEqual([]);
  });

  it('stores tenant-scoped event asset rows once per unique relationship', async () => {
    const dbUrl = getTestDbUrl('event-assets-conflict');
    const { assets, event } = await createEventFixture(dbUrl);
    const eventAssets = await EventAssetCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const asset = await assets.create({
      name: 'thumbnail.png',
      sourceUri: 'file:///tmp/thumbnail.png',
      mimeType: 'image/png',
      tenantId: 'tenant-a',
    });
    await asset.save();

    await event.addAsset(asset, 'thumbnail', 0);
    await event.addAsset(asset, 'thumbnail', 0);

    const links = await eventAssets.byLeft(event.id as string, {
      relationship: 'thumbnail',
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.tenantId).toBe('tenant-a');
  });

  it('supports collection-level asset wrappers', async () => {
    const dbUrl = getTestDbUrl('event-assets-collection');
    const { events, assets, event } = await createEventFixture(dbUrl);

    const asset = await assets.create({
      name: 'agenda.pdf',
      sourceUri: 'file:///tmp/agenda.pdf',
      mimeType: 'application/pdf',
      tenantId: 'tenant-a',
    });
    await asset.save();

    await events.addAsset(event.id as string, asset, 'attachment', 5);
    expect(
      (await events.getAssets(event.id as string, 'attachment')).map(
        (item) => item.id,
      ),
    ).toEqual([asset.id]);

    await events.removeAsset(
      event.id as string,
      asset.id as string,
      'attachment',
    );
    expect(await events.getAssets(event.id as string, 'attachment')).toEqual(
      [],
    );
  });

  it('includes global assets when resolving tenant-owned event links', async () => {
    const dbUrl = getTestDbUrl('event-assets-global');
    const { event, assets } = await createEventFixture(dbUrl);

    const globalAsset = await assets.create({
      name: 'global-hero.jpg',
      sourceUri: 'file:///tmp/global-hero.jpg',
      mimeType: 'image/jpeg',
      tenantId: null,
    });
    await globalAsset.save();

    await event.addAsset(globalAsset, 'hero', 0);

    expect((await event.getAssets('hero')).map((asset) => asset.id)).toEqual([
      globalAsset.id,
    ]);
  });
});
