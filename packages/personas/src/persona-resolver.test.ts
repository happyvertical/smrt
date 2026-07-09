/**
 * Tests for PersonaResolver.
 *
 * Exercises the layering (manifest defaults → TenantAgent gate/ceiling →
 * AgentPersona), tenant-hierarchy inheritance, context specificity, priority
 * ordering, and the defined default fallback.
 *
 * Like `tenant-agent.test.ts`, resolution walks across tenants, so these tests
 * run with the tenancy interceptor disabled and seed `tenantId` explicitly.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentPersonaCollection,
  canonicalAgentClass,
} from './agent-persona.js';
import {
  availabilityFromResolvedAgent,
  type ManifestPersonaDefaults,
  PersonaResolver,
} from './persona-resolver.js';

const PRAECO = '@happyvertical/smrt-agents:Praeco';

// A decorator-registered agent class so its simple name canonicalizes to a
// distinct qualified name — the alias mismatch codex flagged. (Manifest-loaded
// classes do not populate a qualified name under a simple-name lookup in this
// test env, so a locally-declared @smrt() class is what actually exercises it.)
@smrt()
class DemoResolverAgent extends SmrtObject {}

interface SeedOptions {
  tenantId: string;
  name: string;
  agentClass?: string;
  instructions?: string;
  allowedTools?: string[];
  contextType?: string | null;
  contextId?: string | null;
  priority?: number;
  enabled?: boolean;
  runAsUserId?: string;
  actsAsProfileId?: string | null;
  memoryScope?: string;
}

describe('PersonaResolver', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let personas: AgentPersonaCollection;
  let resolver: PersonaResolver;

  beforeEach(async () => {
    // Resolution reads across tenants — keep the interceptor off so ancestor
    // reads are not filtered/blocked. Use disableTenancy() (not resetTenancy)
    // to avoid clearing the shared @TenantScoped registry other test files rely
    // on within the same worker process.
    disableTenancy();
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: ['AgentPersona'],
    });
    personas = await AgentPersonaCollection.create({ db: ctx.db });
    resolver = new PersonaResolver(personas);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function seed(options: SeedOptions) {
    const persona = await personas.create({
      tenantId: options.tenantId,
      agentClass: options.agentClass ?? PRAECO,
      name: options.name,
      instructions: options.instructions ?? '',
      contextType: options.contextType ?? null,
      contextId: options.contextId ?? null,
      priority: options.priority ?? 0,
      enabled: options.enabled ?? true,
      runAsUserId: options.runAsUserId ?? 'user-1',
      actsAsProfileId: options.actsAsProfileId ?? null,
      memoryScope: options.memoryScope ?? '',
    });
    if (options.allowedTools) {
      persona.setAllowedTools(options.allowedTools);
      await persona.save();
    }
    return persona;
  }

  describe('default fallback', () => {
    it('returns a defined default when no persona exists', async () => {
      const resolved = await resolver.resolve('tenant-a', PRAECO);

      expect(resolved.source).toBe('default');
      expect(resolved.name).toBe('default');
      expect(resolved.agentClass).toBe(PRAECO);
      expect(resolved.tenantId).toBe('tenant-a');
      expect(resolved.instructions).toBe('');
      expect(resolved.allowedTools).toEqual([]);
      expect(resolved.available).toBe(true);
      // Derived memory scope keeps agents partitioned by class + tenant.
      expect(resolved.memoryScope).toBe(`${PRAECO}:tenant-a`);
    });

    it('layers manifest defaults into the fallback', async () => {
      const manifestDefaults: ManifestPersonaDefaults = {
        instructions: 'Default instructions.',
        allowedTools: ['search'],
        memoryScope: 'manifest-scope',
      };
      const resolved = await resolver.resolve(
        'tenant-a',
        PRAECO,
        {},
        {
          manifestDefaults,
        },
      );

      expect(resolved.source).toBe('default');
      expect(resolved.instructions).toBe('Default instructions.');
      expect(resolved.allowedTools).toEqual(['search']);
      expect(resolved.memoryScope).toBe('manifest-scope');
    });
  });

  describe('explicit resolution', () => {
    it("returns the tenant's own persona over the default", async () => {
      await seed({
        tenantId: 'tenant-a',
        name: 'Support',
        instructions: 'Tenant instructions.',
        allowedTools: ['search', 'summarize'],
      });

      const resolved = await resolver.resolve('tenant-a', PRAECO);
      expect(resolved.source).toBe('persona');
      expect(resolved.personaSource).toBe('explicit');
      expect(resolved.sourceTenantId).toBe('tenant-a');
      expect(resolved.name).toBe('Support');
      expect(resolved.instructions).toBe('Tenant instructions.');
      expect(resolved.allowedTools).toEqual(['search', 'summarize']);
    });

    it('falls back to manifest instructions when the persona leaves them blank', async () => {
      await seed({ tenantId: 'tenant-a', name: 'Blank', instructions: '' });

      const resolved = await resolver.resolve(
        'tenant-a',
        PRAECO,
        {},
        {
          manifestDefaults: { instructions: 'Manifest instructions.' },
        },
      );
      expect(resolved.source).toBe('persona');
      expect(resolved.instructions).toBe('Manifest instructions.');
    });

    it('resolves a persona stored under a simple class name via canonical lookup', async () => {
      const simple = 'DemoResolverAgent';
      const canonical = canonicalAgentClass(simple);
      // Precondition: registration canonicalizes the simple name to a distinct
      // qualified name, so this genuinely exercises the alias bridge.
      expect(canonical).not.toBe(simple);
      expect(canonical.endsWith(':DemoResolverAgent')).toBe(true);

      // Persisted under the SIMPLE name (as an un-normalized generated write
      // would store it).
      await seed({
        tenantId: 'tenant-a',
        name: 'SimpleStored',
        agentClass: simple,
      });

      // Looked up by the canonical qualified name — the alias-aware lookup
      // still finds the simple-named row.
      const resolved = await resolver.resolve('tenant-a', canonical);
      expect(resolved.source).toBe('persona');
      expect(resolved.name).toBe('SimpleStored');
    });
  });

  describe('tenant-hierarchy inheritance', () => {
    const getAncestorIds = async (tenantId: string): Promise<string[]> => {
      if (tenantId === 'child') return ['parent', 'root'];
      if (tenantId === 'parent') return ['root'];
      return [];
    };

    it('inherits a persona from the parent tenant', async () => {
      await seed({
        tenantId: 'parent',
        name: 'Inherited',
        instructions: 'From parent.',
      });

      const resolved = await resolver.resolve(
        'child',
        PRAECO,
        {},
        {
          getAncestorIds,
        },
      );
      expect(resolved.source).toBe('persona');
      expect(resolved.personaSource).toBe('inherited');
      expect(resolved.sourceTenantId).toBe('parent');
      expect(resolved.name).toBe('Inherited');
      expect(resolved.instructions).toBe('From parent.');
      // The result is still reported for the requesting tenant.
      expect(resolved.tenantId).toBe('child');
    });

    it('prefers the closer ancestor over a more distant one', async () => {
      await seed({ tenantId: 'root', name: 'RootPersona' });
      await seed({ tenantId: 'parent', name: 'ParentPersona' });

      const resolved = await resolver.resolve(
        'child',
        PRAECO,
        {},
        {
          getAncestorIds,
        },
      );
      expect(resolved.name).toBe('ParentPersona');
      expect(resolved.sourceTenantId).toBe('parent');
    });

    it("prefers the tenant's own persona over an inherited one", async () => {
      await seed({ tenantId: 'parent', name: 'ParentPersona' });
      await seed({ tenantId: 'child', name: 'ChildPersona' });

      const resolved = await resolver.resolve(
        'child',
        PRAECO,
        {},
        {
          getAncestorIds,
        },
      );
      expect(resolved.name).toBe('ChildPersona');
      expect(resolved.personaSource).toBe('explicit');
      expect(resolved.sourceTenantId).toBe('child');
    });

    it('inherits from a grandparent through the chain', async () => {
      await seed({ tenantId: 'root', name: 'RootPersona' });

      const resolved = await resolver.resolve(
        'child',
        PRAECO,
        {},
        {
          getAncestorIds,
        },
      );
      expect(resolved.name).toBe('RootPersona');
      expect(resolved.sourceTenantId).toBe('root');
    });
  });

  describe('priority ordering', () => {
    it('selects the highest-priority persona at a tenant level', async () => {
      await seed({ tenantId: 'tenant-a', name: 'Low', priority: 1 });
      await seed({ tenantId: 'tenant-a', name: 'High', priority: 10 });
      await seed({ tenantId: 'tenant-a', name: 'Mid', priority: 5 });

      const resolved = await resolver.resolve('tenant-a', PRAECO);
      expect(resolved.name).toBe('High');
      expect(resolved.priority).toBe(10);
    });
  });

  describe('context specificity', () => {
    it('prefers an exact context match over type-scoped and tenant-wide', async () => {
      await seed({ tenantId: 'tenant-a', name: 'Wide' });
      await seed({
        tenantId: 'tenant-a',
        name: 'TypeScoped',
        contextType: 'site',
      });
      await seed({
        tenantId: 'tenant-a',
        name: 'Exact',
        contextType: 'site',
        contextId: 'site-1',
        // Lower priority than the others to prove specificity beats priority.
        priority: 0,
      });
      await seed({ tenantId: 'tenant-a', name: 'WideHigh', priority: 99 });

      const resolved = await resolver.resolve('tenant-a', PRAECO, {
        contextType: 'site',
        contextId: 'site-1',
      });
      expect(resolved.name).toBe('Exact');
    });

    it('ignores personas scoped to a different context', async () => {
      await seed({
        tenantId: 'tenant-a',
        name: 'OtherSite',
        contextType: 'site',
        contextId: 'site-2',
      });

      const resolved = await resolver.resolve('tenant-a', PRAECO, {
        contextType: 'site',
        contextId: 'site-1',
      });
      // No applicable persona → default fallback.
      expect(resolved.source).toBe('default');
    });

    it('applies a tenant-wide default to any context', async () => {
      await seed({ tenantId: 'tenant-a', name: 'Wide' });

      const resolved = await resolver.resolve('tenant-a', PRAECO, {
        contextType: 'site',
        contextId: 'site-1',
      });
      expect(resolved.name).toBe('Wide');
      expect(resolved.contextType).toBe('site');
      expect(resolved.contextId).toBe('site-1');
    });
  });

  describe('enabled filtering', () => {
    it('skips disabled personas', async () => {
      await seed({
        tenantId: 'tenant-a',
        name: 'Disabled',
        enabled: false,
        priority: 100,
      });

      const resolved = await resolver.resolve('tenant-a', PRAECO);
      expect(resolved.source).toBe('default');
    });
  });

  describe('TenantAgent ceiling + availability gate', () => {
    it('caps allowedTools to the availability ceiling', async () => {
      await seed({
        tenantId: 'tenant-a',
        name: 'Tooled',
        allowedTools: ['search', 'summarize', 'delete'],
      });

      const resolved = await resolver.resolve(
        'tenant-a',
        PRAECO,
        {},
        {
          availability: {
            status: 'active',
            toolCeiling: ['search', 'summarize'],
          },
        },
      );
      expect(resolved.allowedTools).toEqual(['search', 'summarize']);
      expect(resolved.available).toBe(true);
    });

    it('marks the persona unavailable when the TenantAgent gate is disabled', async () => {
      await seed({ tenantId: 'tenant-a', name: 'Support' });

      const resolved = await resolver.resolve(
        'tenant-a',
        PRAECO,
        {},
        {
          availability: { status: 'disabled' },
        },
      );
      expect(resolved.source).toBe('persona');
      expect(resolved.available).toBe(false);
    });

    it('passes tools through unchanged when no ceiling is set', async () => {
      await seed({
        tenantId: 'tenant-a',
        name: 'Tooled',
        allowedTools: ['search', 'summarize'],
      });

      const resolved = await resolver.resolve(
        'tenant-a',
        PRAECO,
        {},
        {
          availability: { status: 'active' },
        },
      );
      expect(resolved.allowedTools).toEqual(['search', 'summarize']);
    });
  });

  describe('availabilityFromResolvedAgent', () => {
    it('returns null for a missing resolution', () => {
      expect(availabilityFromResolvedAgent(null)).toBeNull();
      expect(availabilityFromResolvedAgent(undefined)).toBeNull();
    });

    it('maps status and derives a tool ceiling from prefixed permissions', () => {
      const gate = availabilityFromResolvedAgent(
        {
          agentClass: 'Praeco',
          agentType: PRAECO,
          status: 'active',
          source: 'explicit',
          sourceTenantId: 'tenant-a',
          permissions: {
            'tool:search': true,
            'tool:delete': false,
            'manage:sources': true,
          },
        },
        { toolPermissionPrefix: 'tool:' },
      );

      expect(gate).not.toBeNull();
      expect(gate?.status).toBe('active');
      expect(gate?.sourceTenantId).toBe('tenant-a');
      expect(gate?.toolCeiling).toEqual(['search']);
    });

    it('leaves the ceiling open when no prefix is given', () => {
      const gate = availabilityFromResolvedAgent({
        agentClass: 'Praeco',
        agentType: PRAECO,
        status: 'disabled',
        source: 'inherited',
        sourceTenantId: 'root',
        permissions: {},
      });
      expect(gate?.status).toBe('disabled');
      expect(gate?.toolCeiling).toBeUndefined();
    });
  });
});
