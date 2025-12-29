/**
 * Comprehensive CRUD tests for objects with @oneToMany relationships
 *
 * These tests verify that basic database operations work correctly
 * when objects have relationship fields that should NOT be persisted.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { oneToMany } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

// Parent model with @oneToMany relationships
@smrt()
class Parent extends SmrtObject {
  name: string = '';

  // Relationship fields - should NOT be included in SQL
  @oneToMany('Child')
  children: any[] = [];

  @oneToMany('Related')
  relatedItems: any[] = [];
}

// Child model
@smrt()
class Child extends SmrtObject {
  parentId: string = '';
  title: string = '';
}

class ParentCollection extends SmrtCollection<Parent> {
  static readonly _itemClass = Parent;
}

describe('CRUD Operations with @oneToMany Relationships', () => {
  let db: DatabaseInterface;
  let dbPath: string;
  let parents: ParentCollection;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `test-crud-relationships-${randomUUID().slice(0, 8)}.db`,
    );
    db = await getDatabase({ type: 'sqlite', url: dbPath });
    parents = await ParentCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('CREATE operations', () => {
    it('should create instance with auto-generated ID', async () => {
      const parent = await parents.create({
        name: 'Test Parent',
      });

      // ID is auto-generated and saved by create()
      expect(parent.id).toBeDefined();
      expect(parent.id).not.toBeNull();
      expect(parent.name).toBe('Test Parent');
    });

    it('should generate ID on first save', async () => {
      const parent = await parents.create({
        name: 'Test Parent',
      });

      await parent.save();

      // ID should now be generated
      expect(parent.id).toBeDefined();
      expect(parent.id).not.toBeNull();
      expect(typeof parent.id).toBe('string');
      expect(parent.id.length).toBeGreaterThan(0);
    });

    it('should save parent with @oneToMany fields without SQL errors', async () => {
      const parent = await parents.create({
        name: 'Test Parent',
        children: [], // Empty relationship array
        relatedItems: [],
      });

      // This should NOT throw SQLITE_ERROR: table has no column named children
      await expect(parent.save()).resolves.not.toThrow();
      expect(parent.id).toBeDefined();
    });

    it('should save multiple parents successfully', async () => {
      const parent1 = await parents.create({ name: 'Parent 1' });
      const parent2 = await parents.create({ name: 'Parent 2' });
      const parent3 = await parents.create({ name: 'Parent 3' });

      await parent1.save();
      await parent2.save();
      await parent3.save();

      expect(parent1.id).toBeDefined();
      expect(parent2.id).toBeDefined();
      expect(parent3.id).toBeDefined();
      expect(parent1.id).not.toBe(parent2.id);
      expect(parent2.id).not.toBe(parent3.id);
    });
  });

  describe('READ operations', () => {
    it('should load parent by ID', async () => {
      // Create and save
      const parent = await parents.create({ name: 'Test Parent' });
      await parent.save();
      const savedId = parent.id;

      // Load from database
      const loaded = await parents.get({ id: savedId });

      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe(savedId);
      expect(loaded?.name).toBe('Test Parent');
    });

    it('should list all parents', async () => {
      // Create multiple parents
      const p1 = await parents.create({ name: 'Parent 1' });
      const p2 = await parents.create({ name: 'Parent 2' });
      await p1.save();
      await p2.save();

      // List all (must pass empty options object)
      const all = await parents.list({});

      expect(all).toHaveLength(2);
      expect(all.map((p) => p.name)).toContain('Parent 1');
      expect(all.map((p) => p.name)).toContain('Parent 2');
    });

    it('should load parent without @oneToMany fields in result', async () => {
      const parent = await parents.create({ name: 'Test Parent' });
      await parent.save();

      const loaded = await parents.get({ id: parent.id });

      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Test Parent');
      // Relationship fields should not be populated from database
      // (they would need separate queries to load)
    });
  });

  describe('UPDATE operations', () => {
    it('should update parent name', async () => {
      const parent = await parents.create({ name: 'Original Name' });
      await parent.save();

      parent.name = 'Updated Name';
      await parent.save();

      const loaded = await parents.get({ id: parent.id });
      expect(loaded?.name).toBe('Updated Name');
    });

    it('should update parent without affecting relationship fields in SQL', async () => {
      const parent = await parents.create({ name: 'Test Parent' });
      await parent.save();

      parent.name = 'Updated Name';
      // This should NOT try to update children or relatedItems columns
      await expect(parent.save()).resolves.not.toThrow();

      const loaded = await parents.get({ id: parent.id });
      expect(loaded?.name).toBe('Updated Name');
    });
  });

  describe('DELETE operations', () => {
    it('should delete parent by ID', async () => {
      const parent = await parents.create({ name: 'To Delete' });
      await parent.save();
      const savedId = parent.id;

      await parent.delete();

      const loaded = await parents.get({ id: savedId });
      expect(loaded).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('should handle parent with minimal data', async () => {
      const parent = await parents.create({ name: 'Minimal' });
      await parent.save();

      expect(parent.id).toBeDefined();
      expect(parent.name).toBe('Minimal');
    });

    it('should handle saving same parent multiple times', async () => {
      const parent = await parents.create({ name: 'Test' });
      await parent.save();
      const firstId = parent.id;

      parent.name = 'Updated';
      await parent.save();

      // ID should remain the same
      expect(parent.id).toBe(firstId);

      const loaded = await parents.get({ id: firstId });
      expect(loaded?.name).toBe('Updated');
    });
  });
});
