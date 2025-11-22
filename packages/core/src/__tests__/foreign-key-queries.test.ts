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

// Additional STI child types to test type discrimination (issue #386)
@smrt()
class FKQueryAgenda extends FKQueryBaseDoc {
  @foreignKey('FKQueryParent')
  parentId?: string;

  constructor(options: any = {}) {
    super(options);
    if (options.parentId) this.parentId = options.parentId;
  }
}

@smrt()
class FKQueryMinutes extends FKQueryBaseDoc {
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
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      const child = new FKQueryChildDoc({
        parentId: parent.id,
        title: 'Test Child',
        db,
      });
      await child.initialize();
      await child.save();

      const collection = await ObjectRegistry.getCollection<
        typeof FKQueryChildDoc.prototype
      >('FKQueryChildDoc', { db });

      const found = await collection.findOne({
        where: { parentId: parent.id },
      });

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

  describe('STI Type Discrimination with Foreign Keys (issue #386)', () => {
    it('should return correct STI type when multiple types share same foreign key', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      // Create multiple STI types with the SAME foreign key value
      const agenda = new FKQueryAgenda({
        parentId: parent.id,
        title: 'Agenda',
        db,
      });
      await agenda.initialize();
      await agenda.save();

      const minutes = new FKQueryMinutes({
        parentId: parent.id,
        title: 'Minutes',
        db,
      });
      await minutes.initialize();
      await minutes.save();

      // Query each collection by foreign key - should get correct type
      const agendaCollection = await ObjectRegistry.getCollection<
        typeof FKQueryAgenda.prototype
      >('FKQueryAgenda', { db });

      const minutesCollection = await ObjectRegistry.getCollection<
        typeof FKQueryMinutes.prototype
      >('FKQueryMinutes', { db });

      const foundAgenda = await agendaCollection.findOne({
        where: { parentId: parent.id },
      });

      const foundMinutes = await minutesCollection.findOne({
        where: { parentId: parent.id },
      });

      // Each query must return the correct STI type
      expect(foundAgenda).not.toBeNull();
      expect(foundAgenda?.constructor.name).toBe('FKQueryAgenda');
      expect(foundAgenda?.title).toBe('Agenda');

      expect(foundMinutes).not.toBeNull();
      expect(foundMinutes?.constructor.name).toBe('FKQueryMinutes');
      expect(foundMinutes?.title).toBe('Minutes');
    });

    it('should return null when STI type does not exist, not wrong type', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      // Only create Agenda (no Minutes)
      const agenda = new FKQueryAgenda({
        parentId: parent.id,
        title: 'Agenda',
        db,
      });
      await agenda.initialize();
      await agenda.save();

      // Query for Minutes (doesn't exist) - should return null, NOT Agenda
      const minutesCollection = await ObjectRegistry.getCollection<
        typeof FKQueryMinutes.prototype
      >('FKQueryMinutes', { db });

      const foundMinutes = await minutesCollection.findOne({
        where: { parentId: parent.id },
      });

      // Must return null, not the wrong STI type
      expect(foundMinutes).toBeNull();
    });

    it('should filter list() by correct STI type with shared foreign key', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      // Create multiple of each type with same parent
      const agenda1 = new FKQueryAgenda({
        parentId: parent.id,
        title: 'Agenda 1',
        db,
      });
      await agenda1.initialize();
      await agenda1.save();

      const agenda2 = new FKQueryAgenda({
        parentId: parent.id,
        title: 'Agenda 2',
        db,
      });
      await agenda2.initialize();
      await agenda2.save();

      const minutes = new FKQueryMinutes({
        parentId: parent.id,
        title: 'Minutes',
        db,
      });
      await minutes.initialize();
      await minutes.save();

      // Query each type - should only get matching types
      const agendaCollection = await ObjectRegistry.getCollection<
        typeof FKQueryAgenda.prototype
      >('FKQueryAgenda', { db });

      const minutesCollection = await ObjectRegistry.getCollection<
        typeof FKQueryMinutes.prototype
      >('FKQueryMinutes', { db });

      const agendas = await agendaCollection.list({
        where: { parentId: parent.id },
      });

      const minutesList = await minutesCollection.list({
        where: { parentId: parent.id },
      });

      // Verify correct types and counts
      expect(agendas).toHaveLength(2);
      expect(agendas.every((a) => a.constructor.name === 'FKQueryAgenda')).toBe(
        true,
      );

      expect(minutesList).toHaveLength(1);
      expect(
        minutesList.every((m) => m.constructor.name === 'FKQueryMinutes'),
      ).toBe(true);
    });
  });

  describe('Collection.count() STI Filtering', () => {
    it('should count only records matching STI child type', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      // Create 3 Agendas
      for (let i = 0; i < 3; i++) {
        const agenda = new FKQueryAgenda({
          parentId: parent.id,
          title: `Agenda ${i + 1}`,
          db,
        });
        await agenda.initialize();
        await agenda.save();
      }

      // Create 2 Minutes
      for (let i = 0; i < 2; i++) {
        const minutes = new FKQueryMinutes({
          parentId: parent.id,
          title: `Minutes ${i + 1}`,
          db,
        });
        await minutes.initialize();
        await minutes.save();
      }

      // Query each collection - should only count matching types
      const agendaCollection = await ObjectRegistry.getCollection<
        typeof FKQueryAgenda.prototype
      >('FKQueryAgenda', { db });

      const minutesCollection = await ObjectRegistry.getCollection<
        typeof FKQueryMinutes.prototype
      >('FKQueryMinutes', { db });

      const agendaCount = await agendaCollection.count({
        where: { parentId: parent.id },
      });

      const minutesCount = await minutesCollection.count({
        where: { parentId: parent.id },
      });

      // Must count only the correct STI type (not all types in shared table)
      expect(agendaCount).toBe(3); // Only Agendas, not 5 total
      expect(minutesCount).toBe(2); // Only Minutes, not 5 total
    });

    it('should count all STI types when querying base collection', async () => {
      const parent = new FKQueryParent({ name: 'Test Parent', db });
      await parent.initialize();
      await parent.save();

      // Create 3 Agendas + 2 Minutes (all with title prefix "Test")
      for (let i = 0; i < 3; i++) {
        const agenda = new FKQueryAgenda({
          parentId: parent.id,
          title: `Test Agenda ${i + 1}`,
          db,
        });
        await agenda.initialize();
        await agenda.save();
      }

      for (let i = 0; i < 2; i++) {
        const minutes = new FKQueryMinutes({
          parentId: parent.id,
          title: `Test Minutes ${i + 1}`,
          db,
        });
        await minutes.initialize();
        await minutes.save();
      }

      // Query base collection - should count ALL types
      const baseCollection = await ObjectRegistry.getCollection<
        typeof FKQueryBaseDoc.prototype
      >('FKQueryBaseDoc', { db });

      // Count all records (no WHERE clause to avoid querying child-only fields)
      const totalCount = await baseCollection.count();

      // Base collection should count all child types
      expect(totalCount).toBe(5); // 3 Agendas + 2 Minutes
    });

    it('should combine _meta_type filter with custom WHERE clause', async () => {
      const parent1 = new FKQueryParent({ name: 'Parent 1', db });
      await parent1.initialize();
      await parent1.save();

      const parent2 = new FKQueryParent({ name: 'Parent 2', db });
      await parent2.initialize();
      await parent2.save();

      // Create 2 Agendas for parent1
      for (let i = 0; i < 2; i++) {
        const agenda = new FKQueryAgenda({
          parentId: parent1.id,
          title: `P1 Agenda ${i + 1}`,
          db,
        });
        await agenda.initialize();
        await agenda.save();
      }

      // Create 1 Agenda for parent2
      const agenda = new FKQueryAgenda({
        parentId: parent2.id,
        title: 'P2 Agenda',
        db,
      });
      await agenda.initialize();
      await agenda.save();

      // Create 2 Minutes for parent1
      for (let i = 0; i < 2; i++) {
        const minutes = new FKQueryMinutes({
          parentId: parent1.id,
          title: `P1 Minutes ${i + 1}`,
          db,
        });
        await minutes.initialize();
        await minutes.save();
      }

      const agendaCollection = await ObjectRegistry.getCollection<
        typeof FKQueryAgenda.prototype
      >('FKQueryAgenda', { db });

      // Count Agendas for parent1 only
      const parent1AgendaCount = await agendaCollection.count({
        where: { parentId: parent1.id },
      });

      // Should count ONLY parent1's Agendas (not parent1's Minutes)
      expect(parent1AgendaCount).toBe(2); // 2 Agendas, not 4 total docs
    });
  });
});
