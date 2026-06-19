/**
 * Tests for the opt-in collection read-through cache (issue #1498).
 *
 * Test Coverage:
 * 1. Per-call `list({ cache: { ttl } })` memoizes result rows (no second query)
 * 2. Distinct query shapes get distinct cache entries
 * 3. TTL expiry forces a fresh read
 * 4. Mutations (create / save / delete) invalidate the table's entries
 * 5. `cache: false` bypasses a model-level opt-in
 * 6. Model-level `@smrt({ cache })` config enables caching by default
 * 7. `get()` caching and invalidation on update
 * 8. STI: child write invalidates the shared base table; children inherit
 *    the base class cache config
 * 9. Two `:memory:` databases never share cache scope
 * 10. Cross-process: writes broadcast over db.notifications; received
 *     notifications invalidate local entries
 *
 * Related:
 * - Issue #1498: opt-in read-through cache for collection.list() with
 *   write + pub/sub invalidation
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import {
  buildQueryCacheKey,
  CACHE_INVALIDATION_CHANNEL,
  getCachedRows,
  getCacheGeneration,
  invalidateCollectionCache,
  resetCollectionCache,
  resolveDbCacheKey,
  setCachedRows,
} from '../collection-cache';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

// ============================================================================
// Test Classes
// ============================================================================

// Uncached by default — caching is per-call only
@smrt()
class CacheTestProduct extends SmrtObject {
  name: string = '';
  price: number = 0.0;
}

class CacheTestProductCollection extends SmrtCollection<CacheTestProduct> {
  static readonly _itemClass = CacheTestProduct;
}

// Model-level opt-in via decorator config
@smrt({ cache: { ttl: 60_000 } })
class CacheTestArticle extends SmrtObject {
  title: string = '';
}

class CacheTestArticleCollection extends SmrtCollection<CacheTestArticle> {
  static readonly _itemClass = CacheTestArticle;
}

// STI hierarchy with cache opt-in on the base class
@smrt({ tableStrategy: 'sti', cache: { ttl: 60_000 } })
class CacheTestEvent extends SmrtObject {
  title: string = '';
}

@smrt()
class CacheTestMeeting extends CacheTestEvent {
  room: string = '';
}

class CacheTestEventCollection extends SmrtCollection<CacheTestEvent> {
  static readonly _itemClass = CacheTestEvent;
}

class CacheTestMeetingCollection extends SmrtCollection<CacheTestMeeting> {
  static readonly _itemClass = CacheTestMeeting;
}

// Cross-process opt-in
@smrt({ cache: { ttl: 60_000, crossProcess: true } })
class CacheTestFeedItem extends SmrtObject {
  body: string = '';
}

class CacheTestFeedItemCollection extends SmrtCollection<CacheTestFeedItem> {
  static readonly _itemClass = CacheTestFeedItem;
}

// STI hierarchy where the base caches the shared table cross-process while
// a child explicitly opts out of caching for its own reads
@smrt({ tableStrategy: 'sti', cache: { ttl: 60_000, crossProcess: true } })
class CacheTestStream extends SmrtObject {
  title: string = '';
}

@smrt({ cache: false })
class CacheTestPrivateStream extends CacheTestStream {
  secret: string = '';
}

class CacheTestPrivateStreamCollection extends SmrtCollection<CacheTestPrivateStream> {
  static readonly _itemClass = CacheTestPrivateStream;
}

const TEST_CLASSES = [
  'CacheTestProduct',
  'CacheTestArticle',
  'CacheTestEvent',
  'CacheTestMeeting',
  'CacheTestFeedItem',
  'CacheTestStream',
  'CacheTestPrivateStream',
];

// ============================================================================
// Helpers
// ============================================================================

async function createDb(): Promise<DatabaseInterface> {
  return getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: TEST_CLASSES,
  });
}

function countSelectsAgainst(querySpy: any, tableName: string): number {
  return querySpy.mock.calls.filter(
    (call: unknown[]) =>
      typeof call[0] === 'string' &&
      call[0].startsWith('SELECT') &&
      call[0].includes(tableName),
  ).length;
}

/**
 * Minimal stub of the sql package's NotificationCapabilities: notify
 * records broadcasts, listen exposes a push-driven async iterable.
 */
function stubNotifications(db: DatabaseInterface) {
  const broadcasts: Array<{ channel: string; payload: any }> = [];
  const waiters: Array<(value: { channel: string; payload: any }) => void> = [];
  const queue: Array<{ channel: string; payload: any }> = [];

  const push = (notification: { channel: string; payload: any }) => {
    const waiter = waiters.shift();
    if (waiter) waiter(notification);
    else queue.push(notification);
  };

  (db as any).notifications = {
    async notify(channel: string, payload: any) {
      broadcasts.push({ channel, payload });
      return 1;
    },
    listen(_channel: string) {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<{ channel: string; payload: any }>> {
              const queued = queue.shift();
              if (queued) {
                return Promise.resolve({ value: queued, done: false });
              }
              return new Promise((resolve) => {
                waiters.push((value) => resolve({ value, done: false }));
              });
            },
            return(): Promise<
              IteratorResult<{ channel: string; payload: any }>
            > {
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      };
    },
  };

  return { broadcasts, push };
}

async function flushAsync(): Promise<void> {
  // Let the background listener loop consume pushed notifications.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// ============================================================================
// Tests
// ============================================================================

describe('collection read cache (issue #1498)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    resetCollectionCache();
    db = await createDb();
  });

  afterEach(async () => {
    resetCollectionCache();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('per-call list({ cache })', () => {
    it('serves repeated queries from cache without hitting the database', async () => {
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });
      await products.create({ name: 'Gadget', price: 19.99 });

      const querySpy = vi.spyOn(db, 'query');

      const first = await products.list({ cache: { ttl: 60_000 } });
      const selectsAfterFirst = countSelectsAgainst(
        querySpy,
        'cache_test_products',
      );

      const second = await products.list({ cache: { ttl: 60_000 } });
      const selectsAfterSecond = countSelectsAgainst(
        querySpy,
        'cache_test_products',
      );

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(second.map((p) => p.name).sort()).toEqual(['Gadget', 'Widget']);
      // The second list() must not have issued another SELECT
      expect(selectsAfterSecond).toBe(selectsAfterFirst);
    });

    it('returns fresh, independent instances on cache hits', async () => {
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });

      const [first] = await products.list({ cache: { ttl: 60_000 } });
      first.name = 'Mutated locally';

      const [second] = await products.list({ cache: { ttl: 60_000 } });
      expect(second.name).toBe('Widget');
      expect(second).not.toBe(first);
    });

    it('keys distinct query shapes separately', async () => {
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Cheap', price: 1 });
      await products.create({ name: 'Expensive', price: 100 });

      const cheap = await products.list({
        where: { 'price <': 50 },
        cache: { ttl: 60_000 },
      });
      const all = await products.list({ cache: { ttl: 60_000 } });

      expect(cheap).toHaveLength(1);
      expect(all).toHaveLength(2);
    });

    it('expires entries after ttl', async () => {
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });

      const first = await products.list({ cache: { ttl: 25 } });
      expect(first).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 60));

      const querySpy = vi.spyOn(db, 'query');
      const second = await products.list({ cache: { ttl: 25 } });
      expect(second).toHaveLength(1);
      expect(countSelectsAgainst(querySpy, 'cache_test_products')).toBe(1);
    });

    it('does not cache by default', async () => {
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });

      const querySpy = vi.spyOn(db, 'query');
      await products.list();
      await products.list();
      expect(countSelectsAgainst(querySpy, 'cache_test_products')).toBe(2);
    });
  });

  describe('write invalidation', () => {
    it('create() invalidates cached list results', async () => {
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });

      const before = await products.list({ cache: { ttl: 60_000 } });
      expect(before).toHaveLength(1);

      await products.create({ name: 'Gadget', price: 19.99 });

      const after = await products.list({ cache: { ttl: 60_000 } });
      expect(after).toHaveLength(2);
    });

    it('save() on an instance invalidates cached results', async () => {
      const products = await CacheTestProductCollection.create({ db });
      const product = await products.create({ name: 'Widget', price: 9.99 });

      const before = await products.list({ cache: { ttl: 60_000 } });
      expect(before[0].price).toBe(9.99);

      product.price = 14.99;
      await product.save();

      const after = await products.list({ cache: { ttl: 60_000 } });
      expect(after[0].price).toBe(14.99);
    });

    it('delete() invalidates cached results', async () => {
      const products = await CacheTestProductCollection.create({ db });
      const product = await products.create({ name: 'Widget', price: 9.99 });

      const before = await products.list({ cache: { ttl: 60_000 } });
      expect(before).toHaveLength(1);

      await products.delete(product.id as string);

      const after = await products.list({ cache: { ttl: 60_000 } });
      expect(after).toHaveLength(0);
    });
  });

  describe('model-level @smrt({ cache })', () => {
    it('caches list() by default for opted-in models', async () => {
      const articles = await CacheTestArticleCollection.create({ db });
      await articles.create({ title: 'Hello' });

      const querySpy = vi.spyOn(db, 'query');
      await articles.list();
      await articles.list();
      expect(countSelectsAgainst(querySpy, 'cache_test_articles')).toBe(1);
    });

    it('honors cache: false as a per-call bypass', async () => {
      const articles = await CacheTestArticleCollection.create({ db });
      await articles.create({ title: 'Hello' });

      const querySpy = vi.spyOn(db, 'query');
      await articles.list({ cache: false });
      await articles.list({ cache: false });
      expect(countSelectsAgainst(querySpy, 'cache_test_articles')).toBe(2);
    });

    it('resolves config through ObjectRegistry', () => {
      expect(
        ObjectRegistry.resolveCollectionCacheConfig('CacheTestArticle'),
      ).toEqual({ ttl: 60_000 });
      expect(
        ObjectRegistry.resolveCollectionCacheConfig('CacheTestProduct'),
      ).toBeUndefined();
      // A child's `cache: false` opts out despite the base's opt-in
      expect(
        ObjectRegistry.resolveCollectionCacheConfig('CacheTestPrivateStream'),
      ).toBeUndefined();
    });
  });

  describe('interceptor-controlled cache option', () => {
    afterEach(() => {
      GlobalInterceptors.clear();
    });

    it('honors a cache option injected by a beforeList interceptor', async () => {
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });

      GlobalInterceptors.register({
        name: 'cache-test-enable',
        beforeList(_className, options) {
          return { ...options, cache: { ttl: 60_000 } };
        },
      });

      const querySpy = vi.spyOn(db, 'query');
      await products.list();
      await products.list();
      expect(countSelectsAgainst(querySpy, 'cache_test_products')).toBe(1);
    });

    it('honors an interceptor clearing the cache option', async () => {
      const articles = await CacheTestArticleCollection.create({ db });
      await articles.create({ title: 'Hello' });

      GlobalInterceptors.register({
        name: 'cache-test-disable',
        beforeList(_className, options) {
          return { ...options, cache: false };
        },
      });

      const querySpy = vi.spyOn(db, 'query');
      await articles.list();
      await articles.list();
      expect(countSelectsAgainst(querySpy, 'cache_test_articles')).toBe(2);
    });
  });

  describe('get() caching', () => {
    it('caches get() lookups and invalidates on update', async () => {
      const products = await CacheTestProductCollection.create({ db });
      const product = await products.create({ name: 'Widget', price: 9.99 });
      const id = product.id as string;

      const first = await products.get(id, { cache: { ttl: 60_000 } });
      expect(first?.price).toBe(9.99);

      const querySpy = vi.spyOn(db, 'query');
      const second = await products.get(id, { cache: { ttl: 60_000 } });
      expect(second?.price).toBe(9.99);
      expect(countSelectsAgainst(querySpy, 'cache_test_products')).toBe(0);

      product.price = 12.5;
      await product.save();

      const third = await products.get(id, { cache: { ttl: 60_000 } });
      expect(third?.price).toBe(12.5);
    });

    it('caches get()-by-slug independently and invalidates on write', async () => {
      const articles = await CacheTestArticleCollection.create({ db });
      const created = await articles.create({ title: 'Hello' });
      const slug = created.slug as string;

      const first = await articles.get(slug, { cache: { ttl: 60_000 } });
      expect(first?.title).toBe('Hello');

      const querySpy = vi.spyOn(db, 'query');
      const second = await articles.get(slug, { cache: { ttl: 60_000 } });
      expect(second?.title).toBe('Hello');
      // by-slug shape served from cache, no new SELECT
      expect(countSelectsAgainst(querySpy, 'cache_test_articles')).toBe(0);

      created.title = 'Updated';
      await created.save();

      const third = await articles.get(slug, { cache: { ttl: 60_000 } });
      expect(third?.title).toBe('Updated');
    });
  });

  describe('internal mutation-gating reads bypass the cache', () => {
    it('delete() returns false for a row removed out-of-band despite a cached read', async () => {
      // CacheTestArticle has model-level caching, so delete()'s internal
      // existence probe would hit the cache unless it forces a fresh read.
      const articles = await CacheTestArticleCollection.create({ db });
      const created = await articles.create({ title: 'Doomed' });
      const id = created.id as string;

      // Prime the model cache for this id.
      await articles.get(id);

      // Remove the row WITHOUT going through the framework (no invalidation).
      await db.query('DELETE FROM cache_test_articles WHERE id = ?', id);

      // The probe must read through: the row is gone, so delete returns false.
      expect(await articles.delete(id)).toBe(false);
    });

    it('getOrUpsert() creates when the cached row was removed out-of-band', async () => {
      const articles = await CacheTestArticleCollection.create({ db });
      const created = await articles.create({ title: 'Seed' });
      const slug = created.slug as string;

      // Prime cache, then delete out-of-band.
      await articles.get(slug);
      await db.query('DELETE FROM cache_test_articles WHERE slug = ?', slug);

      // Fresh probe sees no row → creates rather than updating a phantom.
      const upserted = await articles.getOrUpsert({ slug, title: 'Reborn' });
      expect(upserted.title).toBe('Reborn');
      expect(await articles.count({ where: { slug } })).toBe(1);
    });
  });

  describe('query() raw-SQL invalidation', () => {
    it('busts the table cache after a write issued through query()', async () => {
      const products = await CacheTestProductCollection.create({ db });
      const p = await products.create({ name: 'Widget', price: 9.99 });

      const before = await products.list({ cache: { ttl: 60_000 } });
      expect(before[0].name).toBe('Widget');

      // Mutate through the raw escape hatch, bypassing save()/delete().
      await products.query(
        'UPDATE cache_test_products SET name = ? WHERE id = ?',
        ['Renamed', p.id],
      );

      const after = await products.list({ cache: { ttl: 60_000 } });
      expect(after[0].name).toBe('Renamed');
    });

    it('does not invalidate for a read-only query()', async () => {
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });

      await products.list({ cache: { ttl: 60_000 } });
      // A SELECT (even mentioning columns like updated_at) must not bust cache.
      await products.query(
        'SELECT * FROM cache_test_products ORDER BY updated_at DESC',
      );

      const querySpy = vi.spyOn(db, 'query');
      await products.list({ cache: { ttl: 60_000 } });
      expect(countSelectsAgainst(querySpy, 'cache_test_products')).toBe(0);
    });
  });

  describe('concurrent write during in-flight read (generation guard)', () => {
    it('drops a result whose table was invalidated mid-flight', () => {
      const dbKey = 'gen-test-db';
      const table = 'gen_test_rows';
      const queryKey = buildQueryCacheKey('SELECT * FROM gen_test_rows', []);

      // Simulate: read captures generation, a concurrent write invalidates,
      // then the stale read tries to cache its result.
      const captured = getCacheGeneration(dbKey, table);
      invalidateCollectionCache(dbKey, table); // concurrent write
      setCachedRows(
        dbKey,
        table,
        queryKey,
        [{ id: 'stale' }],
        60_000,
        captured,
      );

      expect(getCachedRows(dbKey, table, queryKey)).toBeUndefined();

      // A fresh read (post-invalidation generation) caches normally.
      const fresh = getCacheGeneration(dbKey, table);
      setCachedRows(dbKey, table, queryKey, [{ id: 'fresh' }], 60_000, fresh);
      expect(getCachedRows(dbKey, table, queryKey)).toEqual([{ id: 'fresh' }]);
    });
  });

  describe('crossProcess without notification capability', () => {
    it('caches in-process and returns correct data when db has no notifications', async () => {
      // The default test db exposes no `notifications` capability.
      expect(
        (db as unknown as { notifications?: unknown }).notifications,
      ).toBeUndefined();

      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });

      const first = await products.list({
        cache: { ttl: 60_000, crossProcess: true },
      });
      const querySpy = vi.spyOn(db, 'query');
      const second = await products.list({
        cache: { ttl: 60_000, crossProcess: true },
      });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      // Still served from the in-process cache despite no notifications.
      expect(countSelectsAgainst(querySpy, 'cache_test_products')).toBe(0);
    });
  });

  describe('STI', () => {
    it('children inherit the base class cache config', () => {
      expect(
        ObjectRegistry.resolveCollectionCacheConfig('CacheTestMeeting'),
      ).toEqual({ ttl: 60_000 });
    });

    it('a child write invalidates cached reads on the shared table', async () => {
      const events = await CacheTestEventCollection.create({ db });
      const meetings = await CacheTestMeetingCollection.create({ db });

      await events.create({ title: 'Launch' });
      const before = await events.list();
      expect(before).toHaveLength(1);

      // Sibling/child write hits the same backing table
      await meetings.create({ title: 'Standup', room: '3A' });

      const after = await events.list();
      expect(after).toHaveLength(2);
    });
  });

  describe('database isolation', () => {
    it('never shares cache scope between two :memory: databases', async () => {
      const otherDb = await createDb();
      try {
        expect(resolveDbCacheKey(db)).not.toBe(resolveDbCacheKey(otherDb));

        const productsA = await CacheTestProductCollection.create({ db });
        const productsB = await CacheTestProductCollection.create({
          db: otherDb,
        });

        await productsA.create({ name: 'OnlyInA', price: 1 });

        const fromA = await productsA.list({ cache: { ttl: 60_000 } });
        const fromB = await productsB.list({ cache: { ttl: 60_000 } });

        expect(fromA).toHaveLength(1);
        expect(fromB).toHaveLength(0);
      } finally {
        if (typeof otherDb.close === 'function') {
          await otherDb.close();
        }
      }
    });
  });

  describe('cross-process invalidation', () => {
    it('broadcasts invalidation on write when the model opts into crossProcess', async () => {
      const { broadcasts } = stubNotifications(db);
      const feed = await CacheTestFeedItemCollection.create({ db });

      await feed.create({ body: 'hello' });

      expect(broadcasts.length).toBeGreaterThan(0);
      const broadcast = broadcasts.at(-1);
      expect(broadcast?.channel).toBe(CACHE_INVALIDATION_CHANNEL);
      expect(broadcast?.payload.table).toBe('cache_test_feed_items');
      expect(typeof broadcast?.payload.source).toBe('string');
    });

    it('does not broadcast for models without crossProcess', async () => {
      const { broadcasts } = stubNotifications(db);
      const articles = await CacheTestArticleCollection.create({ db });

      await articles.create({ title: 'local only' });

      expect(broadcasts).toHaveLength(0);
    });

    it('broadcasts on a child write when the STI base caches the shared table cross-process', async () => {
      const { broadcasts } = stubNotifications(db);
      const privateStreams = await CacheTestPrivateStreamCollection.create({
        db,
      });

      // The child opted out with cache: false, but its writes hit the same
      // table CacheTestStream peers are caching with crossProcess: true —
      // invalidation is table-scoped, so the broadcast decision must be too.
      await privateStreams.create({ title: 'Private', secret: 'shh' });

      expect(broadcasts.length).toBeGreaterThan(0);
      expect(broadcasts.at(-1)?.payload.table).toBe('cache_test_streams');
    });

    it('broadcasts writes after a per-call crossProcess cached read', async () => {
      const { broadcasts } = stubNotifications(db);
      const products = await CacheTestProductCollection.create({ db });
      await products.create({ name: 'Widget', price: 9.99 });
      expect(broadcasts).toHaveLength(0); // no opt-in seen yet

      // Per-call opt-in registers table-scoped interest in this process
      await products.list({ cache: { ttl: 60_000, crossProcess: true } });

      await products.create({ name: 'Gadget', price: 19.99 });

      expect(broadcasts.length).toBeGreaterThan(0);
      expect(broadcasts.at(-1)?.payload.table).toBe('cache_test_products');
    });

    it('invalidates local cache when a peer broadcast arrives', async () => {
      const { push } = stubNotifications(db);
      const feed = await CacheTestFeedItemCollection.create({ db });
      await feed.create({ body: 'first' });

      // Prime the cache (also starts the invalidation listener)
      const before = await feed.list();
      expect(before).toHaveLength(1);
      await flushAsync();

      // Simulate a peer replica's write landing in the shared database
      // without going through this process's mutation path.
      await db.query(
        `INSERT INTO cache_test_feed_items (id, slug, context, body, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000001', 'peer-row', '', 'from peer', datetime('now'), datetime('now'))`,
      );

      // Without the broadcast, the cached read stays stale
      const stale = await feed.list();
      expect(stale).toHaveLength(1);

      // Peer broadcast invalidates the table's local entries
      push({
        channel: CACHE_INVALIDATION_CHANNEL,
        payload: { table: 'cache_test_feed_items', source: 'peer-process' },
      });
      await flushAsync();

      const fresh = await feed.list();
      expect(fresh).toHaveLength(2);
    });
  });
});
