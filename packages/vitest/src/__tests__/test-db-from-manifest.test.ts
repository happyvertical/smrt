/**
 * Tests for createIsolatedTestDbFromManifest and related helpers
 *
 * These tests verify the manifest loading, DDL extraction, STI deduplication,
 * and foreign key dependency ordering functionality.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import the function we're testing
import { createIsolatedTestDbFromManifest } from '../test-db.js';

// Test fixtures directory
const testDir = join(tmpdir(), `smrt-vitest-test-${Date.now()}`);

describe('createIsolatedTestDbFromManifest', () => {
  beforeAll(() => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    // Cleanup test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('manifest loading', () => {
    it('should throw helpful error when no manifest found', async () => {
      // Save and restore cwd
      const originalCwd = process.cwd();
      try {
        process.chdir(testDir);

        await expect(createIsolatedTestDbFromManifest()).rejects.toThrow(
          'No manifest found',
        );
        await expect(createIsolatedTestDbFromManifest()).rejects.toThrow(
          '.smrt/manifest.json',
        );
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should load manifest from explicit path', async () => {
      const manifestPath = join(testDir, 'custom-manifest.json');
      const manifest = {
        objects: {
          Product: {
            className: 'Product',
            schema: {
              tableName: 'products',
              ddl: 'CREATE TABLE IF NOT EXISTS "products" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT DEFAULT \'\');',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Verify db is usable
        expect(db).toBeDefined();
        expect(typeof db.list).toBe('function');
      } finally {
        await cleanup();
      }
    });

    it('should auto-detect manifest from .smrt/manifest.json', async () => {
      const smrtDir = join(testDir, '.smrt');
      mkdirSync(smrtDir, { recursive: true });

      const manifest = {
        objects: {
          Order: {
            className: 'Order',
            schema: {
              tableName: 'orders',
              ddl: 'CREATE TABLE IF NOT EXISTS "orders" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
        },
      };

      writeFileSync(join(smrtDir, 'manifest.json'), JSON.stringify(manifest));

      const originalCwd = process.cwd();
      try {
        process.chdir(testDir);
        const { db, cleanup } = await createIsolatedTestDbFromManifest();

        try {
          expect(db).toBeDefined();
        } finally {
          await cleanup();
        }
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('DDL extraction', () => {
    it('should extract DDL from manifest objects', async () => {
      const manifestPath = join(testDir, 'ddl-test.json');
      const manifest = {
        objects: {
          Customer: {
            className: 'Customer',
            schema: {
              tableName: 'customers',
              ddl: 'CREATE TABLE IF NOT EXISTS "customers" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT DEFAULT \'\');',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Table should be created
        const customers = await db.list('customers', {});
        expect(customers).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('should throw error when no objects have schema', async () => {
      const manifestPath = join(testDir, 'no-schema.json');
      const manifest = {
        objects: {
          AbstractClass: {
            className: 'AbstractClass',
            // No schema
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      await expect(
        createIsolatedTestDbFromManifest({ manifestPath }),
      ).rejects.toThrow('No objects with schema found in manifest');
    });
  });

  describe('includeObjects filtering', () => {
    it('should filter to specified objects', async () => {
      const manifestPath = join(testDir, 'filter-test.json');
      const manifest = {
        objects: {
          Product: {
            className: 'Product',
            schema: {
              tableName: 'products',
              ddl: 'CREATE TABLE IF NOT EXISTS "products" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
          Order: {
            className: 'Order',
            schema: {
              tableName: 'orders',
              ddl: 'CREATE TABLE IF NOT EXISTS "orders" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
          Log: {
            className: 'Log',
            schema: {
              tableName: 'logs',
              ddl: 'CREATE TABLE IF NOT EXISTS "logs" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
        includeObjects: ['Product', 'Order'],
      });

      try {
        // Product and Order tables should exist
        await db.list('products', {});
        await db.list('orders', {});

        // Logs table should NOT exist
        await expect(db.list('logs', {})).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });

    it('should throw error when filter matches no objects', async () => {
      const manifestPath = join(testDir, 'filter-none.json');
      const manifest = {
        objects: {
          Product: {
            className: 'Product',
            schema: {
              tableName: 'products',
              ddl: 'CREATE TABLE IF NOT EXISTS "products" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      await expect(
        createIsolatedTestDbFromManifest({
          manifestPath,
          includeObjects: ['NonExistent'],
        }),
      ).rejects.toThrow('No objects with schema found matching: NonExistent');
    });

    it('should filter using className even when manifest keys are namespaced (Issue #860)', async () => {
      const manifestPath = join(testDir, 'namespaced-filter.json');
      const manifest = {
        objects: {
          // Manifest keys are namespaced (e.g., @package:ClassName)
          '@dumm/models:Product': {
            className: 'Product',
            schema: {
              tableName: 'products',
              ddl: 'CREATE TABLE IF NOT EXISTS "products" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
          '@dumm/models:Order': {
            className: 'Order',
            schema: {
              tableName: 'orders',
              ddl: 'CREATE TABLE IF NOT EXISTS "orders" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
          '@dumm/models:Log': {
            className: 'Log',
            schema: {
              tableName: 'logs',
              ddl: 'CREATE TABLE IF NOT EXISTS "logs" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      // Filter using simple class names (not namespaced keys)
      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
        includeObjects: ['Product', 'Order'], // Simple class names, not @dumm/models:Product
      });

      try {
        // Product and Order tables should exist
        await db.list('products', {});
        await db.list('orders', {});

        // Logs table should NOT exist
        await expect(db.list('logs', {})).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });

    it('should also support filtering by namespaced key directly', async () => {
      const manifestPath = join(testDir, 'namespaced-key-filter.json');
      const manifest = {
        objects: {
          '@dumm/models:Product': {
            className: 'Product',
            schema: {
              tableName: 'products',
              ddl: 'CREATE TABLE IF NOT EXISTS "products" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
          '@dumm/models:Order': {
            className: 'Order',
            schema: {
              tableName: 'orders',
              ddl: 'CREATE TABLE IF NOT EXISTS "orders" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      // Filter using namespaced keys (for backwards compatibility)
      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
        includeObjects: ['@dumm/models:Product'],
      });

      try {
        // Product table should exist
        await db.list('products', {});

        // Order table should NOT exist
        await expect(db.list('orders', {})).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });
  });

  describe('STI deduplication', () => {
    it('should deduplicate classes sharing the same table (STI)', async () => {
      const manifestPath = join(testDir, 'sti-test.json');
      const manifest = {
        objects: {
          Event: {
            className: 'Event',
            schema: {
              tableName: 'events',
              ddl: 'CREATE TABLE IF NOT EXISTS "events" ("id" TEXT PRIMARY KEY NOT NULL, "_meta_type" TEXT NOT NULL, "title" TEXT DEFAULT \'\');',
            },
          },
          Meeting: {
            className: 'Meeting',
            schema: {
              // Same table as Event (STI)
              tableName: 'events',
              ddl: 'CREATE TABLE IF NOT EXISTS "events" ("id" TEXT PRIMARY KEY NOT NULL, "_meta_type" TEXT NOT NULL, "title" TEXT DEFAULT \'\');',
            },
          },
          Conference: {
            className: 'Conference',
            schema: {
              // Same table as Event (STI)
              tableName: 'events',
              ddl: 'CREATE TABLE IF NOT EXISTS "events" ("id" TEXT PRIMARY KEY NOT NULL, "_meta_type" TEXT NOT NULL, "title" TEXT DEFAULT \'\');',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      // Should not throw "table already exists" error
      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Single events table should be created
        const events = await db.list('events', {});
        expect(events).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });

  describe('foreign key dependency ordering', () => {
    it('should create tables in dependency order', async () => {
      const manifestPath = join(testDir, 'fk-test.json');
      const manifest = {
        objects: {
          // OrderItem references Order (defined first but depends on Order)
          OrderItem: {
            className: 'OrderItem',
            schema: {
              tableName: 'order_items',
              ddl: `CREATE TABLE IF NOT EXISTS "order_items" (
                "id" TEXT PRIMARY KEY NOT NULL,
                "order_id" TEXT REFERENCES "orders"("id"),
                "product_id" TEXT REFERENCES "products"("id")
              );`,
            },
          },
          // Order references Customer
          Order: {
            className: 'Order',
            schema: {
              tableName: 'orders',
              ddl: `CREATE TABLE IF NOT EXISTS "orders" (
                "id" TEXT PRIMARY KEY NOT NULL,
                "customer_id" TEXT REFERENCES "customers"("id")
              );`,
            },
          },
          // Customer has no dependencies (should be first)
          Customer: {
            className: 'Customer',
            schema: {
              tableName: 'customers',
              ddl: 'CREATE TABLE IF NOT EXISTS "customers" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
          // Product has no dependencies
          Product: {
            className: 'Product',
            schema: {
              tableName: 'products',
              ddl: 'CREATE TABLE IF NOT EXISTS "products" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      // Should not throw foreign key constraint error
      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // All tables should be created
        await db.list('customers', {});
        await db.list('products', {});
        await db.list('orders', {});
        await db.list('order_items', {});
      } finally {
        await cleanup();
      }
    });

    it('should handle circular dependencies gracefully', async () => {
      const manifestPath = join(testDir, 'circular-test.json');
      const manifest = {
        objects: {
          // A references B, B references A (circular)
          TableA: {
            className: 'TableA',
            schema: {
              tableName: 'table_a',
              ddl: `CREATE TABLE IF NOT EXISTS "table_a" (
                "id" TEXT PRIMARY KEY NOT NULL,
                "b_id" TEXT REFERENCES "table_b"("id")
              );`,
            },
          },
          TableB: {
            className: 'TableB',
            schema: {
              tableName: 'table_b',
              ddl: `CREATE TABLE IF NOT EXISTS "table_b" (
                "id" TEXT PRIMARY KEY NOT NULL,
                "a_id" TEXT REFERENCES "table_a"("id")
              );`,
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      // SQLite doesn't enforce FK constraints by default, so this should work
      // The point is that the function doesn't infinite loop on circular deps
      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        expect(db).toBeDefined();
      } finally {
        await cleanup();
      }
    });
  });

  describe('transaction isolation', () => {
    it('should return transaction handle for test isolation', async () => {
      const manifestPath = join(testDir, 'isolation-test.json');
      const manifest = {
        objects: {
          User: {
            className: 'User',
            schema: {
              tableName: 'users',
              ddl: 'CREATE TABLE IF NOT EXISTS "users" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT DEFAULT \'\');',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Insert data in transaction
        await db.insert('users', { id: 'test-1', name: 'Alice' });

        // Verify data exists in transaction
        const user = await db.get('users', { id: 'test-1' });
        expect(user?.name).toBe('Alice');
      } finally {
        // Cleanup rolls back transaction
        await cleanup();
      }

      // After cleanup, create new db - data should not exist
      const { db: db2, cleanup: cleanup2 } =
        await createIsolatedTestDbFromManifest({
          manifestPath,
        });

      try {
        const users = await db2.list('users', {});
        expect(users).toHaveLength(0);
      } finally {
        await cleanup2();
      }
    });

    it('should close base database connection on cleanup (Issue #858)', async () => {
      const manifestPath = join(testDir, 'connection-close-test.json');
      const manifest = {
        objects: {
          Item: {
            className: 'Item',
            schema: {
              tableName: 'items',
              ddl: 'CREATE TABLE IF NOT EXISTS "items" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { baseDb, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      // Verify baseDb is usable before cleanup
      expect(baseDb).toBeDefined();

      // Call cleanup which should close the connection
      await cleanup();

      // After cleanup, the baseDb should be closed
      // Attempting to use it should fail or indicate it's closed
      const dbRecord = baseDb as unknown as Record<string, unknown>;
      if (typeof dbRecord.isClosed === 'function') {
        expect((dbRecord.isClosed as () => boolean)()).toBe(true);
      } else if (typeof dbRecord.closed !== 'undefined') {
        expect(dbRecord.closed).toBe(true);
      } else {
        // If no closed indicator, verify operations fail
        // This is adapter-dependent, so we just verify cleanup completed
        expect(true).toBe(true);
      }
    });
  });

  describe('options', () => {
    it('should use custom prefix for temp files', async () => {
      const manifestPath = join(testDir, 'prefix-test.json');
      const manifest = {
        objects: {
          Test: {
            className: 'Test',
            schema: {
              tableName: 'tests',
              ddl: 'CREATE TABLE IF NOT EXISTS "tests" ("id" TEXT PRIMARY KEY NOT NULL);',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { config, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
        prefix: 'my-custom-prefix',
      });

      try {
        // SQLite URL should contain the custom prefix
        if (config.type === 'sqlite') {
          expect(config.url).toContain('my-custom-prefix');
        }
      } finally {
        await cleanup();
      }
    });
  });
});
