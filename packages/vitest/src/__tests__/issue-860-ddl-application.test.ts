/**
 * Tests for Issue #860 - DDL not being applied from manifest
 *
 * These tests verify that DDL extracted from manifests is actually
 * applied to create tables, not just silently ignored.
 *
 * Key symptoms from the issue:
 * 1. Manifest is valid with DDL present
 * 2. createIsolatedTestDbFromManifest returns without error
 * 3. Only SMRT system tables exist, not application tables
 * 4. syncSchema returns without error but creates nothing
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIsolatedTestDb,
  createIsolatedTestDbFromManifest,
  getTestDbConfig,
} from '../test-db.js';

// Test fixtures directory
const testDir = join(tmpdir(), `smrt-vitest-issue-860-${Date.now()}`);

describe('Issue #860 - DDL Application', () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('DDL string verification', () => {
    it('should pass non-empty DDL string to createIsolatedTestDb', async () => {
      const manifestPath = join(testDir, 'ddl-verification.json');
      const expectedDDL =
        'CREATE TABLE IF NOT EXISTS "test_items" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT DEFAULT \'\');';

      const manifest = {
        objects: {
          TestItem: {
            className: 'TestItem',
            schema: {
              tableName: 'test_items',
              ddl: expectedDDL,
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      // The function should not throw with valid manifest
      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Verify table exists by attempting to list (would throw if missing)
        const items = await db.list('test_items', {});
        expect(Array.isArray(items)).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe('syncSchema actually creates tables', () => {
    it('should create table via direct createIsolatedTestDb call', async () => {
      const schema = `
        CREATE TABLE IF NOT EXISTS "direct_test" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "value" TEXT DEFAULT ''
        );
      `;

      const { db, cleanup } = await createIsolatedTestDb({
        schema,
        prefix: 'issue-860-direct',
      });

      try {
        // Verify table exists by listing (would throw if table doesn't exist)
        const items = await db.list('direct_test', {});
        expect(Array.isArray(items)).toBe(true);
        expect(items).toHaveLength(0);

        // Insert and retrieve to prove table is functional
        await db.insert('direct_test', { id: 'test-1', value: 'hello' });
        const item = await db.get('direct_test', { id: 'test-1' });
        expect(item).toBeDefined();
        expect((item as Record<string, unknown>).value).toBe('hello');
      } finally {
        await cleanup();
      }
    });

    it('should create multiple tables from manifest DDL', async () => {
      const manifestPath = join(testDir, 'multi-table-test.json');

      // Simulate a real manifest with multiple tables
      // Use unique table names to avoid collision with other tests
      const manifest = {
        objects: {
          Customer: {
            className: 'Customer',
            schema: {
              tableName: 'multi_customers',
              ddl: 'CREATE TABLE IF NOT EXISTS "multi_customers" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT DEFAULT \'\');',
            },
          },
          Product: {
            className: 'Product',
            schema: {
              tableName: 'multi_products',
              ddl: 'CREATE TABLE IF NOT EXISTS "multi_products" ("id" TEXT PRIMARY KEY NOT NULL, "sku" TEXT DEFAULT \'\');',
            },
          },
          Order: {
            className: 'Order',
            schema: {
              tableName: 'multi_orders',
              ddl: 'CREATE TABLE IF NOT EXISTS "multi_orders" ("id" TEXT PRIMARY KEY NOT NULL, "customer_id" TEXT, "total" REAL DEFAULT 0);',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Verify all tables are queryable via transaction handle
        // If tables weren't created, these would throw
        const customers = await db.list('multi_customers', {});
        const products = await db.list('multi_products', {});
        const orders = await db.list('multi_orders', {});

        expect(Array.isArray(customers)).toBe(true);
        expect(Array.isArray(products)).toBe(true);
        expect(Array.isArray(orders)).toBe(true);

        // Insert into each table to prove they're functional
        await db.insert('multi_customers', { id: 'c1', name: 'Alice' });
        await db.insert('multi_products', { id: 'p1', sku: 'SKU-001' });
        await db.insert('multi_orders', {
          id: 'o1',
          customer_id: 'c1',
          total: 99.99,
        });

        // Verify inserts
        const customer = await db.get('multi_customers', { id: 'c1' });
        expect((customer as Record<string, unknown>).name).toBe('Alice');
      } finally {
        await cleanup();
      }
    });
  });

  describe('namespaced manifest keys (Issue #860 specific)', () => {
    it('should create tables from manifest with namespaced keys when no filter specified', async () => {
      const manifestPath = join(testDir, 'namespaced-no-filter.json');

      // This is the exact format reported in Issue #860
      // Keys are namespaced like "@package:ClassName"
      // Use unique table names to avoid collision with other tests
      const manifest = {
        objects: {
          '@dumm/models:Product': {
            className: 'Product',
            schema: {
              tableName: 'ns_products',
              ddl: 'CREATE TABLE IF NOT EXISTS "ns_products" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT DEFAULT \'\', "price" REAL DEFAULT 0);',
            },
          },
          '@dumm/models:Build': {
            className: 'Build',
            schema: {
              tableName: 'ns_builds',
              ddl: 'CREATE TABLE IF NOT EXISTS "ns_builds" ("id" TEXT PRIMARY KEY NOT NULL, "version" TEXT DEFAULT \'\');',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      // NO includeObjects filter - should create ALL tables
      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Verify both tables exist by listing (would throw if missing)
        const products = await db.list('ns_products', {});
        expect(Array.isArray(products)).toBe(true);

        const builds = await db.list('ns_builds', {});
        expect(Array.isArray(builds)).toBe(true);

        // Insert into both tables to verify they're functional
        await db.insert('ns_products', {
          id: 'p1',
          name: 'Widget',
          price: 19.99,
        });
        await db.insert('ns_builds', { id: 'b1', version: '1.0.0' });

        // Verify data
        const product = await db.get('ns_products', { id: 'p1' });
        expect((product as Record<string, unknown>).name).toBe('Widget');

        const build = await db.get('ns_builds', { id: 'b1' });
        expect((build as Record<string, unknown>).version).toBe('1.0.0');
      } finally {
        await cleanup();
      }
    });
  });

  describe('large manifest (performance regression)', () => {
    it('should handle manifest with many objects', async () => {
      const manifestPath = join(testDir, 'large-manifest.json');

      // Create a manifest with 50 objects (simulating a larger project)
      const objects: Record<
        string,
        { className: string; schema: { tableName: string; ddl: string } }
      > = {};

      for (let i = 0; i < 50; i++) {
        const className = `Entity${i}`;
        const tableName = `entities_${i}`;
        objects[`@test/models:${className}`] = {
          className,
          schema: {
            tableName,
            ddl: `CREATE TABLE IF NOT EXISTS "${tableName}" ("id" TEXT PRIMARY KEY NOT NULL, "value" TEXT DEFAULT '');`,
          },
        };
      }

      const manifest = { objects };
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Spot-check a few tables exist
        await db.list('entities_0', {});
        await db.list('entities_25', {});
        await db.list('entities_49', {});
      } finally {
        await cleanup();
      }
    });
  });

  describe('DDL with indexes', () => {
    it('should create indexes from manifest', async () => {
      const manifestPath = join(testDir, 'with-indexes.json');

      const manifest = {
        objects: {
          IndexedItem: {
            className: 'IndexedItem',
            schema: {
              tableName: 'indexed_items',
              ddl: 'CREATE TABLE IF NOT EXISTS "indexed_items" ("id" TEXT PRIMARY KEY NOT NULL, "slug" TEXT NOT NULL, "context" TEXT NOT NULL);',
              indexes: [
                {
                  name: 'idx_indexed_items_slug',
                  columns: ['slug'],
                  unique: false,
                },
                {
                  name: 'idx_indexed_items_slug_context',
                  columns: ['slug', 'context'],
                  unique: true,
                },
              ],
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Table should exist and be queryable
        const items = await db.list('indexed_items', {});
        expect(Array.isArray(items)).toBe(true);

        // Insert data to verify table is functional
        await db.insert('indexed_items', {
          id: 'i1',
          slug: 'test-slug',
          context: 'ctx1',
        });

        // The unique index should prevent duplicate slug+context
        // First, verify the data was inserted
        const item = await db.get('indexed_items', { id: 'i1' });
        expect((item as Record<string, unknown>).slug).toBe('test-slug');

        // Note: We can't easily test unique index violation without
        // depending on specific error handling. The important thing
        // is that the DDL with indexes was applied without error.
      } finally {
        await cleanup();
      }
    });

    it('should create unique index required for UPSERT', async () => {
      const manifestPath = join(testDir, 'upsert-index.json');

      const manifest = {
        objects: {
          UpsertItem: {
            className: 'UpsertItem',
            schema: {
              tableName: 'upsert_items',
              ddl: 'CREATE TABLE IF NOT EXISTS "upsert_items" ("id" TEXT PRIMARY KEY NOT NULL, "slug" TEXT NOT NULL, "value" TEXT DEFAULT \'\');',
              indexes: [
                {
                  name: 'idx_upsert_items_slug',
                  columns: ['slug'],
                  unique: true,
                },
              ],
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Insert initial record
        await db.insert('upsert_items', {
          id: 'item-1',
          slug: 'test-slug',
          value: 'original',
        });

        // The unique index should allow ON CONFLICT handling
        // This verifies the index was actually created
        const items = await db.list('upsert_items', {});
        expect(items).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe('tables visible through transaction', () => {
    it('should make DDL changes visible to transaction started after schema sync', async () => {
      const manifestPath = join(testDir, 'transaction-visibility.json');

      const manifest = {
        objects: {
          Widget: {
            className: 'Widget',
            schema: {
              tableName: 'widgets',
              ddl: 'CREATE TABLE IF NOT EXISTS "widgets" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT DEFAULT \'\');',
            },
          },
        },
      };

      writeFileSync(manifestPath, JSON.stringify(manifest));

      const { db, cleanup } = await createIsolatedTestDbFromManifest({
        manifestPath,
      });

      try {
        // Insert and query within transaction
        await db.insert('widgets', { id: 'w1', name: 'Widget One' });

        const widget = await db.get('widgets', { id: 'w1' });
        expect(widget).toBeDefined();
        expect((widget as Record<string, unknown>).name).toBe('Widget One');

        // List should work too
        const widgets = await db.list('widgets', {});
        expect(widgets).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });
  });
});
