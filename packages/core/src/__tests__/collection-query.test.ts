/**
 * Tests for collection.query() method
 *
 * The query() method provides raw SQL power for complex queries (JOINs, CTEs, NOT EXISTS, etc.)
 * while still returning properly hydrated SMRT objects.
 *
 * Test Coverage:
 * 1. Basic SELECT queries with hydration
 * 2. Parameterized queries
 * 3. Complex queries (NOT EXISTS, JOINs)
 * 4. STI polymorphic hydration
 * 5. Error handling
 *
 * Related:
 * - Issue #XXX: Custom query support for interests
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

// ============================================================================
// Test Classes
// ============================================================================

// Simple non-STI class for basic tests
@smrt()
class QueryTestProduct extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  category: string = '';
  inStock: boolean = true;
}

class QueryTestProductCollection extends SmrtCollection<QueryTestProduct> {
  static readonly _itemClass = QueryTestProduct;
}

// STI hierarchy for polymorphic tests
@smrt({ tableStrategy: 'sti' })
class QueryTestEvent extends SmrtObject {
  title: string = '';
  date: Date = new Date();
  location: string = '';
}

@smrt()
class QueryTestMeeting extends QueryTestEvent {
  type: string = 'Regular';
  agendaUrl: string = '';
}

@smrt()
class QueryTestConference extends QueryTestEvent {
  sponsorName: string = '';
  ticketPrice: number = 0.0;
}

class QueryTestEventCollection extends SmrtCollection<QueryTestEvent> {
  static readonly _itemClass = QueryTestEvent;
}

// Related table for NOT EXISTS tests
@smrt()
class QueryTestRecap extends SmrtObject {
  eventId: string = '';
  summary: string = '';
}

class QueryTestRecapCollection extends SmrtCollection<QueryTestRecap> {
  static readonly _itemClass = QueryTestRecap;
}

// ============================================================================
// Database Adapter Configurations
// ============================================================================

const adapterConfigs = [
  {
    name: 'SQLite (in-memory)',
    getConfig: () => ({ type: 'sqlite' as const, url: ':memory:' }),
    cleanup: async () => {},
  },
  {
    name: 'SQLite (file)',
    getConfig: () => ({
      type: 'sqlite' as const,
      url: join(
        tmpdir(),
        `test-collection-query-${randomUUID().slice(0, 8)}.db`,
      ),
    }),
    cleanup: async (config: any) => {
      if (config?.url && config.url !== ':memory:' && existsSync(config.url)) {
        unlinkSync(config.url);
      }
    },
  },
  {
    name: 'JSON (DuckDB)',
    getConfig: () => ({
      type: 'json' as const,
      url: join(
        tmpdir(),
        `test-collection-query-json-${randomUUID().slice(0, 8)}`,
      ),
    }),
    cleanup: async (config: any) => {
      if (config?.url && existsSync(config.url)) {
        try {
          rmSync(config.url, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  },
];

// ============================================================================
// Test Suites
// ============================================================================

function runBasicQueryTests(
  getContext: () => { products: QueryTestProductCollection },
) {
  describe('Basic Query Operations', () => {
    it('should execute simple SELECT query', async () => {
      const { products } = getContext();

      // Create test data
      await products.create({
        name: 'Widget',
        price: 19.99,
        category: 'gadgets',
      });
      await products.create({
        name: 'Gizmo',
        price: 29.99,
        category: 'gadgets',
      });

      // Query all records
      const results = await products.query(
        `SELECT * FROM ${products.tableName}`,
      );

      expect(results.length).toBe(2);
      expect(results[0]).toBeInstanceOf(QueryTestProduct);
      expect(results[0].name).toBeDefined();
    });

    it('should execute query with WHERE clause', async () => {
      const { products } = getContext();

      await products.create({
        name: 'Widget',
        price: 19.99,
        category: 'gadgets',
      });
      await products.create({
        name: 'Expensive',
        price: 199.99,
        category: 'premium',
      });
      await products.create({
        name: 'Cheap',
        price: 5.99,
        category: 'bargain',
      });

      // Query with price filter
      const results = await products.query(
        `SELECT * FROM ${products.tableName} WHERE price > 15`,
      );

      expect(results.length).toBe(2);
      expect(results.every((p) => p.price > 15)).toBe(true);
    });

    it('should execute parameterized query', async () => {
      const { products } = getContext();

      await products.create({
        name: 'Widget',
        price: 19.99,
        category: 'gadgets',
      });
      await products.create({
        name: 'Gizmo',
        price: 29.99,
        category: 'gadgets',
      });
      await products.create({
        name: 'Thingamajig',
        price: 39.99,
        category: 'premium',
      });

      // Query with parameters
      const results = await products.query(
        `SELECT * FROM ${products.tableName} WHERE category = ? AND price < ?`,
        ['gadgets', 30],
      );

      expect(results.length).toBe(2);
      expect(results.every((p) => p.category === 'gadgets')).toBe(true);
    });

    it('should execute query with ORDER BY', async () => {
      const { products } = getContext();

      await products.create({
        name: 'C-Product',
        price: 30.0,
        category: 'test',
      });
      await products.create({
        name: 'A-Product',
        price: 10.0,
        category: 'test',
      });
      await products.create({
        name: 'B-Product',
        price: 20.0,
        category: 'test',
      });

      const results = await products.query(
        `SELECT * FROM ${products.tableName} ORDER BY price ASC`,
      );

      expect(results.length).toBe(3);
      expect(results[0].price).toBe(10.0);
      expect(results[1].price).toBe(20.0);
      expect(results[2].price).toBe(30.0);
    });

    it('should execute query with LIMIT', async () => {
      const { products } = getContext();

      for (let i = 0; i < 5; i++) {
        await products.create({
          name: `Product ${i}`,
          price: 10.0 + i,
          category: 'test',
        });
      }

      const results = await products.query(
        `SELECT * FROM ${products.tableName} LIMIT ?`,
        [2],
      );

      expect(results.length).toBe(2);
    });

    it('should return empty array for no matches', async () => {
      const { products } = getContext();

      await products.create({
        name: 'Widget',
        price: 19.99,
        category: 'gadgets',
      });

      const results = await products.query(
        `SELECT * FROM ${products.tableName} WHERE category = ?`,
        ['nonexistent'],
      );

      expect(results).toEqual([]);
    });

    it('should hydrate all fields correctly', async () => {
      const { products } = getContext();

      await products.create({
        name: 'Test Product',
        price: 49.99,
        category: 'electronics',
        inStock: false,
      });

      const results = await products.query(
        `SELECT * FROM ${products.tableName} WHERE name = ?`,
        ['Test Product'],
      );

      expect(results.length).toBe(1);
      const product = results[0];

      expect(product.name).toBe('Test Product');
      // Use toBeCloseTo for decimals due to DuckDB floating point precision
      expect(product.price).toBeCloseTo(49.99, 2);
      expect(product.category).toBe('electronics');
      expect(product.inStock).toBe(false);
      expect(product.id).toBeDefined();
      expect(product.slug).toBeDefined();
    });
  });
}

function runSTIQueryTests(
  getContext: () => { events: QueryTestEventCollection },
) {
  describe('STI Polymorphic Query', () => {
    it('should hydrate correct subclass based on _meta_type', async () => {
      const { events } = getContext();

      // Create different event types
      await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Team Meeting',
        location: 'Room A',
        type: 'Regular',
        agendaUrl: 'http://example.com/agenda',
      });

      await events.create({
        _meta_type: 'QueryTestConference',
        title: 'Tech Conference',
        location: 'Convention Center',
        sponsorName: 'TechCorp',
        ticketPrice: 299.99,
      });

      // Query all and check polymorphic hydration
      const results = await events.query(`SELECT * FROM ${events.tableName}`);

      expect(results.length).toBe(2);

      const meeting = results.find((e) => e.title === 'Team Meeting');
      const conference = results.find((e) => e.title === 'Tech Conference');

      expect(meeting).toBeInstanceOf(QueryTestMeeting);
      expect(conference).toBeInstanceOf(QueryTestConference);

      // Verify child-specific fields are populated
      expect((meeting as QueryTestMeeting).type).toBe('Regular');
      expect((meeting as QueryTestMeeting).agendaUrl).toBe(
        'http://example.com/agenda',
      );
      expect((conference as QueryTestConference).sponsorName).toBe('TechCorp');
      // Use toBeCloseTo for decimals due to DuckDB floating point precision
      expect((conference as QueryTestConference).ticketPrice).toBeCloseTo(
        299.99,
        2,
      );
    });

    it('should filter by _meta_type in raw query', async () => {
      const { events } = getContext();

      await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Meeting 1',
        location: 'Room A',
      });
      await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Meeting 2',
        location: 'Room B',
      });
      await events.create({
        _meta_type: 'QueryTestConference',
        title: 'Conference 1',
        location: 'Hall A',
      });

      const meetings = await events.query(
        `SELECT * FROM ${events.tableName} WHERE _meta_type = ?`,
        ['QueryTestMeeting'],
      );

      expect(meetings.length).toBe(2);
      expect(meetings.every((e) => e instanceof QueryTestMeeting)).toBe(true);
    });

    it('should handle base class instances', async () => {
      const { events } = getContext();

      // Create base class instance
      await events.create({
        title: 'Generic Event',
        location: 'Main Hall',
      });

      const results = await events.query(`SELECT * FROM ${events.tableName}`);

      expect(results.length).toBe(1);
      // Base class should be hydrated as QueryTestEvent
      expect(results[0].title).toBe('Generic Event');
    });
  });
}

function runComplexQueryTests(
  getContext: () => {
    events: QueryTestEventCollection;
    recaps: QueryTestRecapCollection;
  },
) {
  describe('Complex Query Patterns', () => {
    it('should handle NOT EXISTS pattern', async () => {
      const { events, recaps } = getContext();

      // Create events
      const event1 = await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Meeting With Recap',
        location: 'Room A',
      });
      const event2 = await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Meeting Without Recap',
        location: 'Room B',
      });

      // Create recap for first event only
      await recaps.create({
        eventId: event1.id!,
        summary: 'Great meeting',
      });

      // Query events without recaps
      const results = await events.query(
        `SELECT e.* FROM ${events.tableName} e
         WHERE NOT EXISTS (
           SELECT 1 FROM ${recaps.tableName} r
           WHERE r.event_id = e.id
         )`,
      );

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Meeting Without Recap');
    });

    it('should handle subqueries', async () => {
      const { events, recaps } = getContext();

      // Create events and recaps
      const event1 = await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Important Meeting',
        location: 'Board Room',
      });
      await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Casual Meeting',
        location: 'Cafeteria',
      });

      await recaps.create({
        eventId: event1.id!,
        summary: 'Discussed budget',
      });

      // Query events that have recaps (using IN subquery)
      const results = await events.query(
        `SELECT * FROM ${events.tableName}
         WHERE id IN (
           SELECT event_id FROM ${recaps.tableName}
         )`,
      );

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Important Meeting');
    });

    it('should handle aggregate subqueries', async () => {
      const { events } = getContext();

      // Create events at different locations
      await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Meeting 1',
        location: 'Room A',
      });
      await events.create({
        _meta_type: 'QueryTestMeeting',
        title: 'Meeting 2',
        location: 'Room A',
      });
      await events.create({
        _meta_type: 'QueryTestConference',
        title: 'Conference',
        location: 'Room B',
      });

      // Query events at the most popular location
      // This tests that complex queries with subqueries work
      const results = await events.query(
        `SELECT * FROM ${events.tableName}
         WHERE location = (
           SELECT location FROM ${events.tableName}
           GROUP BY location
           ORDER BY COUNT(*) DESC
           LIMIT 1
         )`,
      );

      expect(results.length).toBe(2);
      expect(results.every((e) => e.location === 'Room A')).toBe(true);
    });
  });
}

// ============================================================================
// Run Test Suites Against All Adapters
// ============================================================================

describe('collection.query()', () => {
  adapterConfigs.forEach((adapterConfig) => {
    describe(adapterConfig.name, () => {
      let db: DatabaseInterface;
      let dbConfig: any;
      let products: QueryTestProductCollection;
      let events: QueryTestEventCollection;
      let recaps: QueryTestRecapCollection;

      beforeEach(async () => {
        dbConfig = adapterConfig.getConfig();
        db = await getDatabase(dbConfig);
        products = await QueryTestProductCollection.create({ db });
        events = await QueryTestEventCollection.create({ db });
        recaps = await QueryTestRecapCollection.create({ db });
      });

      afterEach(async () => {
        if (db && typeof db.close === 'function') {
          try {
            await db.close();
          } catch {
            // Ignore close errors
          }
        }
        // Small delay to allow DuckDB to release file locks before cleanup
        await new Promise((resolve) => setTimeout(resolve, 50));
        await adapterConfig.cleanup(dbConfig);
      });

      // Run test suites
      runBasicQueryTests(() => ({ products }));
      runSTIQueryTests(() => ({ events }));
      runComplexQueryTests(() => ({ events, recaps }));
    });
  });
});
