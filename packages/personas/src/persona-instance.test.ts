/**
 * Tests for the persona-as-durable-instance helpers (#1890).
 *
 * Covers per-instance identity + independent config, per-instance scheduling
 * (an `AgentSchedule` bound to the persona), the instance-aware admin surface
 * (class panels rendered per instance, add/remove), and the non-destructive
 * singleton→default-persona upgrade.
 *
 * Resolution/admin helpers read across the tenant (admin path), so — like
 * `persona-resolver.test.ts` — these run with the tenancy interceptor disabled
 * and seed `tenantId` explicitly. Real in-memory SQLite from the generated
 * manifest.
 */

import {
  AgentScheduleCollection,
  instanceScopedSubscriber,
} from '@happyvertical/smrt-agents';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentPersonaCollection } from './agent-persona.js';
import {
  addPersonaInstance,
  agentOptionsForPersona,
  buildPersonaInstanceAdmin,
  DEFAULT_PERSONA_NAME,
  isDefaultPersona,
  personaInstanceKey,
  removePersonaInstance,
  schedulePersonaInstance,
  upgradeSingletonToDefaultPersona,
} from './persona-instance.js';

const PRAECO = '@happyvertical/smrt-agents:Praeco';

const MANIFEST = {
  uiSlots: {
    sources: { id: 'sources', label: 'Sources', order: 1 },
    settings: { id: 'settings', label: 'Settings', order: 2 },
  },
  adminRoutes: [{ path: 'sources', component: 'SourcesPanel' }],
};

describe('persona-as-instance (#1890)', () => {
  // getTestDatabase() creates schemas for every registered class — including the
  // cross-package AgentSchedule the scheduling helper persists into — from the
  // same DDL as production. Resolution/admin helpers read across the tenant, so
  // tenancy enforcement is disabled and tenantId is seeded explicitly.
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let personas: AgentPersonaCollection;

  beforeEach(async () => {
    disableTenancy();
    db = await getTestDatabase();
    personas = await AgentPersonaCollection.create({ db });
  });

  describe('personaInstanceKey / identity', () => {
    it('maps the default persona to the singleton identity (null key)', async () => {
      const persona = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: DEFAULT_PERSONA_NAME,
        runAsUserId: 'user-1',
      });
      expect(isDefaultPersona(persona)).toBe(true);
      expect(personaInstanceKey(persona)).toBeNull();
      expect(agentOptionsForPersona(persona)).toEqual({
        instanceKey: null,
        tenantId: 'tenant-a',
      });
      // Null key → the class-keyed dispatch subscriber (unchanged singleton).
      expect(
        instanceScopedSubscriber(PRAECO, personaInstanceKey(persona)),
      ).toBe(PRAECO);
    });

    it('maps a non-default persona to its id and a distinct subscriber', async () => {
      const persona = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Support',
        runAsUserId: 'user-1',
      });
      expect(personaInstanceKey(persona)).toBe(persona.id);
      expect(
        instanceScopedSubscriber(PRAECO, personaInstanceKey(persona)),
      ).toBe(`${PRAECO}#${persona.id}`);
    });

    it('two instances of one class have independent config + distinct identity', async () => {
      const support = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Support',
        runAsUserId: 'user-support',
        instructions: 'Be terse.',
        allowedTools: ['search'],
        memoryScope: 'm-support',
      });
      const sales = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Sales',
        runAsUserId: 'user-sales',
        instructions: 'Be warm.',
        allowedTools: ['summarize'],
        memoryScope: 'm-sales',
      });

      // Independent config.
      expect(support.instructions).not.toBe(sales.instructions);
      expect(support.getAllowedTools()).toEqual(['search']);
      expect(sales.getAllowedTools()).toEqual(['summarize']);
      expect(support.memoryScope).not.toBe(sales.memoryScope);
      expect(support.runAsUserId).not.toBe(sales.runAsUserId);

      // Distinct per-instance dispatch identities → no cross-processing.
      expect(personaInstanceKey(support)).not.toBe(personaInstanceKey(sales));
      expect(
        instanceScopedSubscriber(PRAECO, personaInstanceKey(support)),
      ).not.toBe(instanceScopedSubscriber(PRAECO, personaInstanceKey(sales)));
    });

    it('refuses to key an unsaved non-default persona', () => {
      expect(() =>
        personaInstanceKey({ name: 'Support', id: undefined }),
      ).toThrow(/must be saved/);
    });
  });

  describe('schedulePersonaInstance', () => {
    it('carries the instance key in agentConfig (not agentId, which loadFromId-s the STI table)', async () => {
      const schedules = await AgentScheduleCollection.create({ db });
      const persona = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Support',
        runAsUserId: 'user-1',
      });

      const schedule = await schedulePersonaInstance(schedules, persona, {
        cron: '0 2 * * *',
      });

      // agentId stays null so the runner constructs a fresh instance instead of
      // loadFromId-ing the persona id against the agents STI table; the identity
      // reaches AgentOptions.instanceKey via agentConfig.
      expect(schedule.agentId).toBeNull();
      expect(schedule.agentConfig.instanceKey).toBe(persona.id);
      expect(schedule.agentType).toBe(PRAECO);
      expect(schedule.tenantId).toBe('tenant-a');
      expect(schedule.cron).toBe('0 2 * * *');
      expect(schedule.enabled).toBe(true);
    });

    it('schedules the default instance as the singleton (no instance key)', async () => {
      const schedules = await AgentScheduleCollection.create({ db });
      const { persona } = await upgradeSingletonToDefaultPersona(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        runAsUserId: 'user-1',
      });

      const schedule = await schedulePersonaInstance(schedules, persona, {
        cron: '*/5 * * * *',
      });
      expect(schedule.agentId).toBeNull();
      expect(schedule.agentConfig.instanceKey).toBeUndefined();
      expect(schedule.agentType).toBe(PRAECO);
    });

    it('preserves caller agentConfig alongside the instance key', async () => {
      const schedules = await AgentScheduleCollection.create({ db });
      const persona = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Support',
        runAsUserId: 'user-1',
      });

      const schedule = await schedulePersonaInstance(schedules, persona, {
        cron: '0 2 * * *',
        agentConfig: { region: 'eu' },
      });
      expect(schedule.agentConfig.region).toBe('eu');
      expect(schedule.agentConfig.instanceKey).toBe(persona.id);
    });

    it('supports many independent schedules for one class', async () => {
      const schedules = await AgentScheduleCollection.create({ db });
      const support = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Support',
        runAsUserId: 'u1',
      });
      const sales = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Sales',
        runAsUserId: 'u2',
      });

      const s1 = await schedulePersonaInstance(schedules, support, {
        cron: '0 1 * * *',
      });
      const s2 = await schedulePersonaInstance(schedules, sales, {
        cron: '0 2 * * *',
      });

      expect(s1.agentConfig.instanceKey).not.toBe(s2.agentConfig.instanceKey);
      const forClass = await schedules.listByAgentType(PRAECO);
      expect(forClass).toHaveLength(2);
    });
  });

  describe('buildPersonaInstanceAdmin — instance-aware admin', () => {
    it('renders the class panels per instance with add/remove', async () => {
      await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Support',
        runAsUserId: 'u1',
        priority: 5,
      });
      await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Sales',
        runAsUserId: 'u2',
      });

      const admin = await buildPersonaInstanceAdmin(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        manifest: MANIFEST,
      });

      expect(admin.agentClass).toBe(PRAECO);
      expect(admin.canAddInstance).toBe(true);
      expect(admin.instances).toHaveLength(2);
      // Priority-ordered (Support priority 5 before Sales priority 0).
      expect(admin.instances.map((i) => i.name)).toEqual(['Support', 'Sales']);
      // Each instance carries the class's uiSlots + adminRoutes.
      for (const instance of admin.instances) {
        expect(Object.keys(instance.slots)).toEqual(['sources', 'settings']);
        expect(instance.adminRoutes).toEqual(MANIFEST.adminRoutes);
        expect(instance.dispatchSubscriber).toBe(
          `${PRAECO}#${instance.personaId}`,
        );
      }

      // Add affordance → a third instance.
      const added = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Ops',
        runAsUserId: 'u3',
      });
      const afterAdd = await buildPersonaInstanceAdmin(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        manifest: MANIFEST,
      });
      expect(afterAdd.instances).toHaveLength(3);

      // Remove affordance → back to two, others untouched.
      const removed = await removePersonaInstance(personas, added.id as string);
      expect(removed).toBe(true);
      const afterRemove = await buildPersonaInstanceAdmin(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        manifest: MANIFEST,
      });
      expect(afterRemove.instances.map((i) => i.name).sort()).toEqual([
        'Sales',
        'Support',
      ]);
    });

    it('renders the default instance with the singleton (class-keyed) subscriber', async () => {
      await upgradeSingletonToDefaultPersona(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        runAsUserId: 'u1',
      });

      const admin = await buildPersonaInstanceAdmin(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        manifest: MANIFEST,
      });
      const def = admin.instances.find((i) => i.isDefault);
      expect(def).toBeDefined();
      expect(def?.instanceKey).toBeNull();
      expect(def?.dispatchSubscriber).toBe(PRAECO);
    });

    it('returns no instances (empty, addable) when none are configured', async () => {
      const admin = await buildPersonaInstanceAdmin(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
      });
      expect(admin.instances).toEqual([]);
      expect(admin.canAddInstance).toBe(true);
    });
  });

  describe('upgradeSingletonToDefaultPersona — non-destructive', () => {
    it('maps the existing singleton to a single default persona', async () => {
      const result = await upgradeSingletonToDefaultPersona(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        runAsUserId: 'user-1',
        instructions: 'legacy behavior',
      });

      expect(result.created).toBe(true);
      expect(result.persona.name).toBe(DEFAULT_PERSONA_NAME);
      expect(result.instanceKey).toBeNull();
      // Maps to the singleton runtime identity — unchanged.
      expect(personaInstanceKey(result.persona)).toBeNull();

      const all = await personas.byTenantAndClass('tenant-a', PRAECO);
      expect(all.filter(isDefaultPersona)).toHaveLength(1);
    });

    it('is idempotent and does not overwrite the existing default', async () => {
      const first = await upgradeSingletonToDefaultPersona(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        runAsUserId: 'user-1',
        instructions: 'legacy behavior',
      });

      // A second upgrade with different config must not clobber the first.
      const second = await upgradeSingletonToDefaultPersona(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        runAsUserId: 'user-2',
        instructions: 'DIFFERENT',
      });

      expect(second.created).toBe(false);
      expect(second.persona.id).toBe(first.persona.id);
      expect(second.persona.instructions).toBe('legacy behavior');

      const all = await personas.byTenantAndClass('tenant-a', PRAECO);
      expect(all.filter(isDefaultPersona)).toHaveLength(1);
    });

    it('leaves other instances untouched when upgrading', async () => {
      const support = await addPersonaInstance(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        name: 'Support',
        runAsUserId: 'u1',
        instructions: 'terse',
      });

      await upgradeSingletonToDefaultPersona(personas, {
        tenantId: 'tenant-a',
        agentClass: PRAECO,
        runAsUserId: 'user-1',
      });

      const reloaded = await personas.get({ id: support.id as string });
      expect(reloaded?.instructions).toBe('terse');
      const all = await personas.byTenantAndClass('tenant-a', PRAECO);
      expect(all).toHaveLength(2);
    });
  });
});
