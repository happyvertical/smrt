/**
 * Multi-level STI (Single Table Inheritance) tests
 *
 * Tests that multi-level inheritance hierarchies work correctly with STI,
 * including save operations and field inheritance.
 *
 * Related to issue #332
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

// Simulate multi-level inheritance like Council → Organization → Profile → SmrtObject
// Profile is the STI base class
@smrt({ tableStrategy: 'sti' })
class Profile extends SmrtObject {
  name: string = '';
  bio: string = '';
}

// Organization extends Profile (middle level)
@smrt()
class Organization extends Profile {
  website: string = '';
  foundedYear: number = 0;
}

// Council extends Organization (leaf level)
@smrt()
class Council extends Organization {
  meetingsUrl: string = '';
  jurisdiction: string = '';
}

// Collection for the STI hierarchy
class ProfileCollection extends SmrtCollection<Profile> {
  static readonly _itemClass = Profile;
}

describe('Multi-Level STI Save Operations', () => {
  let db: DatabaseInterface;
  let dbPath: string;
  let profiles: ProfileCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-sti-multilevel-${Date.now()}.db`);
    db = await getDatabase({ type: 'sqlite', url: dbPath });
    profiles = await ProfileCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Save operations', () => {
    it('should save Profile (base class) successfully', async () => {
      const profile = await profiles.create({
        _meta_type: 'Profile',
        name: 'John Doe',
        bio: 'Software developer',
      });

      await expect(profile.save()).resolves.not.toThrow();
      expect(profile.id).toBeDefined();
      expect(profile.name).toBe('John Doe');
      expect(profile.bio).toBe('Software developer');
    });

    it('should save Organization (middle level) successfully', async () => {
      const org = await profiles.create({
        _meta_type: 'Organization',
        name: 'Acme Corp',
        bio: 'We make everything',
        website: 'https://acme.com',
        foundedYear: 1920,
      });

      await expect(org.save()).resolves.not.toThrow();
      expect(org.id).toBeDefined();
      expect(org.name).toBe('Acme Corp');
      expect(org.bio).toBe('We make everything');
      expect((org as any).website).toBe('https://acme.com');
      expect((org as any).foundedYear).toBe(1920);
    });

    it('should save Council (leaf level) successfully', async () => {
      const council = await profiles.create({
        _meta_type: 'Council',
        name: 'Springfield City Council',
        bio: 'Municipal government',
        website: 'https://springfield.gov',
        foundedYear: 1850,
        meetingsUrl: 'https://springfield.gov/meetings',
        jurisdiction: 'Springfield, IL',
      });

      // This is the failing case from issue #332
      await expect(council.save()).resolves.not.toThrow();
      expect(council.id).toBeDefined();
      expect(council.name).toBe('Springfield City Council');
      expect(council.bio).toBe('Municipal government');
      expect((council as any).website).toBe('https://springfield.gov');
      expect((council as any).foundedYear).toBe(1850);
      expect((council as any).meetingsUrl).toBe(
        'https://springfield.gov/meetings',
      );
      expect((council as any).jurisdiction).toBe('Springfield, IL');
    });

    it('should load Council from database with all inherited fields', async () => {
      // Create and save
      const council = await profiles.create({
        _meta_type: 'Council',
        name: 'Springfield City Council',
        bio: 'Municipal government',
        website: 'https://springfield.gov',
        foundedYear: 1850,
        meetingsUrl: 'https://springfield.gov/meetings',
        jurisdiction: 'Springfield, IL',
      });
      await council.save();
      const savedId = council.id;

      // Load from database
      const loaded = await profiles.get({ id: savedId });

      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe(savedId);
      expect(loaded?.name).toBe('Springfield City Council');
      expect(loaded?.bio).toBe('Municipal government');
      expect((loaded as any).website).toBe('https://springfield.gov');
      expect((loaded as any).foundedYear).toBe(1850);
      expect((loaded as any).meetingsUrl).toBe(
        'https://springfield.gov/meetings',
      );
      expect((loaded as any).jurisdiction).toBe('Springfield, IL');
    });
  });

  describe('Polymorphic queries', () => {
    it('should list mixed types in one query', async () => {
      // Create one of each type
      const profile = await profiles.create({
        _meta_type: 'Profile',
        name: 'John Doe',
        bio: 'Developer',
      });
      await profile.save();

      const org = await profiles.create({
        _meta_type: 'Organization',
        name: 'Acme Corp',
        bio: 'Company',
        website: 'https://acme.com',
        foundedYear: 1920,
      });
      await org.save();

      const council = await profiles.create({
        _meta_type: 'Council',
        name: 'Springfield Council',
        bio: 'Government',
        website: 'https://springfield.gov',
        foundedYear: 1850,
        meetingsUrl: 'https://springfield.gov/meetings',
        jurisdiction: 'Springfield',
      });
      await council.save();

      // List all
      const all = await profiles.list({});

      expect(all).toHaveLength(3);
      expect(all.map((p) => p.name)).toContain('John Doe');
      expect(all.map((p) => p.name)).toContain('Acme Corp');
      expect(all.map((p) => p.name)).toContain('Springfield Council');
    });

    it('should filter by discriminator type', async () => {
      // Create one of each type
      await (
        await profiles.create({
          _meta_type: 'Profile',
          name: 'John',
          bio: 'Developer',
        })
      ).save();
      await (
        await profiles.create({
          _meta_type: 'Organization',
          name: 'Acme',
          bio: 'Company',
          website: 'https://acme.com',
        })
      ).save();
      await (
        await profiles.create({
          _meta_type: 'Council',
          name: 'Springfield',
          bio: 'Government',
          meetingsUrl: 'https://gov.com/meetings',
          jurisdiction: 'Springfield, IL',
        })
      ).save();

      // Filter by type
      const councils = await profiles.list({
        where: { _meta_type: 'Council' },
      });

      expect(councils).toHaveLength(1);
      expect(councils[0].name).toBe('Springfield');
    });
  });
});
