import {
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Agent, type AgentOptions } from './agent.js';
import { mergeFilters, normalizeSort } from './interests.js';

// Test SMRT objects for querying
// Using TypeScript types - smrt test generates manifest for field discovery
@smrt()
class Meeting extends SmrtObject {
  title: string = '';
  scheduledAt: Date = new Date();
  isPublic: boolean = true;
  priority: number = 0;
}

@smrt()
class Document extends SmrtObject {
  title: string = '';
  type: string = '';
  createdAt: Date = new Date();
  priority: number = 0;
}

// Test collections for querying
class MeetingCollection extends SmrtCollection<Meeting> {
  static readonly _itemClass = Meeting;
}

class DocumentCollection extends SmrtCollection<Document> {
  static readonly _itemClass = Document;
}

// Test agent with interests
@smrt()
class TestInterestAgent extends Agent {
  protected config = { enabled: true };

  constructor(options: AgentOptions = {}) {
    super(options);
  }

  async run(): Promise<void> {
    // Agent implementation
  }
}

describe('Agent Interests', () => {
  // Create a SINGLE shared database instance for all tests
  // This ensures all agents share the same in-memory database and tables persist
  let sharedDb: any;
  let meetingCollection: SmrtCollection<Meeting>;
  let documentCollection: SmrtCollection<Document>;

  // Counter for unique slugs per test
  let testCounter = 0;

  beforeAll(async () => {
    sharedDb = await getDatabase({ type: 'sqlite', url: ':memory:' });
    meetingCollection = await MeetingCollection.create({ db: sharedDb });
    documentCollection = await DocumentCollection.create({ db: sharedDb });
  });

  beforeEach(() => {
    // Increment counter for unique names/slugs per test
    testCounter++;
  });

  // Helper to create unique names for test isolation
  function uniqueName(base: string): string {
    return `${base}-${testCounter}-${Date.now()}`;
  }

  describe('interesting() method', () => {
    it('should throw error when no interests configured', async () => {
      const agent = new TestInterestAgent({
        name: uniqueName('no-interests-agent'),
        db: sharedDb,
      });
      await agent.initialize();

      await expect(agent.interesting()).rejects.toThrow(
        'has no interests configured',
      );
    });

    it('should return empty array with warning when objects is empty', async () => {
      const agent = new TestInterestAgent({
        name: uniqueName('empty-interests-agent'),
        db: sharedDb,
        interests: {
          objects: {},
        },
      });
      await agent.initialize();

      const results = await agent.interesting();
      expect(results).toEqual([]);
    });

    it('should query configured object types and return results', async () => {
      const meeting1 = await meetingCollection.create({
        title: uniqueName('Board Meeting'),
        scheduledAt: new Date('2024-06-01'),
        isPublic: true,
        priority: 1,
      });
      await meeting1.save();

      const meeting2 = await meetingCollection.create({
        title: uniqueName('Committee Meeting'),
        scheduledAt: new Date('2024-06-15'),
        isPublic: false,
        priority: 2,
      });
      await meeting2.save();

      const agent = new TestInterestAgent({
        name: uniqueName('basic-query-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {},
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Should return at least the 2 meetings we just created
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r.type === 'Meeting')).toBe(true);
    });

    it('should merge global and object filters (AND logic)', async () => {
      // Create meetings with different properties - use unique titles to filter
      const testPrefix = uniqueName('filter-test');

      const publicMeeting = await meetingCollection.create({
        title: `${testPrefix}-public`,
        isPublic: true,
        priority: 5,
      });
      await publicMeeting.save();

      const privateMeeting = await meetingCollection.create({
        title: `${testPrefix}-private`,
        isPublic: false,
        priority: 5,
      });
      await privateMeeting.save();

      const lowPriorityMeeting = await meetingCollection.create({
        title: `${testPrefix}-low`,
        isPublic: true,
        priority: 1,
      });
      await lowPriorityMeeting.save();

      const agent = new TestInterestAgent({
        name: uniqueName('filter-merge-agent'),
        db: sharedDb,
        interests: {
          filter: { isPublic: true }, // Global: only public
          objects: {
            Meeting: {
              filter: { 'priority >=': 5 }, // Object: high priority
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Filter to only our test meetings
      const ourResults = results.filter((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      // Should only get the public, high-priority meeting
      expect(ourResults.length).toBe(1);
      expect(ourResults[0].data.id).toBe(publicMeeting.id);
    });

    it('should apply object-specific qualifier after SQL query', async () => {
      const testPrefix = uniqueName('qualifier-test');

      const publicMeeting = await meetingCollection.create({
        title: `${testPrefix}-public`,
        isPublic: true,
      });
      await publicMeeting.save();

      const privateMeeting = await meetingCollection.create({
        title: `${testPrefix}-private`,
        isPublic: false,
      });
      await privateMeeting.save();

      const agent = new TestInterestAgent({
        name: uniqueName('object-qualifier-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              qualify: async (meetings) =>
                meetings.filter(
                  (m) =>
                    (m as Meeting).isPublic &&
                    (m as Meeting).title.startsWith(testPrefix),
                ),
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Should only get the public meeting from our test
      expect(results.length).toBe(1);
      expect((results[0].data as Meeting).isPublic).toBe(true);
      expect((results[0].data as Meeting).title).toBe(`${testPrefix}-public`);
    });

    it('should apply global qualifier after all object qualifiers', async () => {
      const testPrefix = uniqueName('global-qual');

      const meeting = await meetingCollection.create({
        title: `${testPrefix}-meeting`,
        priority: 10,
      });
      await meeting.save();

      const doc = await documentCollection.create({
        title: `${testPrefix}-document`,
        type: 'agenda',
        priority: 5,
      });
      await doc.save();

      const agent = new TestInterestAgent({
        name: uniqueName('global-qualifier-agent'),
        db: sharedDb,
        interests: {
          qualify: async (items) =>
            items.filter(
              (item) =>
                (item as any).priority >= 10 &&
                (item as any).title.startsWith(testPrefix),
            ),
          objects: {
            Meeting: {},
            Document: {},
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Only the meeting has priority >= 10
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('Meeting');
    });

    it('should warn and skip unregistered object types', async () => {
      const agent = new TestInterestAgent({
        name: uniqueName('unregistered-type-agent'),
        db: sharedDb,
        interests: {
          objects: {
            NonExistentClass: {},
          },
        },
      });
      await agent.initialize();

      // Should not throw, just return empty results
      const results = await agent.interesting();
      expect(results).toEqual([]);
    });

    it('should apply global sort across all types', async () => {
      const testPrefix = uniqueName('sort-test');

      const meeting = await meetingCollection.create({
        title: `${testPrefix}-meeting`,
        priority: 5,
      });
      await meeting.save();

      const doc = await documentCollection.create({
        title: `${testPrefix}-document`,
        type: 'agenda',
        priority: 10,
      });
      await doc.save();

      const agent = new TestInterestAgent({
        name: uniqueName('global-sort-agent'),
        db: sharedDb,
        interests: {
          sort: 'priority DESC',
          // Use qualifier to filter to only our test items
          qualify: async (items) =>
            items.filter((item) => (item as any).title.startsWith(testPrefix)),
          objects: {
            Meeting: {},
            Document: {},
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      expect(results.length).toBe(2);
      // Document (priority 10) should be first
      expect(results[0].type).toBe('Document');
      expect(results[1].type).toBe('Meeting');
    });

    it('should respect per-type limit option', async () => {
      const testPrefix = uniqueName('limit-test');

      // Create 5 meetings
      for (let i = 0; i < 5; i++) {
        const meeting = await meetingCollection.create({
          title: `${testPrefix}-meeting-${i}`,
        });
        await meeting.save();
      }

      const agent = new TestInterestAgent({
        name: uniqueName('limit-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              limit: 2,
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Should have at most 2 results due to limit
      // (may have more if other tests added meetings, but limit applies per-query)
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Helper functions', () => {
    describe('mergeFilters', () => {
      it('should return empty object when both filters are undefined', () => {
        expect(mergeFilters(undefined, undefined)).toEqual({});
      });

      it('should return global filter when object filter is undefined', () => {
        const global = { status: 'active' };
        expect(mergeFilters(global, undefined)).toEqual({ status: 'active' });
      });

      it('should return object filter when global filter is undefined', () => {
        const object = { type: 'meeting' };
        expect(mergeFilters(undefined, object)).toEqual({ type: 'meeting' });
      });

      it('should merge both filters with object taking precedence', () => {
        const global = { status: 'active', priority: 1 };
        const object = { type: 'meeting', priority: 5 };
        expect(mergeFilters(global, object)).toEqual({
          status: 'active',
          type: 'meeting',
          priority: 5, // Object filter wins
        });
      });
    });

    describe('normalizeSort', () => {
      it('should return empty array when sort is undefined', () => {
        expect(normalizeSort(undefined)).toEqual([]);
      });

      it('should wrap string in array', () => {
        expect(normalizeSort('priority DESC')).toEqual(['priority DESC']);
      });

      it('should return array as-is', () => {
        expect(normalizeSort(['priority DESC', 'name ASC'])).toEqual([
          'priority DESC',
          'name ASC',
        ]);
      });
    });
  });
});
