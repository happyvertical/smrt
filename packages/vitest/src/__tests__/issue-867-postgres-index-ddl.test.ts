/**
 * Issue #867: CREATE INDEX statements not executed for PostgreSQL test databases
 *
 * The generateIndexDDL() fix in v0.19.67 only works for SQLite, not PostgreSQL.
 * UPSERT operations fail on PostgreSQL with "no unique or exclusion constraint"
 * because the CREATE INDEX statements are not being executed.
 *
 * This test verifies that:
 * 1. SQLite: CREATE INDEX statements ARE executed (fix works)
 * 2. PostgreSQL: CREATE INDEX statements are NOT executed (bug)
 *
 * @see https://github.com/happyvertical/smrt/issues/867
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIsolatedTestDbFromManifest,
  getTestAdapter,
  type IsolatedTestDbResult,
} from '../test-db.js';

describe('Issue #867: PostgreSQL CREATE INDEX execution', () => {
  let testDir: string;
  let manifestPath: string;
  let testResult: IsolatedTestDbResult | null = null;

  beforeEach(() => {
    // Create a temporary directory for the test manifest
    testDir = join(tmpdir(), `smrt-test-867-${randomUUID().slice(0, 8)}`);
    mkdirSync(testDir, { recursive: true });
    manifestPath = join(testDir, 'manifest.json');
  });

  afterEach(async () => {
    // Cleanup test database
    if (testResult) {
      await testResult.cleanup();
      testResult = null;
    }

    // Cleanup temp directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should execute CREATE INDEX and support ON CONFLICT upsert', async () => {
    const adapter = getTestAdapter();

    // Create a manifest with a unique index on (slug, context)
    const manifest = {
      objects: {
        Item: {
          className: 'Item',
          schema: {
            tableName: 'items',
            ddl: `CREATE TABLE IF NOT EXISTS "items" (
              "id" TEXT PRIMARY KEY,
              "slug" TEXT NOT NULL,
              "context" TEXT DEFAULT '',
              "name" TEXT NOT NULL
            );`,
            indexes: [
              {
                name: 'items_slug_context_idx',
                columns: ['slug', 'context'],
                unique: true,
              },
            ],
          },
        },
      },
    };

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    testResult = await createIsolatedTestDbFromManifest({
      manifestPath,
      prefix: 'smrt-867',
    });

    const { db, baseDb } = testResult;

    // Insert initial record
    await db.insert('items', {
      id: 'item-1',
      slug: 'test-item',
      context: '',
      name: 'Original Name',
    });

    // Verify initial insert worked
    const inserted = await db.get('items', { id: 'item-1' });
    expect(inserted).toBeDefined();
    expect((inserted as Record<string, unknown>)?.name).toBe('Original Name');

    // Now attempt upsert using raw SQL with ON CONFLICT
    // This requires the unique index to exist
    // PostgreSQL uses EXCLUDED, SQLite uses excluded (case-insensitive but we match convention)
    const upsertSql =
      adapter === 'postgres'
        ? `INSERT INTO items (id, slug, context, name)
           VALUES ('item-2', 'test-item', '', 'Updated Name')
           ON CONFLICT (slug, context) DO UPDATE SET name = EXCLUDED.name`
        : `INSERT INTO items (id, slug, context, name)
           VALUES ('item-2', 'test-item', '', 'Updated Name')
           ON CONFLICT (slug, context) DO UPDATE SET name = excluded.name`;

    try {
      await baseDb.query(upsertSql);

      // If we get here, the upsert worked - verify the result
      const result = await db.get('items', {
        slug: 'test-item',
        context: '',
      });
      expect((result as Record<string, unknown>)?.name).toBe('Updated Name');

      // Also verify we only have 1 record (upsert updated, didn't insert)
      const allItems = await db.list('items', {});
      expect(allItems).toHaveLength(1);
    } catch (error) {
      // This is the Issue #867 bug: PostgreSQL fails because the index wasn't created
      // The DatabaseError wraps the original error, so we need to check both
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorString = JSON.stringify(error);

      // Check for the Issue #867 specific error in both message and serialized form
      const isConflictError =
        errorMessage.includes('no unique or exclusion constraint') ||
        errorString.includes('no unique or exclusion constraint') ||
        errorString.includes('42P10'); // PostgreSQL error code for this

      if (adapter === 'postgres' && isConflictError) {
        // This is the expected failure for Issue #867
        throw new Error(
          `Issue #867: PostgreSQL UPSERT failed because CREATE INDEX was not executed.\n` +
            `Adapter: ${adapter}\n` +
            `Error: ${errorString}\n\n` +
            `The generateIndexDDL() function generates the CREATE INDEX statement correctly,\n` +
            `but syncSchema() from @happyvertical/sql does not execute it for PostgreSQL.\n` +
            `The DDL is passed as a single string containing both CREATE TABLE and CREATE INDEX,\n` +
            `but PostgreSQL's syncSchema only parses and executes CREATE TABLE statements.`,
        );
      }

      // Re-throw any other unexpected errors
      throw error;
    }
  });

  it('should work for multiple indexes', async () => {
    const adapter = getTestAdapter();

    // Create a manifest with multiple indexes
    const manifest = {
      objects: {
        Product: {
          className: 'Product',
          schema: {
            tableName: 'products',
            ddl: `CREATE TABLE IF NOT EXISTS "products" (
              "id" TEXT PRIMARY KEY,
              "slug" TEXT NOT NULL,
              "context" TEXT DEFAULT '',
              "sku" TEXT NOT NULL,
              "name" TEXT NOT NULL
            );`,
            indexes: [
              {
                name: 'products_slug_context_idx',
                columns: ['slug', 'context'],
                unique: true,
              },
              {
                name: 'products_sku_idx',
                columns: ['sku'],
                unique: true,
              },
            ],
          },
        },
      },
    };

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    testResult = await createIsolatedTestDbFromManifest({
      manifestPath,
      prefix: 'smrt-867-multi',
    });

    const { db, baseDb } = testResult;

    // Insert a product
    await db.insert('products', {
      id: 'prod-1',
      slug: 'widget',
      context: '',
      sku: 'SKU-001',
      name: 'Widget',
    });

    // Try to insert duplicate SKU - should fail with unique constraint
    const duplicateSkuSql =
      adapter === 'postgres'
        ? `INSERT INTO products (id, slug, context, sku, name)
           VALUES ('prod-2', 'other-widget', '', 'SKU-001', 'Other Widget')
           ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name`
        : `INSERT INTO products (id, slug, context, sku, name)
           VALUES ('prod-2', 'other-widget', '', 'SKU-001', 'Other Widget')
           ON CONFLICT (sku) DO UPDATE SET name = excluded.name`;

    try {
      await baseDb.query(duplicateSkuSql);

      // Should have updated existing record
      const product = await db.get('products', { sku: 'SKU-001' });
      expect((product as Record<string, unknown>)?.name).toBe('Other Widget');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorString = JSON.stringify(error);

      const isConflictError =
        errorMessage.includes('no unique or exclusion constraint') ||
        errorString.includes('no unique or exclusion constraint') ||
        errorString.includes('42P10');

      if (adapter === 'postgres' && isConflictError) {
        throw new Error(
          `Issue #867: PostgreSQL ON CONFLICT (sku) failed - SKU unique index not created.\n` +
            `Adapter: ${adapter}\n` +
            `Error: ${errorString}`,
        );
      }

      throw error;
    }
  });
});
