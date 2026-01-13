/**
 * Multi-Adapter Parity Tests for STI (Single Table Inheritance)
 *
 * This comprehensive test suite ensures consistent behavior across all database adapters
 * (SQLite, JSON/DuckDB) when working with STI hierarchies, UPSERT operations, and default values.
 *
 * Test Coverage:
 * 1. Basic CRUD operations with default field values
 * 2. STI inheritance and polymorphic queries
 * 3. Type preservation across save/load cycles
 * 4. Query operations with filtering
 * 5. UPSERT conflict resolution
 *
 * Test Organization:
 * - Reusable test suites that run against all configured adapters
 * - Centralized test fixtures for consistency
 * - Easy to extend with new adapters or test scenarios
 *
 * Related Issues:
 * - #396: JSON adapter UPSERT with status field (reproduced in STI tests)
 *
 * @see Issue396Event, Issue396Meeting - Test classes with default status field
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

// ============================================================================
// Test Classes (STI Hierarchy)
// ============================================================================

@smrt({ tableStrategy: 'sti' })
class Issue396Event extends SmrtObject {
  title: string = '';
  date: Date = new Date();
  location: string = '';
  status: string = 'scheduled'; // Default value - this is the field from #396
}

@smrt()
class Issue396Meeting extends Issue396Event {
  type: string = 'Regular';
  agendaUrl: string = '';
  minutesUrl: string = '';
  councilId: string = '';
}

class Issue396EventCollection extends SmrtCollection<Issue396Event> {
  static readonly _itemClass = Issue396Event;
}

// ============================================================================
// Test Fixtures
// ============================================================================

// Issue #713: STI discriminators now use qualified names
const fixtures = {
  event: {
    scheduled: {
      _meta_type: '@happyvertical/smrt-core:Issue396Event',
      title: 'Community Event',
      date: new Date('2025-01-15'),
      location: 'Community Center',
      status: 'scheduled',
    },
    completed: {
      _meta_type: '@happyvertical/smrt-core:Issue396Event',
      title: 'Past Event',
      date: new Date('2024-12-01'),
      location: 'Town Hall',
      status: 'completed',
    },
  },
  meeting: {
    regular: {
      _meta_type: '@happyvertical/smrt-core:Issue396Meeting',
      title: 'Regular Council Meeting',
      date: new Date('2025-11-25'),
      location: 'Council Chambers',
      type: 'Regular',
      agendaUrl: 'https://example.com/agenda',
      councilId: 'test-council-id',
    },
    special: {
      _meta_type: '@happyvertical/smrt-core:Issue396Meeting',
      title: 'Special Council Meeting',
      date: new Date('2025-12-01'),
      location: 'Council Chambers',
      type: 'Special',
      status: 'completed',
      agendaUrl: 'https://example.com/special-agenda',
      councilId: 'test-council-id',
    },
    // Exact scenario from #396 - Meeting without explicit status
    withoutStatus: {
      _meta_type: '@happyvertical/smrt-core:Issue396Meeting',
      title: 'Regular Council Meeting – November 25, 2025',
      date: new Date('2025-11-25'),
      location: 'Council Chambers',
      type: 'Regular',
      agendaUrl:
        'https://townofbentley.ca/download/regular-council-meeting-november-25-2025-agenda/',
      councilId: '147c31cf-86af-4435-b112-90ba5ac9f23d',
      // status is NOT provided - should use default 'scheduled'
    },
  },
};

// ============================================================================
// Database Adapter Configurations
// ============================================================================

const adapterConfigs = [
  {
    name: 'SQLite (in-memory)',
    getConfig: () => ({ type: 'sqlite' as const, url: ':memory:' }),
    cleanup: async () => {
      /* no cleanup needed */
    },
  },
  {
    name: 'SQLite (file)',
    getConfig: () => ({
      type: 'sqlite' as const,
      url: join(
        tmpdir(),
        `test-issue-396-sqlite-${randomUUID().slice(0, 8)}.db`,
      ),
    }),
    cleanup: async (config: any) => {
      if (config?.url && config.url !== ':memory:' && existsSync(config.url)) {
        unlinkSync(config.url);
      }
    },
  },
  {
    name: 'JSON (DuckDB)',
    getConfig: () => ({
      type: 'json' as const,
      url: join(tmpdir(), `test-issue-396-json-${randomUUID().slice(0, 8)}`),
    }),
    cleanup: async (config: any) => {
      if (config?.url && existsSync(config.url)) {
        try {
          rmSync(config.url, { recursive: true, force: true });
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    },
  },
  {
    name: 'JSON (immediate writes)',
    getConfig: () => ({
      type: 'json' as const,
      url: join(
        tmpdir(),
        `test-issue-396-json-immediate-${randomUUID().slice(0, 8)}`,
      ),
      writeStrategy: 'immediate' as const,
    }),
    cleanup: async (config: any) => {
      if (config?.url && existsSync(config.url)) {
        try {
          rmSync(config.url, { recursive: true, force: true });
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    },
  },
];

// ============================================================================
// Shared Test Suites
// ============================================================================

/**
 * Test suite for basic CRUD operations with default values
 */
function runBasicOperationsTests(
  getContext: () => { events: Issue396EventCollection },
) {
  describe('Basic Operations', () => {
    it('should create Event with default status', async () => {
      const { events } = getContext();
      // create() saves internally, no need for explicit save()
      const event = await events.create(fixtures.event.scheduled);

      expect(event.id).toBeDefined();
      expect(event.status).toBe('scheduled');
    });

    it('should create Event with explicit status', async () => {
      const { events } = getContext();
      // create() saves internally, no need for explicit save()
      const event = await events.create(fixtures.event.completed);

      expect(event.status).toBe('completed');
    });

    it('should update Event via UPSERT', async () => {
      const { events } = getContext();
      // create() saves internally
      const event = await events.create(fixtures.event.scheduled);
      const eventId = event.id;

      // Update and save again (testing UPSERT behavior)
      event.status = 'completed';
      event.title = 'Updated Event';
      await expect(event.save()).resolves.not.toThrow();

      // Verify
      const loaded = await events.get({ id: eventId });
      expect(loaded?.status).toBe('completed');
      expect(loaded?.title).toBe('Updated Event');
    });

    it('should handle multiple saves', async () => {
      const { events } = getContext();
      // create() saves internally
      const event = await events.create(fixtures.event.scheduled);

      // Intentionally testing multiple saves don't error
      event.title = 'Update 1';
      await event.save();
      event.title = 'Update 2';
      await event.save();

      expect(event.title).toBe('Update 2');
    });
  });
}

/**
 * Test suite for STI (Single Table Inheritance) operations
 */
function runSTITests(getContext: () => { events: Issue396EventCollection }) {
  describe('STI Operations', () => {
    it('should create Meeting with inherited status field', async () => {
      const { events } = getContext();
      // create() saves internally
      const meeting = await events.create(fixtures.meeting.regular);

      expect(meeting.id).toBeDefined();
      expect(meeting.status).toBe('scheduled'); // Default from Event
      expect((meeting as any).type).toBe('Regular');
    });

    it('should create Meeting without explicit status (issue #396 reproduction)', async () => {
      const { events } = getContext();
      // This is the EXACT scenario that fails in production
      // create() saves internally - tests that save with default status works
      const meeting = await events.create(fixtures.meeting.withoutStatus);

      expect(meeting.status).toBe('scheduled'); // Should use default
      expect((meeting as any).agendaUrl).toContain('townofbentley.ca');
    });

    it('should create Meeting with explicit status', async () => {
      const { events } = getContext();
      // create() saves internally
      const meeting = await events.create(fixtures.meeting.special);

      expect(meeting.status).toBe('completed');
      expect((meeting as any).type).toBe('Special');
    });

    it('should load Meeting with all inherited fields', async () => {
      const { events } = getContext();
      // create() saves internally
      const meeting = await events.create(fixtures.meeting.regular);

      const loaded = await events.get({ id: meeting.id });
      expect(loaded).toBeDefined();
      expect(loaded?.title).toBe('Regular Council Meeting');
      expect(loaded?.status).toBe('scheduled');
      expect((loaded as any).type).toBe('Regular');
      expect((loaded as any).agendaUrl).toBe('https://example.com/agenda');
    });

    it('should handle polymorphic queries', async () => {
      const { events } = getContext();

      // create() saves internally - all three are already saved
      const event = await events.create(fixtures.event.scheduled);
      const meeting1 = await events.create(fixtures.meeting.regular);
      const meeting2 = await events.create(fixtures.meeting.special);

      // Query all
      const all = await events.list({});
      expect(all.length).toBeGreaterThanOrEqual(3);

      // Query by type - Issue #713: STI discriminators now use qualified names
      const meetings = await events.list({
        where: { _meta_type: '@happyvertical/smrt-core:Issue396Meeting' },
      });
      expect(meetings.length).toBeGreaterThanOrEqual(2);
    });
  });
}

/**
 * Test suite for type preservation
 */
function runTypePreservationTests(
  getContext: () => { events: Issue396EventCollection },
) {
  describe('Type Preservation', () => {
    it('should preserve string type for status field', async () => {
      const { events } = getContext();
      // create() saves internally
      const meeting = await events.create({
        ...fixtures.meeting.regular,
        status: 'scheduled',
      });

      const loaded = await events.get({ id: meeting.id });

      expect(loaded).toBeDefined();
      expect(typeof loaded?.status).toBe('string');
      expect(loaded?.status).toBe('scheduled');
    });

    it('should preserve Date type for date field', async () => {
      const { events } = getContext();
      const testDate = new Date('2025-11-25T19:00:00Z');
      // create() saves internally
      const meeting = await events.create({
        ...fixtures.meeting.regular,
        date: testDate,
      });

      const loaded = await events.get({ id: meeting.id });

      expect(loaded).toBeDefined();
      expect(loaded?.date).toBeInstanceOf(Date);
      expect(loaded?.date.toISOString()).toBe(testDate.toISOString());
    });

    it('should preserve status through update cycle', async () => {
      const { events } = getContext();
      // create() saves internally
      const meeting = await events.create({
        ...fixtures.meeting.regular,
        status: 'scheduled',
      });

      // Update and save (testing UPSERT preserves types)
      meeting.status = 'completed';
      await meeting.save();

      const loaded = await events.get({ id: meeting.id });
      expect(typeof loaded?.status).toBe('string');
      expect(loaded?.status).toBe('completed');
    });
  });
}

/**
 * Test suite for query operations
 */
function runQueryTests(getContext: () => { events: Issue396EventCollection }) {
  describe('Query Operations', () => {
    it('should query by status field', async () => {
      const { events } = getContext();

      // create() saves internally - both records already saved
      await Promise.all([
        events.create({ ...fixtures.meeting.regular, status: 'scheduled' }),
        events.create({ ...fixtures.meeting.special, status: 'completed' }),
      ]);

      const scheduled = await events.list({ where: { status: 'scheduled' } });
      const completed = await events.list({ where: { status: 'completed' } });

      expect(scheduled.length).toBeGreaterThanOrEqual(1);
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(scheduled.every((e) => e.status === 'scheduled')).toBe(true);
      expect(completed.every((e) => e.status === 'completed')).toBe(true);
    });

    it('should query with multiple conditions', async () => {
      const { events } = getContext();

      // create() saves internally
      const meeting = await events.create({
        ...fixtures.meeting.regular,
        status: 'scheduled',
        location: 'Council Chambers',
      });

      // Issue #713: STI discriminators now use qualified names
      const results = await events.list({
        where: {
          status: 'scheduled',
          location: 'Council Chambers',
          _meta_type: '@happyvertical/smrt-core:Issue396Meeting',
        },
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].status).toBe('scheduled');
      expect(results[0].location).toBe('Council Chambers');
    });

    it('should handle list queries without errors', async () => {
      const { events } = getContext();

      // create() saves internally - all records already saved
      await Promise.all([
        events.create(fixtures.event.scheduled),
        events.create(fixtures.event.completed),
        events.create(fixtures.meeting.regular),
      ]);

      // Various query patterns should work
      await expect(events.list({})).resolves.toBeDefined();
      await expect(events.list({ limit: 10 })).resolves.toBeDefined();
      await expect(
        events.list({ orderBy: 'created_at DESC' }),
      ).resolves.toBeDefined();
    });
  });
}

/**
 * Test suite for UPSERT conflict resolution
 */
function runUpsertTests(getContext: () => { events: Issue396EventCollection }) {
  describe('UPSERT Operations', () => {
    it('should UPSERT on same object instance', async () => {
      const { events } = getContext();
      // create() saves internally
      const meeting = await events.create({
        ...fixtures.meeting.regular,
        slug: 'council-meeting-nov-2025',
      });

      const originalId = meeting.id;

      // Update same object and test UPSERT behavior
      (meeting as any).agendaUrl = 'https://example.com/updated-agenda';
      meeting.title = 'Updated Meeting Title';
      await meeting.save();

      // Should keep same ID
      expect(meeting.id).toBe(originalId);

      // Verify only one record exists
      const all = await events.list({
        where: { slug: 'council-meeting-nov-2025' },
      });
      expect(all.length).toBe(1);
      expect(all[0].id).toBe(originalId);
      expect(all[0].title).toBe('Updated Meeting Title');
    });

    it('should handle conflict on unique constraint', async () => {
      const { events } = getContext();
      // create() saves internally
      const meeting1 = await events.create({
        ...fixtures.meeting.regular,
        slug: 'unique-meeting',
        context: '',
      });

      // Update the same meeting and test UPSERT behavior
      meeting1.title = 'Updated Title';
      await expect(meeting1.save()).resolves.not.toThrow();

      // Should still be one record
      const all = await events.list({ where: { slug: 'unique-meeting' } });
      expect(all.length).toBe(1);
    });
  });
}

// ============================================================================
// Issue #442: _meta_type should be set on object creation
// ============================================================================

function runMetaTypeOnCreationTests(
  getContext: () => { events: Issue396EventCollection },
) {
  describe('Issue #442: _meta_type on creation', () => {
    it('should have _meta_type set immediately after create() for base class', async () => {
      const { events } = getContext();

      // Create a base class instance
      const event = await events.create({
        title: 'Test Event',
        location: 'Test Location',
      });

      // _meta_type should be set immediately, not undefined
      // Issue #713: STI discriminators now use qualified names
      expect((event as any)._meta_type).toBe(
        '@happyvertical/smrt-core:Issue396Event',
      );
      expect(event.constructor.name).toBe('Issue396Event');
    });

    it('should have _meta_type set immediately after create() for child class', async () => {
      const { events } = getContext();

      // Create a child class instance with explicit _meta_type
      // Issue #713: STI discriminators now use qualified names
      const meeting = await events.create({
        _meta_type: '@happyvertical/smrt-core:Issue396Meeting',
        title: 'Test Meeting',
        location: 'Conference Room',
        type: 'Special',
      });

      // _meta_type should be set immediately
      expect((meeting as any)._meta_type).toBe(
        '@happyvertical/smrt-core:Issue396Meeting',
      );
      expect(meeting.constructor.name).toBe('Issue396Meeting');
    });

    it('should preserve _meta_type through save/load cycle', async () => {
      const { events } = getContext();

      // Create and verify _meta_type is set
      // Issue #713: STI discriminators now use qualified names
      const meeting = await events.create({
        _meta_type: '@happyvertical/smrt-core:Issue396Meeting',
        title: 'Persistence Test Meeting',
        location: 'Main Hall',
        slug: 'persistence-test-meeting',
      });

      expect((meeting as any)._meta_type).toBe(
        '@happyvertical/smrt-core:Issue396Meeting',
      );

      // Reload from database
      const reloaded = await events.get({ slug: 'persistence-test-meeting' });
      expect(reloaded).not.toBeNull();
      expect((reloaded as any)._meta_type).toBe(
        '@happyvertical/smrt-core:Issue396Meeting',
      );
    });

    it('should allow filtering by _meta_type in arrays', async () => {
      const { events } = getContext();

      // Create mixed types
      const event1 = await events.create({
        title: 'Event 1',
        location: 'Location 1',
      });

      // Issue #713: STI discriminators now use qualified names
      const meeting1 = await events.create({
        _meta_type: '@happyvertical/smrt-core:Issue396Meeting',
        title: 'Meeting 1',
        location: 'Location 2',
      });

      const event2 = await events.create({
        title: 'Event 2',
        location: 'Location 3',
      });

      // All should have _meta_type set
      // Issue #713: STI discriminators now use qualified names
      const items = [event1, meeting1, event2];
      const meetings = items.filter(
        (i) =>
          (i as any)._meta_type === '@happyvertical/smrt-core:Issue396Meeting',
      );
      const baseEvents = items.filter(
        (i) =>
          (i as any)._meta_type === '@happyvertical/smrt-core:Issue396Event',
      );

      expect(meetings.length).toBe(1);
      expect(baseEvents.length).toBe(2);
    });
  });
}

// ============================================================================
// Run Test Suites Against All Adapters
// ============================================================================

describe('STI Adapter Parity', () => {
  adapterConfigs.forEach((adapterConfig) => {
    describe(adapterConfig.name, () => {
      let db: DatabaseInterface;
      let dbConfig: any;
      let events: Issue396EventCollection;

      beforeEach(async () => {
        dbConfig = adapterConfig.getConfig();
        // Use getTestDatabase to initialize schemas for test classes
        db = await getTestDatabase({
          type: dbConfig.type,
          url: dbConfig.url,
        });
        events = await Issue396EventCollection.create({ db });
      });

      afterEach(async () => {
        if (db && typeof db.close === 'function') {
          try {
            await db.close();
          } catch {
            // Ignore close errors
          }
        }
        // Small delay to allow DuckDB to release file locks before cleanup
        await new Promise((resolve) => setTimeout(resolve, 50));
        await adapterConfig.cleanup(dbConfig);
      });

      const getContext = () => ({ events });

      // Run all test suites
      runBasicOperationsTests(getContext);
      runSTITests(getContext);
      runTypePreservationTests(getContext);
      runQueryTests(getContext);
      runUpsertTests(getContext);
      runMetaTypeOnCreationTests(getContext);
    });
  });
});
