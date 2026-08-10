/**
 * Test for issue #792: Complex WHERE clause support
 * https://github.com/happyvertical/smrt/issues/792
 *
 * Tests for:
 * - 'not in' operator validation
 * - Dot-notation field name handling for JSON path queries
 *
 * The 'contains' operator and dot-notation JSON paths were removed from the
 * accepted surface in #2276: both passed validation here and then failed inside
 * the query builder, because neither was ever implemented downstream. Their
 * rejection is covered by `issue-2276-where-contract.test.ts`; this file keeps
 * the parts of #792 that do execute.
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
    it('should execute not in against the database', async () => {
      // Asserted end-to-end rather than "validation did not throw": #2276 was
      // exactly a condition that passed validation and then failed to execute,
      // so a swallowed SQL error is not evidence the operator works.
      const results = await collection.list({
        where: { 'category not in': ['A', 'B'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Gamma');
    });

    it('should execute not in with a single value array', async () => {
      const results = await collection.list({
        where: { 'status not in': ['archived'] },
      });
      expect(results).toHaveLength(2);
      expect(results.every((r: any) => r.status === 'active')).toBe(true);
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

  describe('dot-notation field names', () => {
    // #792 accepted these at validation on the assumption the SDK would extract
    // the JSON path. It never did, so #2276 moved the rejection here, where the
    // caller can act on it. Message-level assertions live in
    // `issue-2276-where-contract.test.ts`.
    it('should reject dot-notation on an existing JSON column', async () => {
      await expect(
        collection.list({ where: { 'metadata.userId': 'user-1' } }),
      ).rejects.toThrow('Dot-notation JSON paths are not supported');
    });

    it('should reject dot-notation for non-existent base fields', async () => {
      // The unknown column is the more specific problem, so it wins over the
      // JSON-path rejection — otherwise a typo'd key would be answered with
      // advice to filter on a column that does not exist.
      await expect(
        collection.list({ where: { 'nonExistentField.path': 'value' } }),
      ).rejects.toThrow(/Field does not exist/);
    });

    it('should reject dot-notation carrying an operator', async () => {
      await expect(
        collection.list({ where: { 'metadata.count >': 5 } }),
      ).rejects.toThrow('Dot-notation JSON paths are not supported');
    });
  });

  describe('operator validation', () => {
    it('should reject the contains operator', async () => {
      await expect(
        collection.list({ where: { 'metadata contains': 'userId' } }),
      ).rejects.toThrow('Invalid WHERE clause operator');
    });

    it('should still reject invalid operators', async () => {
      await expect(
        collection.list({ where: { 'name between': [1, 10] } }),
      ).rejects.toThrow('Invalid WHERE clause operator');
    });

    it('should list the executable operators in the error message', async () => {
      try {
        await collection.list({ where: { 'name invalid': 'x' } });
        expect.unreachable('invalid operator should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('not in');
        expect(e.message).not.toContain('contains');
      }
    });
  });
});
