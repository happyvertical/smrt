/**
 * Test for Issue #551: Collection tableName not inferred from managed STI subclass
 *
 * When a SmrtCollection manages an STI subclass, the collection's tableName should
 * be inferred from the STI parent's table, not from the collection class name.
 *
 * Fix: Extract the generic type argument from the extends clause
 * (e.g., "Meeting" from "SmrtCollection<Meeting>") to reliably find the item class.
 *
 * @see https://github.com/happyvertical/smrt/issues/551
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

describe('Issue #551: Collection STI table name from generic type argument', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('should infer collection tableName from STI item class via generic type', () => {
    // Define STI base class
    @smrt({ tableStrategy: 'sti' })
    class Event extends SmrtObject {
      title: string = '';
      date: Date = new Date();
    }

    // Define STI child class
    @smrt()
    class Meeting extends Event {
      roomNumber: string = '';
      attendees: string[] = [];
    }

    // Define collection that manages the STI child
    // The generic type argument <Meeting> should be extracted by AST scanner
    @smrt()
    class Meetings extends SmrtCollection<Meeting> {
      static readonly _itemClass = Meeting;
    }

    // Verify STI inheritance works
    expect(ObjectRegistry.getTableName('Event')).toBe('events');
    expect(ObjectRegistry.getTableName('Meeting')).toBe('events');

    // CRITICAL: Collection should inherit tableName from Meeting -> Event
    // Before fix: Would incorrectly use 'meetings' (from collection class name)
    // After fix: Should use 'events' (from STI base class)
    expect(ObjectRegistry.getTableName('Meetings')).toBe('events');
  });

  it('should work with multiple collections for different STI children', () => {
    @smrt({ tableStrategy: 'sti' })
    class Event extends SmrtObject {
      title: string = '';
    }

    @smrt()
    class Meeting extends Event {
      roomNumber: string = '';
    }

    @smrt()
    class Conference extends Event {
      sponsor: string = '';
    }

    @smrt()
    class Meetings extends SmrtCollection<Meeting> {
      static readonly _itemClass = Meeting;
    }

    @smrt()
    class Conferences extends SmrtCollection<Conference> {
      static readonly _itemClass = Conference;
    }

    // Both collections should point to the same 'events' table
    expect(ObjectRegistry.getTableName('Meetings')).toBe('events');
    expect(ObjectRegistry.getTableName('Conferences')).toBe('events');
  });

  it('should work with "Collection" suffix naming convention', () => {
    // Use unique class names to avoid collision with smrt-content's Article/Content
    @smrt({ tableStrategy: 'sti' })
    class Issue551Content extends SmrtObject {
      body: string = '';
    }

    @smrt()
    class Issue551Article extends Issue551Content {
      headline: string = '';
    }

    @smrt()
    class Issue551ArticleCollection extends SmrtCollection<Issue551Article> {
      static readonly _itemClass = Issue551Article;
    }

    // Verify STI hierarchy is correct
    expect(ObjectRegistry.getTableName('Issue551Content')).toBe(
      'issue551contents',
    );
    expect(ObjectRegistry.getTableName('Issue551Article')).toBe(
      'issue551contents',
    );

    // Collection should inherit tableName from Issue551Article -> Issue551Content
    expect(ObjectRegistry.getTableName('Issue551ArticleCollection')).toBe(
      'issue551contents',
    );
  });

  it('should verify collection tableName is correctly set', () => {
    @smrt({ tableStrategy: 'sti' })
    class Event extends SmrtObject {
      title: string = '';
    }

    @smrt()
    class Meeting extends Event {
      roomNumber: string = '';
    }

    @smrt()
    class Meetings extends SmrtCollection<Meeting> {
      static readonly _itemClass = Meeting;
    }

    // The collection should have tableName set correctly via getTableName
    // This verifies the collection class name -> tableName mapping works
    expect(ObjectRegistry.getTableName('Meetings')).toBe('events');

    // The item class (Meeting) should also point to the STI base table
    expect(ObjectRegistry.getTableName('Meeting')).toBe('events');
  });
});
