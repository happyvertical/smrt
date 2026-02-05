/**
 * Tests for TenantAgent and TenantAgentCollection
 *
 * Tests the tenant-agent binding model, hierarchical resolution,
 * permission merging, and enable/disable/setPermissions operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantAgentCollection } from './tenant-agent.js';
import type { AgentManifestInfo } from './ui.js';

describe('TenantAgentCollection', () => {
  let sharedDb: DatabaseInterface;
  let collection: TenantAgentCollection;
  let testCounter = 0;

  beforeAll(async () => {
    sharedDb = await getTestDatabase();
    // Create UNIQUE index that matches conflictColumns in @smrt() config.
    // getTestDatabase() generates a default (slug, context) UNIQUE index,
    // but TenantAgent uses conflictColumns: ['tenant_id', 'agent_class']
    await sharedDb.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS tenant_agents_tenant_id_agent_class_idx ON tenant_agents (tenant_id, agent_class)',
    );
    collection = await TenantAgentCollection.create({ db: sharedDb });
  });

  beforeEach(() => {
    testCounter++;
  });

  // Unique tenant IDs per test to avoid cross-test pollution
  function tenantId(name: string): string {
    return `tenant-${name}-${testCounter}-${Date.now()}`;
  }

  // Test manifests for permission merging
  const praecoManifest: AgentManifestInfo = {
    name: 'Praeco',
    slug: 'praeco',
    icon: 'newspaper',
    tier: 'standard',
    description: 'News coverage agent',
    uiSlots: {},
    permissions: [
      {
        id: 'manage:sources',
        label: 'Manage Sources',
        category: 'slot',
        defaultGranted: true,
      },
      {
        id: 'manage:reports',
        label: 'Manage Reports',
        category: 'slot',
        defaultGranted: true,
      },
      {
        id: 'execute:discover',
        label: 'Execute discover',
        category: 'method',
        defaultGranted: true,
      },
      {
        id: 'execute:analyze',
        label: 'Execute analyze',
        category: 'method',
        defaultGranted: false,
      },
    ],
    features: [],
    menuItems: [],
    components: [],
  };

  const caelusManifest: AgentManifestInfo = {
    name: 'Caelus',
    slug: 'caelus',
    icon: 'cloud',
    tier: 'free',
    uiSlots: {},
    permissions: [
      {
        id: 'manage:forecasts',
        label: 'Manage Forecasts',
        category: 'slot',
        defaultGranted: true,
      },
    ],
    features: [],
    menuItems: [],
    components: [],
  };

  function manifests(): Map<string, AgentManifestInfo> {
    return new Map([
      ['Praeco', praecoManifest],
      ['Caelus', caelusManifest],
    ]);
  }

  describe('enableAgent', () => {
    it('should create an active tenant-agent binding', async () => {
      const tid = tenantId('enable');
      const entry = await collection.enableAgent(tid, 'Praeco');

      expect(entry.tenantId).toBe(tid);
      expect(entry.agentClass).toBe('Praeco');
      expect(entry.status).toBe('active');
    });

    it('should re-enable a previously disabled agent', async () => {
      const tid = tenantId('reenable');
      await collection.disableAgent(tid, 'Praeco');
      const entry = await collection.enableAgent(tid, 'Praeco');

      expect(entry.status).toBe('active');
    });
  });

  describe('disableAgent', () => {
    it('should create a disabled tenant-agent binding', async () => {
      const tid = tenantId('disable');
      const entry = await collection.disableAgent(tid, 'Praeco');

      expect(entry.tenantId).toBe(tid);
      expect(entry.agentClass).toBe('Praeco');
      expect(entry.status).toBe('disabled');
    });

    it('should disable a previously enabled agent', async () => {
      const tid = tenantId('disableactive');
      await collection.enableAgent(tid, 'Praeco');
      const entry = await collection.disableAgent(tid, 'Praeco');

      expect(entry.status).toBe('disabled');
    });
  });

  describe('clearOverride', () => {
    it('should remove explicit binding', async () => {
      const tid = tenantId('clear');
      await collection.enableAgent(tid, 'Praeco');

      // Verify it exists
      const before = await collection.findByTenantAndClass(tid, 'Praeco');
      expect(before).not.toBeNull();

      await collection.clearOverride(tid, 'Praeco');

      const after = await collection.findByTenantAndClass(tid, 'Praeco');
      expect(after).toBeNull();
    });

    it('should be a no-op when no binding exists', async () => {
      const tid = tenantId('clearnoop');
      // Should not throw
      await collection.clearOverride(tid, 'Praeco');
    });
  });

  describe('setPermissions', () => {
    it('should set permission overrides on existing binding', async () => {
      const tid = tenantId('perms');
      await collection.enableAgent(tid, 'Praeco');

      const entry = await collection.setPermissions(tid, 'Praeco', {
        'execute:analyze': false,
        'manage:sources': true,
      });

      expect(entry.permissions).toEqual({
        'execute:analyze': false,
        'manage:sources': true,
      });
    });

    it('should create binding with permissions if none exists', async () => {
      const tid = tenantId('permsnew');
      const entry = await collection.setPermissions(tid, 'Praeco', {
        'manage:reports': false,
      });

      expect(entry.status).toBe('active');
      expect(entry.permissions).toEqual({
        'manage:reports': false,
      });
    });
  });

  describe('findByTenantAndClass', () => {
    it('should find existing binding', async () => {
      const tid = tenantId('find');
      await collection.enableAgent(tid, 'Praeco');

      const found = await collection.findByTenantAndClass(tid, 'Praeco');
      expect(found).not.toBeNull();
      expect(found?.agentClass).toBe('Praeco');
    });

    it('should return null for non-existent binding', async () => {
      const tid = tenantId('findnone');
      const found = await collection.findByTenantAndClass(tid, 'Praeco');
      expect(found).toBeNull();
    });
  });

  describe('resolveForTenant', () => {
    it('should resolve explicit entries for a tenant', async () => {
      const tid = tenantId('resolve-explicit');
      await collection.enableAgent(tid, 'Praeco');
      await collection.enableAgent(tid, 'Caelus');

      const noAncestors = async () => [];
      const resolved = await collection.resolveForTenant(
        tid,
        noAncestors,
        manifests(),
      );

      expect(resolved).toHaveLength(2);

      const praeco = resolved.find((r) => r.agentClass === 'Praeco');
      expect(praeco).toBeDefined();
      expect(praeco?.status).toBe('active');
      expect(praeco?.source).toBe('explicit');
      expect(praeco?.sourceTenantId).toBe(tid);
      expect(praeco?.manifest).toBe(praecoManifest);

      const caelus = resolved.find((r) => r.agentClass === 'Caelus');
      expect(caelus).toBeDefined();
      expect(caelus?.source).toBe('explicit');
    });

    it('should inherit agents from parent tenant', async () => {
      const parentId = tenantId('parent');
      const childId = tenantId('child');

      // Parent has Praeco enabled
      await collection.enableAgent(parentId, 'Praeco');

      // Child has no explicit bindings
      const getAncestorIds = async (id: string) =>
        id === childId ? [parentId] : [];

      const resolved = await collection.resolveForTenant(
        childId,
        getAncestorIds,
        manifests(),
      );

      expect(resolved).toHaveLength(1);
      expect(resolved[0].agentClass).toBe('Praeco');
      expect(resolved[0].source).toBe('inherited');
      expect(resolved[0].sourceTenantId).toBe(parentId);
    });

    it('should inherit from grandparent through hierarchy', async () => {
      const rootId = tenantId('root');
      const parentId = tenantId('mid');
      const childId = tenantId('leaf');

      // Root has Caelus
      await collection.enableAgent(rootId, 'Caelus');

      // Mid-level has nothing explicit
      // Child has nothing explicit

      const getAncestorIds = async (id: string) => {
        if (id === childId) return [parentId, rootId];
        if (id === parentId) return [rootId];
        return [];
      };

      const resolved = await collection.resolveForTenant(
        childId,
        getAncestorIds,
        manifests(),
      );

      expect(resolved).toHaveLength(1);
      expect(resolved[0].agentClass).toBe('Caelus');
      expect(resolved[0].source).toBe('inherited');
      expect(resolved[0].sourceTenantId).toBe(rootId);
    });

    it('should prefer explicit over inherited', async () => {
      const parentId = tenantId('parent-override');
      const childId = tenantId('child-override');

      // Parent has Praeco active
      await collection.enableAgent(parentId, 'Praeco');

      // Child explicitly disables Praeco
      await collection.disableAgent(childId, 'Praeco');

      const getAncestorIds = async (id: string) =>
        id === childId ? [parentId] : [];

      const resolved = await collection.resolveForTenant(
        childId,
        getAncestorIds,
        manifests(),
      );

      expect(resolved).toHaveLength(1);
      expect(resolved[0].agentClass).toBe('Praeco');
      expect(resolved[0].status).toBe('disabled');
      expect(resolved[0].source).toBe('explicit');
      expect(resolved[0].sourceTenantId).toBe(childId);
    });

    it('should prefer closer ancestor over distant ancestor', async () => {
      const rootId = tenantId('root-close');
      const parentId = tenantId('parent-close');
      const childId = tenantId('child-close');

      // Root enables Praeco
      await collection.enableAgent(rootId, 'Praeco');
      // Parent disables Praeco (closer ancestor)
      await collection.disableAgent(parentId, 'Praeco');

      const getAncestorIds = async (id: string) => {
        if (id === childId) return [parentId, rootId];
        if (id === parentId) return [rootId];
        return [];
      };

      const resolved = await collection.resolveForTenant(
        childId,
        getAncestorIds,
        manifests(),
      );

      const praeco = resolved.find((r) => r.agentClass === 'Praeco');
      expect(praeco).toBeDefined();
      expect(praeco?.status).toBe('disabled');
      expect(praeco?.sourceTenantId).toBe(parentId);
    });

    it('should merge agents from multiple ancestors', async () => {
      const rootId = tenantId('root-multi');
      const parentId = tenantId('parent-multi');
      const childId = tenantId('child-multi');

      // Root has Caelus
      await collection.enableAgent(rootId, 'Caelus');
      // Parent has Praeco
      await collection.enableAgent(parentId, 'Praeco');

      const getAncestorIds = async (id: string) => {
        if (id === childId) return [parentId, rootId];
        if (id === parentId) return [rootId];
        return [];
      };

      const resolved = await collection.resolveForTenant(
        childId,
        getAncestorIds,
        manifests(),
      );

      expect(resolved).toHaveLength(2);
      expect(resolved.map((r) => r.agentClass).sort()).toEqual([
        'Caelus',
        'Praeco',
      ]);
    });

    it('should return empty array when no agents in hierarchy', async () => {
      const tid = tenantId('empty');
      const noAncestors = async () => [];

      const resolved = await collection.resolveForTenant(
        tid,
        noAncestors,
        manifests(),
      );
      expect(resolved).toEqual([]);
    });

    it('should work without manifests parameter', async () => {
      const tid = tenantId('no-manifests');
      await collection.enableAgent(tid, 'Praeco');

      const noAncestors = async () => [];
      const resolved = await collection.resolveForTenant(tid, noAncestors);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].agentClass).toBe('Praeco');
      expect(resolved[0].manifest).toBeUndefined();
      // Without manifest, permissions should be empty (no defaults to merge)
      expect(resolved[0].permissions).toEqual({});
    });
  });

  describe('permission merging', () => {
    it('should use manifest defaults when no overrides', async () => {
      const tid = tenantId('perm-defaults');
      await collection.enableAgent(tid, 'Praeco');

      const noAncestors = async () => [];
      const resolved = await collection.resolveForTenant(
        tid,
        noAncestors,
        manifests(),
      );

      const praeco = resolved.find((r) => r.agentClass === 'Praeco')!;
      expect(praeco.permissions['manage:sources']).toBe(true);
      expect(praeco.permissions['manage:reports']).toBe(true);
      expect(praeco.permissions['execute:discover']).toBe(true);
      // defaultGranted: false
      expect(praeco.permissions['execute:analyze']).toBe(false);
    });

    it('should override manifest defaults with explicit permissions', async () => {
      const tid = tenantId('perm-override');
      await collection.enableAgent(tid, 'Praeco');
      await collection.setPermissions(tid, 'Praeco', {
        'execute:analyze': true,
        'manage:sources': false,
      });

      const noAncestors = async () => [];
      const resolved = await collection.resolveForTenant(
        tid,
        noAncestors,
        manifests(),
      );

      const praeco = resolved.find((r) => r.agentClass === 'Praeco')!;
      // Overridden to true (manifest default was false)
      expect(praeco.permissions['execute:analyze']).toBe(true);
      // Overridden to false (manifest default was true)
      expect(praeco.permissions['manage:sources']).toBe(false);
      // Not overridden, uses manifest default
      expect(praeco.permissions['manage:reports']).toBe(true);
      expect(praeco.permissions['execute:discover']).toBe(true);
    });

    it('should merge inherited permissions with manifest defaults', async () => {
      const parentId = tenantId('perm-parent');
      const childId = tenantId('perm-child');

      // Parent enables Praeco with custom permissions
      await collection.enableAgent(parentId, 'Praeco');
      await collection.setPermissions(parentId, 'Praeco', {
        'manage:reports': false,
      });

      const getAncestorIds = async (id: string) =>
        id === childId ? [parentId] : [];

      const resolved = await collection.resolveForTenant(
        childId,
        getAncestorIds,
        manifests(),
      );

      const praeco = resolved.find((r) => r.agentClass === 'Praeco')!;
      expect(praeco.source).toBe('inherited');
      // Inherited permission override from parent
      expect(praeco.permissions['manage:reports']).toBe(false);
      // Manifest defaults for others
      expect(praeco.permissions['manage:sources']).toBe(true);
    });
  });
});
