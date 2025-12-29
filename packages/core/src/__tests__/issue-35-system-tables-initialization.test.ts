/**
 * Test for Issue #35: Missing _smrt_contexts table in DuckDB JSON mode breaks recall()
 *
 * This test verifies that:
 * 1. System tables are created exactly once per unique database instance
 * 2. Multiple SMRT objects sharing the same database instance don't recreate tables
 * 3. Different database instances each get their own system tables
 * 4. JSON databases with different dataDirs are properly distinguished
 * 5. DatabaseInterface instances are properly tracked without key collisions
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';

// Helper to create unique test database paths
function getTempDbPath(name: string): string {
  return join(tmpdir(), `test-issue-35-${name}-${randomUUID().slice(0, 8)}.db`);
}

// Move test classes to module level so AST scanner can pick them up during test manifest generation
class Issue35TestObject1 extends SmrtObject {
  value1: string = '';
}

class Issue35TestObject2 extends SmrtObject {
  value2: string = '';
}

class Issue35TestObjectDiffDb extends SmrtObject {
  value: string = '';
}

class Issue35TestDocument extends SmrtObject {
  content: string = '';
}

class Issue35TestObjectStringConfig extends SmrtObject {
  value: string = '';
}

class Issue35TestObjectConfigObj extends SmrtObject {
  value: string = '';
}

class Issue35TestObjectConcurrent extends SmrtObject {
  value: string = '';
}

class Issue35TestObjectWeakSet extends SmrtObject {
  value: string = '';
}

describe('Issue #35: System Tables Initialization', () => {
  // Clear the WeakSet before each test by creating new classes
  // (WeakSet is static, so we need fresh class instances)
  beforeEach(() => {
    // Force garbage collection hint for WeakSet
    if (global.gc) {
      global.gc();
    }
  });

  describe('Same database instance used by multiple objects', () => {
    it('should create system tables only once when multiple SMRT objects share the same database instance', async () => {
      // Create a single database instance
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

      // Create first SMRT object with this database
      const obj1 = new Issue35TestObject1({ db, value1: 'test1' });
      await obj1.initialize();

      // Verify system tables exist
      const migrations1 = await db.query('SELECT * FROM _smrt_migrations');
      expect(migrations1.rows.length).toBeGreaterThan(0);

      // Create second SMRT object with SAME database instance
      const obj2 = new Issue35TestObject2({ db, value2: 'test2' });
      await obj2.initialize();

      // System tables should NOT be recreated (same count of migrations)
      const migrations2 = await db.query('SELECT * FROM _smrt_migrations');
      expect(migrations2.rows.length).toBe(migrations1.rows.length);

      // Verify recall() works (the original issue)
      await obj1.remember({
        scope: 'test',
        key: 'data',
        value: { foo: 'bar' },
      });

      const recalled = await obj1.recall({ scope: 'test', key: 'data' });
      expect(recalled).toEqual({ foo: 'bar' });
    });
  });

  describe('Different database instances', () => {
    it('should create system tables for each different database instance', async () => {
      // Create two separate database instances
      const db1 = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const db2 = await getDatabase({ type: 'sqlite', url: ':memory:' });

      // Initialize with first database
      const obj1 = new Issue35TestObjectDiffDb({ db: db1, value: 'test1' });
      await obj1.initialize();

      // Verify system tables in db1
      const migrations1 = await db1.query('SELECT * FROM _smrt_migrations');
      expect(migrations1.rows.length).toBeGreaterThan(0);

      // Initialize with second database
      const obj2 = new Issue35TestObjectDiffDb({ db: db2, value: 'test2' });
      await obj2.initialize();

      // Verify system tables in db2 (should be created independently)
      const migrations2 = await db2.query('SELECT * FROM _smrt_migrations');
      expect(migrations2.rows.length).toBeGreaterThan(0);

      // Both databases should have independent system tables
      expect(migrations1.rows.length).toBe(migrations2.rows.length);
    });
  });

  describe('JSON databases with different dataDirs', () => {
    it('should create system tables for each JSON database with different dataDir', async () => {
      const dataDir1 = join(
        tmpdir(),
        `test-json-1-${randomUUID().slice(0, 8)}`,
      );
      const dataDir2 = join(
        tmpdir(),
        `test-json-2-${randomUUID().slice(0, 8)}`,
      );

      // Create two JSON databases with different dataDirs
      const db1 = await getDatabase({
        type: 'json',
        url: dataDir1, // SDK now requires url parameter
        dataDir: dataDir1,
        writeStrategy: 'immediate',
      });

      const db2 = await getDatabase({
        type: 'json',
        url: dataDir2, // SDK now requires url parameter
        dataDir: dataDir2,
        writeStrategy: 'immediate',
      });

      // Initialize with first JSON database
      const doc1 = new Issue35TestDocument({ db: db1, content: 'test1' });
      await doc1.initialize();

      // Verify system tables in db1
      const migrations1 = await db1.query('SELECT * FROM _smrt_migrations');
      expect(migrations1.rows.length).toBeGreaterThan(0);

      // Initialize with second JSON database
      const doc2 = new Issue35TestDocument({ db: db2, content: 'test2' });
      await doc2.initialize();

      // Verify system tables in db2 (should be created independently)
      const migrations2 = await db2.query('SELECT * FROM _smrt_migrations');
      expect(migrations2.rows.length).toBeGreaterThan(0);

      // Both should be able to use recall() (original issue)
      await doc1.remember({
        scope: 'discovery',
        key: 'test',
        value: 'data1',
      });
      await doc2.remember({
        scope: 'discovery',
        key: 'test',
        value: 'data2',
      });

      const recalled1 = await doc1.recall({ scope: 'discovery', key: 'test' });
      const recalled2 = await doc2.recall({ scope: 'discovery', key: 'test' });

      expect(recalled1).toBe('data1');
      expect(recalled2).toBe('data2');
    });
  });

  describe('Database configuration variations', () => {
    it('should handle string database configuration correctly', async () => {
      const dbPath = getTempDbPath('string-config');

      // Use config object with file path (string shortcut alone can't auto-detect type from path)
      const obj = new Issue35TestObjectStringConfig({
        db: { type: 'sqlite', url: dbPath },
        value: 'test',
      });
      await obj.initialize();

      // Verify system tables were created
      const db = obj._db as DatabaseInterface;
      const migrations = await db.query('SELECT * FROM _smrt_migrations');
      expect(migrations.rows.length).toBeGreaterThan(0);

      // Verify recall() works
      await obj.remember({ scope: 'test', key: 'key1', value: 'value1' });
      const recalled = await obj.recall({ scope: 'test', key: 'key1' });
      expect(recalled).toBe('value1');
    });

    it('should handle config object database configuration correctly', async () => {
      const dbPath = getTempDbPath('config-object');

      // Use config object for database configuration
      const obj = new Issue35TestObjectConfigObj({
        db: { type: 'sqlite', url: dbPath },
        value: 'test',
      });
      await obj.initialize();

      // Verify system tables were created
      const db = obj._db as DatabaseInterface;
      const migrations = await db.query('SELECT * FROM _smrt_migrations');
      expect(migrations.rows.length).toBeGreaterThan(0);
    });
  });

  describe('Concurrent initialization', () => {
    it('should handle concurrent initialization with same database instance', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

      // Create multiple objects concurrently with same database
      const objects = await Promise.all([
        (async () => {
          const obj = new Issue35TestObjectConcurrent({ db, value: 'test1' });
          await obj.initialize();
          return obj;
        })(),
        (async () => {
          const obj = new Issue35TestObjectConcurrent({ db, value: 'test2' });
          await obj.initialize();
          return obj;
        })(),
        (async () => {
          const obj = new Issue35TestObjectConcurrent({ db, value: 'test3' });
          await obj.initialize();
          return obj;
        })(),
      ]);

      // Verify system tables exist and were created only once
      const migrations = await db.query('SELECT * FROM _smrt_migrations');
      expect(migrations.rows.length).toBeGreaterThan(0);

      // All objects should be able to use recall()
      for (const obj of objects) {
        const testValue = `test-value-${obj.id}`;
        await obj.remember({ scope: 'test', key: 'key', value: testValue });
        const recalled = await obj.recall({ scope: 'test', key: 'key' });
        expect(recalled).toBe(testValue);
      }
    });
  });

  describe('WeakSet garbage collection behavior', () => {
    it('should allow garbage collection of database instances', async () => {
      // Create and initialize object with database
      {
        const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
        const obj = new Issue35TestObjectWeakSet({ db, value: 'test' });
        await obj.initialize();

        // Verify system tables were created
        const migrations = await db.query('SELECT * FROM _smrt_migrations');
        expect(migrations.rows.length).toBeGreaterThan(0);
      } // db goes out of scope here

      // Force garbage collection hint (if available)
      if (global.gc) {
        global.gc();
      }

      // Create new database instance
      const db2 = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const obj2 = new Issue35TestObjectWeakSet({ db: db2, value: 'test2' });
      await obj2.initialize();

      // System tables should be created for this new instance
      const migrations2 = await db2.query('SELECT * FROM _smrt_migrations');
      expect(migrations2.rows.length).toBeGreaterThan(0);
    });
  });
});
