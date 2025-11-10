/**
 * Test for Issue #137: Add type guard for Field instance detection
 *
 * This verifies that the isFieldInstance() type guard correctly identifies
 * Field instances and provides proper TypeScript type narrowing.
 */

import { describe, expect, it } from 'vitest';
import {
  boolean as booleanField,
  datetime,
  decimal,
  foreignKey,
  integer,
  json,
  text,
} from '../fields';
import { SmrtObject } from '../object';
import { isFieldInstance } from '../utils';

describe('Issue #137: Field type guard', () => {
  describe('isFieldInstance()', () => {
    it('should return true for text field instances', () => {
      const field = text({ default: 'hello' });
      expect(isFieldInstance(field)).toBe(true);
    });

    it('should return true for integer field instances', () => {
      const field = integer({ default: 42 });
      expect(isFieldInstance(field)).toBe(true);
    });

    it('should return true for decimal field instances', () => {
      const field = decimal({ default: 3.14 });
      expect(isFieldInstance(field)).toBe(true);
    });

    it('should return true for boolean field instances', () => {
      const field = booleanField({ default: true });
      expect(isFieldInstance(field)).toBe(true);
    });

    it('should return true for datetime field instances', () => {
      const field = datetime({ default: new Date() });
      expect(isFieldInstance(field)).toBe(true);
    });

    it('should return true for json field instances', () => {
      const field = json({ default: {} });
      expect(isFieldInstance(field)).toBe(true);
    });

    it('should return true for foreignKey field instances', () => {
      const field = foreignKey(SmrtObject);
      expect(isFieldInstance(field)).toBe(true);
    });

    it('should return false for plain objects with value and type', () => {
      const fakeField = { value: 'hello', type: 'text' };
      // Should still return false because it's missing 'options'
      expect(isFieldInstance(fakeField)).toBe(false);
    });

    it('should return false for objects with all properties but wrong types', () => {
      const fakeField = { value: 'hello', type: 123, options: {} };
      // type should be a string
      expect(isFieldInstance(fakeField)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isFieldInstance(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isFieldInstance(undefined)).toBe(false);
    });

    it('should return false for primitives', () => {
      expect(isFieldInstance('string')).toBe(false);
      expect(isFieldInstance(42)).toBe(false);
      expect(isFieldInstance(true)).toBe(false);
    });

    it('should return false for plain objects', () => {
      expect(isFieldInstance({})).toBe(false);
      expect(isFieldInstance({ foo: 'bar' })).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isFieldInstance([])).toBe(false);
      expect(isFieldInstance([1, 2, 3])).toBe(false);
    });
  });

  describe('Type narrowing', () => {
    it('should properly narrow types in TypeScript', () => {
      const value: unknown = text({ default: 'test' });

      if (isFieldInstance(value)) {
        // TypeScript should know that value is a Field here
        expect(value.type).toBe('text');
        expect(value.value).toBe('test');
        expect(value.options).toBeDefined();
      } else {
        throw new Error('Expected isFieldInstance to return true');
      }
    });

    it('should allow accessing Field properties after type guard', () => {
      const maybeField: any = integer({ default: 100, min: 0, max: 1000 });

      if (isFieldInstance(maybeField)) {
        // All these should be accessible without TypeScript errors
        const fieldType = maybeField.type;
        const fieldValue = maybeField.value;
        const fieldOptions = maybeField.options;

        expect(fieldType).toBe('integer');
        expect(fieldValue).toBe(100);
        expect(fieldOptions.min).toBe(0);
        expect(fieldOptions.max).toBe(1000);
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle objects with extra properties', () => {
      const field = text({ default: 'test' });
      (field as any).extraProp = 'extra';

      // Should still be recognized as a Field
      expect(isFieldInstance(field)).toBe(true);
    });

    it('should handle Field instances with undefined value', () => {
      const field = text(); // No default value
      expect(isFieldInstance(field)).toBe(true);
      expect(field.value).toBeUndefined();
    });

    it('should handle Field instances with null value', () => {
      const field = text({ default: null });
      expect(isFieldInstance(field)).toBe(true);
      expect(field.value).toBeNull();
    });
  });
});
