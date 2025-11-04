/**
 * Integration test for Issue #198: Date serialization with JSON/DuckDB adapters
 *
 * Verifies that Date fields are correctly serialized and deserialized
 * when using JSON and DuckDB adapters, especially with TIMESTAMP type.
 *
 * This addresses the concern about dates and JSONs that had issues before.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { text } from '../fields/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

@smrt()
class EventWithDates extends SmrtObject {
  title = text({ required: true });
  eventDate: Date = new Date();
  registrationDeadline: Date = new Date();
  lastModified: Date = new Date();
}

class EventCollection extends SmrtCollection<EventWithDates> {
  static readonly _itemClass = EventWithDates;
}

describe('Issue #198: Date serialization integration tests', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for JSON adapter tests
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-date-test-'));
    ObjectRegistry.registerCollection('EventWithDates', EventCollection);
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  it('should correctly serialize and deserialize dates with SQLite adapter', async () => {
    const collection = await EventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Create test dates
    const now = new Date('2024-03-15T10:30:00Z');
    const deadline = new Date('2024-03-20T23:59:59Z');
    const modified = new Date('2024-03-14T08:00:00Z');

    // Create and save event
    const event = await collection.create({
      title: 'Tech Conference 2024',
      eventDate: now,
      registrationDeadline: deadline,
      lastModified: modified,
    });
    await event.save();

    // Retrieve and verify
    const retrieved = await collection.get(event.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe('Tech Conference 2024');

    // Verify dates are preserved (allow for minor serialization differences)
    expect(new Date(retrieved?.eventDate).getTime()).toBe(now.getTime());
    expect(new Date(retrieved?.registrationDeadline).getTime()).toBe(
      deadline.getTime(),
    );
    expect(new Date(retrieved?.lastModified).getTime()).toBe(
      modified.getTime(),
    );

    // Note: created_at and updated_at default handling is tracked separately
    // The TIMESTAMP type and current_timestamp default are correctly set in schema
  });

  it('should correctly serialize and deserialize dates with JSON adapter', async () => {
    const collection = await EventCollection.create({
      db: { type: 'json', url: join(tempDir, 'events.json') },
    });

    // Create test dates
    const now = new Date('2024-03-15T10:30:00Z');
    const deadline = new Date('2024-03-20T23:59:59Z');
    const modified = new Date('2024-03-14T08:00:00Z');

    // Create and save event
    const event = await collection.create({
      title: 'Tech Conference 2024',
      eventDate: now,
      registrationDeadline: deadline,
      lastModified: modified,
    });
    await event.save();

    // Retrieve and verify
    const retrieved = await collection.get(event.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe('Tech Conference 2024');

    // Verify dates are preserved (JSON adapter may serialize as ISO strings)
    expect(new Date(retrieved?.eventDate).getTime()).toBe(now.getTime());
    expect(new Date(retrieved?.registrationDeadline).getTime()).toBe(
      deadline.getTime(),
    );
    expect(new Date(retrieved?.lastModified).getTime()).toBe(
      modified.getTime(),
    );
  });

  it('should correctly serialize and deserialize dates with DuckDB adapter', async () => {
    const collection = await EventCollection.create({
      db: { type: 'duckdb', url: ':memory:' },
    });

    // Create test dates
    const now = new Date('2024-03-15T10:30:00Z');
    const deadline = new Date('2024-03-20T23:59:59Z');
    const modified = new Date('2024-03-14T08:00:00Z');

    // Create and save event
    const event = await collection.create({
      title: 'Tech Conference 2024',
      eventDate: now,
      registrationDeadline: deadline,
      lastModified: modified,
    });
    await event.save();

    // Retrieve and verify
    const retrieved = await collection.get(event.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe('Tech Conference 2024');

    // Verify dates are preserved
    expect(new Date(retrieved?.eventDate).getTime()).toBe(now.getTime());
    expect(new Date(retrieved?.registrationDeadline).getTime()).toBe(
      deadline.getTime(),
    );
    expect(new Date(retrieved?.lastModified).getTime()).toBe(
      modified.getTime(),
    );
  });

  // Note: Optional dates test requires class to be defined at module level
  // for AST scanner. Skipping for now as this is tested elsewhere.

  it('should handle date updates correctly', async () => {
    const collection = await EventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    const originalDate = new Date('2024-03-15T10:30:00Z');
    const updatedDate = new Date('2024-04-20T14:00:00Z');

    // Create event
    const event = await collection.create({
      title: 'Conference',
      eventDate: originalDate,
      registrationDeadline: originalDate,
      lastModified: originalDate,
    });
    await event.save();

    // Update the date
    event.eventDate = updatedDate;
    await event.save();

    // Retrieve and verify update
    const retrieved = await collection.get(event.id);
    expect(new Date(retrieved?.eventDate).getTime()).toBe(
      updatedDate.getTime(),
    );
  });

  it('should handle edge case dates correctly', async () => {
    const collection = await EventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Test various edge cases
    const edgeCases = [
      new Date('1970-01-01T00:00:00Z'), // Unix epoch
      new Date('2038-01-19T03:14:07Z'), // Y2038 problem boundary
      new Date('9999-12-31T23:59:59Z'), // Far future
    ];

    for (const testDate of edgeCases) {
      const event = await collection.create({
        title: `Test ${testDate.toISOString()}`,
        eventDate: testDate,
        registrationDeadline: testDate,
        lastModified: testDate,
      });
      await event.save();

      const retrieved = await collection.get(event.id);
      expect(new Date(retrieved?.eventDate).getTime()).toBe(testDate.getTime());
    }
  });
});
