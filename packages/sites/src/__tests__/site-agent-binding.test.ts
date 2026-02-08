/**
 * SiteAgentBinding model tests
 *
 * Tests for:
 * 1. Binding CRUD operations
 * 2. Config handling (JSON field)
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteAgentBindingCollection } from '../collections/SiteAgentBindingCollection';

describe('SiteAgentBinding', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `smrt-binding-test-${Date.now()}.db`);
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

  describe('Basic CRUD', () => {
    it('should create a binding', async () => {
      const bindings = await SiteAgentBindingCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const binding = await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        agentClass: 'Praeco',
        enabled: true,
        priority: 10,
      });

      expect(binding.id).toBeDefined();
      expect(binding.siteId).toBe('site-1');
      expect(binding.agentClass).toBe('Praeco');
      expect(binding.enabled).toBe(true);
      expect(binding.priority).toBe(10);
    });

    it('should preserve data through save/load cycle', async () => {
      const bindings = await SiteAgentBindingCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const binding = await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-2',
        agentClass: 'Caelus',
        enabled: false,
        priority: 5,
        config: { forecastDays: 7 },
      });
      await binding.save();

      const loaded = await bindings.get({ id: binding.id });
      expect(loaded).toBeDefined();
      expect(loaded?.siteId).toBe('site-2');
      expect(loaded?.agentClass).toBe('Caelus');
      expect(loaded?.enabled).toBe(false);
      expect(loaded?.priority).toBe(5);
    });

    it('should delete a binding', async () => {
      const bindings = await SiteAgentBindingCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const binding = await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-3',
        agentClass: 'Ludis',
      });
      await binding.save();

      await binding.delete();

      const loaded = await bindings.get({ id: binding.id });
      expect(loaded).toBeNull();
    });
  });

  describe('Config handling', () => {
    it('should store and retrieve config', async () => {
      const bindings = await SiteAgentBindingCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const binding = await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-4',
        agentClass: 'Praeco',
        config: { sources: ['url1', 'url2'], maxArticles: 5 },
      });
      await binding.save();

      const loaded = await bindings.get({ id: binding.id });
      expect(loaded?.config).toBeDefined();
    });

    it('should handle null config', async () => {
      const bindings = await SiteAgentBindingCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const binding = await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-5',
        agentClass: 'Aedile',
        config: null,
      });

      expect(binding.config).toBeNull();
    });
  });
});
