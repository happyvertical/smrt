import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkuCollection } from './lib/collections/SkuCollection.js';
import { Sku } from './lib/models/Sku.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function createSkuCollection(name: string): Promise<SkuCollection> {
  return SkuCollection.create({
    db: { type: 'sqlite', url: getTestDbUrl(name) },
  });
}

describe('Sku model construction', () => {
  it('assigns every supplied option onto the new SKU', () => {
    const sku = new Sku({
      tenantId: 'tenant-7',
      productId: 'product-42',
      code: 'ABC-123',
      barcode: '0123456789012',
      name: 'Navy Medium Tee',
      attributes: { size: 'M', color: 'navy' },
      weightGrams: 180.5,
      parentSkuId: 'parent-99',
      active: false,
    });

    expect(sku.tenantId).toBe('tenant-7');
    expect(sku.productId).toBe('product-42');
    expect(sku.code).toBe('ABC-123');
    expect(sku.barcode).toBe('0123456789012');
    expect(sku.name).toBe('Navy Medium Tee');
    expect(sku.getAttributes()).toEqual({ size: 'M', color: 'navy' });
    expect(sku.weightGrams).toBe(180.5);
    expect(sku.parentSkuId).toBe('parent-99');
    expect(sku.active).toBe(false);
  });

  it('keeps field defaults when no options are supplied', () => {
    const sku = new Sku();

    expect(sku.tenantId).toBeNull();
    expect(sku.productId).toBe('');
    expect(sku.code).toBe('');
    expect(sku.barcode).toBe('');
    expect(sku.name).toBe('');
    expect(sku.attributes).toBe('{}');
    expect(sku.getAttributes()).toEqual({});
    expect(sku.weightGrams).toBe(0.0);
    expect(sku.parentSkuId).toBe('');
    expect(sku.active).toBe(true);
  });

  it('accepts an explicit null tenantId for a global SKU', () => {
    const sku = new Sku({ tenantId: null, productId: 'p1', code: 'c1' });
    expect(sku.tenantId).toBeNull();
  });

  it('accepts a pre-serialized attributes string from the constructor', () => {
    const sku = new Sku({ attributes: '{"finish":"walnut"}' });
    expect(sku.attributes).toBe('{"finish":"walnut"}');
    expect(sku.getAttributes()).toEqual({ finish: 'walnut' });
  });
});

describe('Sku attribute helpers', () => {
  it('round-trips an object through setAttributes and getAttributes', () => {
    const sku = new Sku();
    sku.setAttributes({ size: 'L', voltage: '230V' });

    expect(sku.attributes).toBe(JSON.stringify({ size: 'L', voltage: '230V' }));
    expect(sku.getAttributes()).toEqual({ size: 'L', voltage: '230V' });
  });

  it('stores a raw JSON string verbatim when set as a string', () => {
    const sku = new Sku();
    sku.setAttributes('{"packSize":"12oz"}');

    expect(sku.attributes).toBe('{"packSize":"12oz"}');
    expect(sku.getAttributes()).toEqual({ packSize: '12oz' });
  });

  it('falls back to an empty object when setAttributes receives null', () => {
    const sku = new Sku();
    sku.setAttributes(null as unknown as Record<string, unknown>);

    expect(sku.attributes).toBe('{}');
    expect(sku.getAttributes()).toEqual({});
  });

  it('returns an empty object when stored attributes are empty', () => {
    const sku = new Sku();
    sku.attributes = '';
    expect(sku.getAttributes()).toEqual({});
  });

  it('returns an empty object when stored attributes are invalid JSON', () => {
    const sku = new Sku();
    sku.attributes = 'not-json{';
    expect(sku.getAttributes()).toEqual({});
  });

  it('returns an empty object when stored attributes parse to an array', () => {
    const sku = new Sku();
    sku.attributes = '["size","color"]';
    expect(sku.getAttributes()).toEqual({});
  });

  it('returns an empty object when stored attributes parse to a primitive', () => {
    const sku = new Sku();
    sku.attributes = '42';
    expect(sku.getAttributes()).toEqual({});
  });
});

describe('SkuCollection lookups', () => {
  it('finds a SKU by its tenant-scoped code', async () => {
    const skus = await createSkuCollection('sku-find-code');
    const sku = await skus.create({ productId: 'prod-1', code: 'WIDGET-1' });
    await sku.save();

    const found = await skus.findByCode('WIDGET-1');
    expect(found?.code).toBe('WIDGET-1');
    expect(found?.productId).toBe('prod-1');
  });

  it('returns null from findByCode when no SKU matches', async () => {
    const skus = await createSkuCollection('sku-find-code-miss');
    const found = await skus.findByCode('DOES-NOT-EXIST');
    expect(found).toBeNull();
  });

  it('finds a SKU by its scannable barcode', async () => {
    const skus = await createSkuCollection('sku-find-barcode');
    const sku = await skus.create({
      productId: 'prod-1',
      code: 'WIDGET-2',
      barcode: '5012345678900',
    });
    await sku.save();

    const found = await skus.findByBarcode('5012345678900');
    expect(found?.code).toBe('WIDGET-2');
  });

  it('returns null early from findByBarcode when given an empty barcode', async () => {
    const skus = await createSkuCollection('sku-find-barcode-empty');
    const sku = await skus.create({
      productId: 'prod-1',
      code: 'WIDGET-3',
      barcode: '',
    });
    await sku.save();

    const found = await skus.findByBarcode('');
    expect(found).toBeNull();
  });

  it('returns null from findByBarcode when no SKU matches', async () => {
    const skus = await createSkuCollection('sku-find-barcode-miss');
    const found = await skus.findByBarcode('0000000000000');
    expect(found).toBeNull();
  });

  it('lists every SKU for a product ordered by code', async () => {
    const skus = await createSkuCollection('sku-find-product');

    const bbb = await skus.create({ productId: 'prod-A', code: 'BBB' });
    await bbb.save();
    const aaa = await skus.create({ productId: 'prod-A', code: 'AAA' });
    await aaa.save();
    const other = await skus.create({ productId: 'prod-B', code: 'CCC' });
    await other.save();

    const found = await skus.findByProduct('prod-A');
    expect(found.map((s) => s.code)).toEqual(['AAA', 'BBB']);
  });

  it('lists every SKU that is a component of a parent SKU', async () => {
    const skus = await createSkuCollection('sku-find-parent');

    const child2 = await skus.create({
      productId: 'prod-1',
      code: 'KIT-PART-2',
      parentSkuId: 'kit-parent',
    });
    await child2.save();
    const child1 = await skus.create({
      productId: 'prod-1',
      code: 'KIT-PART-1',
      parentSkuId: 'kit-parent',
    });
    await child1.save();
    const unrelated = await skus.create({
      productId: 'prod-1',
      code: 'STANDALONE',
    });
    await unrelated.save();

    const found = await skus.findByParent('kit-parent');
    expect(found.map((s) => s.code)).toEqual(['KIT-PART-1', 'KIT-PART-2']);
  });

  it('finds all active SKUs across products', async () => {
    const skus = await createSkuCollection('sku-find-active');

    const liveA = await skus.create({ productId: 'prod-A', code: 'LIVE-A' });
    await liveA.save();
    const liveB = await skus.create({ productId: 'prod-B', code: 'LIVE-B' });
    await liveB.save();
    const retired = await skus.create({
      productId: 'prod-A',
      code: 'RETIRED',
      active: false,
    });
    await retired.save();

    const found = await skus.findActive();
    expect(found.map((s) => s.code)).toEqual(['LIVE-A', 'LIVE-B']);
  });

  it('finds active SKUs narrowed to a single product', async () => {
    const skus = await createSkuCollection('sku-find-active-product');

    const liveA = await skus.create({ productId: 'prod-A', code: 'LIVE-A' });
    await liveA.save();
    const liveB = await skus.create({ productId: 'prod-B', code: 'LIVE-B' });
    await liveB.save();
    const retiredA = await skus.create({
      productId: 'prod-A',
      code: 'RETIRED-A',
      active: false,
    });
    await retiredA.save();

    const found = await skus.findActive('prod-A');
    expect(found.map((s) => s.code)).toEqual(['LIVE-A']);
  });
});
