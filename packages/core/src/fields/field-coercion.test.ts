/**
 * Tests for Field class transparent coercion to values
 *
 * These tests verify that Field instances automatically coerce to their values
 * in various JavaScript contexts, making them transparent to users.
 */

import { describe, expect, it } from 'vitest';
import { boolean, decimal, Field, foreignKey, integer, text } from './index.js';

describe('Field Value Coercion', () => {
  describe('Symbol.toPrimitive', () => {
    it('should coerce to string when hint is "string"', () => {
      const field = text({ default: 'Hello' });
      const result = `${field}`; // Template literal triggers 'string' hint
      expect(result).toBe('Hello');
    });

    it('should coerce to number when hint is "number"', () => {
      const field = integer({ default: 42 });
      const result = +field; // Unary plus triggers 'number' hint
      expect(result).toBe(42);
    });

    it('should return value when hint is "default"', () => {
      const field = integer({ default: 42 });
      // Arithmetic operations trigger 'default' or 'number' hint
      const result = field + 0;
      expect(result).toBe(42);
    });

    it('should handle null/undefined values in string context', () => {
      const field = new Field('text', {});
      const result = `${field}`;
      expect(result).toBe('');
    });

    it('should handle null/undefined values in number context', () => {
      const field = new Field('integer', {});
      const result = +field;
      expect(result).toBe(0);
    });
  });

  describe('toString()', () => {
    it('should convert field value to string', () => {
      const field = text({ default: 'World' });
      expect(field.toString()).toBe('World');
    });

    it('should handle numeric values', () => {
      const field = integer({ default: 100 });
      expect(field.toString()).toBe('100');
    });

    it('should handle boolean values', () => {
      const field = boolean({ default: true });
      expect(field.toString()).toBe('true');
    });

    it('should return empty string for null/undefined', () => {
      const field = new Field('text', {});
      expect(field.toString()).toBe('');
    });
  });

  describe('valueOf()', () => {
    it('should return the field value', () => {
      const field = integer({ default: 25 });
      expect(field.valueOf()).toBe(25);
    });

    it('should work with arithmetic operations', () => {
      const age = integer({ default: 25 });
      const result = age.valueOf() + 5;
      expect(result).toBe(30);
    });

    it('should return undefined for uninitialized fields', () => {
      const field = new Field('text', {});
      expect(field.valueOf()).toBeUndefined();
    });
  });

  describe('toJSON()', () => {
    it('should serialize field value correctly', () => {
      const field = text({ default: 'JSON test' });
      expect(field.toJSON()).toBe('JSON test');
    });

    it('should work with JSON.stringify', () => {
      const data = {
        name: text({ default: 'John' }),
        age: integer({ default: 30 }),
        active: boolean({ default: true }),
      };

      const json = JSON.stringify(data);
      const parsed = JSON.parse(json);

      expect(parsed).toEqual({
        name: 'John',
        age: 30,
        active: true,
      });
    });

    it('should handle null values', () => {
      const field = new Field('text', {});
      expect(field.toJSON()).toBeUndefined();
    });
  });

  describe('String operations', () => {
    it('should work with string concatenation', () => {
      const name = text({ default: 'Alice' });
      const greeting = `Hello, ${name}`;
      expect(greeting).toBe('Hello, Alice');
    });

    it('should work with template literals', () => {
      const city = text({ default: 'Paris' });
      const message = `Welcome to ${city}!`;
      expect(message).toBe('Welcome to Paris!');
    });

    it('should work with string methods via toString()', () => {
      const name = text({ default: 'john' });
      const upper = name.toString().toUpperCase();
      expect(upper).toBe('JOHN');
    });
  });

  describe('Numeric operations', () => {
    it('should work with addition', () => {
      const a = integer({ default: 10 });
      const b = integer({ default: 20 });
      const result = a.valueOf() + b.valueOf();
      expect(result).toBe(30);
    });

    it('should work with comparison operators', () => {
      const age = integer({ default: 25 });
      expect(age.valueOf() > 18).toBe(true);
      expect(age.valueOf() < 30).toBe(true);
    });

    it('should work with decimal values', () => {
      const price = decimal({ default: 19.99 });
      const total = price.valueOf() * 2;
      expect(total).toBeCloseTo(39.98);
    });
  });

  describe('Foreign key fields', () => {
    it('should store and retrieve foreign key values', () => {
      const councilId = foreignKey('Council');
      councilId.value = 'uuid-123-456';
      expect(councilId.value).toBe('uuid-123-456');
      expect(councilId.valueOf()).toBe('uuid-123-456');
    });

    it('should coerce to string for database queries', () => {
      const meetingId = foreignKey('Meeting');
      meetingId.value = 'meeting-abc-def';
      const query = `SELECT * FROM councils WHERE id = '${meetingId}'`;
      expect(query).toBe("SELECT * FROM councils WHERE id = 'meeting-abc-def'");
    });

    it('should work with undefined values', () => {
      const councilId = foreignKey('Council');
      expect(councilId.value).toBeUndefined();
      expect(councilId.toString()).toBe('');
    });
  });

  describe('Equality comparisons', () => {
    it('should use valueOf() for value comparisons', () => {
      const name = text({ default: 'test' });
      // Field instances don't === their values (different types)
      expect(name.valueOf() === 'test').toBe(true);
    });

    it('should not work with strict equality (different types)', () => {
      const name = text({ default: 'test' });
      // Field object !== string primitive
      expect(name === 'test').toBe(false);
      // But valueOf() extracts the value
      expect(name.valueOf() === 'test').toBe(true);
    });

    it('should compare Field instances correctly', () => {
      const a = integer({ default: 10 });
      const b = integer({ default: 10 });
      expect(a.valueOf()).toBe(b.valueOf());
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string defaults', () => {
      const field = text({ default: '' });
      expect(field.toString()).toBe('');
      expect(field.valueOf()).toBe('');
    });

    it('should handle zero defaults', () => {
      const field = integer({ default: 0 });
      expect(field.valueOf()).toBe(0);
      expect(+field).toBe(0);
    });

    it('should handle false defaults', () => {
      const field = boolean({ default: false });
      expect(field.valueOf()).toBe(false);
      expect(field.toString()).toBe('false');
    });

    it('should handle complex default values', () => {
      const field = new Field('json', {
        default: { key: 'value', nested: { a: 1 } },
      });
      expect(field.valueOf()).toEqual({ key: 'value', nested: { a: 1 } });
    });
  });

  describe('Type preservation', () => {
    it('should preserve string types', () => {
      const field = text({ default: 'test' });
      expect(typeof field.valueOf()).toBe('string');
    });

    it('should preserve number types', () => {
      const field = integer({ default: 42 });
      expect(typeof field.valueOf()).toBe('number');
    });

    it('should preserve boolean types', () => {
      const field = boolean({ default: true });
      expect(typeof field.valueOf()).toBe('boolean');
    });

    it('should preserve object types', () => {
      const field = new Field('json', { default: { a: 1 } });
      expect(typeof field.valueOf()).toBe('object');
      expect(field.valueOf()).toBeInstanceOf(Object);
    });
  });
});
