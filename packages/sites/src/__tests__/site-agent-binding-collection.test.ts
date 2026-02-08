/**
 * SiteAgentBindingCollection tests
 *
 * Tests for collection query methods:
 * 1. findBySite
 * 2. findByAgent
 * 3. findEnabled
 * 4. findBySiteAndAgent
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteAgentBindingCollection } from '../collections/SiteAgentBindingCollection';

describe('SiteAgentBindingCollection', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `smrt-binding-collection-test-${Date.now()}.db`);
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

  it('should find bindings by site', async () => {
    const bindings = await SiteAgentBindingCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        agentClass: 'Praeco',
      })
    ).save();
    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        agentClass: 'Caelus',
      })
    ).save();
    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-2',
        agentClass: 'Praeco',
      })
    ).save();

    const site1Bindings = await bindings.findBySite('site-1');
    expect(site1Bindings).toHaveLength(2);
  });

  it('should find bindings by agent class', async () => {
    const bindings = await SiteAgentBindingCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        agentClass: 'Praeco',
      })
    ).save();
    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-2',
        agentClass: 'Praeco',
      })
    ).save();
    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-3',
        agentClass: 'Caelus',
      })
    ).save();

    const praecoBindings = await bindings.findByAgent('Praeco');
    expect(praecoBindings).toHaveLength(2);
  });

  it('should find enabled bindings for a site', async () => {
    const bindings = await SiteAgentBindingCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        agentClass: 'Praeco',
        enabled: true,
        priority: 10,
      })
    ).save();
    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        agentClass: 'Caelus',
        enabled: false,
        priority: 5,
      })
    ).save();
    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        agentClass: 'Ludis',
        enabled: true,
        priority: 20,
      })
    ).save();

    const enabled = await bindings.findEnabled('site-1');
    expect(enabled).toHaveLength(2);
    // Should be sorted by priority descending
    expect(enabled[0].agentClass).toBe('Ludis');
    expect(enabled[1].agentClass).toBe('Praeco');
  });

  it('should find specific site-agent binding', async () => {
    const bindings = await SiteAgentBindingCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    await (
      await bindings.create({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        agentClass: 'Praeco',
      })
    ).save();

    const found = await bindings.findBySiteAndAgent('site-1', 'Praeco');
    expect(found).toBeDefined();
    expect(found?.agentClass).toBe('Praeco');

    const notFound = await bindings.findBySiteAndAgent('site-1', 'Nonexistent');
    expect(notFound).toBeNull();
  });
});
