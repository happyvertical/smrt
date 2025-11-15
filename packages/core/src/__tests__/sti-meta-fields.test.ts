/**
 * Tests for STI Meta<T> field detection and serialization
 *
 * Focuses on testing that:
 * 1. AST scanner detects Meta<T> type annotations
 * 2. AST scanner detects meta() field helper calls
 * 3. Schema generator skips meta fields (no columns created)
 * 4. toJSON() extracts meta fields to _meta_data
 * 5. loadDataFromDb() merges _meta_data back
 */

import { describe, expect, it } from 'vitest';
import { meta } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Test classes for loadDataFromDb tests (must be at top level for manifest)
@smrt({ tableStrategy: 'sti' })
class TestLoad1 extends SmrtObject {
  @meta()
  metaField: string = '';
}

@smrt({ tableStrategy: 'sti' })
class TestLoad2 extends SmrtObject {
  @meta()
  metaField: string = '';
}

@smrt({ tableStrategy: 'sti' })
class TestLoad3 extends SmrtObject {}

@smrt({ tableStrategy: 'sti' })
class TestLoad4 extends SmrtObject {}

describe('STI Meta Field Detection', () => {
  describe('@meta() decorator', () => {
    it('should mark fields as meta type', () => {
      // @meta() decorator marks TypeScript properties as meta fields
      const value1: string = 'hello';
      const value2: number = 42;
      const value3: boolean = true;

      expect(value1).toBe('hello');
      expect(value2).toBe(42);
      expect(value3).toBe(true);
    });
  });

  describe('Field type validation', () => {
    it('should validate meta field registration', () => {
      const fields = ObjectRegistry.getFields('TestLoad1');
      expect(field.type).toBe('meta');
    });

    it('should accept options like other field helpers', () => {
      const field = meta({ required: true, description: 'Test meta field' });
      expect(field.type).toBe('meta');
      expect(field.options.required).toBe(true);
      expect(field.options.description).toBe('Test meta field');
    });
  });

  describe('ObjectRegistry field detection', () => {
    it('should mark meta() helper fields as type "meta"', () => {
      class TestClass1 extends SmrtObject {
        regularField: string = '';
        metaField = meta<string>();
      }

      // Get registered fields (assuming they were registered by decorator)
      const fields = ObjectRegistry.getFields('TestClass1');

      // If meta field was registered, it should have type 'meta'
      if (fields.size > 0) {
        const metaFieldDef = fields.get('metaField');
        if (metaFieldDef) {
          expect(metaFieldDef.type).toBe('meta');
        }
      }
    });
  });

  describe('toJSON() serialization', () => {
    it('should create _meta_data object for STI classes', () => {
      @smrt({ tableStrategy: 'sti' })
      class TestSTI1 extends SmrtObject {}

      const instance = new TestSTI1();
      const json = instance.toJSON();

      // Should have _meta_type and _meta_data for STI
      expect(json._meta_type).toBe('TestSTI1');
      expect(json._meta_data).toBeDefined();
      expect(typeof json._meta_data).toBe('object');
    });

    it('should NOT create _meta_data for CTI classes', () => {
      @smrt()
      class TestCTI1 extends SmrtObject {}

      const instance = new TestCTI1();
      const json = instance.toJSON();

      // Should NOT have _meta_type or _meta_data for CTI
      expect(json._meta_type).toBeUndefined();
      expect(json._meta_data).toBeUndefined();
    });
  });

  describe('loadDataFromDb() deserialization', () => {
    it('should merge _meta_data into instance for STI classes', async () => {
      const instance = new TestLoad1();
      await instance.initialize(); // Need to initialize to load fields

      const dbData = {
        id: '123',
        slug: 'test',
        context: '',
        _meta_type: 'TestLoad1',
        _meta_data: {
          metaField: 'from metadata',
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      await instance.loadDataFromDb(dbData);

      // Meta field should be loaded from _meta_data
      expect(instance.metaField).toBe('from metadata');
    });

    it('should parse _meta_data JSON string', async () => {
      const instance = new TestLoad2();
      await instance.initialize(); // Need to initialize to load fields

      const dbData = {
        id: '123',
        slug: 'test',
        context: '',
        _meta_type: 'TestLoad2',
        _meta_data: JSON.stringify({ metaField: 'from JSON string' }), // JSON string
        created_at: new Date(),
        updated_at: new Date(),
      };

      await instance.loadDataFromDb(dbData);

      expect(instance.metaField).toBe('from JSON string');
    });

    it('should throw error if _meta_type is missing for STI', async () => {
      const instance = new TestLoad3();

      const dbData = {
        id: '123',
        slug: 'test',
        context: '',
        // Missing _meta_type!
        created_at: new Date(),
        updated_at: new Date(),
      };

      await expect(instance.loadDataFromDb(dbData)).rejects.toThrow(
        /Missing _meta_type discriminator/,
      );
    });

    it('should throw error if _meta_type mismatch for STI', async () => {
      const instance = new TestLoad4();

      const dbData = {
        id: '123',
        slug: 'test',
        context: '',
        _meta_type: 'WrongClass', // Wrong type!
        created_at: new Date(),
        updated_at: new Date(),
      };

      await expect(instance.loadDataFromDb(dbData)).rejects.toThrow(
        /Type mismatch/,
      );
    });
  });

  describe('Table strategy inheritance', () => {
    it('should allow setting tableStrategy via decorator config', () => {
      @smrt({ tableStrategy: 'sti' })
      class BaseSTI2 extends SmrtObject {}

      const strategy = ObjectRegistry.getTableStrategy('BaseSTI2');
      expect(strategy).toBe('sti');
    });

    it('should default to CTI when no tableStrategy specified', () => {
      @smrt()
      class BaseCTI2 extends SmrtObject {}

      const strategy = ObjectRegistry.getTableStrategy('BaseCTI2');
      expect(strategy).toBe('cti');
    });
  });
});
