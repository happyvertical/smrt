/**
 * Property model tests
 *
 * Tests for:
 * 1. Property CRUD operations
 * 2. Property status management
 * 3. Property-Zone relationships
 * 4. STI polymorphic save/load
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Meta,
  ObjectRegistry,
  SmrtCollection,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PropertyCollection } from '../collections/Properties';
import { Property } from '../models/Property';

// STI subclass for testing
@smrt()
class TestSite extends Property {
  static readonly _meta_type = 'TestSite';
  databaseUrl: Meta<string> = '';
  agents: Meta<string[]> = [];
}

class TestSiteCollection extends SmrtCollection<TestSite> {
  static readonly _itemClass = TestSite;
}

describe('Property', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `smrt-property-test-${Date.now()}.db`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Basic CRUD Operations', () => {
    it('should create a property', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const property = await properties.create({
        name: 'Oak Creek News',
        domain: 'oakcreeknews.com',
        url: 'https://oakcreeknews.com',
        status: 'active',
      });

      expect(property.id).toBeDefined();
      expect(property.name).toBe('Oak Creek News');
      expect(property.domain).toBe('oakcreeknews.com');
      expect(property.status).toBe('active');
    });

    it('should preserve data through save/load cycle', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const property = await properties.create({
        name: 'Test Site',
        domain: 'test.com',
        url: 'https://test.com',
        description: 'A test site',
      });
      await property.save();

      const loaded = await properties.get({ id: property.id });
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Test Site');
      expect(loaded?.domain).toBe('test.com');
      expect(loaded?.description).toBe('A test site');
    });

    it('should update property fields', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const property = await properties.create({
        name: 'Original Name',
        domain: 'original.com',
      });
      await property.save();

      property.name = 'Updated Name';
      property.status = 'inactive';
      await property.save();

      const loaded = await properties.get({ id: property.id });
      expect(loaded?.name).toBe('Updated Name');
      expect(loaded?.status).toBe('inactive');
    });

    it('should delete a property', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const property = await properties.create({
        name: 'Deletable',
        domain: 'delete.me',
      });
      await property.save();

      await property.delete();

      const loaded = await properties.get({ id: property.id });
      expect(loaded).toBeNull();
    });
  });

  describe('Status Management', () => {
    it('should check if property is active', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const active = await properties.create({
        name: 'Active Site',
        status: 'active',
      });

      const inactive = await properties.create({
        name: 'Inactive Site',
        status: 'inactive',
      });

      expect(active.isActive()).toBe(true);
      expect(inactive.isActive()).toBe(false);
    });

    it('should find active properties', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await properties.create({ name: 'Site 1', status: 'active' })
      ).save();
      await (
        await properties.create({ name: 'Site 2', status: 'inactive' })
      ).save();
      await (
        await properties.create({ name: 'Site 3', status: 'active' })
      ).save();

      const active = await properties.findActive();
      expect(active).toHaveLength(2);
      expect(active.map((p) => p.name).sort()).toEqual(['Site 1', 'Site 3']);
    });
  });

  describe('Collection Queries', () => {
    it('should find property by domain', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await properties.create({ name: 'Site A', domain: 'site-a.com' })
      ).save();
      await (
        await properties.create({ name: 'Site B', domain: 'site-b.com' })
      ).save();

      const found = await properties.findByDomain('site-a.com');
      expect(found).toBeDefined();
      expect(found?.name).toBe('Site A');

      const notFound = await properties.findByDomain('nonexistent.com');
      expect(notFound).toBeNull();
    });

    it('should get or create by domain', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      // First call creates
      const created = await properties.getOrCreateByDomain('new-site.com', {
        name: 'New Site',
      });
      expect(created.name).toBe('New Site');
      expect(created.domain).toBe('new-site.com');

      // Second call returns existing
      const existing = await properties.getOrCreateByDomain('new-site.com', {
        name: 'Different Name',
      });
      expect(existing.id).toBe(created.id);
      expect(existing.name).toBe('New Site'); // Original name preserved
    });
  });

  describe('Metadata', () => {
    it('should store and retrieve metadata', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const property = await properties.create({
        name: 'Site with Meta',
        metadata: {
          analyticsId: 'UA-12345',
          theme: 'dark',
          features: ['comments', 'newsletter'],
        },
      });
      await property.save();

      const loaded = await properties.get({ id: property.id });
      expect(loaded?.metadata.analyticsId).toBe('UA-12345');
      expect(loaded?.metadata.theme).toBe('dark');
      expect(loaded?.metadata.features).toEqual(['comments', 'newsletter']);
    });
  });

  describe('STI (Single Table Inheritance)', () => {
    beforeEach(() => {
      ObjectRegistry.registerCollection('TestSite', TestSiteCollection);
    });

    it('should save and load STI subclass with _meta_type', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const site = await properties.create({
        _meta_type: 'TestSite',
        name: 'My News Site',
        domain: 'news.example.com',
        databaseUrl: 'postgres://localhost/news',
        agents: ['crawler', 'publisher'],
      });
      await site.save();

      const loaded = await properties.get({ id: site.id });
      expect(loaded).toBeInstanceOf(TestSite);
      expect(loaded?.name).toBe('My News Site');
      expect(loaded?.domain).toBe('news.example.com');
      expect((loaded as TestSite).databaseUrl).toBe(
        'postgres://localhost/news',
      );
      expect((loaded as TestSite).agents).toEqual(['crawler', 'publisher']);
    });

    it('should load base Property with empty _meta_type', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const property = await properties.create({
        name: 'Plain Property',
        domain: 'plain.example.com',
      });
      await property.save();

      const loaded = await properties.get({ id: property.id });
      expect(loaded).toBeInstanceOf(Property);
      expect(loaded).not.toBeInstanceOf(TestSite);
      expect(loaded?.name).toBe('Plain Property');
    });

    it('should return mixed types in polymorphic list', async () => {
      const properties = await PropertyCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await properties.create({
          name: 'Base Property',
          domain: 'base.example.com',
        })
      ).save();

      await (
        await properties.create({
          _meta_type: 'TestSite',
          name: 'Site Property',
          domain: 'site.example.com',
          databaseUrl: 'postgres://localhost/site',
        })
      ).save();

      const all = await properties.list({});
      expect(all).toHaveLength(2);

      const base = all.find((p) => p.domain === 'base.example.com');
      const site = all.find((p) => p.domain === 'site.example.com');

      expect(base).toBeInstanceOf(Property);
      expect(base).not.toBeInstanceOf(TestSite);
      expect(site).toBeInstanceOf(TestSite);
      expect((site as TestSite).databaseUrl).toBe('postgres://localhost/site');
    });
  });
});
