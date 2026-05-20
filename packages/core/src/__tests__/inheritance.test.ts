/**
 * Test suite for multi-level class inheritance in SMRT framework
 *
 * Tests cover:
 * - 3-level inheritance chain (SmrtObject → Content → PraecoContent → BentleyContent)
 * - Field merging from all ancestors
 * - Method inheritance for CLI/API/MCP
 * - Field config merging (constraints, validators)
 * - Schema generation with inherited fields
 * - Inheritance chain caching
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { SchemaGenerator } from '../schema/generator.js';
import {
  ChildTypeMismatch,
  ChildWithConstraints,
  ChildWithMethod,
  InheritanceTestBentleyContent,
  InheritanceTestContent,
  InheritanceTestPraecoContent,
  OrphanClass,
  ParentTypeMismatch,
  ParentWithConstraints,
  ParentWithMethod,
} from './fixtures/inheritance-test-classes.js';

describe('Multi-level Class Inheritance', () => {
  beforeEach(() => {
    // Clear caches before each test
    ObjectRegistry.invalidateAllInheritanceCaches();
  });

  describe('Inheritance Chain Building', () => {
    it('should build correct inheritance chain for 3-level hierarchy', () => {
      const chain = ObjectRegistry.getInheritanceChain(
        'InheritanceTestBentleyContent',
      );
      // SmrtObject is excluded from chains (fixed in #265).
      // R5-canon: chains return qualified names.
      expect(chain).toEqual([
        '@happyvertical/smrt-core:InheritanceTestContent',
        '@happyvertical/smrt-core:InheritanceTestPraecoContent',
        '@happyvertical/smrt-core:InheritanceTestBentleyContent',
      ]);
    });

    it('should build correct inheritance chain for 2-level hierarchy', () => {
      const chain = ObjectRegistry.getInheritanceChain(
        'InheritanceTestPraecoContent',
      );
      // SmrtObject is excluded from chains (fixed in #265).
      // R5-canon: chains return qualified names.
      expect(chain).toEqual([
        '@happyvertical/smrt-core:InheritanceTestContent',
        '@happyvertical/smrt-core:InheritanceTestPraecoContent',
      ]);
    });

    it('should build correct inheritance chain for 1-level hierarchy', () => {
      const chain = ObjectRegistry.getInheritanceChain(
        'InheritanceTestContent',
      );
      // SmrtObject is excluded from chains (fixed in #265).
      // R5-canon: chains return qualified names.
      expect(chain).toEqual([
        '@happyvertical/smrt-core:InheritanceTestContent',
      ]);
    });

    it('should return empty array for unregistered class', () => {
      const chain = ObjectRegistry.getInheritanceChain('NonExistentClass');
      expect(chain).toEqual([]);
    });

    it('should cache inheritance chains for performance', () => {
      // First call builds and caches
      const chain1 = ObjectRegistry.getInheritanceChain(
        'InheritanceTestBentleyContent',
      );

      // Second call should return cached value
      const chain2 = ObjectRegistry.getInheritanceChain(
        'InheritanceTestBentleyContent',
      );

      expect(chain1).toBe(chain2); // Same reference = cached
    });
  });

  describe('Field Inheritance', () => {
    it('should include fields from all ancestors (3 levels)', async () => {
      const allFields = await ObjectRegistry.getAllFields(
        'InheritanceTestBentleyContent',
      );

      // Level 1 (Content) fields
      expect(allFields.has('title')).toBe(true);
      expect(allFields.has('body')).toBe(true);
      expect(allFields.has('publishedAt')).toBe(true);
      expect(allFields.has('wordCount')).toBe(true);

      // Level 2 (PraecoContent) fields
      expect(allFields.has('praecoCustom1')).toBe(true);
      expect(allFields.has('sourceUrl')).toBe(true);
      expect(allFields.has('rating')).toBe(true);

      // Level 3 (BentleyContent) fields
      expect(allFields.has('bentleyCustom1')).toBe(true);
      expect(allFields.has('localTags')).toBe(true);
    });

    it('should include fields from parent only (2 levels)', async () => {
      const allFields = await ObjectRegistry.getAllFields(
        'InheritanceTestPraecoContent',
      );

      // Level 1 (Content) fields
      expect(allFields.has('title')).toBe(true);
      expect(allFields.has('body')).toBe(true);

      // Level 2 (PraecoContent) fields
      expect(allFields.has('praecoCustom1')).toBe(true);
      expect(allFields.has('sourceUrl')).toBe(true);

      // Level 3 (BentleyContent) fields should NOT be included
      expect(allFields.has('bentleyCustom1')).toBe(false);
      expect(allFields.has('localTags')).toBe(false);
    });

    it('should only include own fields (1 level)', async () => {
      const allFields = await ObjectRegistry.getAllFields(
        'InheritanceTestContent',
      );

      // Level 1 (Content) fields
      expect(allFields.has('title')).toBe(true);
      expect(allFields.has('body')).toBe(true);

      // Descendant fields should NOT be included
      expect(allFields.has('praecoCustom1')).toBe(false);
      expect(allFields.has('bentleyCustom1')).toBe(false);
    });

    it('should include SmrtObject system fields but exclude internal framework properties', async () => {
      const allFields = await ObjectRegistry.getAllFields(
        'InheritanceTestContent',
      );

      expect(allFields.has('id')).toBe(true);
      expect(allFields.has('slug')).toBe(true);
      expect(allFields.has('context')).toBe(true);
      expect(allFields.has('created_at')).toBe(true);
      expect(allFields.has('updated_at')).toBe(true);

      // Internal implementation details should still stay out of field metadata.
      const fieldNames = Array.from(allFields.keys());
      expect(fieldNames).not.toContain('_tableName');
      expect(fieldNames).not.toContain('options');
      expect(fieldNames).not.toContain('_loadedRelationships');
    });

    it('should cache merged fields for performance', async () => {
      // First call builds and caches
      const fields1 = await ObjectRegistry.getAllFields(
        'InheritanceTestBentleyContent',
      );

      // Second call should return cached value
      const fields2 = await ObjectRegistry.getAllFields(
        'InheritanceTestBentleyContent',
      );

      // Both should have same content
      expect(fields1.size).toBe(fields2.size);
      expect(Array.from(fields1.keys())).toEqual(Array.from(fields2.keys()));
    });

    it('should prepend system fields when inherited field cache is pre-populated', async () => {
      const registered = ObjectRegistry.getClass(
        'InheritanceTestBentleyContent',
      );
      expect(registered).toBeDefined();
      if (!registered) {
        return;
      }

      registered.inheritedFields = new Map([
        ['headline', { type: 'text', _meta: { required: true } }],
      ]);

      try {
        const fields = await ObjectRegistry.getAllFields(
          'InheritanceTestBentleyContent',
        );

        expect(fields.has('headline')).toBe(true);
        expect(fields.has('id')).toBe(true);
        expect(fields.has('slug')).toBe(true);
        expect(fields.has('context')).toBe(true);
        expect(fields.has('created_at')).toBe(true);
        expect(fields.has('updated_at')).toBe(true);
      } finally {
        registered.inheritedFields = undefined;
      }
    });
  });

  describe('Field Config Merging', () => {
    it('should merge numeric constraints (take strictest)', async () => {
      const allFields = await ObjectRegistry.getAllFields(
        'ChildWithConstraints',
      );

      const ageField = allFields.get('age');
      expect(ageField._meta.min).toBe(18); // Stricter min (child)
      expect(ageField._meta.max).toBe(65); // Stricter max (child)

      const scoreField = allFields.get('score');
      expect(scoreField._meta.min).toBe(50.0); // Stricter min (child)
      expect(scoreField._meta.max).toBe(90.0); // Stricter max (child)
    });

    it('should warn when field types differ (console.warn)', async () => {
      // This test verifies the warning is emitted
      // In production, child type wins but warning alerts developer
      // Classes defined at top level of file
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Clear cache to force re-merge and trigger warning
      const registered = ObjectRegistry.classes.get('ChildTypeMismatch');
      if (registered) {
        registered.inheritedFields = undefined;
      }

      await ObjectRegistry.getAllFields('ChildTypeMismatch');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Field type mismatch'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Method Inheritance', () => {
    it('should include methods from all ancestors (3 levels)', async () => {
      const allMethods = await ObjectRegistry.getAllMethods(
        'InheritanceTestBentleyContent',
      );

      // Level 1 (Content) methods
      expect(allMethods.has('generateSummary')).toBe(true);

      // Level 2 (PraecoContent) methods
      expect(allMethods.has('analyzeSentiment')).toBe(true);

      // Level 3 (BentleyContent) methods
      expect(allMethods.has('analyzeLocal')).toBe(true);
    });

    it('should allow child methods to override parent methods', async () => {
      // Classes defined at top level of file
      const allMethods = await ObjectRegistry.getAllMethods('ChildWithMethod');
      const method = allMethods.get('doSomething');

      // Child method should override parent (last one wins)
      expect(method).toBeDefined();
    });

    it('should cache merged methods for performance', async () => {
      const methods1 = await ObjectRegistry.getAllMethods(
        'InheritanceTestBentleyContent',
      );
      const methods2 = await ObjectRegistry.getAllMethods(
        'InheritanceTestBentleyContent',
      );

      expect(methods1.size).toBe(methods2.size);
      expect(Array.from(methods1.keys())).toEqual(Array.from(methods2.keys()));
    });
  });

  describe('Schema Generation with Inheritance', () => {
    it('should generate schema with all inherited fields', async () => {
      const generator = new SchemaGenerator();
      const allFields = await ObjectRegistry.getAllFields(
        'InheritanceTestBentleyContent',
      );

      const schema = generator.generateSchemaFromRegistry(
        'InheritanceTestBentleyContent',
        'bentley_contents',
        allFields,
      );

      // Verify columns include fields from all levels (schema uses snake_case)
      expect(schema.columns).toHaveProperty('title'); // Content
      expect(schema.columns).toHaveProperty('body'); // Content
      expect(schema.columns).toHaveProperty('praeco_custom1'); // PraecoContent (snake_case!)
      expect(schema.columns).toHaveProperty('bentley_custom1'); // BentleyContent (snake_case!)

      // Verify SQL column types
      expect(schema.columns.title.type).toBe('TEXT');
      expect(schema.columns.word_count?.type).toBe('INTEGER'); // wordCount → word_count
      expect(schema.columns.rating?.type).toBe('REAL'); // DECIMAL
    });

    it('should maintain field order (base class first, child class last)', async () => {
      const allFields = await ObjectRegistry.getAllFields(
        'InheritanceTestBentleyContent',
      );
      const fieldNames = Array.from(allFields.keys());

      // Content fields should come before PraecoContent fields
      const titleIdx = fieldNames.indexOf('title');
      const praecoCustomIdx = fieldNames.indexOf('praecoCustom1');
      expect(titleIdx).toBeLessThan(praecoCustomIdx);

      // PraecoContent fields should come before BentleyContent fields
      const bentleyCustomIdx = fieldNames.indexOf('bentleyCustom1');
      expect(praecoCustomIdx).toBeLessThan(bentleyCustomIdx);
    });
  });

  describe('Runtime Object Behavior', () => {
    it('should allow creating and saving objects with inherited fields', async () => {
      const bentley = new InheritanceTestBentleyContent({
        title: 'Test Article',
        body: 'Test content',
        praecoCustom1: 'Praeco data',
        bentleyCustom1: 'Bentley data',
        db: { type: 'sqlite', url: ':memory:' },
      });

      await bentley.initialize();

      // Verify all fields are accessible
      expect(bentley.title).toBe('Test Article');
      expect((bentley as any).praecoCustom1).toBe('Praeco data');
      expect((bentley as any).bentleyCustom1).toBe('Bentley data');
    });

    it('should allow calling inherited methods', async () => {
      const bentley = new InheritanceTestBentleyContent({
        title: 'Test',
        db: { type: 'sqlite', url: ':memory:' },
      });

      await bentley.initialize();

      // Call methods from all levels
      const summary = await (bentley as any).generateSummary(); // Content
      const sentiment = await (bentley as any).analyzeSentiment(); // PraecoContent
      const local = await (bentley as any).analyzeLocal(); // BentleyContent

      expect(summary).toBe('Summary from InheritanceTestContent');
      expect(sentiment).toBe('Sentiment from InheritanceTestPraecoContent');
      expect(local).toBe('Analysis from InheritanceTestBentleyContent');
    });
  });

  describe('Performance', () => {
    it('should build inheritance chain in <1ms (cached)', () => {
      // First call to build and cache
      ObjectRegistry.getInheritanceChain('InheritanceTestBentleyContent');

      // Measure cached access
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        ObjectRegistry.getInheritanceChain('InheritanceTestBentleyContent');
      }
      const end = performance.now();
      const avgTime = (end - start) / 1000;

      expect(avgTime).toBeLessThan(1); // <1ms per call when cached
    });

    it('should merge fields in <10ms (cached)', async () => {
      // First call to merge and cache
      await ObjectRegistry.getAllFields('InheritanceTestBentleyContent');

      // Measure cached access
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        await ObjectRegistry.getAllFields('InheritanceTestBentleyContent');
      }
      const end = performance.now();
      const avgTime = (end - start) / 1000;

      expect(avgTime).toBeLessThan(10); // <10ms per call when cached
    });
  });

  describe('Cache Invalidation', () => {
    it('should invalidate cache for specific class', async () => {
      // Build and cache inheritance chain
      const chain1 = ObjectRegistry.getInheritanceChain(
        'InheritanceTestBentleyContent',
      );
      const fields1 = await ObjectRegistry.getAllFields(
        'InheritanceTestBentleyContent',
      );

      expect(chain1.length).toBeGreaterThan(0);
      expect(fields1.size).toBeGreaterThan(0);

      // Invalidate cache
      ObjectRegistry.invalidateInheritanceCache(
        'InheritanceTestBentleyContent',
      );

      // Verify cache was cleared (fields will be rebuilt on next access)
      const registered = ObjectRegistry.classes.get(
        'InheritanceTestBentleyContent',
      );
      expect(registered?.inheritedFields).toBeUndefined();
      expect(registered?.inheritedMethods).toBeUndefined();
    });

    it('should recursively invalidate descendant caches', async () => {
      // Build and cache entire hierarchy
      ObjectRegistry.getInheritanceChain('InheritanceTestContent');
      ObjectRegistry.getInheritanceChain('InheritanceTestPraecoContent');
      ObjectRegistry.getInheritanceChain('InheritanceTestBentleyContent');

      await ObjectRegistry.getAllFields('InheritanceTestContent');
      await ObjectRegistry.getAllFields('InheritanceTestPraecoContent');
      await ObjectRegistry.getAllFields('InheritanceTestBentleyContent');

      // Invalidate parent class
      ObjectRegistry.invalidateInheritanceCache('InheritanceTestContent');

      // Verify all descendants were also invalidated
      const content = ObjectRegistry.classes.get('InheritanceTestContent');
      const praeco = ObjectRegistry.classes.get('InheritanceTestPraecoContent');
      const bentley = ObjectRegistry.classes.get(
        'InheritanceTestBentleyContent',
      );

      expect(content?.inheritedFields).toBeUndefined();
      expect(praeco?.inheritedFields).toBeUndefined();
      expect(bentley?.inheritedFields).toBeUndefined();
    });

    it('should invalidate all inheritance caches', async () => {
      // Build and cache multiple classes
      ObjectRegistry.getInheritanceChain('InheritanceTestContent');
      ObjectRegistry.getInheritanceChain('InheritanceTestPraecoContent');
      ObjectRegistry.getInheritanceChain('InheritanceTestBentleyContent');

      await ObjectRegistry.getAllFields('InheritanceTestContent');
      await ObjectRegistry.getAllFields('InheritanceTestPraecoContent');
      await ObjectRegistry.getAllFields('InheritanceTestBentleyContent');

      // Invalidate all
      ObjectRegistry.invalidateAllInheritanceCaches();

      // Verify all were cleared
      for (const registered of ObjectRegistry.classes.values()) {
        if (registered.extends) {
          expect(registered.inheritedFields).toBeUndefined();
          expect(registered.inheritedMethods).toBeUndefined();
        }
      }
    });

    it('should rebuild cache after invalidation', async () => {
      // Build and cache
      const fields1 = await ObjectRegistry.getAllFields(
        'InheritanceTestBentleyContent',
      );
      expect(fields1.has('title')).toBe(true);

      // Invalidate
      ObjectRegistry.invalidateInheritanceCache(
        'InheritanceTestBentleyContent',
      );

      // Should rebuild cache on next access
      const fields2 = await ObjectRegistry.getAllFields(
        'InheritanceTestBentleyContent',
      );
      expect(fields2.has('title')).toBe(true);
      expect(fields2.size).toBe(fields1.size);
    });
  });

  describe('Error Handling', () => {
    it('should warn about missing ancestors by default', async () => {
      // Manually set extends to non-existent parent and clear inheritance chain
      // (OrphanClass is defined at top level of file)
      // Issue #951: Use findClass for qualified-key-aware lookup
      const registered = ObjectRegistry.getClass('OrphanClass');
      if (registered) {
        registered.extends = 'NonExistentParent';
        // SmrtObject is excluded from chains (fixed in #265)
        registered.inheritanceChain = ['NonExistentParent', 'OrphanClass'];
        registered.inheritedFields = undefined;
      }

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should warn but not throw
      const fields = await ObjectRegistry.getAllFields('OrphanClass');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing ancestor class "NonExistentParent"'),
      );
      // Should still include fields from OrphanClass itself
      expect(fields.has('orphanField')).toBe(true);

      consoleSpy.mockRestore();
    });

    it('should not warn about framework base classes (SmrtObject) in chain', async () => {
      // This test verifies the fix for issue #261
      // Previously, getAllFields() would warn about "Missing ancestor class 'SmrtObject'"
      // even though SmrtObject is a framework base class that shouldn't need to be registered

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Get fields for a simple class that extends SmrtObject
      const fields = await ObjectRegistry.getAllFields(
        'InheritanceTestContent',
      );

      // Should NOT warn about SmrtObject being missing
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Missing ancestor class "SmrtObject"'),
      );

      // Should still include fields from the class
      expect(fields.has('title')).toBe(true);
      expect(fields.has('body')).toBe(true);

      consoleSpy.mockRestore();
    });
  });
});
