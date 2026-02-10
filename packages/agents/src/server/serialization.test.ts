/**
 * Tests for serializeResolvedAgent.
 */

import { describe, expect, it } from 'vitest';
import type { ResolvedAgentAvailability } from '../tenant-agent.js';
import type { AgentManifestInfo } from '../ui.js';
import { serializeResolvedAgent } from './serialization.js';

function createManifest(
  overrides: Partial<AgentManifestInfo> = {},
): AgentManifestInfo {
  return {
    name: 'Praeco',
    slug: 'praeco',
    icon: 'newspaper',
    tier: 'standard',
    description: 'Council meeting agent',
    uiSlots: {
      sources: { id: 'sources', label: 'Sources' },
      reports: { id: 'reports', label: 'Reports' },
    },
    adminRoutes: [
      { path: 'sources', component: 'SourcesPanel' },
      {
        path: 'sources/[sourceId]',
        component: 'SourceDetail',
        load: 'loadSourceDetail',
      },
    ],
    permissions: [
      { id: 'read', label: 'Read', category: 'data', defaultGranted: true },
    ],
    features: [],
    menuItems: [],
    components: [],
    ...overrides,
  };
}

describe('serializeResolvedAgent', () => {
  it('should serialize a resolved agent with manifest', () => {
    const manifest = createManifest();
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      status: 'active',
      source: 'explicit',
      sourceTenantId: 'tenant-1',
      permissions: { read: true, write: false },
      agentId: 'agent-123',
      manifest,
      config: { key: 'value' },
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.id).toBe('agent-123');
    expect(result.name).toBe('Praeco');
    expect(result.agentClass).toBe('Praeco');
    expect(result._meta_type).toBe('Praeco');
    expect(result.source).toBe('explicit');
    expect(result.sourceTenantId).toBe('tenant-1');
    expect(result.permissions).toEqual({ read: true, write: false });
    expect(result.icon).toBe('newspaper');
    expect(result.config).toEqual({ key: 'value' });
  });

  it('should include slots from manifest', () => {
    const manifest = createManifest();
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      status: 'active',
      source: 'explicit',
      sourceTenantId: 'tenant-1',
      permissions: {},
      manifest,
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.slots).toBeDefined();
    expect(result.slots?.sources.label).toBe('Sources');
    expect(result.slots?.reports.label).toBe('Reports');
  });

  it('should include adminRoutes from manifest', () => {
    const manifest = createManifest();
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      status: 'active',
      source: 'explicit',
      sourceTenantId: 'tenant-1',
      permissions: {},
      manifest,
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.adminRoutes).toHaveLength(2);
    expect(result.adminRoutes?.[0].path).toBe('sources');
    expect(result.adminRoutes?.[1].load).toBe('loadSourceDetail');
  });

  it('should generate synthetic ID when agentId is missing', () => {
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Caelus',
      status: 'active',
      source: 'inherited',
      sourceTenantId: 'parent-tenant',
      permissions: {},
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.id).toBe('parent-tenant:Caelus');
  });

  it('should use agentClass as name when manifest is missing', () => {
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Caelus',
      status: 'active',
      source: 'inherited',
      sourceTenantId: 'tenant-1',
      permissions: {},
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.name).toBe('Caelus');
    expect(result.icon).toBeUndefined();
    expect(result.slots).toBeUndefined();
    expect(result.adminRoutes).toBeUndefined();
  });

  it('should handle inherited source', () => {
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      status: 'active',
      source: 'inherited',
      sourceTenantId: 'root-tenant',
      permissions: { read: true },
      agentId: 'agent-456',
      manifest: createManifest(),
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.source).toBe('inherited');
    expect(result.sourceTenantId).toBe('root-tenant');
  });

  it('should handle undefined config', () => {
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      status: 'active',
      source: 'explicit',
      sourceTenantId: 'tenant-1',
      permissions: {},
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.config).toBeUndefined();
  });

  it('should handle empty permissions', () => {
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      status: 'active',
      source: 'explicit',
      sourceTenantId: 'tenant-1',
      permissions: {},
      manifest: createManifest(),
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.permissions).toEqual({});
  });
});
