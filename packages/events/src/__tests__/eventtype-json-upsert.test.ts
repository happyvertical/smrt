/**
 * EventType JSON/DuckDB UPSERT Test
 *
 * This test reproduces the praeco issue where:
 * 1. EventType (STI base class) is used with JSON adapter (DuckDB)
 * 2. UPSERT fails with "columns as conflict target are not referenced by a UNIQUE/PRIMARY KEY CONSTRAINT"
 *
 * The issue is that DuckDB requires inline UNIQUE constraints for ON CONFLICT to work.
 * When schemas aren't properly passed to the JSON adapter, tables are created
 * without UNIQUE constraints.
 *
 * Related Issues:
 * - SDK #522: Remove automatic schema inference from JSON files
 * - DuckDB issue #12684: ON CONFLICT only works with inline UNIQUE constraints
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventTypeCollection } from '../collections/EventTypeCollection';

describe('EventType JSON/DuckDB UPSERT', () => {
  let testDir: string;
  let eventTypes: EventTypeCollection;

  beforeEach(async () => {
    // Create fresh directory for each test to avoid state sharing
    testDir = join(
      tmpdir(),
      `test-eventtype-json-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    // Setup JSON adapter exactly like praeco does
    const db = await getDatabase({
      type: 'json',
      url: testDir,
    });

    eventTypes = await EventTypeCollection.create({ db });
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should create EventType and save without error', async () => {
    const meetingType = await eventTypes.create({
      name: 'Council Meeting',
      slug: 'council-meeting',
      description: 'Regular council meeting',
      schema: '{}',
      participantSchema: '{}',
    });

    expect(meetingType.id).toBeDefined();
    expect(meetingType.name).toBe('Council Meeting');
    expect(meetingType.slug).toBe('council-meeting');
  });

  it('should UPSERT EventType without constraint error', async () => {
    // First create
    const meetingType = await eventTypes.create({
      name: 'Council Meeting',
      slug: 'council-meeting',
      context: 'test-council',
      description: 'Regular council meeting',
      schema: '{}',
      participantSchema: '{}',
    });

    const originalId = meetingType.id;

    // Update and save again - this is where praeco fails
    meetingType.description = 'Updated description';
    await expect(meetingType.save()).resolves.not.toThrow();

    // Verify UPSERT worked (same ID, updated data)
    const loaded = await eventTypes.get({ id: originalId });
    expect(loaded?.id).toBe(originalId);
    expect(loaded?.description).toBe('Updated description');
  });

  it('should handle multiple EventTypes with same slug in different contexts', async () => {
    // Create first
    const type1 = await eventTypes.create({
      name: 'Meeting Type A',
      slug: 'meeting',
      context: 'context-a',
      description: 'Type A',
      schema: '{}',
      participantSchema: '{}',
    });

    // Create second with same slug but different context
    const type2 = await eventTypes.create({
      name: 'Meeting Type B',
      slug: 'meeting',
      context: 'context-b',
      description: 'Type B',
      schema: '{}',
      participantSchema: '{}',
    });

    expect(type1.id).not.toBe(type2.id);
    expect(type1.slug).toBe(type2.slug);
    expect(type1.context).not.toBe(type2.context);

    // Both should exist
    const all = await eventTypes.list({});
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle getOrUpsert pattern (praeco discovery pattern)', async () => {
    // This is what praeco does - getOrUpsert to find or create event types
    const result = await eventTypes.getOrUpsert(
      { slug: 'special-meeting', context: 'test-council' },
      {
        name: 'Special Meeting',
        description: 'A special meeting type',
        schema: '{}',
        participantSchema: '{}',
      },
    );

    expect(result.slug).toBe('special-meeting');
    expect(result.name).toBe('Special Meeting');

    // Call again - should return same record
    const result2 = await eventTypes.getOrUpsert(
      { slug: 'special-meeting', context: 'test-council' },
      {
        name: 'Different Name',
        description: 'Different description',
        schema: '{}',
        participantSchema: '{}',
      },
    );

    expect(result2.id).toBe(result.id);
    // Name should NOT change on getOrUpsert (it found existing)
    expect(result2.name).toBe('Special Meeting');
  });
});
