/**
 * Tests for STI polymorphic queries
 *
 * Tests that:
 * 1. Collection.list() returns instances of correct subclasses
 * 2. Collection.get() returns instance of correct subclass
 * 3. Mixed-type result arrays work correctly
 * 4. Filtering by _meta_type works
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';

import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Base class with STI
@smrt({ tableStrategy: 'sti' })
class PolyEvent extends SmrtObject {
  title: string = '';
  description: string = '';
}

// Child class 1: Meeting
@smrt()
class PolyMeeting extends PolyEvent {
  location: string = '';
  attendees: Meta<string[]> = [];
  duration: Meta<number> = 0;
}

// Child class 2: Concert
@smrt()
class PolyConcert extends PolyEvent {
  venue: string = '';
  artist: Meta<string> = '';
  ticketPrice: Meta<number> = 0;
}

// Child class 3: Conference
@smrt()
class PolyConference extends PolyEvent {
  organizer: string = '';
  tracks: Meta<string[]> = [];
  fee: Meta<number> = 0;
}

// Collections
class PolyEventCollection extends SmrtCollection<PolyEvent> {
  static readonly _itemClass = PolyEvent;
}

class PolyMeetingCollection extends SmrtCollection<PolyMeeting> {
  static readonly _itemClass = PolyMeeting;
}

class PolyConcertCollection extends SmrtCollection<PolyConcert> {
  static readonly _itemClass = PolyConcert;
}

class PolyConferenceCollection extends SmrtCollection<PolyConference> {
  static readonly _itemClass = PolyConference;
}

describe('STI Polymorphic Queries', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-sti-poly-test-'));
    dbPath = join(tempDir, 'events.json');

    // Register collections
    ObjectRegistry.registerCollection('PolyEvent', PolyEventCollection);
    ObjectRegistry.registerCollection('PolyMeeting', PolyMeetingCollection);
    ObjectRegistry.registerCollection('PolyConcert', PolyConcertCollection);
    ObjectRegistry.registerCollection(
      'PolyConference',
      PolyConferenceCollection,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Collection.list() polymorphic hydration', () => {
    it('should return instances of correct subclasses', async () => {
      // Create child collections
      const meetingCollection = await PolyMeetingCollection.create({
        db: { type: 'json', url: dbPath },
      });
      const concertCollection = await PolyConcertCollection.create({
        db: { type: 'json', url: dbPath },
      });
      const conferenceCollection = await PolyConferenceCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Create instances via child collections
      const meeting = await meetingCollection.create({
        title: 'Team Standup',
        description: 'Daily standup meeting',
        location: 'Office',
        attendees: ['Alice', 'Bob'],
        duration: 30,
      });
      await meeting.save();

      const concert = await concertCollection.create({
        title: 'Rock Concert',
        description: 'Live rock performance',
        venue: 'Arena',
        artist: 'The Band',
        ticketPrice: 50,
      });
      await concert.save();

      const conference = await conferenceCollection.create({
        title: 'Tech Summit',
        description: 'Annual technology conference',
        organizer: 'TechCorp',
        tracks: ['AI', 'Web', 'Mobile'],
        fee: 200,
      });
      await conference.save();

      // Query via base collection - should get all types polymorphically
      const eventCollection = await PolyEventCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // List all events - should get mixed types
      const events = await eventCollection.list({});

      expect(events).toHaveLength(3);

      // Verify instance types
      const meetingInstance = events.find((e) => e.title === 'Team Standup');
      const concertInstance = events.find((e) => e.title === 'Rock Concert');
      const conferenceInstance = events.find((e) => e.title === 'Tech Summit');

      expect(meetingInstance).toBeInstanceOf(PolyMeeting);
      expect(concertInstance).toBeInstanceOf(PolyConcert);
      expect(conferenceInstance).toBeInstanceOf(PolyConference);

      // Verify properties are correct
      expect((meetingInstance as PolyMeeting).location).toBe('Office');
      expect((meetingInstance as PolyMeeting).attendees).toEqual([
        'Alice',
        'Bob',
      ]);
      expect((meetingInstance as PolyMeeting).duration).toBe(30);

      expect((concertInstance as PolyConcert).venue).toBe('Arena');
      expect((concertInstance as PolyConcert).artist).toBe('The Band');
      expect((concertInstance as PolyConcert).ticketPrice).toBe(50);

      expect((conferenceInstance as PolyConference).organizer).toBe('TechCorp');
      expect((conferenceInstance as PolyConference).tracks).toEqual([
        'AI',
        'Web',
        'Mobile',
      ]);
      expect((conferenceInstance as PolyConference).fee).toBe(200);
    });

    it('should filter by _meta_type discriminator', async () => {
      const meetingCollection = await PolyMeetingCollection.create({
        db: { type: 'json', url: dbPath },
      });
      const concertCollection = await PolyConcertCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Create multiple types
      const meeting1 = await meetingCollection.create({
        title: 'Meeting 1',
        location: 'Room A',
      });
      await meeting1.save();

      const concert1 = await concertCollection.create({
        title: 'Concert 1',
        venue: 'Stadium',
        artist: 'Band A',
      });
      await concert1.save();

      const meeting2 = await meetingCollection.create({
        title: 'Meeting 2',
        location: 'Room B',
      });
      await meeting2.save();

      // Query via base collection
      const eventCollection = await PolyEventCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Filter by type - only meetings
      const meetings = await eventCollection.list({
        where: { _meta_type: 'PolyMeeting' },
      });

      expect(meetings).toHaveLength(2);
      expect(meetings.every((e) => e instanceof PolyMeeting)).toBe(true);
      expect(meetings.map((m) => m.title)).toEqual(['Meeting 1', 'Meeting 2']);

      // Filter by type - only concerts
      const concerts = await eventCollection.list({
        where: { _meta_type: 'PolyConcert' },
      });

      expect(concerts).toHaveLength(1);
      expect(concerts[0]).toBeInstanceOf(PolyConcert);
      expect(concerts[0].title).toBe('Concert 1');
    });

    it('should support ordering and pagination with mixed types', async () => {
      const meetingCollection = await PolyMeetingCollection.create({
        db: { type: 'json', url: dbPath },
      });
      const concertCollection = await PolyConcertCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Create events in specific order
      for (let i = 1; i <= 5; i++) {
        if (i % 2 === 0) {
          // Even: Meeting
          const meeting = await meetingCollection.create({
            title: `Event ${i}`,
            description: `Description ${i}`,
            location: `Room ${i}`,
          });
          await meeting.save();
        } else {
          // Odd: Concert
          const concert = await concertCollection.create({
            title: `Event ${i}`,
            description: `Description ${i}`,
            venue: `Venue ${i}`,
            artist: `Artist ${i}`,
          });
          await concert.save();
        }
      }

      // Query via base collection
      const eventCollection = await PolyEventCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // List with ordering
      const orderedEvents = await eventCollection.list({
        orderBy: 'title DESC',
        limit: 3,
      });

      expect(orderedEvents).toHaveLength(3);
      expect(orderedEvents[0].title).toBe('Event 5');
      expect(orderedEvents[1].title).toBe('Event 4');
      expect(orderedEvents[2].title).toBe('Event 3');

      // Verify correct types
      expect(orderedEvents[0]).toBeInstanceOf(PolyConcert);
      expect(orderedEvents[1]).toBeInstanceOf(PolyMeeting);
      expect(orderedEvents[2]).toBeInstanceOf(PolyConcert);

      // List with offset
      const pagedEvents = await eventCollection.list({
        orderBy: 'title ASC',
        offset: 2,
        limit: 2,
      });

      expect(pagedEvents).toHaveLength(2);
      expect(pagedEvents[0].title).toBe('Event 3');
      expect(pagedEvents[1].title).toBe('Event 4');
    });
  });

  describe('Collection.get() polymorphic hydration', () => {
    it('should return instance of correct subclass by ID', async () => {
      const meetingCollection = await PolyMeetingCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Create a meeting
      const meeting = await meetingCollection.create({
        title: 'Project Review',
        location: 'Conference Room',
        attendees: ['Manager', 'Team'],
        duration: 60,
      });
      await meeting.save();

      // Query via base collection
      const eventCollection = await PolyEventCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Get by ID - should return PolyMeeting instance
      const retrieved = await eventCollection.get(meeting.id);

      expect(retrieved).toBeDefined();
      expect(retrieved).toBeInstanceOf(PolyMeeting);
      expect(retrieved?.title).toBe('Project Review');
      expect((retrieved as PolyMeeting).location).toBe('Conference Room');
      expect((retrieved as PolyMeeting).attendees).toEqual(['Manager', 'Team']);
      expect((retrieved as PolyMeeting).duration).toBe(60);
    });

    it('should return instance of correct subclass by slug', async () => {
      const concertCollection = await PolyConcertCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Create a concert
      const concert = await concertCollection.create({
        title: 'Jazz Night',
        venue: 'Blue Note',
        artist: 'Miles Davis Tribute',
        ticketPrice: 75,
      });
      await concert.save();

      // Query via base collection
      const eventCollection = await PolyEventCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Get by slug - should return PolyConcert instance
      const retrieved = await eventCollection.get('jazz-night');

      expect(retrieved).toBeDefined();
      expect(retrieved).toBeInstanceOf(PolyConcert);
      expect(retrieved?.title).toBe('Jazz Night');
      expect((retrieved as PolyConcert).venue).toBe('Blue Note');
      expect((retrieved as PolyConcert).artist).toBe('Miles Davis Tribute');
      expect((retrieved as PolyConcert).ticketPrice).toBe(75);
    });
  });

  describe('Child collection queries', () => {
    it('should only return instances of child type from child collection', async () => {
      // Use child collection (MeetingCollection)
      const meetingCollection = await PolyMeetingCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Create meetings via child collection
      const meeting1 = await meetingCollection.create({
        title: 'Sprint Planning',
        location: 'War Room',
        attendees: ['Team'],
        duration: 120,
      });
      await meeting1.save();

      const meeting2 = await meetingCollection.create({
        title: 'Retrospective',
        location: 'Main Office',
        attendees: ['All Hands'],
        duration: 90,
      });
      await meeting2.save();

      // Also create a concert in the same table
      const concertCollection = await PolyConcertCollection.create({
        db: { type: 'json', url: dbPath },
      });

      const concert = await concertCollection.create({
        title: 'Rock Show',
        venue: 'Stadium',
        artist: 'Rock Stars',
      });
      await concert.save();

      // Query via MeetingCollection - should only get meetings
      const meetings = await meetingCollection.list({});

      expect(meetings).toHaveLength(2);
      expect(meetings.every((m) => m instanceof PolyMeeting)).toBe(true);
      expect(meetings.map((m) => m.title).sort()).toEqual([
        'Retrospective',
        'Sprint Planning',
      ]);

      // Query via EventCollection - should get all types
      const eventCollection = await PolyEventCollection.create({
        db: { type: 'json', url: dbPath },
      });
      const allEvents = await eventCollection.list({});
      expect(allEvents).toHaveLength(3);
    });
  });
});
