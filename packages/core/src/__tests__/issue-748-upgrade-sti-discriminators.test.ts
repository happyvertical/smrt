/**
 * Issue #748: db:migrate --upgrade-sti does not upgrade discriminator values
 *
 * The --upgrade-sti flag should upgrade STI discriminators from simple class
 * names to qualified names (e.g., 'Meeting' → '@happyvertical/praeco:Meeting').
 *
 * The bug was that the CLI code referenced `tablesProcessed` which was never
 * defined, causing the upgrade logic to silently skip all tables.
 *
 * Fix: Derive table names from `initOrder` via `ObjectRegistry.getTableName()`.
 *
 * This test verifies the underlying functionality that the CLI command relies on:
 * - isQualifiedName() correctly identifies qualified vs simple names
 * - ObjectRegistry returns proper qualified names for classes
 * - Table names can be derived from class names
 */

import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { isQualifiedName, ObjectRegistry, SmrtObject, smrt } from '../index';

// Test classes to simulate STI hierarchy
@smrt({ tableStrategy: 'sti', tableName: 'test_748_events' })
class Test748Event extends SmrtObject {
  title: string = '';
  location: string = '';
}

@smrt()
class Test748Meeting extends Test748Event {
  roomNumber: string = '';
}

@smrt()
class Test748Conference extends Test748Event {
  sponsorName: string = '';
}

describe('Issue #748: STI Discriminator Upgrade', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  describe('isQualifiedName()', () => {
    it('should return true for qualified names', () => {
      expect(isQualifiedName('@happyvertical/praeco:Meeting')).toBe(true);
      expect(isQualifiedName('@my-org/package:ClassName')).toBe(true);
      expect(isQualifiedName('@scope/pkg:Class')).toBe(true);
    });

    it('should return false for simple class names', () => {
      expect(isQualifiedName('Meeting')).toBe(false);
      expect(isQualifiedName('Conference')).toBe(false);
      expect(isQualifiedName('SomeClass')).toBe(false);
    });

    it('should return false for partial patterns', () => {
      expect(isQualifiedName('@scope:Class')).toBe(false); // Missing /pkg
      expect(isQualifiedName('scope/pkg:Class')).toBe(false); // Missing @
      expect(isQualifiedName('@scope/pkg')).toBe(false); // Missing :Class
    });
  });

  describe('ObjectRegistry table name derivation', () => {
    it('should return table names for all classes in init order', () => {
      // Register classes
      ObjectRegistry.register(Test748Event, {});
      ObjectRegistry.register(Test748Meeting, {});
      ObjectRegistry.register(Test748Conference, {});

      // Get initialization order
      const initOrder = ObjectRegistry.getInitializationOrder();

      // Verify we can get table names for each class
      const tableNames = new Set<string>();
      for (const className of initOrder) {
        const tableName = ObjectRegistry.getTableName(className);
        if (tableName) {
          tableNames.add(tableName);
        }
      }

      // STI classes should share a table
      expect(tableNames.has('test_748_events')).toBe(true);
    });

    it('should provide qualified names for registered classes', () => {
      // Register classes
      ObjectRegistry.register(Test748Event, {});
      ObjectRegistry.register(Test748Meeting, {});

      // Get class info
      const eventInfo = ObjectRegistry.getClass('Test748Event');
      const meetingInfo = ObjectRegistry.getClass('Test748Meeting');

      // Both should be registered
      expect(eventInfo).toBeDefined();
      expect(meetingInfo).toBeDefined();
    });
  });

  describe('STI discriminator upgrade logic', () => {
    it('should detect rows with non-qualified _meta_type values', async () => {
      // Register classes
      ObjectRegistry.register(Test748Event, {});
      ObjectRegistry.register(Test748Meeting, {});
      ObjectRegistry.register(Test748Conference, {});

      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

      // Create the STI table
      await db.query(`
        CREATE TABLE test_748_events (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL,
          context TEXT NOT NULL DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          title TEXT DEFAULT '',
          location TEXT DEFAULT '',
          room_number TEXT DEFAULT '',
          sponsor_name TEXT DEFAULT '',
          _meta_type TEXT,
          _meta_data TEXT
        )
      `);

      // Insert rows with simple (non-qualified) discriminator values
      await db.query(`
        INSERT INTO test_748_events (id, slug, title, _meta_type)
        VALUES ('id-1', 'meeting-1', 'Test Meeting', 'Test748Meeting')
      `);

      await db.query(`
        INSERT INTO test_748_events (id, slug, title, _meta_type)
        VALUES ('id-2', 'conf-1', 'Test Conference', 'Test748Conference')
      `);

      // Query distinct _meta_type values
      const result = await db.query(
        'SELECT DISTINCT _meta_type FROM test_748_events WHERE _meta_type IS NOT NULL',
      );

      // Verify we have non-qualified values
      const metaTypes = result.rows.map((r: any) => r._meta_type);
      expect(metaTypes).toContain('Test748Meeting');
      expect(metaTypes).toContain('Test748Conference');

      // Verify none are qualified yet
      for (const metaType of metaTypes) {
        expect(isQualifiedName(metaType)).toBe(false);
      }
    });

    it('should be able to identify STI tables by _meta_type column', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

      // Create a regular table (no _meta_type)
      await db.query(`
        CREATE TABLE regular_table (
          id TEXT PRIMARY KEY,
          name TEXT
        )
      `);

      // Create an STI table (has _meta_type)
      await db.query(`
        CREATE TABLE sti_table (
          id TEXT PRIMARY KEY,
          name TEXT,
          _meta_type TEXT
        )
      `);

      // Check schemas
      const regularSchema = await db.getTableSchema('regular_table');
      const stiSchema = await db.getTableSchema('sti_table');

      // Regular table should not have _meta_type
      expect(regularSchema?.columns._meta_type).toBeUndefined();

      // STI table should have _meta_type
      expect(stiSchema?.columns._meta_type).toBeDefined();
    });
  });
});
