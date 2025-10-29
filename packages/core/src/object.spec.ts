/**
 * Tests for SmrtObject functionality
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from './object';
import { smrt } from './registry';

// Simple test class extending SmrtObject
// Phase 2: @smrt() decorator needed for test classes (not in AST manifest)
@smrt()
class TestObject extends SmrtObject {
  static tableName = 'test_objects';

  // Need to initialize properties for runtime field detection
  name: string = '';
  description?: string = '';
  active: boolean = false;
  count: number = 0;
}

describe('SmrtObject', () => {
  describe('Basic Instantiation', () => {
    it('should create a new instance with provided values', async () => {
      const obj = new TestObject({
        id: 'test-id',
        name: 'Test Object',
        _skipLoad: true,
      });
      await obj.initialize();

      expect(obj).toBeInstanceOf(SmrtObject);
      expect(obj).toBeInstanceOf(TestObject);
      expect(obj.name).toBe('Test Object');
      expect(obj.id).toBe('test-id');
    });

    it('should handle missing ID (returns null)', async () => {
      const obj = new TestObject({ name: 'No ID Object', _skipLoad: true });
      await obj.initialize();

      expect(obj.name).toBe('No ID Object');
      expect(obj.id).toBeNull();
    });

    it('should accept ID in options', async () => {
      const customId = 'custom-test-id';
      const obj = new TestObject({
        id: customId,
        name: 'Test',
        _skipLoad: true,
      });
      await obj.initialize();

      expect(obj.id).toBe(customId);
    });
  });

  describe('Static Properties', () => {
    it('should have proper table name', () => {
      expect(TestObject.tableName).toBe('test_objects');
    });
  });

  describe('Instance Properties', () => {
    let testObj: TestObject;

    beforeEach(async () => {
      testObj = new TestObject({
        id: 'test-instance-id',
        name: 'Test Instance',
        _skipLoad: true,
      });
      await testObj.initialize();
    });

    it('should have proper property access', () => {
      expect(testObj.id).toBe('test-instance-id');
      expect(testObj.name).toBe('Test Instance');
    });

    it('should have timestamp properties', () => {
      expect(testObj).toHaveProperty('created_at');
      expect(testObj).toHaveProperty('updated_at');
    });
  });

  describe('Property Assignment', () => {
    it('should allow property updates', async () => {
      const obj = new TestObject({
        id: 'test-id',
        name: 'Initial',
        _skipLoad: true,
      });
      await obj.initialize();

      obj.name = 'Updated';
      obj.description = 'Added description';
      obj.count = 5;

      expect(obj.name).toBe('Updated');
      expect(obj.description).toBe('Added description');
      expect(obj.count).toBe(5);
    });
  });

  describe('Readonly Property Handling (Issue #61)', () => {
    // Test class with custom tableName in decorator
    @smrt({ tableName: 'custom_councils' })
    class Council extends SmrtObject {
      name: string = '';
      description?: string = '';
    }

    it('should not throw error when tableName is specified in decorator', async () => {
      // This would previously throw:
      // "TypeError: Cannot set property tableName of #<SmrtObject> which has only a getter"
      expect(async () => {
        const council = new Council({
          name: 'Test Council',
          description: 'A test council',
          _skipLoad: true,
        });
        await council.initialize();
      }).not.toThrow();
    });

    it('should allow accessing tableName getter after initialization', async () => {
      const council = new Council({
        name: 'Test Council',
        _skipLoad: true,
      });
      await council.initialize();

      // The tableName getter should return the value from the decorator
      expect(council.tableName).toBe('custom_councils');
    });

    it('should handle object creation with property values', async () => {
      const council = new Council({
        name: 'City Council',
        description: 'Main city governing body',
        _skipLoad: true,
      });
      await council.initialize();

      // Verify all properties were set correctly
      expect(council.name).toBe('City Council');
      expect(council.description).toBe('Main city governing body');
      expect(council.tableName).toBe('custom_councils');
    });

    it('should not throw error in loadDataFromDb (Issue #63)', async () => {
      // Test loadDataFromDb() directly - it should skip readonly properties
      const council = new Council({
        _skipLoad: true,
      });
      await council.initialize();

      // Simulate database data with table_name field
      const dbData = {
        id: 'test-id',
        name: 'Database Council',
        description: 'Loaded from DB',
        slug: 'database-council',
        context: '',
        tableName: 'custom_councils', // This would be in DB as table_name
        created_at: new Date(),
        updated_at: new Date(),
      };

      // loadDataFromDb should not throw when encountering readonly tableName
      expect(() => {
        council.loadDataFromDb(dbData);
      }).not.toThrow();

      // Verify data was loaded correctly
      expect(council.name).toBe('Database Council');
      expect(council.description).toBe('Loaded from DB');

      // tableName getter should still work
      expect(council.tableName).toBe('custom_councils');
    });
  });

  describe('Nullable Name Field (Issue #111)', () => {
    // Test class that doesn't redefine name (inherits from SmrtObject)
    @smrt({ tableName: 'test_meetings' })
    class TestMeeting extends SmrtObject {
      title: string = '';
      date?: Date;
    }

    it('should inherit null name from SmrtObject when not redefined', async () => {
      const meeting = new TestMeeting({
        title: 'Town Council Meeting',
        _skipLoad: true,
      });
      await meeting.initialize();

      // name should be inherited from SmrtObject and remain null
      expect(meeting.name).toBeNull();
    });

    it('should generate slug from title when name is null (PR #94 fallback)', async () => {
      const meeting = new TestMeeting({
        title: 'Town Council Meeting',
        _skipLoad: true,
      });
      await meeting.initialize();

      // Slug should be generated from title (PR #94 fallback chain: name → title → label → id)
      const slug = await meeting.getSlug();
      expect(slug).toBe('town-council-meeting');
    });

    it('should allow name field to be explicitly set', async () => {
      const meeting = new TestMeeting({
        title: 'Meeting',
        _skipLoad: true,
      });
      await meeting.initialize();

      // Explicitly set name (overrides inherited null)
      meeting.name = 'Custom Name';
      expect(meeting.name).toBe('Custom Name');

      // Slug should now use name instead of title
      const slug = await meeting.getSlug();
      expect(slug).toBe('custom-name');
    });

    it('should fall back to id for slug when both name and title are empty', async () => {
      const meeting = new TestMeeting({
        id: 'test-id-123',
        _skipLoad: true,
      });
      await meeting.initialize();

      // Both name and title are null/empty
      expect(meeting.name).toBeNull();
      expect(meeting.title).toBe('');

      // Slug should fall back to ID (PR #94 final fallback)
      const slug = await meeting.getSlug();
      expect(slug).toBe('test-id-123');
    });
  });
});
