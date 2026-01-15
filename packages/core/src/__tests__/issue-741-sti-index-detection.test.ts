/**
 * Issue #741: db:migrate incorrectly detects existing indexes as missing
 *
 * When using Single Table Inheritance (STI), the `db:migrate` command detects
 * indexes as "missing" when they already exist in the database. This causes all
 * migrations to fail with PostgreSQL error "relation already exists".
 *
 * Root cause: STI subclasses generate indexes with their own class name as prefix
 * (e.g., `idx_meetings_updated_at`). When `getAllSchemas()` merges these into the
 * parent table, it only deduplicates by NAME, not by columns. The base class has
 * `idx_events_updated_at`, the child has `idx_meetings_updated_at`. Both point to
 * the same table (`events`) with the same columns, but the differ sees the child's
 * index as "missing" and tries to create it.
 *
 * Related: https://github.com/happyvertical/smrt/issues/741
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface, DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SchemaComparer } from '../migrations/differ';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import type { SchemaDefinition } from '../schema/types';
import { getTestDatabase } from '../testing/database';

/**
 * Parse index definitions from schema indexes array (SQL strings)
 * This mirrors the function in db-diff.ts
 */
function parseIndexesFromSchema(indexes: string[]): any[] {
  const result: any[] = [];

  for (const indexSQL of indexes) {
    const match = indexSQL.match(
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|(\w+))\s+ON\s+(?:"[^"]+"|'[^']+'|\w+)\s*\(([^)]+)\)/i,
    );

    if (match) {
      const isUnique = !!match[1];
      const indexName = match[2] ?? match[3] ?? match[4];
      const columnsStr = match[5];
      const columns = columnsStr
        .split(',')
        .map((c: string) => c.trim().replace(/["']/g, ''));

      result.push({
        name: indexName,
        columns,
        unique: isUnique,
      });
    }
  }

  return result;
}

/**
 * STI base class - Event
 * This represents a generic event stored in the 'issue741events' table.
 */
@smrt({ tableStrategy: 'sti' })
class Issue741Event extends SmrtObject {
  title: string = '';
  description: string = '';
  startDate: Date = new Date();
}

/**
 * STI child - Meeting
 * Stored in the same table as Event (issue741events).
 * Has its own schema with indexes prefixed by 'issue741meetings'.
 */
@smrt()
class Issue741Meeting extends Issue741Event {
  roomNumber: string = '';
  attendees: string[] = [];
}

/**
 * STI child - WeatherForecast
 * Another child class stored in the same table.
 */
@smrt()
class Issue741WeatherForecast extends Issue741Event {
  temperature: number = 0.0;
  humidity: number = 0;
}

class Issue741EventCollection extends SmrtCollection<Issue741Event> {
  static readonly _itemClass = Issue741Event;
}

describe('Issue #741: STI Index Detection', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-issue-741-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Index merging in getAllSchemas()', () => {
    it('should normalize STI subclass index names to base table prefix', async () => {
      // Get all schemas - this is what db:migrate uses
      const schemas = ObjectRegistry.getAllSchemas();

      // Find the events table schema
      const eventsSchema = schemas.issue741events;
      expect(eventsSchema).toBeDefined();

      // Parse indexes from the schema
      const indexMatches = eventsSchema.ddl.match(/CREATE INDEX[^;]+;/g) || [];

      // All indexes should use the base table name prefix (issue741events)
      // NOT the child class prefixes (issue741meetings, issue741weatherforecasts)
      for (const indexSql of indexMatches) {
        // Extract index name
        const nameMatch = indexSql.match(/CREATE INDEX\s+"?([^"\s]+)"?\s+ON/);
        if (nameMatch) {
          const indexName = nameMatch[1];

          // Index names should use base table name, not child table names
          expect(indexName).not.toMatch(/issue741meeting/i);
          expect(indexName).not.toMatch(/issue741weatherforecast/i);

          // Should either use base table prefix or generic prefix
          expect(indexName).toMatch(/issue741event|idx_/i);
        }
      }
    });

    it('should deduplicate indexes by columns, not just by name', async () => {
      const schemas = ObjectRegistry.getAllSchemas();
      const eventsSchema = schemas.issue741events;

      // Parse all index definitions
      const indexMatches = eventsSchema.ddl.match(/CREATE INDEX[^;]+;/g) || [];

      // Extract (table, columns) pairs for each index
      const indexSignatures = new Set<string>();
      for (const indexSql of indexMatches) {
        // Extract table and column(s) from: CREATE INDEX name ON table (col1, col2)
        const match = indexSql.match(/ON\s+"?([^"\s(]+)"?\s*\(([^)]+)\)/);
        if (match) {
          const table = match[1];
          const columns = match[2]
            .split(',')
            .map((c) => c.trim().replace(/"/g, ''))
            .sort()
            .join(',');
          const signature = `${table}:${columns}`;

          // There should be no duplicate indexes on the same (table, columns)
          expect(indexSignatures.has(signature)).toBe(false);
          indexSignatures.add(signature);
        }
      }
    });

    it('should not include child class indexes pointing to same columns', async () => {
      const schemas = ObjectRegistry.getAllSchemas();
      const eventsSchema = schemas.issue741events;

      // The merged schema should NOT contain indexes like:
      // - idx_issue741meetings_updated_at (redundant with idx_issue741events_updated_at)
      // - idx_issue741weatherforecasts_updated_at (also redundant)

      const indexMatches = eventsSchema.ddl.match(/CREATE INDEX[^;]+;/g) || [];

      // Count how many indexes exist for updated_at column
      const updatedAtIndexes = indexMatches.filter((sql) =>
        sql.includes('updated_at'),
      );

      // There should be exactly ONE updated_at index, not multiple
      expect(updatedAtIndexes.length).toBeLessThanOrEqual(1);
    });
  });

  describe('SchemaComparer with STI tables', () => {
    it('should not detect existing base class indexes as missing', async () => {
      // Step 1: Create the table using the base class (Event)
      const collection = await Issue741EventCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      // Create an event to ensure table exists
      const event = await collection.create({
        title: 'Test Event',
        description: 'Test description',
        startDate: new Date(),
      });
      await event.save();

      // Step 2: Get the merged schema (which may include child class indexes)
      const schemas = ObjectRegistry.getAllSchemas();
      const eventsSchema = schemas.issue741events;

      // Parse SQL string indexes into structured objects (as db-diff.ts does)
      const parsedIndexes = eventsSchema.indexes
        ? parseIndexesFromSchema(eventsSchema.indexes)
        : [];

      // Step 3: Convert to SchemaDefinition format for comparison
      const manifest: Record<string, SchemaDefinition> = {
        issue741events: {
          tableName: 'issue741events',
          ddl: eventsSchema.ddl,
          columns: {},
          indexes: parsedIndexes,
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      // Step 4: Run schema comparison
      const comparer = new SchemaComparer(db as any);
      const diff = await comparer.compare(manifest);

      // Step 5: Filter for index changes
      const indexChanges = diff.changes.filter((c) => c.type === 'add_index');

      // There should be NO missing indexes detected
      // (The base class already created all needed indexes)
      expect(indexChanges).toHaveLength(0);
    });

    it('should detect functionally equivalent indexes', async () => {
      // Create table with an index
      await db.query(`
        CREATE TABLE test_table (
          id TEXT PRIMARY KEY,
          email TEXT,
          updated_at DATETIME
        )
      `);
      await db.query(
        'CREATE INDEX idx_test_updated_at ON test_table(updated_at)',
      );

      // Manifest expects index with DIFFERENT name but SAME columns
      const manifest: Record<string, SchemaDefinition> = {
        test_table: {
          tableName: 'test_table',
          ddl: 'CREATE TABLE test_table (id TEXT PRIMARY KEY, email TEXT, updated_at DATETIME);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            email: { type: 'TEXT' },
            updated_at: { type: 'TIMESTAMP' },
          },
          indexes: [
            // Different name, but same table and columns
            {
              name: 'idx_alt_test_updated_at',
              columns: ['updated_at'],
              unique: false,
            },
          ],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const comparer = new SchemaComparer(db as any);
      const diff = await comparer.compare(manifest);

      // The comparer should recognize that updated_at is already indexed
      // and NOT suggest creating a new index with a different name
      const indexChanges = diff.changes.filter((c) => c.type === 'add_index');

      // This test documents the EXPECTED behavior after the fix
      // Currently this will FAIL (index detected as missing because names differ)
      expect(indexChanges).toHaveLength(0);
    });
  });

  describe('End-to-end STI migration', () => {
    it('should not fail when running db:migrate on existing STI table', async () => {
      // Step 1: Create the table using base class
      const collection = await Issue741EventCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      // Create events of different types
      await (
        await collection.create({
          _meta_type: '@happyvertical/smrt-core:Issue741Event',
          title: 'Base Event',
          description: 'A base event',
          startDate: new Date(),
        })
      ).save();

      await (
        await collection.create({
          _meta_type: '@happyvertical/smrt-core:Issue741Meeting',
          title: 'Team Meeting',
          description: 'Weekly standup',
          startDate: new Date(),
          roomNumber: 'A101',
          attendees: ['Alice', 'Bob'],
        })
      ).save();

      await (
        await collection.create({
          _meta_type: '@happyvertical/smrt-core:Issue741WeatherForecast',
          title: 'Weather Forecast',
          description: 'Daily weather',
          startDate: new Date(),
          temperature: 25.5,
          humidity: 60,
        })
      ).save();

      // Step 2: Simulate db:migrate by comparing schemas
      const schemas = ObjectRegistry.getAllSchemas();
      const eventsSchema = schemas.issue741events;

      // Parse SQL string indexes into structured objects (as db-diff.ts does)
      const parsedIndexes = eventsSchema.indexes
        ? parseIndexesFromSchema(eventsSchema.indexes)
        : [];

      const manifest: Record<string, SchemaDefinition> = {
        issue741events: {
          tableName: 'issue741events',
          ddl: eventsSchema.ddl,
          columns: {},
          indexes: parsedIndexes,
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const comparer = new SchemaComparer(db as any);
      const diff = await comparer.compare(manifest);

      // Step 3: There should be NO actionable changes
      // (table exists, all columns exist, all indexes exist)
      const actionableChanges = diff.changes.filter(
        (c) =>
          c.type === 'add_column' ||
          c.type === 'add_index' ||
          c.type === 'drop_column',
      );

      expect(actionableChanges).toHaveLength(0);
    });
  });
});

describe('Index normalization edge cases', () => {
  it('should handle indexes on multiple columns correctly', async () => {
    // Test that compound indexes with different names but same columns are recognized as functionally equivalent
    const db: DatabaseProvider = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    await db.query(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        status TEXT,
        created_at DATETIME
      )
    `);

    // Create a compound index
    await db.query(
      'CREATE INDEX idx_orders_customer_status ON orders(customer_id, status)',
    );

    // Manifest expects same compound index with different name
    const manifest: Record<string, SchemaDefinition> = {
      orders: {
        tableName: 'orders',
        ddl: 'CREATE TABLE orders (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT, created_at DATETIME);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          customer_id: { type: 'TEXT' },
          status: { type: 'TEXT' },
          created_at: { type: 'TIMESTAMP' },
        },
        indexes: [
          {
            name: 'idx_alt_customer_status',
            columns: ['customer_id', 'status'],
            unique: false,
          },
        ],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db as any);
    const diff = await comparer.compare(manifest);

    const indexChanges = diff.changes.filter((c) => c.type === 'add_index');

    // Should recognize the compound index already exists
    expect(indexChanges).toHaveLength(0);

    if (typeof (db as any).close === 'function') {
      await (db as any).close();
    }
  });

  it('should treat different column orders as non-equivalent indexes', async () => {
    // Column order is semantically significant for composite indexes
    // An index on (a, b) is NOT equivalent to (b, a) - they have different query performance
    const db: DatabaseProvider = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    await db.query(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        status TEXT
      )
    `);

    // Create index with columns in order (customer_id, status)
    await db.query(
      'CREATE INDEX idx_orders_customer_status ON orders(customer_id, status)',
    );

    // Manifest expects index with REVERSED column order (status, customer_id)
    const manifest: Record<string, SchemaDefinition> = {
      orders: {
        tableName: 'orders',
        ddl: 'CREATE TABLE orders (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          customer_id: { type: 'TEXT' },
          status: { type: 'TEXT' },
        },
        indexes: [
          {
            name: 'idx_orders_status_customer',
            columns: ['status', 'customer_id'], // REVERSED order
            unique: false,
          },
        ],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db as any);
    const diff = await comparer.compare(manifest);

    const indexChanges = diff.changes.filter((c) => c.type === 'add_index');

    // Should detect as MISSING because column order is different
    // (status, customer_id) is NOT equivalent to (customer_id, status)
    expect(indexChanges).toHaveLength(1);
    expect(indexChanges[0].name).toBe('idx_orders_status_customer');

    if (typeof (db as any).close === 'function') {
      await (db as any).close();
    }
  });

  it('should handle unique vs non-unique index differences', async () => {
    // Test that unique vs non-unique is considered in index equivalence
    const db: DatabaseProvider = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    await db.query(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT
      )
    `);

    // Create a NON-unique index
    await db.query('CREATE INDEX idx_users_email ON users(email)');

    // Manifest expects a UNIQUE index on same column
    const manifest: Record<string, SchemaDefinition> = {
      users: {
        tableName: 'users',
        ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          email: { type: 'TEXT' },
        },
        indexes: [
          {
            name: 'idx_users_email_unique',
            columns: ['email'],
            unique: true, // UNIQUE index expected
          },
        ],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db as any);
    const diff = await comparer.compare(manifest);

    const indexChanges = diff.changes.filter((c) => c.type === 'add_index');

    // This IS a valid difference - unique constraint is different from non-unique
    // The test documents expected behavior: unique index SHOULD be detected as new
    expect(indexChanges).toHaveLength(1);

    if (typeof (db as any).close === 'function') {
      await (db as any).close();
    }
  });
});
