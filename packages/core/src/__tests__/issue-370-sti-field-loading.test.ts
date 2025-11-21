/**
 * Issue #370: STI Field Loading Bugs
 *
 * Reproduces two distinct STI field loading issues revealed after fixing #368:
 *
 * 1. **External Package STI Classes** - Missing IDs
 *    - Person (from @happyvertical/smrt-profiles) has null ID after creation
 *    - Simulated here with Issue370Person extending Issue370Profile
 *
 * 2. **Multi-Level STI Inheritance** - Null Fields
 *    - Council (extends Organization → Profile from smrt-profiles)
 *    - Simulated here with Issue370Council extending Issue370Organization → Issue370Profile
 *    - Records persist but field values return null on read
 *
 * This test simulates the praeco package structure where Council extends
 * Organization from smrt-profiles, and Organization extends Profile (STI base).
 *
 * Related: https://github.com/happyvertical/smrt/issues/370
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import type { Meta } from '../types';

/**
 * Simulates Profile from @happyvertical/smrt-profiles
 * STI base class with tableStrategy: 'sti'
 */
@smrt({ tableStrategy: 'sti' })
class Issue370Profile extends SmrtObject {
  name: string = '';
  bio: string = '';
}

class Issue370ProfileCollection extends SmrtCollection<Issue370Profile> {
  static readonly _itemClass = Issue370Profile;
}

/**
 * Simulates Person from @happyvertical/smrt-profiles
 * Simple STI child with no additional fields
 */
@smrt()
class Issue370Person extends Issue370Profile {
  constructor(options: any = {}) {
    super(options);
  }
}

class Issue370PersonCollection extends SmrtCollection<Issue370Person> {
  static readonly _itemClass = Issue370Person;
}

/**
 * Simulates Organization from @happyvertical/smrt-profiles
 * STI child with additional fields
 */
@smrt()
class Issue370Organization extends Issue370Profile {
  website: string = '';
  foundedYear: number = 0;
}

/**
 * Simulates Council from praeco package
 * Multi-level STI: Council → Organization → Profile
 * Has Meta<T> fields stored in _meta_data JSONB
 */
@smrt()
class Issue370Council extends Issue370Organization {
  meetingsUrl: Meta<string> = '';
  timezone: Meta<string> = 'America/Edmonton';
}

class Issue370CouncilCollection extends SmrtCollection<Issue370Council> {
  static readonly _itemClass = Issue370Council;
}

describe('Issue #370: STI Field Loading', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-issue-370-${Date.now()}.db`);
    db = await getDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('STI Child Classes - ID Generation', () => {
    it('should generate ID for Issue370Person (simulates Person from profiles)', async () => {
      const persons = await Issue370PersonCollection.create({ db });

      const person = await persons.create({
        _meta_type: 'Issue370Person',
        name: 'John Smith',
      });

      // ID should be generated at creation time and auto-saved
      expect(person.id).toBeDefined();
      expect(person.id).not.toBeNull();
      expect(person.name).toBe('John Smith');

      // Verify persisted (create() auto-saves)
      const found = await persons.findById(person.id!);
      expect(found).toBeDefined();
      expect(found?.name).toBe('John Smith');
    });

    it('should be able to read Issue370Person by ID after creation', async () => {
      const persons = await Issue370PersonCollection.create({ db });

      const created = await persons.create({
        _meta_type: 'Issue370Person',
        name: 'Jane Doe',
      });

      expect(created.id).toBeDefined();
      expect(created.id).not.toBeNull();

      const found = await persons.findById(created.id!);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe('Jane Doe');
    });
  });

  describe('Multi-Level STI - Field Hydration', () => {
    it('should persist and load Issue370Council fields correctly', async () => {
      const councils = await Issue370CouncilCollection.create({ db });

      const council = await councils.create({
        _meta_type: 'Issue370Council',
        name: 'Springfield City Council',
        meetingsUrl: 'https://springfield.gov/meetings',
        timezone: 'America/Edmonton',
      });

      // Load from database
      const loaded = await councils.findById(council.id!);

      // ISSUE: Fields should have values but may return null
      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe(council.id);
      expect(loaded?.name).toBe('Springfield City Council');
      expect(loaded?.meetingsUrl).toBe('https://springfield.gov/meetings');
      expect(loaded?.timezone).toBe('America/Edmonton');
    });

    it('should hydrate inherited fields from Issue370Organization and Issue370Profile', async () => {
      const councils = await Issue370CouncilCollection.create({ db });

      const council = await councils.create({
        _meta_type: 'Issue370Council',
        name: 'Metro Council',
        bio: 'Metropolitan government',
        website: 'https://metro.gov',
        foundedYear: 1950,
        meetingsUrl: 'https://metro.gov/meetings',
      });

      const loaded = await councils.findById(council.id!);

      // Issue370Profile fields (base)
      expect(loaded?.name).toBe('Metro Council');
      expect(loaded?.bio).toBe('Metropolitan government');

      // Issue370Organization fields (middle level)
      expect(loaded?.website).toBe('https://metro.gov');
      expect(loaded?.foundedYear).toBe(1950);

      // Issue370Council fields (leaf level - Meta<T>)
      expect(loaded?.meetingsUrl).toBe('https://metro.gov/meetings');
    });

    it('should list Issue370Councils with correct field values', async () => {
      const councils = await Issue370CouncilCollection.create({ db });

      await councils.create({
        _meta_type: 'Issue370Council',
        name: 'Council A',
        meetingsUrl: 'https://a.gov/meetings',
      });

      await councils.create({
        _meta_type: 'Issue370Council',
        name: 'Council B',
        meetingsUrl: 'https://b.gov/meetings',
      });

      const all = await councils.list({});

      expect(all.length).toBeGreaterThanOrEqual(2);
      const councilA = all.find((c) => c.name === 'Council A');
      const councilB = all.find((c) => c.name === 'Council B');

      expect(councilA).toBeDefined();
      expect(councilA?.name).toBe('Council A');
      expect(councilA?.meetingsUrl).toBe('https://a.gov/meetings');

      expect(councilB).toBeDefined();
      expect(councilB?.name).toBe('Council B');
      expect(councilB?.meetingsUrl).toBe('https://b.gov/meetings');
    });
  });

  describe('STI Meta Field Serialization', () => {
    it('should store Issue370Council meta fields in _meta_data', async () => {
      const councils = await Issue370CouncilCollection.create({ db });

      const council = await councils.create({
        _meta_type: 'Issue370Council',
        name: 'Test Council',
        meetingsUrl: 'https://test.gov/meetings',
        timezone: 'America/Vancouver',
      });

      // Query database directly to inspect _meta_data column
      const row = await db.get('issue370profiles', { id: council.id });

      expect(row).toBeDefined();
      expect(row?._meta_type).toBe('Issue370Council');
      expect(row?._meta_data).toBeDefined();

      // Meta fields should be in _meta_data JSON
      const metaData =
        typeof row?._meta_data === 'string'
          ? JSON.parse(row?._meta_data)
          : row?._meta_data;

      expect(metaData.meetingsUrl).toBe('https://test.gov/meetings');
      expect(metaData.timezone).toBe('America/Vancouver');
    });

    it('should handle polymorphic queries across STI hierarchy', async () => {
      const profiles = await Issue370ProfileCollection.create({ db });

      // Create instances of all three types
      await profiles.create({
        _meta_type: 'Issue370Profile',
        name: 'Plain Profile',
      });

      await profiles.create({
        _meta_type: 'Issue370Person',
        name: 'John Doe',
      });

      await profiles.create({
        _meta_type: 'Issue370Organization',
        name: 'Acme Corp',
        website: 'https://acme.com',
      });

      // Polymorphic query should return all types
      const all = await profiles.list({});

      expect(all.length).toBeGreaterThanOrEqual(3);

      const profile = all.find(
        (p) => (p as any)._meta_type === 'Issue370Profile',
      );
      const person = all.find(
        (p) => (p as any)._meta_type === 'Issue370Person',
      );
      const org = all.find(
        (p) => (p as any)._meta_type === 'Issue370Organization',
      );

      expect(profile).toBeDefined();
      expect(person).toBeDefined();
      expect(org).toBeDefined();

      // Each should be properly typed
      expect(profile?.name).toBe('Plain Profile');
      expect(person?.name).toBe('John Doe');
      expect(org?.name).toBe('Acme Corp');
    });
  });
});
