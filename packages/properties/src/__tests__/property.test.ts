/**
 * Property model tests
 *
 * Tests for:
 * 1. Property CRUD operations
 * 2. Property status management
 * 3. Property-Zone relationships
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PropertyCollection } from '../collections/Properties';

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
});
