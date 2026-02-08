/**
 * SiteService tests
 *
 * Tests for service-layer operations:
 * 1. Site lifecycle (create, activate, suspend, archive)
 * 2. Provisioning status management
 * 3. Agent binding management
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteAgentBindingCollection } from '../collections/SiteAgentBindingCollection';
import { SiteCollection } from '../collections/SiteCollection';
import { SiteService } from '../services/SiteService';

describe('SiteService', () => {
  let dbPath: string;
  let service: SiteService;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-site-service-test-${Date.now()}.db`);
    const dbConfig = { db: { type: 'sqlite' as const, url: dbPath } };

    const sites = await SiteCollection.create(dbConfig);
    const bindings = await SiteAgentBindingCollection.create(dbConfig);
    service = new SiteService({ sites, bindings });
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

  describe('Site lifecycle', () => {
    it('should create a site in draft status', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'New Site',
        domain: 'newsite.com',
      });

      expect(site.status).toBe('draft');
      expect(site.provisioningStatus).toBe('pending');
      expect(site.name).toBe('New Site');
      expect(site.domain).toBe('newsite.com');
      expect(site.tenantId).toBe('tenant-1');
    });

    it('should activate a site', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Activate Me',
        domain: 'activate.com',
      });

      const activated = await service.activateSite(site.id!);
      expect(activated.status).toBe('active');
    });

    it('should reject activation without required fields', async () => {
      const site = await service.createSite('tenant-1', {
        name: '',
        domain: 'no-name.com',
      });

      await expect(service.activateSite(site.id!)).rejects.toThrow(
        'name is required',
      );
    });

    it('should suspend a site', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Suspend Me',
        domain: 'suspend.com',
      });

      const suspended = await service.suspendSite(site.id!);
      expect(suspended.status).toBe('suspended');
    });

    it('should archive a site', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Archive Me',
        domain: 'archive.com',
      });

      const archived = await service.archiveSite(site.id!);
      expect(archived.status).toBe('archived');
    });

    it('should throw for nonexistent site', async () => {
      await expect(service.activateSite('nonexistent')).rejects.toThrow(
        "Site 'nonexistent' not found",
      );
    });
  });

  describe('Provisioning', () => {
    it('should mark site as provisioned', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Provision Me',
        domain: 'provision.com',
      });

      const provisioned = await service.markProvisioned(site.id!);
      expect(provisioned.provisioningStatus).toBe('ready');
      expect(provisioned.provisionedAt).toBeDefined();
      expect(provisioned.provisioningError).toBe('');
    });

    it('should mark provisioning as failed', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Fail Me',
        domain: 'fail.com',
      });

      const failed = await service.markProvisioningFailed(
        site.id!,
        'DNS configuration failed',
      );
      expect(failed.provisioningStatus).toBe('failed');
      expect(failed.provisioningError).toBe('DNS configuration failed');
    });
  });

  describe('Agent bindings', () => {
    it('should bind an agent to a site', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Agent Site',
        domain: 'agent.com',
      });

      const binding = await service.bindAgent(site.id!, 'Praeco', {
        sources: ['url1'],
      });
      expect(binding.siteId).toBe(site.id);
      expect(binding.agentClass).toBe('Praeco');
      expect(binding.enabled).toBe(true);
    });

    it('should re-enable existing binding on rebind', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Rebind Site',
        domain: 'rebind.com',
      });

      const first = await service.bindAgent(site.id!, 'Praeco');
      const second = await service.bindAgent(site.id!, 'Praeco', {
        newConfig: true,
      });

      expect(second.id).toBe(first.id);
      expect(second.enabled).toBe(true);
    });

    it('should unbind an agent from a site', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Unbind Site',
        domain: 'unbind.com',
      });

      await service.bindAgent(site.id!, 'Praeco');
      await service.unbindAgent(site.id!, 'Praeco');

      const enabled = await service.getEnabledAgents(site.id!);
      expect(enabled).toHaveLength(0);
    });

    it('should get enabled agents for a site', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'Multi Agent',
        domain: 'multi.com',
      });

      await service.bindAgent(site.id!, 'Praeco');
      await service.bindAgent(site.id!, 'Caelus');

      const enabled = await service.getEnabledAgents(site.id!);
      expect(enabled).toHaveLength(2);
    });

    it('should handle unbind of nonexistent binding gracefully', async () => {
      const site = await service.createSite('tenant-1', {
        name: 'No Binding',
        domain: 'nobinding.com',
      });

      // Should not throw
      await service.unbindAgent(site.id!, 'Nonexistent');
    });
  });
});
