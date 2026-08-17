/**
 * Regression tests for issue #2367: query bounds on the collection read path.
 * https://github.com/happyvertical/smrt/issues/2367
 *
 * Four unbounded reads, one per acceptance criterion:
 *
 * - `get()` returned `rows[0]` from a query with no `LIMIT`, so a non-unique
 *   filter streamed the whole match set through the driver;
 * - `list()` bound `limit`/`offset` verbatim, so a `NaN` from a generated
 *   surface reached the driver as `LIMIT NaN` (a 500, not a 400);
 * - `orderBy` was checked only against an identifier regex — not the field
 *   whitelist and not the sensitive-column set that `where` (#1540) and
 *   `select` (#1902) enforce — making `?orderBy=api_secret&limit=1` an ordering
 *   oracle over a column the same request may neither filter on nor project;
 * - `listByIds()` expanded a caller-sized array into one `IN (...)` list with no
 *   chunking, so a large id set exceeded the backend's bind-variable ceiling and
 *   the whole query failed before it ran.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { IN_LIST_CHUNK_SIZE } from '../utils/chunk';

@smrt({ api: { include: ['list', 'get'] } })
class QueryBoundsWidget extends SmrtObject {
  // Unique per row: `getSlug()` derives the natural key from `label`, so a
  // shared value would upsert every fixture into the same row.
  @field({ type: 'text' })
  label: string = '';

  // Deliberately NOT unique — the non-unique filter `get()` must cap.
  @field({ type: 'text' })
  category: string = '';

  @field({ type: 'text', sensitive: true })
  apiSecret: string = '';

  // Redacted per caller by `toPublicJSON()` and refused by `select`; ordering
  // over it is the same oracle through a different door.
  @field({ readPermission: 'widgets.read_internal', type: 'text' })
  internalNote: string = '';

  // Registered fields that are NOT columns: the schema generator emits nothing
  // for a transient field or a relationship-only field, so ordering by one used
  // to reach the driver as `no such column` and surface as a 500.
  @field({ transient: true, type: 'text' })
  computedLabel: string = '';

  @field({ related: 'QueryBoundsWidget', type: 'oneToMany' })
  children: QueryBoundsWidget[] = [];

  // Leading underscore: `toSnakeCase()` strips it (`_rank` → `rank`) while
  // `toDbColumnName()` preserves it, so the whitelist and the lookups must
  // agree on both forms or a legitimate column is rejected.
  @field({ type: 'integer' })
  _rank: number = 0;

  constructor(options: any = {}) {
    super(options);
    if (options.label !== undefined) this.label = options.label;
    if (options.category !== undefined) this.category = options.category;
    if (options.apiSecret !== undefined) this.apiSecret = options.apiSecret;
  }
}

class QueryBoundsWidgetCollection extends SmrtCollection<QueryBoundsWidget> {
  static readonly _itemClass = QueryBoundsWidget;
}

describe('Issue #2367: collection query bounds', () => {
  ObjectRegistry.registerCollection(
    'QueryBoundsWidget',
    QueryBoundsWidgetCollection,
  );

  let collection: QueryBoundsWidgetCollection;
  let db: DatabaseInterface;
  const createdIds: string[] = [];

  beforeAll(async () => {
    db = await getTestDatabase({
      classes: ['QueryBoundsWidget'],
      type: 'sqlite',
      url: ':memory:',
    });
    collection = await QueryBoundsWidgetCollection.create({ db });

    for (let index = 0; index < 5; index++) {
      const widget = await collection.create({
        apiSecret: `sk-${index}`,
        category: 'shared-category',
        label: `widget-${index}`,
      });
      await widget.save();
      createdIds.push(widget.id as string);
    }
  });

  afterAll(async () => {
    await db?.close?.();
  });

  describe('get() emits LIMIT 1', () => {
    it('caps the row count in SQL rather than in JavaScript', async () => {
      const querySpy = vi.spyOn(db, 'query');
      let calls: unknown[][];
      try {
        await collection.get({ category: 'shared-category' });
      } finally {
        calls = querySpy.mock.calls.map((call) => [...call]);
        querySpy.mockRestore();
      }

      const selects = calls
        .map((call) => String(call[0]))
        .filter((sql) => /^SELECT \* FROM/i.test(sql.trim()));

      expect(selects.length).toBeGreaterThan(0);
      for (const sql of selects) {
        expect(sql).toMatch(/LIMIT 1\s*$/);
      }
    });

    it('still returns exactly one row for a filter matching many', async () => {
      const found = await collection.get({ category: 'shared-category' });
      expect(found).not.toBeNull();
      expect(found?.category).toBe('shared-category');
    });

    it('still returns null when nothing matches', async () => {
      expect(await collection.get({ category: 'no-such-category' })).toBeNull();
    });
  });

  describe('list() rejects malformed bounds instead of binding them', () => {
    it('rejects NaN, which used to reach the driver as LIMIT NaN', async () => {
      await expect(collection.list({ limit: Number.NaN })).rejects.toThrow(
        /limit/i,
      );
    });

    it('rejects Infinity', async () => {
      await expect(
        collection.list({ limit: Number.POSITIVE_INFINITY }),
      ).rejects.toThrow(/limit/i);
    });

    it('rejects a negative limit', async () => {
      await expect(collection.list({ limit: -1 })).rejects.toThrow(/limit/i);
    });

    it('rejects a fractional limit', async () => {
      await expect(collection.list({ limit: 1.5 })).rejects.toThrow(/limit/i);
    });

    it('rejects a malformed offset', async () => {
      await expect(
        collection.list({ limit: 1, offset: Number.NaN }),
      ).rejects.toThrow(/offset/i);
    });

    it('reports the rejection as a 400-class client error', async () => {
      await expect(collection.list({ limit: -1 })).rejects.toMatchObject({
        status: 400,
      });
    });

    it('still honours limit 0 as an empty page', async () => {
      expect(await collection.list({ limit: 0 })).toHaveLength(0);
    });
  });

  describe('list() bounds are configurable on the collection', () => {
    it('applies defaultListLimit when the caller passes no limit', async () => {
      const bounded = await QueryBoundsWidgetCollection.create({
        db,
        defaultListLimit: 2,
      });
      expect(await bounded.list()).toHaveLength(2);
      // An explicit limit still wins over the default.
      expect(await bounded.list({ limit: 4 })).toHaveLength(4);
    });

    it('clamps an oversized explicit limit to maxListLimit', async () => {
      const bounded = await QueryBoundsWidgetCollection.create({
        db,
        maxListLimit: 3,
      });
      expect(await bounded.list({ limit: 5000 })).toHaveLength(3);
    });

    it('leaves list() unbounded when neither option is set', async () => {
      expect(await collection.list()).toHaveLength(5);
    });

    it('refuses a nonsensical ceiling at construction time', async () => {
      await expect(
        QueryBoundsWidgetCollection.create({ db, maxListLimit: 0 }),
      ).rejects.toThrow(/maxListLimit/);
    });
  });

  describe('orderBy is checked against the same rail as where and select', () => {
    it('rejects ordering by a sensitive field (the ordering oracle)', async () => {
      await expect(
        collection.list({ limit: 1, orderBy: 'apiSecret DESC' }),
      ).rejects.toThrow(/sensitive/i);
    });

    it('rejects the snake_case column form of a sensitive field too', async () => {
      await expect(
        collection.list({ limit: 1, orderBy: 'api_secret ASC' }),
      ).rejects.toThrow(/sensitive/i);
    });

    it('rejects a sensitive field inside a multi-term orderBy array', async () => {
      await expect(
        collection.list({ limit: 1, orderBy: ['label ASC', 'apiSecret DESC'] }),
      ).rejects.toThrow(/sensitive/i);
    });

    it('rejects an unknown column', async () => {
      await expect(
        collection.list({ orderBy: 'not_a_column ASC' }),
      ).rejects.toThrow(/orderBy/i);
    });

    it('does not leak the schema field list in the client-facing message', async () => {
      await expect(
        collection.list({ orderBy: 'not_a_column ASC' }),
      ).rejects.toMatchObject({
        publicMessage: expect.not.stringContaining('api_secret'),
        status: 400,
      });
    });

    it('still rejects a non-identifier ordering term', async () => {
      await expect(
        collection.list({ orderBy: 'label; DROP TABLE widgets' }),
      ).rejects.toThrow(/ordering|orderBy/i);
    });

    it('still rejects an invalid direction', async () => {
      await expect(
        collection.list({ orderBy: 'label SIDEWAYS' }),
      ).rejects.toThrow(/direction/i);
    });

    it('rejects ordering by a readPermission-gated field', async () => {
      await expect(
        collection.list({ limit: 1, orderBy: 'internalNote DESC' }),
      ).rejects.toThrow(/permission-gated/i);
      await expect(
        collection.list({ limit: 1, orderBy: 'internal_note ASC' }),
      ).rejects.toThrow(/permission-gated/i);
    });

    it.each([
      ['computedLabel'],
      ['computed_label'],
      ['children'],
    ])('rejects ordering by the non-column-backed field %s', async (fieldName) => {
      // These pass the name whitelist (they are registered fields) but the
      // schema generator emits no column for them, so without this guard the
      // driver answered `no such column` and the API answered 500.
      await expect(
        collection.list({ limit: 1, orderBy: `${fieldName} ASC` }),
      ).rejects.toMatchObject({
        code: 'INVALID_ORDER_BY_NOT_COLUMN_BACKED',
        status: 400,
      });
    });

    it('resolves an underscore-prefixed field to its real column', async () => {
      // `SchemaGenerator` names the column with `toSnakeCase`, which strips the
      // leading underscore, so a declared `_rank` field lives in `rank`.
      // Both spellings must reach that one column: neither may be rejected as
      // unknown, and neither may emit a `_rank` column that does not exist.
      const querySpy = vi.spyOn(db, 'query');
      let calls: unknown[][];
      try {
        await collection.list({ limit: 1, orderBy: '_rank DESC' });
        await collection.list({ limit: 1, orderBy: 'rank ASC' });
      } finally {
        calls = querySpy.mock.calls.map((call) => [...call]);
        querySpy.mockRestore();
      }

      const ordered = calls
        .map((call) => String(call[0]))
        .filter((sql) => sql.includes('ORDER BY'));
      expect(ordered).toHaveLength(2);
      expect(ordered[0]).toContain('ORDER BY rank DESC');
      expect(ordered[1]).toContain('ORDER BY rank ASC');
    });

    it('accepts declared and framework columns', async () => {
      await expect(
        collection.list({ limit: 1, orderBy: 'label ASC' }),
      ).resolves.toHaveLength(1);
      await expect(
        collection.list({ limit: 1, orderBy: ['created_at DESC', 'id ASC'] }),
      ).resolves.toHaveLength(1);
    });
  });

  describe('listByIds() chunks its IN list', () => {
    it('returns every requested row for an id set larger than one chunk', async () => {
      // 900 is IN_LIST_CHUNK_SIZE; pad the real ids with misses so the array
      // spans three chunks without needing 2000 rows in the table.
      const padding = Array.from(
        { length: 2000 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      );
      const ids = [...createdIds, ...padding];

      const querySpy = vi.spyOn(db, 'query');
      let found: QueryBoundsWidget[];
      let calls: unknown[][];
      try {
        found = await collection.listByIds(ids);
      } finally {
        // Snapshot before restoring: `mockRestore()` also resets call history.
        calls = querySpy.mock.calls.map((call) => [...call]);
        querySpy.mockRestore();
      }

      expect(found).toHaveLength(createdIds.length);
      expect(found.map((item) => item.id).sort()).toEqual(
        [...createdIds].sort(),
      );

      // Three chunks of at most 900 ids → three SELECTs, none over the cap.
      const selects = calls.filter((call) => String(call[0]).includes('IN ('));
      expect(selects).toHaveLength(3);
      for (const call of selects) {
        // db.query(sql, ...params): every bound parameter after the SQL.
        expect(call.length - 1).toBeLessThanOrEqual(IN_LIST_CHUNK_SIZE + 1);
      }
    });

    it('issues a single query when the id set fits in one chunk', async () => {
      const querySpy = vi.spyOn(db, 'query');
      let calls: unknown[][];
      try {
        await collection.listByIds(createdIds);
      } finally {
        calls = querySpy.mock.calls.map((call) => [...call]);
        querySpy.mockRestore();
      }
      expect(
        calls.filter((call) => String(call[0]).includes('IN (')),
      ).toHaveLength(1);
    });

    it('still short-circuits on an empty id list', async () => {
      expect(await collection.listByIds([])).toEqual([]);
    });

    it('does not truncate to a configured page ceiling', async () => {
      // The chunk carries an explicit limit so an opt-in `defaultListLimit`
      // cannot silently drop ids the caller asked for.
      const bounded = await QueryBoundsWidgetCollection.create({
        db,
        defaultListLimit: 1,
      });
      expect(await bounded.listByIds(createdIds)).toHaveLength(
        createdIds.length,
      );
    });

    it('shrinks the chunk to a maxListLimit below the id count', async () => {
      // The chunk's explicit limit is itself clamped by `maxListLimit`, so the
      // chunk must not exceed it or the clamp would silently drop ids.
      const bounded = await QueryBoundsWidgetCollection.create({
        db,
        maxListLimit: 2,
      });

      const querySpy = vi.spyOn(db, 'query');
      let found: QueryBoundsWidget[];
      let calls: unknown[][];
      try {
        found = await bounded.listByIds(createdIds);
      } finally {
        calls = querySpy.mock.calls.map((call) => [...call]);
        querySpy.mockRestore();
      }

      expect(found).toHaveLength(createdIds.length);
      const selects = calls.filter((call) => String(call[0]).includes('IN ('));
      expect(selects).toHaveLength(3); // 5 ids at 2 per chunk
      for (const call of selects) {
        // db.query(sql, ...whereValues, limit): 2 ids + the limit.
        expect(call.length - 1).toBeLessThanOrEqual(3);
      }
    });
  });
});
