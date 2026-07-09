/**
 * Tests for AgentPersona and AgentPersonaCollection.
 *
 * Covers CRUD, the `(tenant_id, agent_class, name)` uniqueness constraint,
 * `@TenantScoped` isolation via the tenancy interceptor, cross-package
 * reference registration + round-trip, and the collection helpers.
 *
 * Uses real in-memory SQLite derived from the generated manifest so the
 * conflictColumns unique index is exactly what ships. Mirrors the proven
 * tenant-interceptor pattern from `smrt-users` (`enableTenancy()` + explicit
 * `tenantId` on write + tenant-filtered reads).
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentPersona, AgentPersonaCollection } from './agent-persona.js';

const PRAECO = '@happyvertical/smrt-agents:Praeco';
const CAELUS = '@happyvertical/smrt-agents:Caelus';

describe('AgentPersona', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let personas: AgentPersonaCollection;

  beforeEach(async () => {
    // Schema + collection first, so DDL setup runs before the interceptor.
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: ['AgentPersona'],
    });
    personas = await AgentPersonaCollection.create({ db: ctx.db });
    // enableTenancy() (not setupTestTenancy) preserves the @TenantScoped
    // registry populated at import time; clearing it would leave AgentPersona
    // unrecognized and disable tenant filtering.
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await ctx.cleanup();
  });

  describe('CRUD', () => {
    it('creates, reads, updates, and deletes a persona within a tenant', async () => {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        const created = await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Support',
          instructions: 'Be helpful.',
          runAsUserId: 'user-1',
          memoryScope: 'praeco:support',
        });

        expect(created.id).toBeTruthy();
        expect(created.tenantId).toBe('tenant-a');
        expect(created.enabled).toBe(true);
        expect(created.priority).toBe(0);

        const loaded = await personas.get({ id: created.id as string });
        expect(loaded?.name).toBe('Support');
        expect(loaded?.instructions).toBe('Be helpful.');
        expect(loaded?.runAsUserId).toBe('user-1');

        loaded!.instructions = 'Be concise.';
        loaded!.priority = 5;
        await loaded!.save();

        const updated = await personas.get({ id: created.id as string });
        expect(updated?.instructions).toBe('Be concise.');
        expect(updated?.priority).toBe(5);

        await updated!.delete();
        const gone = await personas.get({ id: created.id as string });
        expect(gone).toBeNull();
      });
    });

    it('round-trips allowedTools through the JSON helpers', async () => {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        const created = await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Tooled',
          runAsUserId: 'user-1',
        });
        created.setAllowedTools(['search', 'summarize']);
        await created.save();

        const loaded = await personas.get({ id: created.id as string });
        expect(loaded?.getAllowedTools()).toEqual(['search', 'summarize']);
      });
    });

    it('returns an empty array for malformed allowedTools JSON', () => {
      const persona = new AgentPersona();
      persona.allowedTools = 'not json';
      expect(persona.getAllowedTools()).toEqual([]);
    });
  });

  describe('uniqueness on (tenant_id, agent_class, name)', () => {
    it('rejects a second insert with the same tenant, agent class, and name', async () => {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Support',
          runAsUserId: 'user-1',
        });

        await expect(
          personas.create({
            tenantId: 'tenant-a',
            agentClass: PRAECO,
            name: 'Support',
            runAsUserId: 'user-2',
            _insertOnly: true,
          }),
        ).rejects.toThrow();
      });
    });

    it('allows the same name for a different agent class', async () => {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Support',
          runAsUserId: 'user-1',
        });
        await personas.create({
          tenantId: 'tenant-a',
          agentClass: CAELUS,
          name: 'Support',
          runAsUserId: 'user-1',
        });

        const all = await personas.list({ where: { name: 'Support' } });
        expect(all).toHaveLength(2);
        expect(all.map((p) => p.agentClass).sort()).toEqual(
          [CAELUS, PRAECO].sort(),
        );
      });
    });
  });

  describe('@TenantScoped isolation', () => {
    it("does not leak a tenant's personas to another tenant", async () => {
      await withTenant({ tenantId: 'tenant-a' }, () =>
        personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Support',
          runAsUserId: 'user-a',
        }),
      );

      const seenByB = await withTenant({ tenantId: 'tenant-b' }, () =>
        personas.list({}),
      );
      expect(seenByB).toHaveLength(0);

      const seenByA = await withTenant({ tenantId: 'tenant-a' }, () =>
        personas.list({}),
      );
      expect(seenByA).toHaveLength(1);
      expect(seenByA[0].tenantId).toBe('tenant-a');
    });

    it('lets two tenants each own a same-named persona for the same agent class', async () => {
      await withTenant({ tenantId: 'tenant-a' }, () =>
        personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Support',
          runAsUserId: 'user-a',
        }),
      );
      await withTenant({ tenantId: 'tenant-b' }, () =>
        personas.create({
          tenantId: 'tenant-b',
          agentClass: PRAECO,
          name: 'Support',
          runAsUserId: 'user-b',
        }),
      );

      const a = await withTenant({ tenantId: 'tenant-a' }, () =>
        personas.list({}),
      );
      const b = await withTenant({ tenantId: 'tenant-b' }, () =>
        personas.list({}),
      );
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0].runAsUserId).toBe('user-a');
      expect(b[0].runAsUserId).toBe('user-b');
    });
  });

  describe('cross-package references', () => {
    it('registers runAsUserId and actsAsProfileId as cross-package refs', () => {
      const runAsRef = ObjectRegistry.getFieldDecorator(
        'AgentPersona',
        'runAsUserId',
      );
      expect(runAsRef?.type).toBe('crossPackageRef');
      expect(runAsRef?.related).toBe('@happyvertical/smrt-users:User');

      const actsAsRef = ObjectRegistry.getFieldDecorator(
        'AgentPersona',
        'actsAsProfileId',
      );
      expect(actsAsRef?.type).toBe('crossPackageRef');
      expect(actsAsRef?.related).toBe('@happyvertical/smrt-profiles:Profile');
    });

    it('stores and round-trips the cross-package reference ids', async () => {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        const userId = crypto.randomUUID();
        const profileId = crypto.randomUUID();
        const created = await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Identified',
          runAsUserId: userId,
          actsAsProfileId: profileId,
        });

        const loaded = await personas.get({ id: created.id as string });
        expect(loaded?.runAsUserId).toBe(userId);
        expect(loaded?.actsAsProfileId).toBe(profileId);
      });
    });
  });

  describe('collection helpers', () => {
    it('byTenantAndClass returns personas ordered by descending priority', async () => {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Low',
          priority: 1,
          runAsUserId: 'user-1',
        });
        await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'High',
          priority: 10,
          runAsUserId: 'user-1',
        });

        const ordered = await personas.byTenantAndClass('tenant-a', PRAECO);
        expect(ordered.map((p) => p.name)).toEqual(['High', 'Low']);
      });
    });

    it('findActive filters out disabled personas and non-matching contexts', async () => {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'TenantWide',
          runAsUserId: 'user-1',
        });
        await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'Disabled',
          enabled: false,
          runAsUserId: 'user-1',
        });
        await personas.create({
          tenantId: 'tenant-a',
          agentClass: PRAECO,
          name: 'SiteScoped',
          contextType: 'site',
          contextId: 'site-1',
          runAsUserId: 'user-1',
        });

        const forSite1 = await personas.findActive('tenant-a', PRAECO, {
          contextType: 'site',
          contextId: 'site-1',
        });
        expect(forSite1.map((p) => p.name).sort()).toEqual([
          'SiteScoped',
          'TenantWide',
        ]);

        const forSite2 = await personas.findActive('tenant-a', PRAECO, {
          contextType: 'site',
          contextId: 'site-2',
        });
        // Only the tenant-wide default applies to a different site id.
        expect(forSite2.map((p) => p.name)).toEqual(['TenantWide']);
      });
    });
  });
});
