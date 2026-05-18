/**
 * Tests for the upstream STI subtypes (ProductVariant, Material) and tenant
 * isolation on Product / Category.
 *
 * Vertical-specific subtypes (apparel `Style`/`Makeup`, automotive `Model`/`Trim`,
 * etc.) are intentionally NOT in this package — consumers subclass `Product`
 * themselves. See the apparel template for an example.
 *
 * STI uses `_meta_type` discriminator; subtype-specific fields are stored in
 * `_meta_data` JSONB. Tenancy is optional (`@TenantScoped({ mode: 'optional' })`)
 * so all queries auto-filter when wrapped in `withTenant()` and fall through
 * when no context is set.
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

    it.each([
      ['ProductVariant', ProductVariant],
      ['Material', Material],
    ])('resolves Product as STI base for %s', (name) => {
      expect(ObjectRegistry.getSTIBase(name)).toBe('Product');
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

    it.each([
      [
        ProductVariant,
        '@happyvertical/smrt-products:ProductVariant',
        ProductType.VARIANT,
      ],
      [Material, '@happyvertical/smrt-products:Material', ProductType.MATERIAL],
    ])('stamps %s with the right discriminator and productType', async (cls, expected, typeValue) => {
      const instance = new (cls as any)({ name: 'thing' });
      await instance.initialize();
      const json = instance.toJSON();
      expect(json._meta_type).toBe(expected);
      expect(instance.productType).toBe(typeValue);
    });
  });

  describe('Subtype persistence and polymorphic retrieval', () => {
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

    it('returns the right subclass instance from a base collection list', async () => {
      const variants = await ProductVariantCollection.create({ db });
      const materials = await MaterialCollection.create({ db });
      const products = await ProductCollection.create({ db });

      const variant = await variants.create({
        name: 'Variant A',
        parentProductId: 'parent-1',
      });
      await variant.save();
      const material = await materials.create({
        name: 'Cotton thread',
        materialKind: 'thread',
      });
      await material.save();

      const all = await products.list({ orderBy: 'created_at ASC' });
      expect(all.length).toBe(2);

      const variantRow = all.find((p) => p.id === variant.id);
      const materialRow = all.find((p) => p.id === material.id);
      expect(variantRow).toBeInstanceOf(ProductVariant);
      expect(materialRow).toBeInstanceOf(Material);
    });

    it('filters STI subtype collections to their own rows only', async () => {
      const variants = await ProductVariantCollection.create({ db });
      const materials = await MaterialCollection.create({ db });

      await (
        await variants.create({ name: 'V1', parentProductId: 'p1' })
      ).save();
      await (
        await variants.create({ name: 'V2', parentProductId: 'p1' })
      ).save();
      await (
        await materials.create({
          name: 'Cotton thread',
          materialKind: 'thread',
        })
      ).save();

      const allVariants = await variants.list({});
      const allMaterials = await materials.list({});

      expect(allVariants).toHaveLength(2);
      expect(allMaterials).toHaveLength(1);
      expect(allVariants.every((v) => v instanceof ProductVariant)).toBe(true);
      expect(allMaterials.every((m) => m instanceof Material)).toBe(true);
    });

    it('stores ProductVariant axis values as a JSON map', async () => {
      const variants = await ProductVariantCollection.create({ db });

      const navy = await variants.create({
        name: 'Navy variant',
        parentProductId: 'parent-1',
        axisValues: { color: 'Navy' },
      });
      await navy.save();

      const loaded = await variants.get({ id: navy.id! });
      expect(loaded?.axisValues).toEqual({ color: 'Navy' });
      expect(loaded?.parentProductId).toBe('parent-1');
    });
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
});
