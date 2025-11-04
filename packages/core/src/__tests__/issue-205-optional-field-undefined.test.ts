/**
 * Test for Issue #205: Optional fields with ? syntax still pass undefined to database
 *
 * DuckDB throws "Cannot create values of type ANY" when undefined values are passed.
 * Optional fields should either:
 * - Be filtered out of the INSERT/UPDATE query
 * - Be converted to NULL (for databases that support it)
 * - Be converted to appropriate defaults (empty strings for TEXT fields)
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { text } from '../fields';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

// Define test classes at module level so AST scanner can pick them up
@smrt({ tableName: 'councils_ts_optional' })
class CouncilWithTSOptional extends SmrtObject {
  name: string = '';
  url?: string; // Optional field - TypeScript syntax
  location?: string; // Optional field - TypeScript syntax
}

class CouncilTSOptionalCollection extends SmrtCollection<CouncilWithTSOptional> {
  static readonly _itemClass = CouncilWithTSOptional;
}

@smrt({ tableName: 'councils_nullable' })
class CouncilWithNullable extends SmrtObject {
  name = text({ required: true });
  url = text({ nullable: true }); // Optional via field helper
  location = text({ nullable: true });
}

class CouncilNullableCollection extends SmrtCollection<CouncilWithNullable> {
  static readonly _itemClass = CouncilWithNullable;
}

@smrt({ tableName: 'councils_workaround' })
class CouncilWithWorkaround extends SmrtObject {
  name: string = '';
  url?: string;
  location?: string;
}

class CouncilWorkaroundCollection extends SmrtCollection<CouncilWithWorkaround> {
  static readonly _itemClass = CouncilWithWorkaround;
}

@smrt({ tableName: 'councils_update' })
class CouncilForUpdate extends SmrtObject {
  name: string = '';
  url?: string;
  location?: string;
}

class CouncilUpdateCollection extends SmrtCollection<CouncilForUpdate> {
  static readonly _itemClass = CouncilForUpdate;
}

describe('Issue #205: Optional fields with undefined values', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    // Create unique in-memory database for each test
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  describe('TypeScript optional fields (field?: type)', () => {
    it('should allow creating objects without providing optional fields', async () => {
      const collection = await CouncilTSOptionalCollection.create({
        db,
      });

      // Create council without optional fields
      const council = await collection.create({
        name: 'Test Council',
        // url and location not provided
      });

      await council.save();

      // Should succeed without throwing "Cannot create values of type ANY"
      expect(council.id).toBeDefined();
      expect(council.name).toBe('Test Council');
    });

    it('should store undefined optional fields as empty strings for TEXT columns', async () => {
      const collection = await CouncilTSOptionalCollection.create({
        db,
      });

      const council = await collection.create({
        name: 'Test Council',
      });

      await council.save();

      // Reload from database
      const loaded = await collection.get(council.id!);
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Test Council');
      // DuckDB should have stored empty string, not undefined or NULL
      expect(loaded?.url).toBe('');
      expect(loaded?.location).toBe('');
    });

    it('should handle explicitly set optional fields', async () => {
      const collection = await CouncilTSOptionalCollection.create({
        db,
      });

      const council = await collection.create({
        name: 'Test Council',
        url: 'https://example.com',
        location: 'Main Street',
      });

      await council.save();

      const loaded = await collection.get(council.id!);
      expect(loaded?.url).toBe('https://example.com');
      expect(loaded?.location).toBe('Main Street');
    });

    it('should handle mix of defined and undefined optional fields', async () => {
      const collection = await CouncilTSOptionalCollection.create({
        db,
      });

      const council = await collection.create({
        name: 'Test Council',
        url: 'https://example.com',
        // location not provided (undefined)
      });

      await council.save();

      const loaded = await collection.get(council.id!);
      expect(loaded?.url).toBe('https://example.com');
      expect(loaded?.location).toBe('');
    });
  });

  describe('Field helper with nullable option', () => {
    it('should allow creating objects without providing nullable fields', async () => {
      const collection = await CouncilNullableCollection.create({
        db,
      });

      const council = await collection.create({
        name: 'Test Council',
        // url and location not provided
      });

      await council.save();

      expect(council.id).toBeDefined();
      expect(council.name).toBe('Test Council');
    });

    it('should store undefined nullable fields as empty strings', async () => {
      const collection = await CouncilNullableCollection.create({
        db,
      });

      const council = await collection.create({
        name: 'Test Council',
      });

      await council.save();

      const loaded = await collection.get(council.id!);
      expect(loaded).toBeDefined();
      expect(loaded?.url).toBe('');
      expect(loaded?.location).toBe('');
    });
  });

  describe('Regression: workaround should still work', () => {
    it('should work when explicitly passing empty strings', async () => {
      const collection = await CouncilWorkaroundCollection.create({
        db,
      });

      // Current workaround from issue description
      const council = await collection.create({
        name: 'Test Council',
        url: '', // Explicit empty string
        location: '', // Explicit empty string
      });

      await council.save();

      const loaded = await collection.get(council.id!);
      expect(loaded?.url).toBe('');
      expect(loaded?.location).toBe('');
    });
  });

  describe('Update operations with undefined fields', () => {
    it('should handle updates that omit optional fields', async () => {
      const collection = await CouncilUpdateCollection.create({
        db,
      });

      // Create with all fields
      const council = await collection.create({
        name: 'Test Council',
        url: 'https://example.com',
        location: 'Main Street',
      });

      await council.save();

      // Load and update without touching optional fields
      const loaded = await collection.get(council.id!);
      loaded!.name = 'Updated Council';
      // Don't touch url or location
      await loaded?.save();

      // Reload and verify optional fields preserved
      const reloaded = await collection.get(council.id!);
      expect(reloaded?.name).toBe('Updated Council');
      expect(reloaded?.url).toBe('https://example.com');
      expect(reloaded?.location).toBe('Main Street');
    });
  });
});
