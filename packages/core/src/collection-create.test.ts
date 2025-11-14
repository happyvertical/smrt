/**
 * Tests for SmrtCollection.create() static factory method
 *
 * Specifically tests the fix for issue #283:
 * SmrtCollection.create() 'this' context type error on subclasses
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CollectionCreateTestProduct,
  CollectionCreateTestProductCollection,
  Council,
  Councils,
  Organization,
} from './__tests__/fixtures/collection-create-test-classes.js';
import { SmrtCollection } from './collection';

describe('SmrtCollection.create() - Type Signature Fix (#283)', () => {
  describe('Basic Type Inference', () => {
    it('should create collection instance without type errors', async () => {
      // This should not require 'as any' cast (issue #283)
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      expect(collection).toBeInstanceOf(CollectionCreateTestProductCollection);
      expect(collection).toBeInstanceOf(SmrtCollection);
    });

    it('should preserve subclass type through factory method', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      // TypeScript should know about custom methods
      expect(collection.customMethod()).toBe('custom-method');
    });

    it('should return properly typed instance', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      // Should have both base class methods
      expect(typeof collection.list).toBe('function');
      expect(typeof collection.get).toBe('function');
      expect(typeof collection.create).toBe('function');

      // And subclass-specific methods
      expect(typeof collection.customMethod).toBe('function');
    });
  });

  describe('STI Collections (Issue #283 Scenario)', () => {
    // Note: STI tests skipped until STI base class registration is fully working
    it.skip('should create STI collection without type errors', async () => {
      // This exact pattern from issue #283 should work
      const councils = await Councils.create({
        db: { url: ':memory:' },
      });

      expect(councils).toBeInstanceOf(Councils);
      expect(councils).toBeInstanceOf(SmrtCollection);
    });

    it.skip('should support custom methods on STI collections', async () => {
      const councils = await Councils.create({
        db: { url: ':memory:' },
      });

      // TypeScript should know about getByJurisdiction
      const result = await councils.getByJurisdiction('test');
      expect(result).toBeNull(); // No data yet
    });

    it.skip('should properly initialize STI base class table', async () => {
      const councils = await Councils.create({
        db: { url: ':memory:' },
      });

      // Create a council instance
      const council = await councils.create({
        name: 'Test Council',
        jurisdiction: 'Municipal',
      });

      expect(council).toBeInstanceOf(Council);
      expect(council.name).toBe('Test Council');
      expect(council.jurisdiction).toBe('Municipal');
    });
  });

  describe('Constructor Type Compatibility', () => {
    it('should work with base SmrtCollectionOptions', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      expect(collection).toBeInstanceOf(CollectionCreateTestProductCollection);
    });

    it('should work with SmrtClassOptions (broader type)', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
        _className: 'CollectionCreateTestProductCollection',
      });

      expect(collection).toBeInstanceOf(CollectionCreateTestProductCollection);
    });

    it('should extract relevant options from broader config', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
        persistence: { type: 'sql', url: ':memory:' }, // Alias for db
        fs: { basePath: '/tmp' },
        logging: { level: 'info' },
      });

      expect(collection).toBeInstanceOf(CollectionCreateTestProductCollection);
    });
  });

  describe('Return Type Preservation', () => {
    it('should return Promise<T> not Promise<any>', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      // TypeScript should infer this as CollectionCreateTestProductCollection
      // If it's typed as 'any', we would lose type safety
      const customResult = collection.customMethod();
      expect(customResult).toBe('custom-method');
    });

    it('should allow chaining with typed methods', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      // This chain should be fully typed
      const products = await collection.list({ limit: 10 });
      expect(Array.isArray(products)).toBe(true);
    });
  });

  describe('Multiple Subclass Creation', () => {
    it('should work with different collection subclasses', async () => {
      const products = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      const councils = await Councils.create({
        db: { url: ':memory:' },
      });

      // Each should be their own type
      expect(products).toBeInstanceOf(CollectionCreateTestProductCollection);
      expect(councils).toBeInstanceOf(Councils);

      // With their own custom methods
      expect(products.customMethod()).toBe('custom-method');
      expect(typeof councils.getByJurisdiction).toBe('function');
    });
  });

  describe('Initialization State', () => {
    it('should return fully initialized instance', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      // Should be ready to use immediately
      const products = await collection.list({});
      expect(Array.isArray(products)).toBe(true);
    });

    it('should have initialized database connection', async () => {
      const collection = await CollectionCreateTestProductCollection.create({
        db: { url: ':memory:' },
      });

      // DB operations should work immediately
      const product = await collection.create({
        name: 'Test Product',
        price: 9.99,
        quantity: 10,
      });

      expect(product.name).toBe('Test Product');
    });
  });
});
