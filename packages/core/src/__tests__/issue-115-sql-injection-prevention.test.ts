/**
 * Test for issue #115: SQL Injection Risk in Collection WHERE Clause
 * https://github.com/happyvertical/smrt/issues/115
 *
 * Tests that WHERE clause validation prevents:
 * - Invalid operators
 * - Non-existent field names
 * - Type mismatches for operator-specific values
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Test class with known fields (moved to top level for AST scanner)
// Using unique class name to avoid collisions with other test files (see issue #543)
@smrt({ api: { include: ['list', 'get'] } })
class SQLInjectionTestProduct extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  category: string = '';
  active: boolean = false;
}

class SQLInjectionTestProductCollection extends SmrtCollection<SQLInjectionTestProduct> {
  static readonly _itemClass = SQLInjectionTestProduct;
}

describe('Issue #115: SQL Injection Prevention', () => {
  // Register the collection
  ObjectRegistry.registerCollection(
    'SQLInjectionTestProduct',
    SQLInjectionTestProductCollection,
  );

  let collection: SQLInjectionTestProductCollection;

  beforeAll(async () => {
    collection = await SQLInjectionTestProductCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Create() already initializes the database, so we can directly create test data
    // Create some test data
    const widget = await collection.create({
      name: 'Widget',
      price: 100,
      category: 'A',
      active: true,
    });
    await widget.save();

    const gadget = await collection.create({
      name: 'Gadget',
      price: 200,
      category: 'B',
      active: true,
    });
    await gadget.save();

    const doohickey = await collection.create({
      name: 'Doohickey',
      price: 50,
      category: 'A',
      active: false,
    });
    await doohickey.save();
  });

  afterAll(async () => {
    await collection.db?.close?.();
  });

  describe('Operator Validation', () => {
    it('should reject invalid operators', async () => {
      await expect(
        collection.list({
          where: { 'price >>': 100 }, // Invalid operator
        }),
      ).rejects.toThrow(/Invalid WHERE clause operator: '>>'/);
    });

    it('should reject SQL injection attempts via operator', async () => {
      await expect(
        collection.list({
          where: { 'price ; DROP TABLE products--': 100 },
        }),
      ).rejects.toThrow(/Invalid WHERE clause operator/);
    });

    it('should accept all valid operators', async () => {
      const validOperators = ['=', '>', '<', '>=', '<=', '!=', 'in', 'like'];

      for (const operator of validOperators) {
        // Construct appropriate test value for operator
        let value: any = 100;
        if (operator === 'in') {
          value = [100, 200];
        } else if (operator === 'like') {
          // Use string field for LIKE
          await expect(
            collection.list({ where: { [`name ${operator}`]: '%Widget%' } }),
          ).resolves.toBeDefined();
          continue; // Skip the price test for LIKE
        }

        await expect(
          collection.list({ where: { [`price ${operator}`]: value } }),
        ).resolves.toBeDefined();
      }
    });

    it('should handle operator with no explicit value (defaults to =)', async () => {
      const results = await collection.list({ where: { active: true } });
      expect(results).toBeDefined();
      // SQLite stores booleans as integers (0/1), so use truthy comparison
      expect(results.every((p) => p.active)).toBe(true);
    });
  });

  describe('Field Name Validation', () => {
    it('should reject non-existent fields', async () => {
      await expect(
        collection.list({
          where: { nonExistentField: 'value' },
        }),
      ).rejects.toThrow(/Invalid WHERE clause field: 'nonExistentField'/);
    });

    it('should reject SQL injection attempts via field name', async () => {
      await expect(
        collection.list({
          where: { 'price; DROP TABLE products--': 100 },
        }),
      ).rejects.toThrow(/Invalid WHERE clause/); // Can be caught by either operator or field validation
    });

    it('should reject prototype pollution attempts', async () => {
      // Real prototype pollution comes from JSON parsing or Object.create
      // Object literal syntax { __proto__: 'polluted' } doesn't create an own property
      const maliciousWhere1 = JSON.parse('{"__proto__": "polluted"}');
      await expect(
        collection.list({
          where: maliciousWhere1,
        }),
      ).rejects.toThrow(/Prototype pollution attempts are not allowed/);

      // Direct property assignment
      const maliciousWhere2: any = {};
      maliciousWhere2.constructor = 'exploit';
      await expect(
        collection.list({
          where: maliciousWhere2,
        }),
      ).rejects.toThrow(/Prototype pollution attempts are not allowed/);

      // Nested prototype pollution attempt via string key
      await expect(
        collection.list({
          where: { 'constructor.prototype.isAdmin': true },
        }),
      ).rejects.toThrow(/Invalid WHERE clause field/);
    });

    it('should accept standard SMRT fields', async () => {
      const standardFields = [
        'id',
        'slug',
        'context',
        'created_at',
        'updated_at',
      ];

      for (const field of standardFields) {
        await expect(
          collection.list({ where: { [field]: null } }),
        ).resolves.toBeDefined();
      }
    });

    it('should accept defined model fields in camelCase', async () => {
      const results = await collection.list({
        where: { name: 'Widget' },
      });

      expect(results).toBeDefined();
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Widget');
    });

    it('should provide helpful error message with valid fields list', async () => {
      try {
        await collection.list({ where: { invalidField: 'value' } });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Valid fields:');
        expect(error.message).toContain('name');
        expect(error.message).toContain('price');
        expect(error.message).toContain('category');
        expect(error.message).toContain('active');
      }
    });
  });

  describe('Operator-Specific Value Validation', () => {
    it('should reject non-array value for "in" operator', async () => {
      await expect(
        collection.list({
          where: { 'price in': 100 }, // Should be array
        }),
      ).rejects.toThrow(/operator 'in' requires an array value/);
    });

    it('should accept array value for "in" operator', async () => {
      const results = await collection.list({
        where: { 'price in': [100, 200] },
      });

      expect(results).toBeDefined();
      expect(results.length).toBe(2);
    });

    it('should reject non-string value for "like" operator', async () => {
      await expect(
        collection.list({
          where: { 'price like': 100 }, // Should be string
        }),
      ).rejects.toThrow(/operator 'like' requires a string value/);
    });

    it('should accept string value for "like" operator', async () => {
      const results = await collection.list({
        where: { 'name like': '%Widget%' },
      });

      expect(results).toBeDefined();
      expect(results.some((p) => p.name === 'Widget')).toBe(true);
    });
  });

  describe('Complex WHERE Clauses', () => {
    it('should validate multiple conditions', async () => {
      const results = await collection.list({
        where: {
          'price >': 50,
          'price <=': 200,
          category: 'A',
          active: true,
        },
      });

      expect(results).toBeDefined();
      expect(results.every((p) => p.price > 50 && p.price <= 200)).toBe(true);
      expect(results.every((p) => p.category === 'A')).toBe(true);
      // SQLite stores booleans as integers (0/1), so use truthy comparison instead of strict equality
      expect(results.every((p) => p.active)).toBe(true);
    });

    it('should reject if any condition is invalid', async () => {
      await expect(
        collection.list({
          where: {
            'price >': 50, // Valid
            category: 'A', // Valid
            invalidField: 'value', // Invalid - should fail
          },
        }),
      ).rejects.toThrow(/Invalid WHERE clause field/);
    });

    it('should validate each operator independently', async () => {
      await expect(
        collection.list({
          where: {
            'price >': 50, // Valid operator
            'category >>': 'A', // Invalid operator - should fail
          },
        }),
      ).rejects.toThrow(/Invalid WHERE clause operator: '>>'/);
    });
  });

  describe('Security Regression Tests', () => {
    it('should prevent SQL comment injection', async () => {
      await expect(
        collection.list({
          where: { 'name--': 'exploit' },
        }),
      ).rejects.toThrow(/Invalid WHERE clause field/);
    });

    it('should prevent SQL union injection', async () => {
      await expect(
        collection.list({
          where: { 'name UNION SELECT': 'exploit' },
        }),
      ).rejects.toThrow(/Invalid WHERE clause operator/);
    });

    it('should prevent SQL semicolon injection', async () => {
      await expect(
        collection.list({
          where: { 'name; DELETE FROM products;--': 'exploit' },
        }),
      ).rejects.toThrow(/Invalid WHERE clause/); // Can be caught by either operator or field validation
    });

    it('should prevent field name with special characters', async () => {
      const specialChars = ['(', ')', '{', '}', '[', ']', '`', '\\', '/', '*'];

      for (const char of specialChars) {
        await expect(
          collection.list({
            where: { [`name${char}field`]: 'value' },
          }),
        ).rejects.toThrow(/Invalid WHERE clause field/);
      }
    });

    it('should prevent identifier injection via JSON-path dot-notation (#1379)', async () => {
      // The base column passes the field whitelist, but the JSON-path suffix
      // smuggles SQL using `/**/` comments in place of blocked whitespace. The
      // strict identifier guard must reject the whole key before it reaches the
      // unparameterized field position in the query builder.
      const payloads = [
        'metadata.x))/**/UNION/**/SELECT/**/1--',
        'name.x))/**/OR/**/1=1--',
        "category.a'))/**/--",
        'name.x)/**/=/**/1',
      ];
      for (const key of payloads) {
        await expect(
          collection.list({ where: { [key]: 'value' } }),
        ).rejects.toThrow(/Invalid WHERE clause field/);
      }
    });

    it('should still accept a legitimate JSON-path key', async () => {
      // metadata isn't a declared column on this class, so it resolves to the
      // field-whitelist error — NOT the identifier-format error. The point is
      // the strict guard does not reject well-formed dotted identifiers.
      await expect(
        collection.list({ where: { 'metadata.userId': 'value' } }),
      ).rejects.toThrow(/Field does not exist/);
    });
  });

  describe('Backwards Compatibility', () => {
    it('should still work with valid queries', async () => {
      const results = await collection.list({
        where: {
          'price >': 50,
          'price <=': 200,
          'category in': ['A', 'B'],
          active: true,
        },
        limit: 10,
        offset: 0,
      });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle empty WHERE clause', async () => {
      const results = await collection.list({ where: {} });
      expect(results).toBeDefined();
      expect(results.length).toBe(3);
    });

    it('should handle undefined WHERE clause', async () => {
      const results = await collection.list({});
      expect(results).toBeDefined();
      expect(results.length).toBe(3);
    });
  });
});
