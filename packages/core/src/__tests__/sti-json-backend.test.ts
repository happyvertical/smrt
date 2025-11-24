/**
 * Integration tests for STI with JSON database backend
 *
 * Verifies that the JSON database backend (DuckDB) works correctly with:
 * - Collection.create() and UPSERT operations
 * - Single Table Inheritance (STI) with polymorphic queries
 * - JSON array fields in STI sibling classes
 * - Bulk operations and data persistence
 *
 * These tests ensure that undefined JSON fields in STI sibling classes
 * are properly handled with default values to prevent DuckDB JSON casting errors.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject, smrt, text } from '../index';

// Test classes for non-STI scenario (Issue391 prefix to avoid collisions)
@smrt()
class Issue391Event extends SmrtObject {
  title: string = '';
  date: Date = new Date();
  location: string = '';
  description: string = '';
}

// Test classes for STI scenario
@smrt({ tableStrategy: 'sti' })
class Issue391BaseEvent extends SmrtObject {
  title: string = '';
  date: Date = new Date();
  location: string = '';
}

@smrt()
class Issue391Meeting extends Issue391BaseEvent {
  roomNumber: string = '';
  attendees: string[] = [];
}

@smrt()
class Issue391Conference extends Issue391BaseEvent {
  sponsorName: string = '';
  ticketPrice: number = 0.0;
}

// Collections
class Issue391EventCollection extends SmrtCollection<Issue391Event> {
  static readonly _itemClass = Issue391Event;
}

class Issue391BaseEventCollection extends SmrtCollection<Issue391BaseEvent> {
  static readonly _itemClass = Issue391BaseEvent;
}

describe('STI with JSON Backend', () => {
  let tempDir: string;
  let jsonDbPath: string;

  beforeEach(() => {
    // Create a temporary directory for JSON database files
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'smrt-test-json-'));
    jsonDbPath = tempDir;
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Basic JSON Backend Operations', () => {
    it('should create a collection with JSON backend', async () => {
      const collection = await Issue391EventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      expect(collection).toBeDefined();
      expect(collection._itemClass).toBe(Issue391Event);
    });

    it('should create and save a single record with JSON backend', async () => {
      const collection = await Issue391EventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Create a new event
      const event = await collection.create({
        title: 'Test Event',
        date: new Date('2024-01-15'),
        location: 'Test Location',
        description: 'Test Description',
      });

      expect(event.id).toBeDefined();
      expect(event.title).toBe('Test Event');
      expect(event.location).toBe('Test Location');

      // Verify it was saved to the database
      const retrieved = await collection.get({ id: event.id });
      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('Test Event');
    });

    it('should handle multiple creates with JSON backend', async () => {
      const collection = await Issue391EventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Create multiple events
      const event1 = await collection.create({
        title: 'Event 1',
        date: new Date('2024-01-15'),
        location: 'Location 1',
        description: 'Description 1',
      });

      const event2 = await collection.create({
        title: 'Event 2',
        date: new Date('2024-01-16'),
        location: 'Location 2',
        description: 'Description 2',
      });

      const event3 = await collection.create({
        title: 'Event 3',
        date: new Date('2024-01-17'),
        location: 'Location 3',
        description: 'Description 3',
      });

      // Verify all events were created
      expect(event1.id).toBeDefined();
      expect(event2.id).toBeDefined();
      expect(event3.id).toBeDefined();

      // Verify we can list all events
      const events = await collection.list({});
      expect(events.length).toBe(3);
      expect(events.map((e) => e.title)).toEqual(
        expect.arrayContaining(['Event 1', 'Event 2', 'Event 3']),
      );
    });
  });

  describe('UPSERT Operations with JSON Backend', () => {
    it('should update an existing record (UPSERT)', async () => {
      const collection = await Issue391EventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Create initial event
      const event = await collection.create({
        title: 'Original Title',
        date: new Date('2024-01-15'),
        location: 'Original Location',
        description: 'Original Description',
      });

      const originalId = event.id;

      // Update the event
      event.title = 'Updated Title';
      event.location = 'Updated Location';
      await event.save();

      // Verify the update
      const retrieved = await collection.get({ id: originalId });
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(originalId);
      expect(retrieved?.title).toBe('Updated Title');
      expect(retrieved?.location).toBe('Updated Location');
      expect(retrieved?.description).toBe('Original Description'); // Unchanged
    });

    it('should handle UPSERT with slug/context conflicts', async () => {
      const collection = await Issue391EventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Create event with explicit slug
      const event1 = await collection.create({
        slug: 'test-event',
        context: '/events',
        title: 'First Event',
        date: new Date('2024-01-15'),
        location: 'Location 1',
        description: 'First Description',
      });

      // Update the same slug/context (should UPSERT, not create new)
      event1.title = 'Updated Event';
      await event1.save();

      // Verify only one record exists
      const events = await collection.list({});
      expect(events.length).toBe(1);
      expect(events[0].title).toBe('Updated Event');
    });

    it('should handle bulk updates with JSON backend', async () => {
      const collection = await Issue391EventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Create multiple events
      const events = await Promise.all([
        collection.create({
          title: 'Event 1',
          date: new Date('2024-01-15'),
          location: 'Location 1',
          description: 'Description 1',
        }),
        collection.create({
          title: 'Event 2',
          date: new Date('2024-01-16'),
          location: 'Location 2',
          description: 'Description 2',
        }),
        collection.create({
          title: 'Event 3',
          date: new Date('2024-01-17'),
          location: 'Location 3',
          description: 'Description 3',
        }),
      ]);

      // Update all events
      for (const event of events) {
        event.description = 'Updated Description';
        await event.save();
      }

      // Verify all updates
      const updatedEvents = await collection.list({});
      expect(updatedEvents.length).toBe(3);
      expect(
        updatedEvents.every((e) => e.description === 'Updated Description'),
      ).toBe(true);
    });
  });

  describe('STI (Single Table Inheritance) with JSON Backend', () => {
    it('should create STI objects with JSON backend', async () => {
      const collection = await Issue391BaseEventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Create Meeting (STI child)
      const meeting = await collection.create({
        _meta_type: 'Issue391Meeting',
        title: 'Team Standup',
        date: new Date('2024-01-15'),
        location: 'Conference Room A',
        roomNumber: '101',
        attendees: ['Alice', 'Bob'],
      });

      expect(meeting.id).toBeDefined();
      expect(meeting.constructor.name).toBe('Issue391Meeting');
      expect((meeting as any).roomNumber).toBe('101');
    });

    it('should handle polymorphic queries with JSON backend', async () => {
      const collection = await Issue391BaseEventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Create different event types
      const meeting = await collection.create({
        _meta_type: 'Issue391Meeting',
        title: 'Team Standup',
        date: new Date('2024-01-15'),
        location: 'Conference Room A',
        roomNumber: '101',
        attendees: ['Alice', 'Bob'],
      });

      const conference = await collection.create({
        _meta_type: 'Issue391Conference',
        title: 'Tech Conference 2024',
        date: new Date('2024-02-20'),
        location: 'Convention Center',
        sponsorName: 'TechCorp',
        ticketPrice: 299.99,
      });

      // Query all events (polymorphic)
      const allEvents = await collection.list({});
      expect(allEvents.length).toBe(2);

      // Verify correct types
      const meetingFromDb = allEvents.find((e) => e.id === meeting.id);
      const conferenceFromDb = allEvents.find((e) => e.id === conference.id);

      expect(meetingFromDb?.constructor.name).toBe('Issue391Meeting');
      expect(conferenceFromDb?.constructor.name).toBe('Issue391Conference');
    });

    it('should handle UPSERT with STI and JSON backend', async () => {
      const collection = await Issue391BaseEventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Create Meeting
      const meeting = await collection.create({
        _meta_type: 'Issue391Meeting',
        title: 'Original Meeting',
        date: new Date('2024-01-15'),
        location: 'Room A',
        roomNumber: '101',
        attendees: ['Alice'],
      });

      const originalId = meeting.id;

      // Update the meeting
      (meeting as any).title = 'Updated Meeting';
      (meeting as any).roomNumber = '102';
      await meeting.save();

      // Verify update
      const retrieved = await collection.get({ id: originalId });
      expect(retrieved).toBeDefined();
      expect(retrieved?.constructor.name).toBe('Issue391Meeting');
      expect(retrieved?.title).toBe('Updated Meeting');
      expect((retrieved as any).roomNumber).toBe('102');
    });
  });

  describe('Error Handling with JSON Backend', () => {
    it('should handle missing database path gracefully', async () => {
      await expect(
        Issue391EventCollection.create({
          persistence: {
            type: 'json',
            url: '', // Empty path
            writeStrategy: 'immediate',
          },
        }),
      ).rejects.toThrow();
    });

    it('should handle invalid JSON backend configuration', async () => {
      await expect(
        Issue391EventCollection.create({
          persistence: {
            type: 'json',
            // Missing required 'url' field
            writeStrategy: 'immediate',
          } as any,
        }),
      ).rejects.toThrow();
    });
  });

  describe('Praeco-like Scenario (Multiple Meeting Creates)', () => {
    it('should handle scenario from praeco issue #96: multiple meeting creates', async () => {
      const collection = await Issue391BaseEventCollection.create({
        persistence: {
          type: 'json',
          url: jsonDbPath,
          writeStrategy: 'immediate',
        },
      });

      // Simulate discovering 28 meetings (from praeco issue #96)
      const meetingData = Array.from({ length: 28 }, (_, i) => ({
        _meta_type: 'Issue391Meeting',
        title: `Council Meeting ${i + 1}`,
        date: new Date(`2024-01-${(i % 28) + 1}`),
        location: 'Town Hall',
        roomNumber: 'Main Chamber',
        attendees: ['Mayor', 'Council Members'],
      }));

      // Create all meetings
      const meetings = await Promise.all(
        meetingData.map((data) => collection.create(data)),
      );

      // Verify all 28 meetings were created
      expect(meetings.length).toBe(28);
      expect(meetings.every((m) => m.id !== undefined)).toBe(true);

      // Verify we can retrieve all meetings
      const allMeetings = await collection.list({});
      expect(allMeetings.length).toBe(28);
      expect(
        allMeetings.every((m) => m.constructor.name === 'Issue391Meeting'),
      ).toBe(true);
    });
  });
});
