/**
 * Integration test for Issue #144: Verify fix with real Event and Profile collections
 *
 * This test reproduces the original error scenario from the issue and verifies
 * that collections can be created without duplicate column errors.
 */

import { unlinkSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { datetime, text } from '../fields/index.js';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { generateSchema } from '../schema/utils';

// Test classes that mimic Event and Profile from their respective packages
@smrt()
class TestEvent extends SmrtObject {
  title = text();
  description = text();
  startDate = datetime();
  endDate = datetime();
}

@smrt()
class Issue144TestProfile extends SmrtObject {
  firstName = text();
  lastName = text();
  email = text();
  bio = text();
}

class TestEventCollection extends SmrtCollection<TestEvent> {
  static readonly _itemClass = TestEvent;
}

class Issue144TestProfileCollection extends SmrtCollection<Issue144TestProfile> {
  static readonly _itemClass = Issue144TestProfile;
}

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
    // This should not throw "duplicate column name: created_at" error
    const events = await (TestEventCollection as any).create({
      db: {
        type: 'sqlite',
        url: `file:${testDbPath}`,
      },
    });

    expect(events).toBeDefined();
  });

  it('should create ProfileCollection without duplicate column errors', async () => {
    // This should not throw duplicate column errors
    const profiles = await (Issue144TestProfileCollection as any).create({
      db: {
        type: 'sqlite',
        url: `file:${testDbPath}`,
      },
    });

    expect(profiles).toBeDefined();
  });

  it('should generate valid schema for Event class', async () => {
    const schema = await generateSchema(TestEvent);

    // Verify no duplicate columns
    const createdMatches = schema.match(/created_at/g) || [];
    const updatedMatches = schema.match(/updated_at/g) || [];

    expect(createdMatches.length).toBe(1);
    expect(updatedMatches.length).toBe(1);

    // Verify it contains the timestamp columns (with quoted column names)
    expect(schema).toContain('"created_at" TIMESTAMP');
    expect(schema).toContain('"updated_at" TIMESTAMP');
  });

  it('should generate valid schema for Profile class', async () => {
    const schema = await generateSchema(Issue144TestProfile);

    // Verify no duplicate columns
    const createdMatches = schema.match(/created_at/g) || [];
    const updatedMatches = schema.match(/updated_at/g) || [];

    expect(createdMatches.length).toBe(1);
    expect(updatedMatches.length).toBe(1);

    // Verify it contains the timestamp columns (with quoted column names)
    expect(schema).toContain('"created_at" TIMESTAMP');
    expect(schema).toContain('"updated_at" TIMESTAMP');
  });
});
