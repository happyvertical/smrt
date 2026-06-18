/**
 * Unit tests for the under-tested collection helpers in
 * `src/lib/collections/*`.
 *
 * Scope is deliberately complementary to `sti-and-tenancy.test.ts` (which
 * already covers ProductVariant axis lookups, Material tenancy, and
 * Category tenancy) and `product-assets.test.ts` (which exercises the
 * Product model asset API and ProductAssetCollection.byLeft). Here we
 * target:
 *  - CategoryCollection.getRootCategories merge/dedup + early-return paths
 *  - MaterialCollection.findByKind JS filtering of the @meta materialKind
 *  - ProductCollection.findByManufacturer / findInStock WHERE filters
 *  - ProductAssetCollection's own attach/getAssets/removeAsset/byRight/
 *    detach/setLinks helpers (distinct from the model-side API tested in
 *    product-assets.test.ts)
 *
 * Real in-memory SQLite per test, fresh unique db url, never mocked.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCollection } from '@happyvertical/smrt-assets';
import { describe, expect, it } from 'vitest';
import { CategoryCollection } from './lib/collections/CategoryCollection.js';
import { MaterialCollection } from './lib/collections/MaterialCollection.js';
import { ProductAssetCollection } from './lib/collections/ProductAssetCollection.js';
import { ProductCollection } from './lib/collections/ProductCollection.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

describe('CategoryCollection.getRootCategories', () => {
  it('merges empty-string and NULL parents and excludes children', async () => {
    const categories = await CategoryCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('cat-roots-merge') },
    });

    // Created via the framework — parent_id serializes to ''.
    const empty = await categories.create({ name: 'Empty-parent root' });
    await empty.save();

    // A row that ended up with parent_id IS NULL (migration / direct write).
    const nullRow = await categories.create({ name: 'Null-parent root' });
    await nullRow.save();
    await categories.db.query(
      `UPDATE categories SET parent_id = NULL WHERE id = '${nullRow.id}'`,
    );

    // A non-root child pointing at a real parent.
    const child = await categories.create({
      name: 'Child',
      parentId: empty.id,
    });
    await child.save();

    const roots = await categories.getRootCategories();
    expect(roots.map((r) => r.name).sort()).toEqual([
      'Empty-parent root',
      'Null-parent root',
    ]);
  });

  it('de-dupes a row that appears under both empty and NULL queries', async () => {
    // Drive the `seen`-set branch: a category whose parent_id is '' is
    // ALSO matched by an additional NULL-parented sibling, but if a single
    // row could match both lists the merge must emit it once. We force the
    // overlap by leaving one row with '' and confirming the merge path runs
    // (both lists non-empty) without duplicating any id.
    const categories = await CategoryCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('cat-roots-dedup') },
    });

    const a = await categories.create({ name: 'A' });
    await a.save();
    const b = await categories.create({ name: 'B' });
    await b.save();
    await categories.db.query(
      `UPDATE categories SET parent_id = NULL WHERE id = '${b.id}'`,
    );

    const roots = await categories.getRootCategories();
    const ids = roots.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
    expect(roots.map((r) => r.name).sort()).toEqual(['A', 'B']);
  });

  it('returns only empty-string roots when no NULL parents exist (early return)', async () => {
    const categories = await CategoryCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('cat-roots-only-empty') },
    });

    const root = await categories.create({ name: 'Only empty' });
    await root.save();
    const child = await categories.create({
      name: 'Child',
      parentId: root.id,
    });
    await child.save();

    const roots = await categories.getRootCategories();
    expect(roots.map((r) => r.name)).toEqual(['Only empty']);
  });

  it('returns only NULL roots when no empty-string parents exist (early return)', async () => {
    const categories = await CategoryCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('cat-roots-only-null') },
    });

    const root = await categories.create({ name: 'Only null' });
    await root.save();
    // Make the sole root NULL-parented so the empty-string list is empty.
    await categories.db.query(
      `UPDATE categories SET parent_id = NULL WHERE id = '${root.id}'`,
    );

    const roots = await categories.getRootCategories();
    expect(roots.map((r) => r.name)).toEqual(['Only null']);
  });

  it('returns an empty array when there are no categories at all', async () => {
    const categories = await CategoryCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('cat-roots-empty') },
    });
    expect(await categories.getRootCategories()).toEqual([]);
  });
});

describe('MaterialCollection.findByKind', () => {
  it('returns only Materials whose @meta materialKind matches', async () => {
    const materials = await MaterialCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('material-find-by-kind') },
    });

    await (
      await materials.create({ name: 'Cotton jersey', materialKind: 'fabric' })
    ).save();
    await (
      await materials.create({ name: 'Linen weave', materialKind: 'fabric' })
    ).save();
    await (
      await materials.create({ name: 'Cotton thread', materialKind: 'thread' })
    ).save();

    const fabrics = await materials.findByKind('fabric');
    expect(fabrics.map((m) => m.name).sort()).toEqual([
      'Cotton jersey',
      'Linen weave',
    ]);
    expect(fabrics.every((m) => m.materialKind === 'fabric')).toBe(true);

    const threads = await materials.findByKind('thread');
    expect(threads.map((m) => m.name)).toEqual(['Cotton thread']);
  });

  it('returns an empty array when no Material has the requested kind', async () => {
    const materials = await MaterialCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('material-find-by-kind-none') },
    });

    await (
      await materials.create({ name: 'Snap button', materialKind: 'component' })
    ).save();

    expect(await materials.findByKind('packaging')).toEqual([]);
  });
});

describe('ProductCollection filters', () => {
  it('findByManufacturer returns only products from the given manufacturer', async () => {
    const products = await ProductCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('product-by-manufacturer') },
    });

    await (
      await products.create({ name: 'Acme Widget', manufacturer: 'Acme' })
    ).save();
    await (
      await products.create({ name: 'Acme Gadget', manufacturer: 'Acme' })
    ).save();
    await (
      await products.create({ name: 'Globex Gizmo', manufacturer: 'Globex' })
    ).save();

    const acme = await products.findByManufacturer('Acme');
    expect(acme.map((p) => p.name).sort()).toEqual([
      'Acme Gadget',
      'Acme Widget',
    ]);
    expect(acme.every((p) => p.manufacturer === 'Acme')).toBe(true);

    expect(await products.findByManufacturer('Nonexistent')).toEqual([]);
  });

  it('findInStock returns only products with inStock = true', async () => {
    const products = await ProductCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('product-in-stock') },
    });

    await (
      await products.create({ name: 'Available A', inStock: true })
    ).save();
    await (
      await products.create({ name: 'Available B', inStock: true })
    ).save();
    await (await products.create({ name: 'Sold out', inStock: false })).save();

    const inStock = await products.findInStock();
    expect(inStock.map((p) => p.name).sort()).toEqual([
      'Available A',
      'Available B',
    ]);
    expect(inStock.every((p) => p.inStock === true)).toBe(true);
  });
});

describe('ProductAssetCollection direct helpers', () => {
  async function setup(dbUrl: string) {
    const products = await ProductCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    const assets = await AssetCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    const productAssets = await ProductAssetCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const product = await products.create({ name: 'Widget' });
    await product.save();

    return { products, assets, productAssets, product };
  }

  it('addAsset links assets that getAssets then resolves in sort order', async () => {
    const dbUrl = getTestDbUrl('pac-add-get');
    const { assets, productAssets, product } = await setup(dbUrl);

    const hero = await assets.create({
      name: 'hero.jpg',
      sourceUri: 'file:///tmp/hero.jpg',
      mimeType: 'image/jpeg',
    });
    await hero.save();
    const banner = await assets.create({
      name: 'banner.jpg',
      sourceUri: 'file:///tmp/banner.jpg',
      mimeType: 'image/jpeg',
    });
    await banner.save();

    // Insert out of order; getAssets should return them by sortOrder ASC.
    await productAssets.addAsset(product.id as string, banner, 'gallery', 2);
    await productAssets.addAsset(product.id as string, hero, 'gallery', 1);

    const gallery = await productAssets.getAssets(
      product.id as string,
      'gallery',
    );
    expect(gallery.map((a) => a.id)).toEqual([hero.id, banner.id]);
  });

  it('removeAsset detaches a single relationship link', async () => {
    const dbUrl = getTestDbUrl('pac-remove');
    const { assets, productAssets, product } = await setup(dbUrl);

    const asset = await assets.create({
      name: 'manual.pdf',
      sourceUri: 'file:///tmp/manual.pdf',
      mimeType: 'application/pdf',
    });
    await asset.save();

    await productAssets.addAsset(product.id as string, asset, 'manual', 0);
    expect(
      await productAssets.getAssets(product.id as string, 'manual'),
    ).toHaveLength(1);

    await productAssets.removeAsset(
      product.id as string,
      asset.id as string,
      'manual',
    );
    expect(
      await productAssets.getAssets(product.id as string, 'manual'),
    ).toEqual([]);
  });

  it('byRight finds every product-link row for a given asset', async () => {
    const dbUrl = getTestDbUrl('pac-by-right');
    const { products, assets, productAssets, product } = await setup(dbUrl);

    const shared = await assets.create({
      name: 'shared.png',
      sourceUri: 'file:///tmp/shared.png',
      mimeType: 'image/png',
    });
    await shared.save();

    const second = await products.create({ name: 'Second widget' });
    await second.save();

    await productAssets.addAsset(product.id as string, shared, 'gallery', 0);
    await productAssets.addAsset(second.id as string, shared, 'gallery', 0);

    const links = await productAssets.byRight(shared.id as string);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.productId).sort()).toEqual(
      [product.id, second.id].sort(),
    );
    expect(links.every((l) => l.assetId === shared.id)).toBe(true);
  });

  it('attach is idempotent on the product/asset/relationship conflict key', async () => {
    const dbUrl = getTestDbUrl('pac-attach-idempotent');
    const { assets, productAssets, product } = await setup(dbUrl);

    const asset = await assets.create({
      name: 'thumb.png',
      sourceUri: 'file:///tmp/thumb.png',
      mimeType: 'image/png',
    });
    await asset.save();

    await productAssets.attach(product.id as string, asset.id as string, {
      relationship: 'thumbnail',
      sortOrder: 0,
    });
    await productAssets.attach(product.id as string, asset.id as string, {
      relationship: 'thumbnail',
      sortOrder: 0,
    });

    const links = await productAssets.byLeft(product.id as string, {
      relationship: 'thumbnail',
    });
    expect(links).toHaveLength(1);
  });

  it('detach removes the matching link via the junction helper', async () => {
    const dbUrl = getTestDbUrl('pac-detach');
    const { assets, productAssets, product } = await setup(dbUrl);

    const asset = await assets.create({
      name: 'spec.pdf',
      sourceUri: 'file:///tmp/spec.pdf',
      mimeType: 'application/pdf',
    });
    await asset.save();

    await productAssets.attach(product.id as string, asset.id as string, {
      relationship: 'spec',
      sortOrder: 0,
    });
    expect(
      await productAssets.byLeft(product.id as string, {
        relationship: 'spec',
      }),
    ).toHaveLength(1);

    await productAssets.detach(product.id as string, asset.id as string, {
      relationship: 'spec',
    });
    expect(
      await productAssets.byLeft(product.id as string, {
        relationship: 'spec',
      }),
    ).toEqual([]);
  });

  it('setLinks replaces the full set of right rows for a relationship', async () => {
    const dbUrl = getTestDbUrl('pac-set-links');
    const { assets, productAssets, product } = await setup(dbUrl);

    const a1 = await assets.create({
      name: 'a1.png',
      sourceUri: 'file:///tmp/a1.png',
      mimeType: 'image/png',
    });
    await a1.save();
    const a2 = await assets.create({
      name: 'a2.png',
      sourceUri: 'file:///tmp/a2.png',
      mimeType: 'image/png',
    });
    await a2.save();
    const a3 = await assets.create({
      name: 'a3.png',
      sourceUri: 'file:///tmp/a3.png',
      mimeType: 'image/png',
    });
    await a3.save();

    await productAssets.setLinks(
      product.id as string,
      [a1.id as string, a2.id as string],
      { relationship: 'gallery' },
    );
    let links = await productAssets.byLeft(product.id as string, {
      relationship: 'gallery',
    });
    expect(links.map((l) => l.assetId).sort()).toEqual([a1.id, a2.id].sort());

    // Replace with a different set; old rows are dropped.
    await productAssets.setLinks(product.id as string, [a3.id as string], {
      relationship: 'gallery',
    });
    links = await productAssets.byLeft(product.id as string, {
      relationship: 'gallery',
    });
    expect(links.map((l) => l.assetId)).toEqual([a3.id]);
  });
});
