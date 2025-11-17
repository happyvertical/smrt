/**
 * Test for Issue #339: Event.startDate returns null even though start_date column has data
 *
 * When loading Event objects from the database, the startDate property returns null
 * even though the start_date column contains valid timestamp data. This is due to
 * the loadDataFromDb method not converting snake_case database column names to
 * camelCase property names before assigning values.
 *
 * Root Cause:
 * - Database columns use snake_case naming (start_date, end_date)
 * - TypeScript properties use camelCase naming (startDate, endDate)
 * - loadDataFromDb() was accessing data[field] where field is camelCase
 * - But database row has snake_case keys, so data['startDate'] was undefined
 *
 * Fix:
 * - Call formatDataJs() at the beginning of loadDataFromDb()
 * - formatDataJs() converts snake_case to camelCase and handles Date conversion
 */

import { describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators';
import { SmrtObject } from '../object.js';
import { smrt } from '../registry.js';

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
})
class Issue339Event extends SmrtObject {
  name: string = '';

  @field({ nullable: true })
  startDate: Date | null = null;

  @field({ nullable: true })
  endDate: Date | null = null;

  location: string = '';
}

class Issue339EventCollection extends SmrtCollection<Issue339Event> {
  static readonly _itemClass = Issue339Event;
}

describe('Issue #339: snake_case to camelCase date field mapping', () => {
  it('should correctly map start_date and end_date columns to startDate and endDate properties', async () => {
    // Create collection with in-memory database
    const collection = await Issue339EventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Create an event with dates
    const now = new Date('2025-10-14T00:00:00.000Z');
    const later = new Date('2025-10-14T02:00:00.000Z');

    const event = await collection.create({
      name: 'Regular Council Meeting - October 14, 2025',
      location: 'City Hall',
      startDate: now,
      endDate: later,
    });

    await event.save();

    // Verify the event was saved correctly
    expect(event.id).toBeDefined();
    expect(event.startDate).toBeInstanceOf(Date);
    expect(event.endDate).toBeInstanceOf(Date);
    expect(event.startDate?.toISOString()).toBe('2025-10-14T00:00:00.000Z');
    expect(event.endDate?.toISOString()).toBe('2025-10-14T02:00:00.000Z');

    // Load the event by ID (uses loadFromId → loadDataFromDb)
    const loadedById = new Issue339Event({
      id: event.id,
      db: collection.db,
    });
    await loadedById.initialize();

    // Verify dates are correctly mapped from snake_case columns
    expect(loadedById.startDate).toBeInstanceOf(Date);
    expect(loadedById.endDate).toBeInstanceOf(Date);
    expect(loadedById.startDate?.toISOString()).toBe(
      '2025-10-14T00:00:00.000Z',
    );
    expect(loadedById.endDate?.toISOString()).toBe('2025-10-14T02:00:00.000Z');

    // Verify all other properties are also correctly mapped
    expect(loadedById.name).toBe('Regular Council Meeting - October 14, 2025');
    expect(loadedById.location).toBe('City Hall');
  });

  it('should correctly map dates when loading by slug (uses loadFromSlug)', async () => {
    const collection = await Issue339EventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    const now = new Date('2025-10-28T00:00:00.000Z');
    const event = await collection.create({
      slug: 'council-meeting-oct-28',
      name: 'Regular Council Meeting - October 28, 2025',
      location: 'City Hall',
      startDate: now,
    });

    await event.save();

    // Load by slug (uses loadFromSlug → loadDataFromDb)
    const loadedBySlug = new Issue339Event({
      slug: 'council-meeting-oct-28',
      db: collection.db,
    });
    await loadedBySlug.initialize();

    // Verify dates are correctly mapped
    expect(loadedBySlug.startDate).toBeInstanceOf(Date);
    expect(loadedBySlug.startDate?.toISOString()).toBe(
      '2025-10-28T00:00:00.000Z',
    );
    expect(loadedBySlug.name).toBe(
      'Regular Council Meeting - October 28, 2025',
    );
  });

  it('should handle null dates correctly', async () => {
    const collection = await Issue339EventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Create event with null dates
    const event = await collection.create({
      name: 'Event with no dates',
      location: 'TBD',
      startDate: null,
      endDate: null,
    });

    await event.save();

    // Load by ID
    const loaded = new Issue339Event({
      id: event.id,
      db: collection.db,
    });
    await loaded.initialize();

    // Verify null dates are preserved
    expect(loaded.startDate).toBeNull();
    expect(loaded.endDate).toBeNull();
  });

  it('should correctly map dates loaded via collection.get()', async () => {
    // This test verifies that collection.get() also works correctly
    // (it already did before the fix because it uses formatDataJs)
    const collection = await Issue339EventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    const now = new Date('2025-11-01T00:00:00.000Z');
    const event = await collection.create({
      name: 'November Meeting',
      location: 'Conference Room',
      startDate: now,
    });

    await event.save();

    // Load via collection.get()
    const loaded = await collection.get({ id: event.id });

    expect(loaded).toBeDefined();
    expect(loaded?.startDate).toBeInstanceOf(Date);
    expect(loaded?.startDate?.toISOString()).toBe('2025-11-01T00:00:00.000Z');
  });

  it('should correctly map dates loaded via collection.list()', async () => {
    // This test verifies that collection.list() also works correctly
    // (it already did before the fix because it uses formatDataJs)
    const collection = await Issue339EventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    const date1 = new Date('2025-12-01T00:00:00.000Z');
    const date2 = new Date('2025-12-15T00:00:00.000Z');

    await collection
      .create({ name: 'Meeting 1', location: 'Room A', startDate: date1 })
      .then((e) => e.save());
    await collection
      .create({ name: 'Meeting 2', location: 'Room B', startDate: date2 })
      .then((e) => e.save());

    // Load via collection.list()
    const events = await collection.list({});

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].startDate).toBeInstanceOf(Date);
    expect(events[1].startDate).toBeInstanceOf(Date);
  });
});
