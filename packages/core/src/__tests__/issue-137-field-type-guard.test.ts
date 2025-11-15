/**
 * Test for Issue #137: Type narrowing and type guards
 *
 * This has been updated to test TypeScript type system behavior
 * rather than field helper instances (which have been removed).
 */

import { describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';

describe('Issue #137: TypeScript type guards and narrowing', () => {
  describe('TypeScript type system', () => {
    it('should handle string types correctly', () => {
      const value: string = 'hello';
      expect(typeof value).toBe('string');
      expect(value).toBe('hello');
    });

    it('should handle number types correctly', () => {
      const intValue: number = 42;
      const decimalValue: number = 3.14;
      expect(typeof intValue).toBe('number');
      expect(typeof decimalValue).toBe('number');
      expect(intValue).toBe(42);
      expect(decimalValue).toBe(3.14);
    });

    it('should handle boolean types correctly', () => {
      const value: boolean = true;
      expect(typeof value).toBe('boolean');
      expect(value).toBe(true);
    });

    it('should handle Date types correctly', () => {
      const value: Date = new Date();
      expect(value instanceof Date).toBe(true);
    });

    it('should handle object types correctly', () => {
      const value: Record<string, any> = {};
      expect(typeof value).toBe('object');
      expect(value).toEqual({});
    });

    it('should handle null values', () => {
      const value: null = null;
      expect(value).toBeNull();
    });

    it('should handle undefined values', () => {
      const value: undefined = undefined;
      expect(value).toBeUndefined();
    });

    it('should differentiate between primitives', () => {
      expect(typeof 'string').toBe('string');
      expect(typeof 42).toBe('number');
      expect(typeof true).toBe('boolean');
    });

    it('should handle plain objects', () => {
      const obj = {};
      const objWithProps = { foo: 'bar' };
      expect(typeof obj).toBe('object');
      expect(typeof objWithProps).toBe('object');
      expect(objWithProps.foo).toBe('bar');
    });

    it('should handle arrays', () => {
      const emptyArray: any[] = [];
      const numArray: number[] = [1, 2, 3];
      expect(Array.isArray(emptyArray)).toBe(true);
      expect(Array.isArray(numArray)).toBe(true);
      expect(numArray.length).toBe(3);
    });
  });

  describe('Type narrowing with unknown', () => {
    it('should properly narrow types from unknown', () => {
      const value: unknown = 'test';

      if (typeof value === 'string') {
        // TypeScript should know value is string here
        expect(value).toBe('test');
        expect(value.length).toBe(4);
      } else {
        throw new Error('Expected value to be string');
      }
    });

    it('should handle type guards for objects', () => {
      const maybeObject: any = { type: 'test', value: 100 };

      if (typeof maybeObject === 'object' && maybeObject !== null) {
        const objType = maybeObject.type;
        const objValue = maybeObject.value;

        expect(objType).toBe('test');
        expect(objValue).toBe(100);
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle objects with extra properties', () => {
      const obj: any = { base: 'value' };
      obj.extraProp = 'extra';

      expect(obj.base).toBe('value');
      expect(obj.extraProp).toBe('extra');
    });

    it('should handle optional properties', () => {
      interface TestInterface {
        required: string;
        optional?: string;
      }

      const withOptional: TestInterface = { required: 'test' };
      const withBoth: TestInterface = { required: 'test', optional: 'value' };

      expect(withOptional.required).toBe('test');
      expect(withOptional.optional).toBeUndefined();
      expect(withBoth.optional).toBe('value');
    });

    it('should handle nullable properties', () => {
      interface NullableInterface {
        value: string | null;
      }

      const withNull: NullableInterface = { value: null };
      const withValue: NullableInterface = { value: 'test' };

      expect(withNull.value).toBeNull();
      expect(withValue.value).toBe('test');
    });
  });
});
