/**
 * Tests for the products package:
 * - Material STI subtype on the shared `products` table
 * - The standalone `ProductVariant` axis-declaration model
 * - Tenant isolation on Product / Category / ProductVariant
 *
 * Vertical-specific Product STI subtypes (apparel `Style` / `Makeup`,
 * automotive `Model` / `Trim`, furniture `Design` / `Configuration`,
 * etc.) are intentionally NOT in this package — consumers subclass
 * `Product` themselves. See the apparel template for an example.
 *
 * STI uses `_meta_type` discriminator; subtype-specific fields are
 * stored in `_meta_data` JSONB. Tenancy is optional (`@TenantScoped({
 * mode: 'optional' })`) so all queries auto-filter when wrapped in
 * `withTenant()` and fall through when no context is set.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CategoryCollection } from './lib/collections/CategoryCollection';
import { MaterialCollection } from './lib/collections/MaterialCollection';
import { ProductCollection } from './lib/collections/ProductCollection';
import { ProductVariantCollection } from './lib/collections/ProductVariantCollection';
import { Material } from './lib/models/Material';
import { Product } from './lib/models/Product';
import { ProductVariant } from './lib/models/ProductVariant';
import { ProductType } from './lib/models/types';

describe('Product STI subtypes', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Registry', () => {
    it('declares STI strategy on Product base', () => {
      expect(ObjectRegistry.getTableStrategy('Product')).toBe('sti');
    });

    it('resolves Product as STI base for Material', () => {
      expect(ObjectRegistry.getSTIBase('Material')).toBe('Product');
    });

    it('does NOT treat ProductVariant as a Product STI subtype', () => {
      // ProductVariant is a standalone model with its own table; it must
      // not appear in Product's STI hierarchy.
      expect(ObjectRegistry.getSTIBase('ProductVariant')).toBeFalsy();
    });
  });

  describe('_meta_type discriminator', () => {
    it('stamps Product on the base class', async () => {
      const product = new Product({ name: 'Plain widget' });
      await product.initialize();
      expect(product.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-products:Product',
      );
    });

    it('stamps Material with the right discriminator and productType', async () => {
      const material = new Material({ name: 'thing' });
      await material.initialize();
      const json = material.toJSON();
      expect(json._meta_type).toBe('@happyvertical/smrt-products:Material');
      expect(material.productType).toBe(ProductType.MATERIAL);
    });
  });

  describe('Material persistence', () => {
    it('persists Material meta fields and round-trips them', async () => {
      const materials = await MaterialCollection.create({ db });

      const material = await materials.create({
        name: 'Organic cotton jersey',
        materialKind: 'fabric',
        uom: 'yards',
        costPerUnit: 8.5,
      });
      await material.save();

      const loaded = await materials.get({ id: material.id! });
      expect(loaded).not.toBeNull();
      expect(loaded?.name).toBe('Organic cotton jersey');
      expect(loaded?.materialKind).toBe('fabric');
      expect(loaded?.uom).toBe('yards');
      expect(loaded?.costPerUnit).toBe(8.5);
      expect(loaded?.productType).toBe(ProductType.MATERIAL);
    });

    it('returns Material instances from a base Product collection list', async () => {
      const materials = await MaterialCollection.create({ db });
      const products = await ProductCollection.create({ db });

      const material = await materials.create({
        name: 'Cotton thread',
        materialKind: 'thread',
      });
      await material.save();

      const all = await products.list({ orderBy: 'created_at ASC' });
      expect(all).toHaveLength(1);
      expect(all[0]).toBeInstanceOf(Material);
      expect(all[0].id).toBe(material.id);
    });
  });
});

describe('ProductVariant axis-declaration model', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('persists axis declarations and round-trips allowedValues', async () => {
    const variants = await ProductVariantCollection.create({ db });

    const sizeAxis = await variants.create({
      productId: 'style-st-1001',
      axisName: 'size',
      label: 'Size',
      allowedValues: ['XS', 'S', 'M', 'L', 'XL'],
    });
    await sizeAxis.save();

    const loaded = await variants.get({ id: sizeAxis.id! });
    expect(loaded).not.toBeNull();
    expect(loaded?.productId).toBe('style-st-1001');
    expect(loaded?.axisName).toBe('size');
    expect(loaded?.label).toBe('Size');
    expect(loaded?.getValues()).toEqual(['XS', 'S', 'M', 'L', 'XL']);
  });

  it('looks up an axis by (productId, axisName)', async () => {
    const variants = await ProductVariantCollection.create({ db });

    await (
      await variants.create({
        productId: 'style-1',
        axisName: 'size',
        allowedValues: ['S', 'M', 'L'],
      })
    ).save();
    await (
      await variants.create({
        productId: 'style-1',
        axisName: 'color',
        allowedValues: ['navy', 'white'],
      })
    ).save();

    const axis = await variants.findAxis('style-1', 'color');
    expect(axis).not.toBeNull();
    expect(axis?.getValues()).toEqual(['navy', 'white']);
  });

  it('returns every axis for a product in sortOrder', async () => {
    const variants = await ProductVariantCollection.create({ db });

    await (
      await variants.create({
        productId: 'style-1',
        axisName: 'size',
        allowedValues: ['S', 'M'],
        sortOrder: 1,
      })
    ).save();
    await (
      await variants.create({
        productId: 'style-1',
        axisName: 'color',
        allowedValues: ['navy', 'white'],
        sortOrder: 0,
      })
    ).save();

    const axes = await variants.findForProduct('style-1');
    expect(axes.map((a) => a.axisName)).toEqual(['color', 'size']);
  });

  it('lives in its own table, not the products STI table', () => {
    // Sanity: a Product STI subtype would share table 'products' and
    // declare 'sti' as its strategy. ProductVariant must do neither.
    expect(ObjectRegistry.getTableStrategy('ProductVariant')).not.toBe('sti');
    expect(ObjectRegistry.getTableName('ProductVariant')).toBe(
      'product_variants',
    );
  });
});

describe('Product and Category tenancy', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase();
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('auto-populates tenantId on save when inside withTenant', async () => {
    const products = await ProductCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const product = await products.create({ name: 'Tenant A widget' });
      await product.save();
      expect(product.tenantId).toBe('tenant-a');
    });
  });

  it('isolates list() between two tenants', async () => {
    const products = await ProductCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await (await products.create({ name: 'A1' })).save();
      await (await products.create({ name: 'A2' })).save();
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await (await products.create({ name: 'B1' })).save();
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const rows = await products.list({});
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenantId === 'tenant-a')).toBe(true);
    });

    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const rows = await products.list({});
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe('tenant-b');
    });
  });

  it('allows global (tenantId=null) rows when no context is set', async () => {
    const products = await ProductCollection.create({ db });
    const global = await products.create({ name: 'Reference catalog widget' });
    await global.save();
    expect(global.tenantId).toBeNull();
  });

  it('isolates Category between tenants the same way', async () => {
    const categories = await CategoryCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await (await categories.create({ name: 'Tops' })).save();
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await (await categories.create({ name: 'Bottoms' })).save();
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const rows = await categories.list({});
      expect(rows.map((r) => r.name)).toEqual(['Tops']);
    });
  });

  it('isolates ProductVariant axis declarations between tenants', async () => {
    const variants = await ProductVariantCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await (
        await variants.create({
          productId: 'style-1',
          axisName: 'size',
          allowedValues: ['S', 'M'],
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await (
        await variants.create({
          productId: 'style-1',
          axisName: 'size',
          allowedValues: ['XS', 'XL'],
        })
      ).save();
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const axis = await variants.findAxis('style-1', 'size');
      expect(axis?.getValues()).toEqual(['S', 'M']);
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const axis = await variants.findAxis('style-1', 'size');
      expect(axis?.getValues()).toEqual(['XS', 'XL']);
    });
  });
});
