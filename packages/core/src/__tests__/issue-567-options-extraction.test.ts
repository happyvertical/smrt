/**
 * Test for issue #567: ObjectRegistry.getCollection() should properly extract db/ai config
 * https://github.com/happyvertical/smrt/issues/567
 *
 * When calling ObjectRegistry.getCollection() from within a class that has an options
 * object containing db and ai configs, passing this.options directly should work correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtClass, type SmrtClassOptions } from '../class';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Test objects - need unique names to avoid conflicts with test manifest
@smrt({ api: true, mcp: true, cli: true })
class Target567 extends SmrtObject {
  value: string = '';
}

class Target567Collection extends SmrtCollection<Target567> {
  static readonly _itemClass = Target567;
}

// A SmrtClass-based parent that gets collections using its own options
class Parent567 extends SmrtClass {
  async getTargetCollection(): Promise<SmrtCollection<Target567>> {
    // This is the problematic pattern from issue #567
    // Passing this.options which has properties beyond just db/ai
    return ObjectRegistry.getCollection<Target567>('Target567', this.options);
  }

  async getTargetCollectionWithExplicitExtraction(): Promise<
    SmrtCollection<Target567>
  > {
    // This is the workaround that works
    return ObjectRegistry.getCollection<Target567>('Target567', {
      db: this.options.db,
      ai: this.options.ai,
    });
  }
}

describe('Issue #567: ObjectRegistry.getCollection() options extraction', () => {
  beforeEach(async () => {
    // Clear registry before each test
    ObjectRegistry.clear();

    // Re-register the test class
    ObjectRegistry.register(Target567, {
      api: true,
      mcp: true,
      cli: true,
    });
  });

  afterEach(async () => {
    // Clean up
    ObjectRegistry.clear();
  });

  describe('Collection db config extraction from SmrtClass options', () => {
    it('should use the same db when using full options vs explicit extraction', async () => {
      // Create a parent class with options that include db config
      const parentOptions: SmrtClassOptions = {
        db: { type: 'sqlite', url: ':memory:' },
      };

      const parent = new Parent567(parentOptions);
      await parent.initialize();

      // Get collections using both methods
      const collectionFull = await parent.getTargetCollection();
      const collectionExplicit =
        await parent.getTargetCollectionWithExplicitExtraction();

      // Both should use the same underlying database
      // If not, this is the bug from issue #567
      expect(collectionFull.db).toBe(collectionExplicit.db);
    });

    it('should work when parent options include extra properties', async () => {
      // Create parent with options that have extra properties (simulating real-world usage)
      const parentOptions: SmrtClassOptions & {
        customProp?: string;
        nested?: { value: number };
      } = {
        db: { type: 'sqlite', url: ':memory:' },
        customProp: 'extra-value',
        nested: { value: 42 },
      };

      const parent = new Parent567(parentOptions as any);
      await parent.initialize();

      // Get collection using full options (with extra properties)
      const collection = await parent.getTargetCollection();

      // The collection should still work correctly
      expect(collection).toBeDefined();
      expect(collection.db).toBe(parent.db);
    });

    it('should return cached collection for same db instance', async () => {
      const parent = new Parent567({
        db: { type: 'sqlite', url: ':memory:' },
      });
      await parent.initialize();

      // Get collection twice
      const collection1 = await parent.getTargetCollection();
      const collection2 = await parent.getTargetCollection();

      // Should return the same cached instance
      expect(collection1).toBe(collection2);
    });

    it('should use parent db instance when passed in options', async () => {
      const parent = new Parent567({
        db: { type: 'sqlite', url: ':memory:' },
      });
      await parent.initialize();

      // The parent should have a db instance
      const parentDb = parent.db;
      expect(parentDb).toBeDefined();

      // Get collection
      const collection = await parent.getTargetCollection();

      // The collection should use the SAME db instance as the parent
      // This is the core assertion for issue #567
      const collectionDb = collection.db;
      expect(collectionDb).toBe(parentDb);
    });
  });
});
