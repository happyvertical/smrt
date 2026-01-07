/**
 * Integration test for Issue #144: Verify fix with real Event and Profile collections
 *
 * This test reproduces the original error scenario from the issue and verifies
 * that collections can be created without duplicate column errors.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { generateSchema } from '../schema/utils';
import { getTestDatabase } from '../testing/database';

// Test classes that mimic Event and Profile from their respective packages
@smrt()
class TestEvent extends SmrtObject {
  title: string = '';
  description: string = '';
  startDate: Date = new Date();
  endDate: Date = new Date();
}

@smrt()
class Issue144TestProfile extends SmrtObject {
  firstName: string = '';
  lastName: string = '';
  email: string = '';
  bio: string = '';
}

class TestEventCollection extends SmrtCollection<TestEvent> {
  static readonly _itemClass = TestEvent;
}

class Issue144TestProfileCollection extends SmrtCollection<Issue144TestProfile> {
  static readonly _itemClass = Issue144TestProfile;
}

describe('Issue #144: Integration Test with Real Collections', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    // Create in-memory database with schemas pre-created
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  it('should create EventCollection without duplicate column errors', async () => {
    // This should not throw "duplicate column name: created_at" error
    const events = await TestEventCollection.create({ db });

    expect(events).toBeDefined();
  });

  it('should create ProfileCollection without duplicate column errors', async () => {
    // This should not throw duplicate column errors
    const profiles = await Issue144TestProfileCollection.create({ db });

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
