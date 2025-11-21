/**
 * Foreign Key Query Tests for STI Models
 *
 * Tests that Collection.findOne() and Collection.list() properly support querying
 * by foreign key fields in Single Table Inheritance (STI) models.
 *
 * This ensures that the query builder correctly:
 * - Maps camelCase foreign key fields to snake_case database columns
 * - Includes foreign key fields in WHERE clause validation
 * - Retrieves records by foreign key values in both findOne() and list()
 *
 * Related: https://github.com/happyvertical/smrt/issues/384
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foreignKey, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry';

// Test models for foreign key queries with STI
@smrt({ tableStrategy: 'sti' })
class FKQueryParent extends SmrtObject {
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

@smrt({ tableStrategy: 'sti' })
class FKQueryBaseDoc extends SmrtObject {
  title: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title) this.title = options.title;
  }
}

@smrt()
class FKQueryChildDoc extends FKQueryBaseDoc {
  @foreignKey('FKQueryParent')
  parentId?: string;

  constructor(options: any = {}) {
    super(options);
    if (options.parentId) this.parentId = options.parentId;
  }
}

describe('Foreign Key Queries in STI Models', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    // Add random component to ensure uniqueness even with same timestamp
    const random = Math.random().toString(36).substring(7);
    dbPath = join(tmpdir(), `test-fk-queries-${Date.now()}-${random}.db`);
    console.log(`[TEST SETUP] Database: ${dbPath}`);
    db = await getDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Field Registration', () => {
    it('should include foreign key fields in collection fields', async () => {
      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });

      const fields = await collection.getFields();

      expect(fields).toHaveProperty('parentId');
      expect(fields.parentId.type).toBe('foreignKey');
    });

    it('should create parent_id column in database schema', async () => {
      // Initialize the collection to ensure schema is created
      await ObjectRegistry.getCollection<typeof FKQueryChildDoc.prototype>(
        'FKQueryChildDoc',
        { db },
      );

      // Query the database to check table schema using PRAGMA (standard syntax)
      const result = await db.query(
        "PRAGMA table_info('fkquery_base_docs')",
        [],
      );

      const columns = result.rows.map((row: any) => ({
        name: row.name,
        type: row.type,
      }));

      // Debug output
      console.log('Database columns:', JSON.stringify(columns, null, 2));

      // Find the parent_id column
      const parentIdColumn = columns.find(
        (col: any) => col.name === 'parent_id',
      );

      expect(columns.length).toBeGreaterThan(0); // Table should have columns
      expect(parentIdColumn).toBeDefined();
      expect(parentIdColumn?.type).toBe('TEXT'); // Foreign keys are TEXT type
    });

    it('should validate foreign key field names', async () => {
      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });

      await expect(
        collection.findOne({ where: { invalidField: 'value' } }),
      ).rejects.toThrow(/Invalid WHERE clause field: 'invalidField'/);
    });
  });

  describe('findOne() with Foreign Key', () => {
    it('should find record by foreign key field', async () => {
      const t0 = Date.now();
      console.log(`[TIMING] t0: Test start`);

      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      console.log(`[TIMING] t${Date.now() - t0}ms: Parent initialized`);

      await parent.save();
      console.log(
        `[TIMING] t${Date.now() - t0}ms: Parent saved, id=${parent.id}`,
      );

      const child = new FKQueryChildDoc({
        parentId: parent.id,
        title: 'Test Child',
        db,
      });
      await child.initialize();
      console.log(
        `[TIMING] t${Date.now() - t0}ms: Child initialized, parentId=${child.parentId}`,
      );

      await child.save();
      console.log(
        `[TIMING] t${Date.now() - t0}ms: Child saved, id=${child.id}`,
      );

      // Debug: Check what's actually in the database immediately after save
      const rawData = await db.query(
        "SELECT id, title, parent_id, _meta_type, _meta_data FROM fkquery_base_docs WHERE _meta_type = 'FKQueryChildDoc'",
        [],
      );
      console.log(`[TIMING] t${Date.now() - t0}ms: Raw query complete`);
      console.log('Raw database rows:', JSON.stringify(rawData.rows, null, 2));

      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });
      console.log(`[TIMING] t${Date.now() - t0}ms: Collection retrieved`);

      console.log(`[DEBUG] About to query with parentId=${parent.id}`);

      const found = await collection.findOne({
        where: { parentId: parent.id },
      });
      console.log(
        `[TIMING] t${Date.now() - t0}ms: findOne complete, found=${found !== null}`,
      );

      if (!found) {
        // If not found, check if data exists with different ID
        const allChildrenRaw = await db.query(
          "SELECT id, parent_id FROM fkquery_base_docs WHERE _meta_type = 'FKQueryChildDoc'",
          [],
        );
        console.log(
          `[DEBUG] All children in DB:`,
          JSON.stringify(allChildrenRaw.rows, null, 2),
        );
        console.log(`[DEBUG] Searched for parent_id:`, parent.id);
      }

      expect(found).not.toBeNull();
      expect(found?.parentId).toBe(parent.id);
      expect(found?.title).toBe('Test Child');
    });

    it('should return null when no record matches foreign key', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });

      const found = await collection.findOne({
        where: { parentId: parent.id },
      });

      expect(found).toBeNull();
    });
  });

  describe('list() with Foreign Key', () => {
    it('should list all records with matching foreign key', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      // Create multiple children
      const child1 = new FKQueryChildDoc({
        parentId: parent.id,
        title: 'Child 1',
        db,
      });
      await child1.initialize();
      await child1.save();

      const child2 = new FKQueryChildDoc({
        parentId: parent.id,
        title: 'Child 2',
        db,
      });
      await child2.initialize();
      await child2.save();

      // Debug: Check raw database state
      const allRows = await db.query(
        "SELECT id, title, parent_id, _meta_type FROM fkquery_base_docs WHERE _meta_type = 'FKQueryChildDoc'",
        [],
      );
      console.log(
        'All FKQueryChildDoc rows:',
        JSON.stringify(allRows.rows, null, 2),
      );
      console.log('Searching for parent.id:', parent.id);

      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });

      const results = await collection.list({
        where: { parentId: parent.id },
      });

      expect(results.length).toBe(2);
      expect(results.every((r) => r.parentId === parent.id)).toBe(true);
      const titles = results.map((r) => r.title).sort();
      expect(titles).toEqual(['Child 1', 'Child 2']);
    });

    it('should return empty array when no records match foreign key', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });

      const results = await collection.list({
        where: { parentId: parent.id },
      });

      expect(results).toEqual([]);
    });

    it('should filter by foreign key among multiple parents', async () => {
      const parent1 = new FKQueryParent({ name: 'Parent 1', db });
      await parent1.initialize();
      await parent1.save();

      const parent2 = new FKQueryParent({ name: 'Parent 2', db });
      await parent2.initialize();
      await parent2.save();

      // Children for parent1
      const child1 = new FKQueryChildDoc({
        parentId: parent1.id,
        title: 'P1 Child 1',
        db,
      });
      await child1.initialize();
      await child1.save();

      const child2 = new FKQueryChildDoc({
        parentId: parent1.id,
        title: 'P1 Child 2',
        db,
      });
      await child2.initialize();
      await child2.save();

      // Children for parent2
      const child3 = new FKQueryChildDoc({
        parentId: parent2.id,
        title: 'P2 Child 1',
        db,
      });
      await child3.initialize();
      await child3.save();

      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });

      // Query for parent1's children
      const parent1Children = await collection.list({
        where: { parentId: parent1.id },
      });

      expect(parent1Children.length).toBe(2);
      expect(parent1Children.every((c) => c.parentId === parent1.id)).toBe(
        true,
      );
      expect(parent1Children.map((c) => c.title).sort()).toEqual([
        'P1 Child 1',
        'P1 Child 2',
      ]);

      // Query for parent2's children
      const parent2Children = await collection.list({
        where: { parentId: parent2.id },
      });

      expect(parent2Children.length).toBe(1);
      expect(parent2Children[0].parentId).toBe(parent2.id);
      expect(parent2Children[0].title).toBe('P2 Child 1');
    });
  });

  describe('Combined WHERE Clauses', () => {
    it('should filter by foreign key AND other fields', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      const child1 = new FKQueryChildDoc({
        parentId: parent.id,
        title: 'Draft Child',
        db,
      });
      await child1.initialize();
      await child1.save();

      const child2 = new FKQueryChildDoc({
        parentId: parent.id,
        title: 'Published Child',
        db,
      });
      await child2.initialize();
      await child2.save();

      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });

      const results = await collection.list({
        where: {
          parentId: parent.id,
          title: 'Published Child',
        },
      });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Published Child');
      expect(results[0].parentId).toBe(parent.id);
    });
  });
});
