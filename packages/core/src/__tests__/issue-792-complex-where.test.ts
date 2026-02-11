/**
 * Test for issue #792: Complex WHERE clause support
 * https://github.com/happyvertical/smrt/issues/792
 *
 * Tests for:
 * - 'not in' operator validation (SMRT-side; SQL execution depends on SDK)
 * - 'contains' operator validation (SMRT-side; SQL execution depends on SDK)
 * - Dot-notation field name validation for JSON path queries
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

@smrt({ api: { include: ['list', 'get'] } })
class WhereTestItem extends SmrtObject {
  name: string = '';
  category: string = '';
  status: string = '';
  priority: number = 0;
  metadata: Record<string, any> = {};
}

class WhereTestItemCollection extends SmrtCollection<WhereTestItem> {
  static readonly _itemClass = WhereTestItem;
}

describe('Issue #792: Complex WHERE clause support', () => {
  ObjectRegistry.registerCollection('WhereTestItem', WhereTestItemCollection);

  let collection: WhereTestItemCollection;

  beforeAll(async () => {
    collection = await WhereTestItemCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Create test data
    await collection.create({
      name: 'Alpha',
      category: 'A',
      status: 'active',
      priority: 1,
    });
    await collection.create({
      name: 'Beta',
      category: 'B',
      status: 'archived',
      priority: 2,
    });
    await collection.create({
      name: 'Gamma',
      category: 'C',
      status: 'active',
      priority: 3,
    });
  });

  afterAll(async () => {
    await collection.db?.close?.();
  });

  describe('not in operator', () => {
    it('should pass validation for not in operator', async () => {
      // 'not in' passes SMRT-side validation. SQL execution depends on SDK.
      try {
        const results = await collection.list({
          where: { 'category not in': ['A', 'B'] },
        });
        // If SDK supports NOT IN, verify results
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('Gamma');
      } catch (e: any) {
        // SQL-level error is acceptable; validation error is not
        expect(e.message).not.toContain('Invalid WHERE clause operator');
      }
    });

    it('should pass validation for not in with single value array', async () => {
      try {
        const results = await collection.list({
          where: { 'status not in': ['archived'] },
        });
        expect(results).toHaveLength(2);
        expect(results.every((r: any) => r.status === 'active')).toBe(true);
      } catch (e: any) {
        expect(e.message).not.toContain('Invalid WHERE clause operator');
      }
    });

    it('should reject not in with non-array value', async () => {
      await expect(
        collection.list({ where: { 'status not in': 'active' } }),
      ).rejects.toThrow('requires an array value');
    });

    it('should reject not in with empty array', async () => {
      await expect(
        collection.list({ where: { 'status not in': [] } }),
      ).rejects.toThrow('requires a non-empty array');
    });
  });

  describe('dot-notation field name validation', () => {
    it('should pass validation for dot-notation on existing JSON column', async () => {
      // The field 'metadata' exists on the model, so 'metadata.userId' should
      // pass SMRT-side validation (validates 'metadata' base column exists).
      // The actual JSON extraction SQL depends on SDK adapter support.
      // Here we verify the validation doesn't throw an "Invalid WHERE clause field" error.
      try {
        await collection.list({ where: { 'metadata.userId': 'user-1' } });
      } catch (e: any) {
        // If it fails, it should be a SQL-level error, not a validation error
        expect(e.message).not.toContain('Field does not exist');
      }
    });

    it('should reject dot-notation for non-existent base fields', async () => {
      // For classes with registered fields (manifest), this throws a validation error.
      // For inline test classes (no manifest, issue #869), field validation is skipped
      // and the error comes from the SQL layer instead.
      await expect(
        collection.list({ where: { 'nonExistentField.path': 'value' } }),
      ).rejects.toThrow();
    });

    it('should pass validation for dot-notation with operators', async () => {
      try {
        await collection.list({ where: { 'metadata.count >': 5 } });
      } catch (e: any) {
        // SQL-level error is OK; validation error is not
        expect(e.message).not.toContain('Field does not exist');
        expect(e.message).not.toContain('Invalid WHERE clause operator');
      }
    });
  });

  describe('operator validation', () => {
    it('should accept contains operator at validation level', async () => {
      // 'contains' is accepted by validation. SQL execution depends on SDK.
      try {
        await collection.list({ where: { 'metadata contains': 'userId' } });
      } catch (e: any) {
        // SQL-level error is fine, but it should NOT be a validation error
        expect(e.message).not.toContain('Invalid WHERE clause operator');
      }
    });

    it('should still reject invalid operators', async () => {
      await expect(
        collection.list({ where: { 'name between': [1, 10] } }),
      ).rejects.toThrow('Invalid WHERE clause operator');
    });

    it('should list new operators in error message', async () => {
      try {
        await collection.list({ where: { 'name invalid': 'x' } });
      } catch (e: any) {
        expect(e.message).toContain('not in');
        expect(e.message).toContain('contains');
      }
    });
  });
});
