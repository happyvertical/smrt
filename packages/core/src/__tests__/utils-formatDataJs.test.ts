/**
 * Tests for formatDataJs utility function
 *
 * Verifies type coercion when loading data from database:
 * - INTEGER fields are coerced to integers
 * - REAL/DECIMAL fields are coerced to floats
 * - JSON fields are parsed from strings
 * - Boolean fields are converted from 0/1
 */

import { describe, expect, it } from 'vitest';
import { formatDataJs } from '../utils.js';

describe('formatDataJs', () => {
  describe('INTEGER type coercion', () => {
    it('should convert string "2" to number 2 for INTEGER fields', () => {
      const data = { version: '2' };
      const fields = { version: { type: 'INTEGER' } };

      const result = formatDataJs(data, fields);

      expect(result.version).toBe(2);
      expect(typeof result.version).toBe('number');
    });

    it('should convert string "2.0" to number 2 for INTEGER fields', () => {
      const data = { version: '2.0' };
      const fields = { version: { type: 'INTEGER' } };

      const result = formatDataJs(data, fields);

      expect(result.version).toBe(2);
      expect(typeof result.version).toBe('number');
    });

    it('should pass through number 2.0 as 2 for INTEGER fields (JS equivalence)', () => {
      const data = { version: 2.0 };
      const fields = { version: { type: 'INTEGER' } };

      const result = formatDataJs(data, fields);

      // In JavaScript, 2.0 === 2 so no conversion needed
      expect(result.version).toBe(2);
      expect(typeof result.version).toBe('number');
    });

    it('should NOT truncate non-integer values to surface data issues', () => {
      const data = { count: 2.9 };
      const fields = { count: { type: 'INTEGER' } };

      const result = formatDataJs(data, fields);

      // Keep as 2.9 to surface data corruption - don't silently truncate
      expect(result.count).toBe(2.9);
    });

    it('should keep non-numeric strings as-is for INTEGER fields', () => {
      const data = { version: 'abc' };
      const fields = { version: { type: 'INTEGER' } };

      const result = formatDataJs(data, fields);

      expect(result.version).toBe('abc');
    });
  });

  describe('REAL/DECIMAL type coercion', () => {
    it('should convert string "3.14" to number for REAL fields', () => {
      const data = { price: '3.14' };
      const fields = { price: { type: 'REAL' } };

      const result = formatDataJs(data, fields);

      expect(result.price).toBe(3.14);
      expect(typeof result.price).toBe('number');
    });

    it('should convert string "3.14" to number for DECIMAL fields', () => {
      const data = { price: '3.14' };
      const fields = { price: { type: 'DECIMAL' } };

      const result = formatDataJs(data, fields);

      expect(result.price).toBe(3.14);
      expect(typeof result.price).toBe('number');
    });

    it('should keep non-numeric strings as-is for REAL fields', () => {
      const data = { price: 'N/A' };
      const fields = { price: { type: 'REAL' } };

      const result = formatDataJs(data, fields);

      expect(result.price).toBe('N/A');
    });
  });

  describe('Boolean type coercion', () => {
    it('should convert 1 to true for BOOLEAN fields', () => {
      const data = { active: 1 };
      const fields = { active: { type: 'BOOLEAN' } };

      const result = formatDataJs(data, fields);

      expect(result.active).toBe(true);
    });

    it('should convert 0 to false for BOOLEAN fields', () => {
      const data = { active: 0 };
      const fields = { active: { type: 'BOOLEAN' } };

      const result = formatDataJs(data, fields);

      expect(result.active).toBe(false);
    });
  });

  describe('JSON type coercion', () => {
    it('should parse JSON string to object for JSON fields', () => {
      const data = { tags: '["a","b","c"]' };
      const fields = { tags: { type: 'JSON' } };

      const result = formatDataJs(data, fields);

      expect(result.tags).toEqual(['a', 'b', 'c']);
    });

    it('should keep invalid JSON as string', () => {
      const data = { tags: 'not-json' };
      const fields = { tags: { type: 'JSON' } };

      const result = formatDataJs(data, fields);

      expect(result.tags).toBe('not-json');
    });
  });

  describe('snake_case to camelCase conversion', () => {
    it('should convert snake_case keys to camelCase', () => {
      const data = { created_at: '2024-01-01', updated_at: '2024-01-02' };
      const fields = {};

      const result = formatDataJs(data, fields);

      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should preserve underscore-prefixed keys', () => {
      const data = { _meta_type: 'Image', _meta_data: '{}' };
      const fields = {};

      const result = formatDataJs(data, fields);

      expect(result._meta_type).toBe('Image');
      expect(result._meta_data).toBe('{}');
    });
  });

  describe('without field definitions', () => {
    it('should pass through values when no field definitions provided', () => {
      const data = { version: '2.0', price: 3.14 };

      const result = formatDataJs(data);

      expect(result.version).toBe('2.0');
      expect(result.price).toBe(3.14);
    });
  });

  describe('input immutability (#1378)', () => {
    it('does not mutate the caller object when merging _meta_data', () => {
      const data = {
        id: 'abc',
        _meta_type: 'Image',
        _meta_data: '{"width":100,"height":50}',
      };
      const snapshot = { ...data };

      const result = formatDataJs(data);

      // Meta fields are surfaced on the RESULT...
      expect(result.width).toBe(100);
      expect(result.height).toBe(50);

      // ...but the caller's object must be untouched: no injected meta fields
      // and the original keys/values preserved.
      expect(data).toEqual(snapshot);
      expect('width' in data).toBe(false);
      expect('height' in data).toBe(false);
    });

    it('does not mutate the caller object with an object-form _meta_data', () => {
      const data: Record<string, any> = {
        id: 'def',
        _meta_data: { color: 'red' },
      };
      const originalMeta = data._meta_data;

      const result = formatDataJs(data);

      expect(result.color).toBe('red');
      // Top-level meta field not injected onto the input...
      expect('color' in data).toBe(false);
      // ...and the nested _meta_data object reference is unchanged.
      expect(data._meta_data).toBe(originalMeta);
      expect(data._meta_data).toEqual({ color: 'red' });
    });
  });
});
