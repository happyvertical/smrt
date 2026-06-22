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
 *
 * The JSON-default logic now lives in the shared formatter
 * (schema/sql-identifiers.ts) and is exercised here through the public
 * `formatDefaultValue(value, 'JSON')` API rather than reaching into the
 * strategy's protected internals (#1378 consolidation).
 */

import { describe, expect, it } from 'vitest';
import { BaseDDLStrategy } from '../schema/ddl/base-strategy';

// Concrete implementation for testing
class TestDDLStrategy extends BaseDDLStrategy {
  readonly engine = 'sqlite' as const;
}

describe('Issue #735: JSON Default Values in DDL', () => {
  const strategy = new TestDDLStrategy();

  describe('formatDefaultValue with JSON type', () => {
    it('should format empty string as valid JSON null', () => {
      // Empty string '' is not valid JSON - should become 'null'
      const result = strategy.formatDefaultValue('', 'JSON');
      expect(result).toBe("'null'");
      // Verify it's valid JSON when unquoted
      expect(() => JSON.parse('null')).not.toThrow();
    });

    it('should format null as the JSON null literal (not SQL NULL)', () => {
      // For JSON columns, a null default is the JSON literal 'null', not the
      // SQL NULL keyword.
      expect(strategy.formatDefaultValue(null, 'JSON')).toBe("'null'");
    });

    it('should format undefined as the JSON null literal', () => {
      expect(strategy.formatDefaultValue(undefined, 'JSON')).toBe("'null'");
    });

    it('should format empty array as valid JSON', () => {
      const result = strategy.formatDefaultValue([], 'JSON');
      expect(result).toBe("'[]'");
      expect(() => JSON.parse('[]')).not.toThrow();
    });

    it('should format empty object as valid JSON', () => {
      const result = strategy.formatDefaultValue({}, 'JSON');
      expect(result).toBe("'{}'");
      expect(() => JSON.parse('{}')).not.toThrow();
    });

    it('should format object with properties as valid JSON', () => {
      const result = strategy.formatDefaultValue({ key: 'value' }, 'JSON');
      expect(result).toBe('\'{"key":"value"}\'');
      expect(() => JSON.parse('{"key":"value"}')).not.toThrow();
    });

    it('should format array with values as valid JSON', () => {
      const result = strategy.formatDefaultValue(['a', 'b'], 'JSON');
      expect(result).toBe('\'["a","b"]\'');
      expect(() => JSON.parse('["a","b"]')).not.toThrow();
    });

    it('should handle [object Object] string representation', () => {
      // This is a common bug - when toString() is called on an object
      // it returns '[object Object]' which is not valid JSON
      const result = strategy.formatDefaultValue('[object Object]', 'JSON');
      // Should convert to empty object {}
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
      // Converged behavior: a JSON null default is the JSON literal 'null'
      // (valid JSON), not the SQL NULL keyword.
      expect(columnDef).toContain("DEFAULT 'null'");
    });
  });
});
