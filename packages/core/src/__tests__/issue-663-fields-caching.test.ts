/**
 * Test for issue #663: getFields() Performance Overhead
 * https://github.com/happyvertical/smrt/issues/663
 *
 * Tests that fields are cached during collection initialization to avoid
 * async getFields() calls on every query, improving performance.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Test class (unique name to avoid collisions - see issue #543)
@smrt({ api: { include: ['list', 'get'] } })
class FieldsCachingTestProduct extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  category: string = '';
  quantity: number = 0;
}

class FieldsCachingTestProductCollection extends SmrtCollection<FieldsCachingTestProduct> {
  static readonly _itemClass = FieldsCachingTestProduct;
}

describe('Issue #663: Fields Caching Performance', () => {
  ObjectRegistry.registerCollection(
    'FieldsCachingTestProduct',
    FieldsCachingTestProductCollection,
  );

  let collection: FieldsCachingTestProductCollection;

  beforeAll(async () => {
    collection = await FieldsCachingTestProductCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Create test data
    const widget = await collection.create({
      name: 'Widget',
      price: 100.5,
      category: 'A',
      quantity: 10,
    });
    await widget.save();

    const gadget = await collection.create({
      name: 'Gadget',
      price: 200.0,
      category: 'B',
      quantity: 5,
    });
    await gadget.save();
  });

  afterAll(async () => {
    await collection.db?.close?.();
  });

  describe('Fields Caching', () => {
    it('should have cached fields after create()', () => {
      // Access private _cachedFields via type assertion
      const cachedFields = (collection as any)._cachedFields;
      expect(cachedFields).not.toBeNull();
      expect(cachedFields).toBeDefined();
    });

    it('should include all defined fields in cache', () => {
      const cachedFields = (collection as any)._cachedFields;
      expect(cachedFields).toHaveProperty('name');
      expect(cachedFields).toHaveProperty('price');
      expect(cachedFields).toHaveProperty('category');
      expect(cachedFields).toHaveProperty('quantity');
    });

    it('getFieldsSync() should return cached fields', () => {
      const syncFields = (collection as any).getFieldsSync();
      expect(syncFields).toBeDefined();
      expect(syncFields).toHaveProperty('name');
      expect(syncFields).toHaveProperty('price');
    });

    it('getFieldsSync() should return same data as cached fields', () => {
      const cachedFields = (collection as any)._cachedFields;
      const syncFields = (collection as any).getFieldsSync();
      expect(syncFields).toEqual(cachedFields);
    });
  });

  describe('Query Operations (sync convertWhereKeys)', () => {
    it('list() should work with sync field lookup', async () => {
      const results = await collection.list({
        where: { category: 'A' },
      });

      expect(results).toBeDefined();
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Widget');
    });

    it('get() should work with sync field lookup', async () => {
      const products = await collection.list({});
      const product = await collection.get({ name: 'Widget' });

      expect(product).not.toBeNull();
      expect(product?.name).toBe('Widget');
    });

    it('count() should work with sync field lookup', async () => {
      const count = await collection.count({
        where: { 'price >': 150 },
      });

      expect(count).toBe(1); // Only Gadget at 200.00 (Widget is 100.50)
    });

    it('should handle multiple query operations in sequence', async () => {
      // Multiple queries should all work without async field loading
      const list1 = await collection.list({ where: { category: 'A' } });
      const list2 = await collection.list({ where: { category: 'B' } });
      const count1 = await collection.count({ where: { 'quantity >': 0 } });
      const count2 = await collection.count({ where: { 'price >=': 100 } });

      expect(list1.length).toBe(1);
      expect(list2.length).toBe(1);
      expect(count1).toBe(2);
      expect(count2).toBe(2);
    });
  });

  describe('Complex WHERE Clauses', () => {
    it('should validate field names using cached fields', async () => {
      // This should work - valid field
      const results = await collection.list({
        where: { 'price >': 50 },
      });
      expect(results.length).toBe(2);
    });

    it('should reject invalid fields using cached fields', async () => {
      await expect(
        collection.list({
          where: { nonExistentField: 'value' },
        }),
      ).rejects.toThrow(/Invalid WHERE clause field/);
    });

    it('should handle combined operators', async () => {
      const results = await collection.list({
        where: {
          'price >=': 100,
          'quantity >': 0,
          'category in': ['A', 'B'],
        },
      });

      expect(results.length).toBe(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty where clause', async () => {
      const results = await collection.list({ where: {} });
      expect(results.length).toBe(2);
    });

    it('should handle undefined where clause', async () => {
      const results = await collection.list({});
      expect(results.length).toBe(2);
    });

    it('listByIds should work with sync field lookup', async () => {
      const allProducts = await collection.list({});
      const ids = allProducts.map((p) => p.id as string);

      const products = await collection.listByIds(ids);
      expect(products.length).toBe(2);
    });
  });
});
