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

    it('should support array of InterestFilters per object type', async () => {
      const testPrefix = uniqueName('array-filters');

      // Create meetings with different properties
      const publicMeeting = await meetingCollection.create({
        title: `${testPrefix}-public`,
        isPublic: true,
        priority: 1,
      });
      await publicMeeting.save();

      const highPriorityMeeting = await meetingCollection.create({
        title: `${testPrefix}-priority`,
        isPublic: false,
        priority: 10,
      });
      await highPriorityMeeting.save();

      const otherMeeting = await meetingCollection.create({
        title: `${testPrefix}-other`,
        isPublic: false,
        priority: 1,
      });
      await otherMeeting.save();

      // Use array of filters - should match both public AND high priority (OR logic via multiple filters)
      const agent = new TestInterestAgent({
        name: uniqueName('array-filter-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: [
              {
                name: 'public-meetings',
                filter: { isPublic: true },
              },
              {
                name: 'high-priority-meetings',
                filter: { 'priority >=': 10 },
              },
            ],
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Filter to our test meetings
      const ourResults = results.filter((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      // Should get both the public meeting AND the high-priority meeting
      expect(ourResults.length).toBe(2);
      const ids = ourResults.map((r) => r.data.id);
      expect(ids).toContain(publicMeeting.id);
      expect(ids).toContain(highPriorityMeeting.id);
      // Should NOT include the "other" meeting
      expect(ids).not.toContain(otherMeeting.id);
    });

    it('should deduplicate results when same object matches multiple filters', async () => {
      const testPrefix = uniqueName('dedupe-test');

      // Create a meeting that matches both filters
      const bothMatch = await meetingCollection.create({
        title: `${testPrefix}-both`,
        isPublic: true,
        priority: 10,
      });
      await bothMatch.save();

      const agent = new TestInterestAgent({
        name: uniqueName('dedupe-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: [
              {
                name: 'public-meetings',
                filter: { isPublic: true },
              },
              {
                name: 'high-priority-meetings',
                filter: { 'priority >=': 10 },
              },
            ],
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Filter to our test meeting
      const ourResults = results.filter((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      // Should only appear once despite matching both filters
      expect(ourResults.length).toBe(1);
      expect(ourResults[0].data.id).toBe(bothMatch.id);
    });

    it('should support custom query function for complex SQL patterns', async () => {
      const testPrefix = uniqueName('custom-query');

      // Create meetings
      const meeting1 = await meetingCollection.create({
        title: `${testPrefix}-meeting-1`,
        priority: 5,
      });
      await meeting1.save();

      const meeting2 = await meetingCollection.create({
        title: `${testPrefix}-meeting-2`,
        priority: 15,
      });
      await meeting2.save();

      const agent = new TestInterestAgent({
        name: uniqueName('custom-query-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              // Custom query - uses raw SQL
              query: (tableName) => [
                `priority > ? AND title LIKE ?`,
                [10, `${testPrefix}%`],
              ],
              sort: 'priority DESC',
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Should only get the high-priority meeting
      expect(results.length).toBe(1);
      expect(results[0].data.id).toBe(meeting2.id);
    });

    it('should support custom query with NOT EXISTS pattern', async () => {
      const testPrefix = uniqueName('not-exists');

      // Create meetings
      const meetingWithDoc = await meetingCollection.create({
        title: `${testPrefix}-with-doc`,
        priority: 1,
      });
      await meetingWithDoc.save();

      const meetingWithoutDoc = await meetingCollection.create({
        title: `${testPrefix}-without-doc`,
        priority: 2,
      });
      await meetingWithoutDoc.save();

      // Create document linked to first meeting (via title for simplicity)
      const doc = await documentCollection.create({
        title: meetingWithDoc.id!, // Use meeting ID as document title for linking
        type: 'recap',
      });
      await doc.save();

      const agent = new TestInterestAgent({
        name: uniqueName('not-exists-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              // Find meetings without a corresponding document
              query: (tableName) => [
                `NOT EXISTS (
                  SELECT 1 FROM documents d
                  WHERE d.title = ${tableName}.id
                )
                AND ${tableName}.title LIKE ?`,
                [`${testPrefix}%`],
              ],
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Should only get the meeting without a document
      expect(results.length).toBe(1);
      expect(results[0].data.id).toBe(meetingWithoutDoc.id);
    });

    it('should apply qualifier after custom query', async () => {
      const testPrefix = uniqueName('query-qualify');

      const meeting1 = await meetingCollection.create({
        title: `${testPrefix}-meeting-1`,
        isPublic: true,
        priority: 15,
      });
      await meeting1.save();

      const meeting2 = await meetingCollection.create({
        title: `${testPrefix}-meeting-2`,
        isPublic: false,
        priority: 20,
      });
      await meeting2.save();

      const agent = new TestInterestAgent({
        name: uniqueName('query-qualify-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              query: (tableName) => [
                `priority > ? AND title LIKE ?`,
                [10, `${testPrefix}%`],
              ],
              // Additional JS filtering after SQL query
              qualify: async (meetings) =>
                meetings.filter((m) => (m as Meeting).isPublic),
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Should only get public meeting after qualifier
      expect(results.length).toBe(1);
      expect(results[0].data.id).toBe(meeting1.id);
    });

    it('should include filter name in results', async () => {
      const testPrefix = uniqueName('filter-name');

      const meeting = await meetingCollection.create({
        title: `${testPrefix}-meeting`,
        isPublic: true,
      });
      await meeting.save();

      const agent = new TestInterestAgent({
        name: uniqueName('filter-name-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              name: 'public-meetings-filter',
              filter: { isPublic: true },
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Find our test meeting
      const ourResult = results.find((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      expect(ourResult).toBeDefined();
      expect(ourResult?.name).toBe('public-meetings-filter');
    });

    it('should call handler for each matched item and include result', async () => {
      const testPrefix = uniqueName('handler-test');

      const meeting = await meetingCollection.create({
        title: `${testPrefix}-meeting`,
        priority: 5,
      });
      await meeting.save();

      const agent = new TestInterestAgent({
        name: uniqueName('handler-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              name: 'needs-recap',
              filter: { 'priority >': 0 },
              handler: async (item) => ({
                action: 'recap',
                meetingId: item.id,
              }),
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Find our test meeting
      const ourResult = results.find((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      expect(ourResult).toBeDefined();
      expect(ourResult?.handled).toEqual({
        action: 'recap',
        meetingId: meeting.id,
      });
    });

    it('should pass agent instance to handler as second argument', async () => {
      const testPrefix = uniqueName('handler-agent-arg');

      const meeting = await meetingCollection.create({
        title: `${testPrefix}-meeting`,
        priority: 5,
      });
      await meeting.save();

      let receivedAgent: any = null;

      const agent = new TestInterestAgent({
        name: uniqueName('handler-this-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              filter: { 'priority >': 0 },
              handler: async (item, agentInstance) => {
                receivedAgent = agentInstance;
                return {
                  agentName: (agentInstance.options as any).name,
                  itemId: item.id,
                };
              },
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Find our test meeting
      const ourResult = results.find((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      expect(ourResult).toBeDefined();
      expect(receivedAgent).toBe(agent);
      expect(ourResult?.handled.agentName).toBe((agent.options as any).name);
    });

    it('should support async handlers', async () => {
      const testPrefix = uniqueName('async-handler');

      const meeting = await meetingCollection.create({
        title: `${testPrefix}-meeting`,
        priority: 5,
      });
      await meeting.save();

      const agent = new TestInterestAgent({
        name: uniqueName('async-handler-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              filter: { 'priority >': 0 },
              handler: async (item) => {
                // Simulate async work
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { action: 'processed', id: item.id };
              },
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      const ourResult = results.find((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      expect(ourResult).toBeDefined();
      expect(ourResult?.handled).toEqual({
        action: 'processed',
        id: meeting.id,
      });
    });

    it('should support sync handlers', async () => {
      const testPrefix = uniqueName('sync-handler');

      const meeting = await meetingCollection.create({
        title: `${testPrefix}-meeting`,
        priority: 5,
      });
      await meeting.save();

      const agent = new TestInterestAgent({
        name: uniqueName('sync-handler-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              filter: { 'priority >': 0 },
              // Sync handler (no async)
              handler: (item) => ({ action: 'sync-result', id: item.id }),
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      const ourResult = results.find((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      expect(ourResult).toBeDefined();
      expect(ourResult?.handled).toEqual({
        action: 'sync-result',
        id: meeting.id,
      });
    });

    it('should use different handlers for different filters in array', async () => {
      const testPrefix = uniqueName('multi-handler');

      const publicMeeting = await meetingCollection.create({
        title: `${testPrefix}-public`,
        isPublic: true,
        priority: 1,
      });
      await publicMeeting.save();

      const privateMeeting = await meetingCollection.create({
        title: `${testPrefix}-private`,
        isPublic: false,
        priority: 10,
      });
      await privateMeeting.save();

      const agent = new TestInterestAgent({
        name: uniqueName('multi-handler-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: [
              {
                name: 'public-needs-announce',
                filter: { isPublic: true },
                handler: async (m) => ({ action: 'announce', id: m.id }),
              },
              {
                name: 'priority-needs-recap',
                filter: { 'priority >=': 10 },
                handler: async (m) => ({ action: 'recap', id: m.id }),
              },
            ],
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      // Filter to our test meetings
      const ourResults = results.filter((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      expect(ourResults.length).toBe(2);

      const publicResult = ourResults.find(
        (r) => r.data.id === publicMeeting.id,
      );
      const privateResult = ourResults.find(
        (r) => r.data.id === privateMeeting.id,
      );

      expect(publicResult?.name).toBe('public-needs-announce');
      expect(publicResult?.handled).toEqual({
        action: 'announce',
        id: publicMeeting.id,
      });

      expect(privateResult?.name).toBe('priority-needs-recap');
      expect(privateResult?.handled).toEqual({
        action: 'recap',
        id: privateMeeting.id,
      });
    });

    it('should not include handled when no handler is defined', async () => {
      const testPrefix = uniqueName('no-handler');

      const meeting = await meetingCollection.create({
        title: `${testPrefix}-meeting`,
        priority: 5,
      });
      await meeting.save();

      const agent = new TestInterestAgent({
        name: uniqueName('no-handler-agent'),
        db: sharedDb,
        interests: {
          objects: {
            Meeting: {
              name: 'no-handler-filter',
              filter: { 'priority >': 0 },
              // No handler defined
            },
          },
        },
      });
      await agent.initialize();

      const results = await agent.interesting();

      const ourResult = results.find((r) =>
        (r.data as Meeting).title.startsWith(testPrefix),
      );

      expect(ourResult).toBeDefined();
      expect(ourResult?.name).toBe('no-handler-filter');
      expect(ourResult?.handled).toBeUndefined();
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
