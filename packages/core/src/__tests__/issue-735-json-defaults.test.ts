/**
 * Test for Issue #735: Invalid JSON defaults in DDL generation
 *
 * PostgreSQL rejects CREATE TABLE statements with invalid JSON defaults like:
 * - JSON DEFAULT '' (empty string is not valid JSON)
 * - JSON DEFAULT '[object Object]' (string representation of object)
 *
 * Valid JSON defaults should be:
 * - 'null' for null/undefined
 * - '[]' for empty arrays
 * - '{}' for empty objects
 */

import { describe, expect, it } from 'vitest';
import { BaseDDLStrategy } from '../schema/ddl/base-strategy';
import { SQLiteDDLStrategy } from '../schema/ddl/sqlite-strategy';

// Concrete implementation for testing
class TestDDLStrategy extends BaseDDLStrategy {
  readonly engine = 'sqlite' as const;
}

describe('Issue #735: JSON Default Values in DDL', () => {
  const strategy = new TestDDLStrategy();

  describe('formatJSONDefault', () => {
    it('should format empty string as valid JSON null', () => {
      // Empty string '' is not valid JSON - should become 'null'
      const result = (strategy as any).formatJSONDefault('');
      expect(result).toBe("'null'");
      // Verify it's valid JSON when unquoted
      expect(() => JSON.parse('null')).not.toThrow();
    });

    it('should format null as JSON null literal', () => {
      const result = (strategy as any).formatJSONDefault(null);
      // For JSON columns, null should be the JSON literal 'null', not SQL NULL
      expect(result).toBe("'null'");
    });

    it('should format undefined as JSON null literal', () => {
      const result = (strategy as any).formatJSONDefault(undefined);
      expect(result).toBe("'null'");
    });

    it('should format empty array as valid JSON', () => {
      const result = (strategy as any).formatJSONDefault([]);
      expect(result).toBe("'[]'");
      expect(() => JSON.parse('[]')).not.toThrow();
    });

    it('should format empty object as valid JSON', () => {
      const result = (strategy as any).formatJSONDefault({});
      expect(result).toBe("'{}'");
      expect(() => JSON.parse('{}')).not.toThrow();
    });

    it('should format object with properties as valid JSON', () => {
      const result = (strategy as any).formatJSONDefault({ key: 'value' });
      expect(result).toBe('\'{"key":"value"}\'');
      expect(() => JSON.parse('{"key":"value"}')).not.toThrow();
    });

    it('should format array with values as valid JSON', () => {
      const result = (strategy as any).formatJSONDefault(['a', 'b']);
      expect(result).toBe('\'["a","b"]\'');
      expect(() => JSON.parse('["a","b"]')).not.toThrow();
    });

    it('should handle [object Object] string representation', () => {
      // This is a common bug - when toString() is called on an object
      // it returns '[object Object]' which is not valid JSON
      const result = (strategy as any).formatJSONDefault('[object Object]');
      // Should convert to empty object {}
      expect(result).toBe("'{}'");
    });
  });

  describe('formatDefaultValue with JSON type', () => {
    it('should format empty string for JSON type as valid JSON', () => {
      const result = strategy.formatDefaultValue('', 'JSON');
      expect(result).toBe("'null'");
    });

    it('should format [object Object] for JSON type as valid JSON', () => {
      const result = strategy.formatDefaultValue('[object Object]', 'JSON');
      expect(result).toBe("'{}'");
    });

    it('should pass through valid JSON strings', () => {
      const result = strategy.formatDefaultValue('{"key":"value"}', 'JSON');
      expect(result).toBe('\'{"key":"value"}\'');
    });

    it('should encode non-JSON strings as JSON strings', () => {
      const result = strategy.formatDefaultValue('hello world', 'JSON');
      expect(result).toBe('\'"hello world"\'');
    });
  });

  describe('generateColumnDefinition with JSON defaults', () => {
    it('should generate valid DDL for JSON column with empty array default', () => {
      const columnDef = strategy.generateColumnDefinition('tags', {
        type: 'JSON',
        defaultValue: [],
      });
      expect(columnDef).toContain("DEFAULT '[]'");
    });

    it('should generate valid DDL for JSON column with empty object default', () => {
      const columnDef = strategy.generateColumnDefinition('metadata', {
        type: 'JSON',
        defaultValue: {},
      });
      expect(columnDef).toContain("DEFAULT '{}'");
    });

    it('should generate valid DDL for JSON column with null default', () => {
      const columnDef = strategy.generateColumnDefinition('data', {
        type: 'JSON',
        defaultValue: null,
      });
      expect(columnDef).toContain('DEFAULT NULL');
    });
  });
});
