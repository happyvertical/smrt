/**
 * SiteCollection tests
 *
 * Tests for collection query methods:
 * 1. findByDomain
 * 2. findByTenant
 * 3. findByStatus
 * 4. findActive
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteCollection } from '../collections/SiteCollection';

describe('SiteCollection', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `smrt-site-collection-test-${Date.now()}.db`);
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

  it('should find site by domain', async () => {
    const sites = await SiteCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    await (
      await sites.create({
        tenantId: 'tenant-1',
        name: 'Site A',
        domain: 'site-a.com',
      })
    ).save();
    await (
      await sites.create({
        tenantId: 'tenant-1',
        name: 'Site B',
        domain: 'site-b.com',
      })
    ).save();

    const found = await sites.findByDomain('site-a.com');
    expect(found).toBeDefined();
    expect(found?.name).toBe('Site A');

    const notFound = await sites.findByDomain('nonexistent.com');
    expect(notFound).toBeNull();
  });

  it('should find sites by tenant', async () => {
    const sites = await SiteCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    await (
      await sites.create({
        name: 'T1-A',
        domain: 't1a.com',
        tenantId: 'tenant-1',
      })
    ).save();
    await (
      await sites.create({
        name: 'T1-B',
        domain: 't1b.com',
        tenantId: 'tenant-1',
      })
    ).save();
    await (
      await sites.create({
        name: 'T2-A',
        domain: 't2a.com',
        tenantId: 'tenant-2',
      })
    ).save();

    const t1Sites = await sites.findByTenant('tenant-1');
    expect(t1Sites).toHaveLength(2);
    expect(t1Sites.map((s) => s.name).sort()).toEqual(['T1-A', 'T1-B']);
  });

  it('should find sites by status', async () => {
    const sites = await SiteCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    await (
      await sites.create({
        tenantId: 'tenant-1',
        name: 'Active 1',
        domain: 'a1.com',
        status: 'active',
      })
    ).save();
    await (
      await sites.create({
        tenantId: 'tenant-1',
        name: 'Draft 1',
        domain: 'd1.com',
        status: 'draft',
      })
    ).save();
    await (
      await sites.create({
        tenantId: 'tenant-1',
        name: 'Active 2',
        domain: 'a2.com',
        status: 'active',
      })
    ).save();

    const active = await sites.findByStatus('active');
    expect(active).toHaveLength(2);

    const drafts = await sites.findByStatus('draft');
    expect(drafts).toHaveLength(1);
  });

  it('should find active sites', async () => {
    const sites = await SiteCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    await (
      await sites.create({
        tenantId: 'tenant-1',
        name: 'Active',
        domain: 'active.com',
        status: 'active',
      })
    ).save();
    await (
      await sites.create({
        tenantId: 'tenant-1',
        name: 'Suspended',
        domain: 'suspended.com',
        status: 'suspended',
      })
    ).save();
    await (
      await sites.create({
        tenantId: 'tenant-1',
        name: 'Archived',
        domain: 'archived.com',
        status: 'archived',
      })
    ).save();

    const active = await sites.findActive();
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('Active');
  });
});
