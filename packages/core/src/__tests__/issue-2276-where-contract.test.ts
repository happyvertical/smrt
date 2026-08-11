/**
 * Issue #2276: WHERE validation accepted conditions the SQL layer cannot execute.
 * https://github.com/happyvertical/smrt/issues/2276
 *
 * `convertWhereKeys` hands its output straight to `@happyvertical/sql`'s
 * `buildWhere`, so the operators and field syntax it accepts are a promise about
 * what that builder can execute. Two entries broke the promise:
 *
 * - `contains` was whitelisted but has never existed in `parseConditionKey`, so
 *   `buildWhere` could not split it off the key and threw
 *   `Invalid SQL identifier: name contains` — a query-builder error, naming
 *   query-builder concepts, for a query this layer had just accepted.
 * - Dot-notation JSON paths validated but were never rewritten into an
 *   extraction expression, so `metadata.color` arrived as a qualified column
 *   reference and SQLite answered `no such column`, surfaced as an opaque
 *   `DatabaseError: Failed to execute raw query`.
 *
 * Both now fail at the API boundary with an actionable message. The load-bearing
 * test in this file is "every accepted operator executes": it is what keeps the
 * whitelist and the query builder from drifting apart again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

@smrt({ api: { include: ['list', 'get'] } })
class WhereContractItem extends SmrtObject {
  name: string = '';
  category: string = '';
  priority: number = 0;
  metadata: Record<string, any> = {};
}

class WhereContractItemCollection extends SmrtCollection<WhereContractItem> {
  static readonly _itemClass = WhereContractItem;
}

/**
 * Undecorated on purpose: with no `@smrt()` registration there are no manifest
 * fields, so `convertWhereKeys` takes the `skipFieldValidation` branch (#869)
 * and cannot check any column name. Used to pin what the JSON-path rejection
 * does when nothing knows which columns are real.
 */
class UnregisteredItem extends SmrtObject {
  name: string = '';
}

class UnregisteredItemCollection extends SmrtCollection<UnregisteredItem> {
  static readonly _itemClass = UnregisteredItem;
}

/**
 * Every operator the validator accepts, with a value and the ids it must match
 * against the fixture rows below. Adding an operator to `VALID_OPERATORS`
 * without adding it here leaves it unexercised; adding it here without the SQL
 * layer supporting it fails this suite.
 */
const ACCEPTED_OPERATORS: Array<{
  where: Record<string, unknown>;
  expected: string[];
}> = [
  { where: { category: 'A' }, expected: ['alpha'] },
  { where: { 'category =': 'A' }, expected: ['alpha'] },
  { where: { 'category !=': 'A' }, expected: ['beta', 'gamma'] },
  { where: { 'priority >': 2 }, expected: ['gamma'] },
  { where: { 'priority <': 2 }, expected: ['alpha'] },
  { where: { 'priority >=': 2 }, expected: ['beta', 'gamma'] },
  { where: { 'priority <=': 2 }, expected: ['alpha', 'beta'] },
  { where: { 'category in': ['A', 'B'] }, expected: ['alpha', 'beta'] },
  { where: { 'category not in': ['A', 'B'] }, expected: ['gamma'] },
  { where: { 'name like': 'Al%' }, expected: ['alpha'] },
  // Arrays without an explicit operator auto-detect IN.
  { where: { category: ['A', 'C'] }, expected: ['alpha', 'gamma'] },
];

describe('Issue #2276: WHERE contract matches what the SQL layer executes', () => {
  ObjectRegistry.registerCollection(
    'WhereContractItem',
    WhereContractItemCollection,
  );

  let collection: WhereContractItemCollection;

  beforeAll(async () => {
    collection = await WhereContractItemCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    await collection.create({
      name: 'Alpha',
      category: 'A',
      priority: 1,
      metadata: { color: 'red', count: 10 },
    });
    await collection.create({
      name: 'Beta',
      category: 'B',
      priority: 2,
      metadata: { color: 'blue', count: 20 },
    });
    await collection.create({
      name: 'Gamma',
      category: 'C',
      priority: 3,
      metadata: { color: 'red', count: 30 },
    });
  });

  afterAll(async () => {
    await collection.db?.close?.();
  });

  describe('every accepted operator executes', () => {
    // This is the regression guard for the whole issue. Validation passing is
    // not evidence an operator works; only reaching the database is.
    it.each(ACCEPTED_OPERATORS)('executes $where end-to-end', async ({
      where,
      expected,
    }) => {
      const results = await collection.list({ where });
      expect(results.map((r: any) => r.name.toLowerCase()).sort()).toEqual(
        [...expected].sort(),
      );
    });

    it('treats NULL as a value, not an operator', async () => {
      // The query builder turns a null value into `IS NULL` for `=` and
      // `IS NOT NULL` for anything else, so `is null` is not — and must not
      // become — a whitelist entry. AGENTS.md documents it this way; this is
      // what holds that documentation to the code.
      expect(await collection.list({ where: { name: null } })).toHaveLength(0);
      expect(
        await collection.list({ where: { 'name !=': null } }),
      ).toHaveLength(3);
      await expect(
        collection.list({ where: { 'name is null': true } }),
      ).rejects.toThrow('Invalid WHERE clause operator');
    });
  });

  describe("the 'contains' operator is rejected at the API boundary", () => {
    it('rejects contains instead of failing inside the query builder', async () => {
      await expect(
        collection.list({ where: { 'name contains': 'lph' } }),
      ).rejects.toThrow('Invalid WHERE clause operator');
    });

    it('never surfaces the query builder error it used to produce', async () => {
      // The bug's signature: an internal `Invalid SQL identifier: name contains`
      // raised by buildWhere after this layer had approved the query.
      await expect(
        collection.list({ where: { 'name contains': 'lph' } }),
      ).rejects.not.toThrow(/Invalid SQL identifier/);
    });

    it('names the operator and points at the supported alternative', async () => {
      await expect(
        collection.list({ where: { 'name contains': 'lph' } }),
      ).rejects.toThrow(/'contains'[\s\S]*'like' with explicit wildcards/);
    });

    it('no longer advertises contains in the valid-operator list', async () => {
      await expect(
        collection.list({ where: { 'name bogus': 'x' } }),
      ).rejects.toThrow(
        /Valid operators: =, >, <, >=, <=, !=, in, not in, like$/,
      );
    });

    it('still rejects other unknown operators without a hint', async () => {
      await expect(
        collection.list({ where: { 'priority between': [1, 10] } }),
      ).rejects.toThrow('Invalid WHERE clause operator');
    });

    it('does not splice a prototype member into the hint', async () => {
      // The hint lookup key is caller-supplied. Held in a plain object it would
      // resolve `toString`/`constructor` through Object.prototype and append a
      // function body to the error message.
      for (const operator of ['toString', 'constructor', 'hasOwnProperty']) {
        await expect(
          collection.list({ where: { [`name ${operator}`]: 'x' } }),
        ).rejects.toThrow(
          /Valid operators: =, >, <, >=, <=, !=, in, not in, like$/,
        );
      }
    });
  });

  describe('dot-notation JSON paths are rejected at the API boundary', () => {
    it('rejects a JSON path instead of failing at execution', async () => {
      await expect(
        collection.list({ where: { 'metadata.color': 'red' } }),
      ).rejects.toThrow('Dot-notation JSON paths are not supported');
    });

    it('never surfaces the opaque database error it used to produce', async () => {
      await expect(
        collection.list({ where: { 'metadata.color': 'red' } }),
      ).rejects.not.toThrow(/Failed to execute raw query/);
    });

    it('names the offending key and the column to filter instead', async () => {
      await expect(
        collection.list({ where: { 'metadata.color': 'red' } }),
      ).rejects.toThrow(/'metadata\.color'[\s\S]*'metadata' column/);
    });

    it('rejects a JSON path carrying an operator', async () => {
      await expect(
        collection.list({ where: { 'metadata.count >': 5 } }),
      ).rejects.toThrow('Dot-notation JSON paths are not supported');
    });

    it('rejects a nested JSON path', async () => {
      await expect(
        collection.list({ where: { 'metadata.nested.deep': 'x' } }),
      ).rejects.toThrow('Dot-notation JSON paths are not supported');
    });

    it('leaves the plain column filter working', async () => {
      // The rejection is scoped to the path suffix; the column itself is
      // unaffected, which is what the error message tells callers to fall back to.
      const results = await collection.list({
        where: { metadata: JSON.stringify({ color: 'red', count: 10 }) },
      });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Alpha');
    });
  });

  describe('every more specific guard reports before the JSON-path rejection', () => {
    // The JSON-path message ends in advice — "filter on the '<column>' column
    // itself". That advice is only true for a key whose sole problem is the
    // path suffix, so every guard that describes a different problem with the
    // same key has to answer first.

    it('reports an injection payload as an invalid identifier, not a JSON path', async () => {
      // #1379: the identifier allowlist still catches a crafted path suffix.
      await expect(
        collection.list({
          where: {
            'metadata.x))/**/UNION/**/SELECT/**/secret/**/FROM/**/users--': 1,
          },
        }),
      ).rejects.toThrow('Field names must be identifiers');
    });

    it('reports a prototype-pollution key as such, not as a JSON path', async () => {
      await expect(
        collection.list({ where: { 'constructor.prototype.isAdmin': true } }),
      ).rejects.toThrow('Prototype pollution attempts are not allowed');
    });

    it('reports an unknown base column as unknown, not as a JSON path', async () => {
      // Without this ordering a typo'd key is answered with advice to filter on
      // a column that does not exist — the message would assert something false
      // about the schema.
      await expect(
        collection.list({ where: { 'noSuchColumn.path': 'value' } }),
      ).rejects.toThrow(/Field does not exist/);
      await expect(
        collection.list({ where: { 'noSuchColumn.path': 'value' } }),
      ).rejects.not.toThrow(/Dot-notation JSON paths/);
    });

    it('reports an invalid operator on a JSON path as an operator problem', async () => {
      await expect(
        collection.list({ where: { 'metadata.color contains': 'red' } }),
      ).rejects.toThrow('Invalid WHERE clause operator');
    });

    it('still rejects the path when no manifest exists to check the column against', async () => {
      // #869: a class with no registered fields skips column checking entirely,
      // so the JSON-path message here names a column nobody verified. That is
      // the documented limit of that mode, not a hole in this rejection — the
      // key is still refused, which is what keeps it out of the query builder.
      const unregistered = await UnregisteredItemCollection.create({
        db: { type: 'sqlite', url: ':memory:' },
      });
      try {
        // No manifest means no generated schema either, so give `list()` a
        // table to reach — otherwise it fails on the missing table before the
        // WHERE validation this test is about ever runs.
        await unregistered.db?.query(
          'CREATE TABLE IF NOT EXISTS unregistered_items (id TEXT PRIMARY KEY, name TEXT)',
        );
        await expect(
          unregistered.list({ where: { 'anythingAtAll.path': 'x' } }),
        ).rejects.toThrow('Dot-notation JSON paths are not supported');
      } finally {
        await unregistered.db?.close?.();
      }
    });
  });
});
