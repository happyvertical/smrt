/**
 * Tests for serializeResolvedAgent.
 */

import { describe, expect, it } from 'vitest';
import type { ResolvedAgentAvailability } from '../tenant-agent.js';
import type { AgentManifestInfo } from '../ui.js';
import { serializeResolvedAgent } from './serialization.js';

const PRAECO_TYPE = '@happyvertical/smrt-agents:Praeco';
const CAELUS_TYPE = '@happyvertical/smrt-agents:Caelus';

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
      agentType: PRAECO_TYPE,
      status: 'active',
      source: 'explicit',
      sourceTenantId: 'tenant-1',
      permissions: { read: true, write: false },
      agentId: 'agent-123',
      manifest,
      // Non-secret key — survives sanitizeConfig (#1553). A bare `key` would be
      // stripped as secret-shaped; secret handling is covered by its own test.
      config: { setting: 'value' },
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.id).toBe('agent-123');
    expect(result.name).toBe('Praeco');
    expect(result.agentClass).toBe('Praeco');
    expect(result.agentType).toBe(PRAECO_TYPE);
    expect(result._meta_type).toBe(PRAECO_TYPE);
    expect(result.source).toBe('explicit');
    expect(result.sourceTenantId).toBe('tenant-1');
    expect(result.permissions).toEqual({ read: true, write: false });
    expect(result.icon).toBe('newspaper');
    expect(result.config).toEqual({ setting: 'value' });
  });

  it('should include slots from manifest', () => {
    const manifest = createManifest();
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      agentType: PRAECO_TYPE,
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
      agentType: PRAECO_TYPE,
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
      agentType: CAELUS_TYPE,
      status: 'active',
      source: 'inherited',
      sourceTenantId: 'parent-tenant',
      permissions: {},
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.id).toBe(`parent-tenant:${CAELUS_TYPE}`);
  });

  it('should use agentClass as name when manifest is missing', () => {
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Caelus',
      agentType: CAELUS_TYPE,
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
      agentType: PRAECO_TYPE,
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
      agentType: PRAECO_TYPE,
      status: 'active',
      source: 'explicit',
      sourceTenantId: 'tenant-1',
      permissions: {},
    };

    const result = serializeResolvedAgent(resolved);

    expect(result.config).toBeUndefined();
  });

  it('secret-sanitizes config before it reaches the client (#1553)', () => {
    // Assemble fake secret tokens from fragments so the test source never
    // contains a contiguous secret-shaped literal (repo convention — avoids
    // tripping secret-scanning / push-protection on fake keys).
    const fakeSkValue = ['sk', 'ant', 'deadbeefdeadbeefdeadbeef'].join('-');
    const fakeApiKeyValue = ['sk', 'ant', 'fakekeyfakekeyfakekey'].join('-');

    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      agentType: PRAECO_TYPE,
      status: 'active',
      source: 'explicit',
      sourceTenantId: 'tenant-1',
      permissions: {},
      config: {
        // Non-secret keys must survive for the admin UI to display.
        endpoint: 'https://api.example.com',
        model: 'sonnet',
        nested: { region: 'us-east', password: 'hunter2' },
        // Secret-shaped keys must be dropped.
        apiKey: fakeApiKeyValue,
        authToken: 'super-secret',
        // Secret-shaped value under a benign key must be masked.
        note: `use ${fakeSkValue} for access`,
      },
    };

    const result = serializeResolvedAgent(resolved);
    const config = result.config as Record<string, any>;

    // Non-secret keys preserved.
    expect(config.endpoint).toBe('https://api.example.com');
    expect(config.model).toBe('sonnet');
    expect(config.nested.region).toBe('us-east');

    // Secret-shaped keys stripped (top-level and nested).
    expect(config.apiKey).toBeUndefined();
    expect(config.authToken).toBeUndefined();
    expect(config.nested.password).toBeUndefined();

    // Secret-shaped value under a benign key is masked (not removed, not
    // passed through verbatim).
    expect(config.note).toBe('use *** for access');
    expect(config.note).toContain('***');
    expect(config.note).not.toContain(fakeSkValue);

    // No raw secret material anywhere in the serialized payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain(fakeApiKeyValue);
    expect(serialized).not.toContain(fakeSkValue);
  });

  it('should handle empty permissions', () => {
    const resolved: ResolvedAgentAvailability = {
      agentClass: 'Praeco',
      agentType: PRAECO_TYPE,
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
