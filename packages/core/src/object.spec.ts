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

  // Don't initialize these - let SmrtObject handle them
  declare name: string;
  declare description?: string;
  declare active: boolean;
  declare count: number;
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
});
