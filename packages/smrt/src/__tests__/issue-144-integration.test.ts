/**
 * Integration test for Issue #144: Verify fix with real Event and Profile collections
 *
 * This test reproduces the original error scenario from the issue and verifies
 * that collections can be created without duplicate column errors.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { generateSchema } from '../utils';

describe('Issue #144: Integration Test with Real Collections', () => {
  const testDbPath = '/tmp/test-issue-144.db';

  afterAll(() => {
    // Cleanup test database
    try {
      unlinkSync(testDbPath);
    } catch (err) {
      // Ignore if file doesn't exist
    }
  });

  it('should create EventCollection without duplicate column errors', async () => {
    const { EventCollection } = await import('@have/events');

    // This should not throw "duplicate column name: created_at" error
    const events = await EventCollection.create({
      db: {
        type: 'sqlite',
        url: `file:${testDbPath}`,
      },
    });

    expect(events).toBeDefined();
  });

  it('should create ProfileCollection without duplicate column errors', async () => {
    const { ProfileCollection } = await import('@have/profiles');

    // This should not throw duplicate column errors
    const profiles = await ProfileCollection.create({
      db: {
        type: 'sqlite',
        url: `file:${testDbPath}`,
      },
    });

    expect(profiles).toBeDefined();
  });

  it('should generate valid schema for Event class', async () => {
    const { Event } = await import('@have/events');

    const schema = generateSchema(Event);

    // Verify no duplicate columns
    const createdMatches = schema.match(/created_at/g) || [];
    const updatedMatches = schema.match(/updated_at/g) || [];

    expect(createdMatches.length).toBe(1);
    expect(updatedMatches.length).toBe(1);

    // Verify it contains the timestamp columns
    expect(schema).toContain('created_at DATETIME');
    expect(schema).toContain('updated_at DATETIME');
  });

  it('should generate valid schema for Profile class', async () => {
    const { Profile } = await import('@have/profiles');

    const schema = generateSchema(Profile);

    // Verify no duplicate columns
    const createdMatches = schema.match(/created_at/g) || [];
    const updatedMatches = schema.match(/updated_at/g) || [];

    expect(createdMatches.length).toBe(1);
    expect(updatedMatches.length).toBe(1);

    // Verify it contains the timestamp columns
    expect(schema).toContain('created_at DATETIME');
    expect(schema).toContain('updated_at DATETIME');
  });
});
