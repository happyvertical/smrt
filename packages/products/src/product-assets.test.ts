import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCollection } from '@happyvertical/smrt-assets';
import { describe, expect, it } from 'vitest';
import { ProductAssetCollection } from './lib/collections/ProductAssetCollection.js';
import { ProductCollection } from './lib/collections/ProductCollection.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function createProductFixture(dbUrl: string) {
  const products = await ProductCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  const assets = await AssetCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });

  const product = await products.create({
    name: 'SMRT Widget',
    description: 'Testing owned product assets',
  });
  await product.save();

  return { products, assets, product };
}

describe('Product owned assets', () => {
  it('manages owned assets from the model API', async () => {
    const dbUrl = getTestDbUrl('product-assets-model');
    const { assets, product } = await createProductFixture(dbUrl);

    const second = await assets.create({
      name: 'manual.pdf',
      sourceUri: 'file:///tmp/manual.pdf',
      mimeType: 'application/pdf',
    });
    await second.save();

    const first = await assets.create({
      name: 'hero.jpg',
      sourceUri: 'file:///tmp/hero.jpg',
      mimeType: 'image/jpeg',
    });
    await first.save();

    await product.addAsset(second, 'gallery', 2);
    await product.addAsset(first, 'gallery', 1);
    await product.addAsset(first, 'hero', 0);

    const galleryAssets = await product.getAssets('gallery');
    expect(galleryAssets.map((asset) => asset.id)).toEqual([
      first.id,
      second.id,
    ]);

    await product.removeAsset(first.id as string, 'hero');
    expect(await product.getAssets('hero')).toEqual([]);
  });

  it('stores one product asset row per unique relationship', async () => {
    const dbUrl = getTestDbUrl('product-assets-conflict');
    const { assets, product } = await createProductFixture(dbUrl);
    const productAssets = await ProductAssetCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const asset = await assets.create({
      name: 'thumbnail.png',
      sourceUri: 'file:///tmp/thumbnail.png',
      mimeType: 'image/png',
    });
    await asset.save();

    await product.addAsset(asset, 'thumbnail', 0);
    await product.addAsset(asset, 'thumbnail', 0);

    const links = await productAssets.byLeft(product.id as string, {
      relationship: 'thumbnail',
    });
    expect(links).toHaveLength(1);
  });

  it('supports collection-level asset wrappers', async () => {
    const dbUrl = getTestDbUrl('product-assets-collection');
    const { products, assets, product } = await createProductFixture(dbUrl);

    const asset = await assets.create({
      name: 'attachment.pdf',
      sourceUri: 'file:///tmp/attachment.pdf',
      mimeType: 'application/pdf',
    });
    await asset.save();

    await products.addAsset(product.id as string, asset, 'attachment', 5);
    expect(
      (await products.getAssets(product.id as string, 'attachment')).map(
        (item) => item.id,
      ),
    ).toEqual([asset.id]);

    await products.removeAsset(
      product.id as string,
      asset.id as string,
      'attachment',
    );
    expect(
      await products.getAssets(product.id as string, 'attachment'),
    ).toEqual([]);
  });
});
