/**
 * Site model tests
 *
 * Tests for:
 * 1. Site CRUD operations
 * 2. Site status management
 * 3. JSON field handling (portalConfig, metadata)
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteCollection } from '../collections/SiteCollection';

describe('Site', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `smrt-site-test-${Date.now()}.db`);
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
    it('should create a site', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const site = await sites.create({
        tenantId: 'tenant-1',
        name: 'Bentley Alberta',
        domain: 'bentleyalberta.com',
        status: 'active',
        tier: 'standard',
      });

      expect(site.id).toBeDefined();
      expect(site.name).toBe('Bentley Alberta');
      expect(site.domain).toBe('bentleyalberta.com');
      expect(site.status).toBe('active');
      expect(site.tier).toBe('standard');
    });

    it('should preserve data through save/load cycle', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const site = await sites.create({
        tenantId: 'tenant-1',
        name: 'Test Site',
        domain: 'test.com',
        tier: 'premium',
        databaseUrl: 'file:./data/test.db',
        databaseType: 'sqlite',
        repositoryUrl: 'https://github.com/org/test',
        templateName: 'default',
      });
      await site.save();

      const loaded = await sites.get({ id: site.id });
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Test Site');
      expect(loaded?.domain).toBe('test.com');
      expect(loaded?.tier).toBe('premium');
      expect(loaded?.databaseUrl).toBe('file:./data/test.db');
      expect(loaded?.databaseType).toBe('sqlite');
      expect(loaded?.repositoryUrl).toBe('https://github.com/org/test');
      expect(loaded?.templateName).toBe('default');
    });

    it('should update site fields', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const site = await sites.create({
        tenantId: 'tenant-1',
        name: 'Original',
        domain: 'original.com',
      });
      await site.save();

      site.name = 'Updated';
      site.status = 'suspended';
      await site.save();

      const loaded = await sites.get({ id: site.id });
      expect(loaded?.name).toBe('Updated');
      expect(loaded?.status).toBe('suspended');
    });

    it('should delete a site', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const site = await sites.create({
        tenantId: 'tenant-1',
        name: 'Deletable',
        domain: 'delete.me',
      });
      await site.save();

      await site.delete();

      const loaded = await sites.get({ id: site.id });
      expect(loaded).toBeNull();
    });
  });

  describe('Status helpers', () => {
    it('should check if site is active', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const active = await sites.create({
        tenantId: 'tenant-1',
        name: 'Active',
        domain: 'active.com',
        status: 'active',
      });

      const draft = await sites.create({
        tenantId: 'tenant-1',
        name: 'Draft',
        domain: 'draft.com',
        status: 'draft',
      });

      expect(active.isActive()).toBe(true);
      expect(draft.isActive()).toBe(false);
    });

    it('should check if site is ready', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const ready = await sites.create({
        tenantId: 'tenant-1',
        name: 'Ready',
        domain: 'ready.com',
        provisioningStatus: 'ready',
      });

      const pending = await sites.create({
        tenantId: 'tenant-1',
        name: 'Pending',
        domain: 'pending.com',
        provisioningStatus: 'pending',
      });

      expect(ready.isReady()).toBe(true);
      expect(pending.isReady()).toBe(false);
    });
  });

  describe('JSON fields', () => {
    it('should store and retrieve portalConfig', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const site = await sites.create({
        tenantId: 'tenant-1',
        name: 'Themed Site',
        domain: 'themed.com',
        portalConfig: {
          theme: 'dark',
          branding: { logo: '/logo.png' },
          navigation: [{ label: 'Home', path: '/' }],
        },
      });
      await site.save();

      const loaded = await sites.get({ id: site.id });
      const config = loaded?.getPortalConfig();
      expect(config?.theme).toBe('dark');
      expect(config?.branding?.logo).toBe('/logo.png');
      expect(config?.navigation).toHaveLength(1);
    });

    it('should store and retrieve metadata', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const site = await sites.create({
        tenantId: 'tenant-1',
        name: 'Meta Site',
        domain: 'meta.com',
        metadata: {
          analyticsId: 'UA-12345',
          features: ['ads', 'newsletter'],
        },
      });
      await site.save();

      const loaded = await sites.get({ id: site.id });
      const meta = loaded?.getMetadata();
      expect(meta?.analyticsId).toBe('UA-12345');
      expect(meta?.features).toEqual(['ads', 'newsletter']);
    });

    it('should merge metadata updates', async () => {
      const sites = await SiteCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const site = await sites.create({
        tenantId: 'tenant-1',
        name: 'Merge Site',
        domain: 'merge.com',
        metadata: { a: 1, b: 2 },
      });
      await site.save();

      // Reload to get the persisted state
      const loaded = await sites.get({ id: site.id });
      expect(loaded).toBeDefined();

      loaded?.updateMetadata({ b: 3, c: 4 });
      expect(loaded?.getMetadata()).toEqual({ a: 1, b: 3, c: 4 });
    });
  });
});
