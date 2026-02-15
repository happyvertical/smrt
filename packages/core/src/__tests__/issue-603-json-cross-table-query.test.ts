/**
 * Test for Issue #603: JSON adapter cross-table query support
 *
 * Verifies that cross-table SQL queries work correctly with JSON adapter
 * by ensuring all tables are pre-loaded at initialization time.
 *
 * Problem: JSON adapter loads tables on-demand, but cross-table queries
 * (JOINs, NOT EXISTS subqueries) fail because referenced tables aren't loaded.
 *
 * Solution: ObjectRegistry.getAllSchemas() is passed to getDatabase() during
 * initialization, enabling the JSON adapter to pre-create all registered tables.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { foreignKey, SmrtObject, smrt } from '../index';

// Test classes for cross-table query scenario
// Using unique prefixes to avoid collisions with other tests

@smrt({ tableStrategy: 'sti' })
class Issue603Event extends SmrtObject {
  title: string = '';
  eventDate: Date = new Date();
  location: string = '';
}

@smrt()
class Issue603Meeting extends Issue603Event {
  roomNumber: string = '';
  attendees: string[] = [];
}

@smrt({ tableStrategy: 'sti' })
class Issue603Content extends SmrtObject {
  title: string = '';
  body: string = '';
  meetingId: string = '';
}

@smrt()
class Issue603MeetingRecap extends Issue603Content {
  summary: string = '';
  actionItems: string[] = [];
}

// Collections
class Issue603EventCollection extends SmrtCollection<Issue603Event> {
  static readonly _itemClass = Issue603Event;
}

class Issue603MeetingCollection extends SmrtCollection<Issue603Meeting> {
  static readonly _itemClass = Issue603Meeting;
}

class Issue603ContentCollection extends SmrtCollection<Issue603Content> {
  static readonly _itemClass = Issue603Content;
}

class Issue603MeetingRecapCollection extends SmrtCollection<Issue603MeetingRecap> {
  static readonly _itemClass = Issue603MeetingRecap;
}

describe('Issue #603: JSON adapter cross-table queries', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a unique temporary directory for each test
    tempDir = mkdtempSync(
      path.join(os.tmpdir(), `smrt-issue-603-${randomUUID().slice(0, 8)}-`),
    );
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should correctly evaluate NOT EXISTS subquery across tables', async () => {
    // Create collections with JSON adapter
    // Both collections must share the same database directory
    const eventCollection = await Issue603MeetingCollection.create({
      db: { type: 'json', url: tempDir, writeStrategy: 'immediate' },
    });

    const contentCollection = await Issue603MeetingRecapCollection.create({
      db: { type: 'json', url: tempDir, writeStrategy: 'immediate' },
    });

    // Create two meetings
    const meeting1 = await eventCollection.create({
      title: 'Team Standup',
      eventDate: new Date('2024-01-15'),
      location: 'Room A',
      roomNumber: '101',
      attendees: ['Alice', 'Bob'],
    });
    await meeting1.save();

    const meeting2 = await eventCollection.create({
      title: 'Project Review',
      eventDate: new Date('2024-01-16'),
      location: 'Room B',
      roomNumber: '102',
      attendees: ['Charlie', 'Dave'],
    });
    await meeting2.save();

    // Create a recap only for meeting1
    const recap = await contentCollection.create({
      title: 'Team Standup Recap',
      body: 'We discussed the sprint progress...',
      meetingId: meeting1.id,
      summary: 'Sprint is on track',
      actionItems: ['Complete task A', 'Review task B'],
    });
    await recap.save();

    // Query for meetings WITHOUT a recap using NOT EXISTS subquery
    // This is the pattern that was failing before the fix
    const tableName = 'issue603events'; // STI base table name (no underscore)
    const contentTableName = 'issue603contents'; // Content STI base table

    const results = await eventCollection.query(
      `
      SELECT * FROM ${tableName}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${contentTableName} c
        WHERE c.meeting_id = ${tableName}.id
        AND c._meta_type = '@happyvertical/smrt-core:Issue603MeetingRecap'
      )
    `,
      [],
    );

    // Should only return meeting2 (meeting1 has a recap)
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Project Review');
    expect(results[0].id).toBe(meeting2.id);
  });

  it('should correctly evaluate EXISTS subquery across tables', async () => {
    // Create collections with JSON adapter
    const eventCollection = await Issue603MeetingCollection.create({
      db: { type: 'json', url: tempDir, writeStrategy: 'immediate' },
    });

    const contentCollection = await Issue603MeetingRecapCollection.create({
      db: { type: 'json', url: tempDir, writeStrategy: 'immediate' },
    });

    // Create two meetings
    const meeting1 = await eventCollection.create({
      title: 'Team Standup',
      eventDate: new Date('2024-01-15'),
      location: 'Room A',
      roomNumber: '101',
    });
    await meeting1.save();

    const meeting2 = await eventCollection.create({
      title: 'Project Review',
      eventDate: new Date('2024-01-16'),
      location: 'Room B',
      roomNumber: '102',
    });
    await meeting2.save();

    // Create a recap only for meeting1
    const recap = await contentCollection.create({
      title: 'Team Standup Recap',
      body: 'We discussed the sprint progress...',
      meetingId: meeting1.id,
      summary: 'Sprint is on track',
    });
    await recap.save();

    // Query for meetings WITH a recap using EXISTS subquery
    const tableName = 'issue603events';
    const contentTableName = 'issue603contents';

    const results = await eventCollection.query(
      `
      SELECT * FROM ${tableName}
      WHERE EXISTS (
        SELECT 1 FROM ${contentTableName} c
        WHERE c.meeting_id = ${tableName}.id
        AND c._meta_type = '@happyvertical/smrt-core:Issue603MeetingRecap'
      )
    `,
      [],
    );

    // Should only return meeting1 (which has a recap)
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Team Standup');
    expect(results[0].id).toBe(meeting1.id);
  });

  it('should correctly evaluate JOIN queries across tables', async () => {
    // Create collections with JSON adapter
    const eventCollection = await Issue603MeetingCollection.create({
      db: { type: 'json', url: tempDir, writeStrategy: 'immediate' },
    });

    const contentCollection = await Issue603MeetingRecapCollection.create({
      db: { type: 'json', url: tempDir, writeStrategy: 'immediate' },
    });

    // Create a meeting
    const meeting = await eventCollection.create({
      title: 'Team Standup',
      eventDate: new Date('2024-01-15'),
      location: 'Room A',
      roomNumber: '101',
    });
    await meeting.save();

    // Create a recap for the meeting
    const recap = await contentCollection.create({
      title: 'Team Standup Recap',
      body: 'We discussed the sprint progress...',
      meetingId: meeting.id,
      summary: 'Sprint is on track',
    });
    await recap.save();

    // Query using INNER JOIN
    const tableName = 'issue603events';
    const contentTableName = 'issue603contents';

    const results = await eventCollection.query(
      `
      SELECT e.* FROM ${tableName} e
      INNER JOIN ${contentTableName} c ON c.meeting_id = e.id
      WHERE c._meta_type = '@happyvertical/smrt-core:Issue603MeetingRecap'
    `,
      [],
    );

    // Should return the meeting that has a recap
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Team Standup');
  });

  it('should handle empty related table correctly', async () => {
    // Create only the event collection (no content collection created)
    const eventCollection = await Issue603MeetingCollection.create({
      db: { type: 'json', url: tempDir, writeStrategy: 'immediate' },
    });

    // Also create content collection to ensure table exists
    // (but don't add any content)
    await Issue603MeetingRecapCollection.create({
      db: { type: 'json', url: tempDir, writeStrategy: 'immediate' },
    });

    // Create meetings
    const meeting1 = await eventCollection.create({
      title: 'Team Standup',
      eventDate: new Date('2024-01-15'),
      location: 'Room A',
      roomNumber: '101',
    });
    await meeting1.save();

    const meeting2 = await eventCollection.create({
      title: 'Project Review',
      eventDate: new Date('2024-01-16'),
      location: 'Room B',
      roomNumber: '102',
    });
    await meeting2.save();

    // Query for meetings WITHOUT a recap (all should be returned since no recaps exist)
    const tableName = 'issue603events';
    const contentTableName = 'issue603contents';

    const results = await eventCollection.query(
      `
      SELECT * FROM ${tableName}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${contentTableName} c
        WHERE c.meeting_id = ${tableName}.id
        AND c._meta_type = '@happyvertical/smrt-core:Issue603MeetingRecap'
      )
      ORDER BY title
    `,
      [],
    );

    // Should return both meetings since neither has a recap
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Project Review');
    expect(results[1].title).toBe('Team Standup');
  });
});
