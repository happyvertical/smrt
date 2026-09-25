import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidPromptScopeError,
  PromptOverrideAuthorizationError,
} from './prompt-override-service.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';
import {
  PromptFieldNotEditableError,
  PromptSettingsService,
  UnknownPromptKeyError,
} from './prompt-settings.js';

const DRAFTS = '@test/pkg:Invoice#drafts';
const REPORTS = '@test/pkg:Invoice#reports';

describe('PromptSettingsService', () => {
  const closers = new Set<() => Promise<void>>();

  afterEach(async () => {
    for (const close of closers) {
      await close();
    }
    closers.clear();
    PromptRegistry.clear();
    clearCache();
  });

  async function setup(options: { authorize?: any } = {}) {
    definePrompt({
      key: DRAFTS,
      template: 'Draft default text.',
      editable: { template: true },
    });
    definePrompt({
      key: REPORTS,
      template: 'Reports default text.',
      editable: { template: false },
    });

    const db = await getTestDatabase({ classes: ['PromptOverride'] });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const service = await PromptSettingsService.create(
      { db },
      { authorize: options.authorize },
    );

    return { db, service };
  }

  describe('listPromptSettings', () => {
    it('returns the full row shape for a definition with no overrides', async () => {
      const { service } = await setup();

      const rows = await service.listPromptSettings({});

      expect(rows.map((row) => row.key)).toEqual([DRAFTS, REPORTS]);
      expect(rows[0]).toEqual({
        key: DRAFTS,
        description: '',
        editable: {
          template: true,
          profile: false,
          model: false,
          params: false,
        },
        defaultTemplate: 'Draft default text.',
        effectiveTemplate: 'Draft default text.',
        appTemplate: null,
        tenantTemplate: null,
        appDefaultTemplate: 'Draft default text.',
        inheritedTemplate: null,
        supplyingLevel: 'default',
      });
    });

    it('filters to an explicit key allowlist and ignores unknown keys', async () => {
      const { service } = await setup();

      const rows = await service.listPromptSettings({
        keys: [REPORTS, 'never.registered'],
      });

      expect(rows.map((row) => row.key)).toEqual([REPORTS]);
    });

    it('reports the config override as effective, with level "config"', async () => {
      const { service } = await setup();
      setConfig({
        packages: {
          prompts: { prompts: { [DRAFTS]: { template: 'Config text.' } } },
        },
      });

      const [drafts] = await service.listPromptSettings({});

      expect(drafts.effectiveTemplate).toBe('Config text.');
      expect(drafts.supplyingLevel).toBe('config');
      expect(drafts.appDefaultTemplate).toBe('Config text.');
    });

    it('lets an app override win over config, with level "app"', async () => {
      const { db, service } = await setup();
      setConfig({
        packages: {
          prompts: { prompts: { [DRAFTS]: { template: 'Config text.' } } },
        },
      });
      const authed = await PromptSettingsService.create(
        { db },
        { authorize: () => true },
      );
      await authed.setAppPromptOverride(DRAFTS, 'App text.');

      const [drafts] = await service.listPromptSettings({});

      expect(drafts.effectiveTemplate).toBe('App text.');
      expect(drafts.appTemplate).toBe('App text.');
      expect(drafts.supplyingLevel).toBe('app');
    });

    it('lets a tenant override win over app, and reports what reverting it produces', async () => {
      const { db, service } = await setup();
      const authed = await PromptSettingsService.create(
        { db },
        { authorize: () => true },
      );
      await authed.setAppPromptOverride(DRAFTS, 'App text.');
      await authed.setTenantPromptOverride(DRAFTS, 'tenant-a', 'Tenant text.');

      const [forTenantA] = await service.listPromptSettings({
        tenantId: 'tenant-a',
      });
      expect(forTenantA.effectiveTemplate).toBe('Tenant text.');
      expect(forTenantA.tenantTemplate).toBe('Tenant text.');
      expect(forTenantA.appTemplate).toBe('App text.');
      expect(forTenantA.supplyingLevel).toBe('tenant');
      // Reverting tenant-a's override returns to the app override, not the
      // bare registry default.
      expect(forTenantA.inheritedTemplate).toBe('App text.');

      // A different tenant still sees the app override, with no tenant row.
      const [forTenantB] = await service.listPromptSettings({
        tenantId: 'tenant-b',
      });
      expect(forTenantB.effectiveTemplate).toBe('App text.');
      expect(forTenantB.tenantTemplate).toBeNull();
      expect(forTenantB.supplyingLevel).toBe('app');
      expect(forTenantB.inheritedTemplate).toBe('App text.');
    });

    it('reports an app-only view when no tenant is requested', async () => {
      const { db, service } = await setup();
      const authed = await PromptSettingsService.create(
        { db },
        { authorize: () => true },
      );
      await authed.setAppPromptOverride(DRAFTS, 'App text.');
      await authed.setTenantPromptOverride(DRAFTS, 'tenant-a', 'Tenant text.');

      const [drafts] = await service.listPromptSettings({});

      expect(drafts.effectiveTemplate).toBe('App text.');
      expect(drafts.tenantTemplate).toBeNull();
      expect(drafts.inheritedTemplate).toBeNull();
    });

    it('is not truncated by a caller-configured list bound (#3056 class)', async () => {
      const { db } = await setup();
      // Register enough prompts that a small bound would drop some of their
      // override rows from the bulk enumeration read.
      const keys: string[] = [];
      for (let index = 0; index < 5; index++) {
        const key = `@test/pkg:Bulk#p${index}`;
        keys.push(key);
        definePrompt({
          key,
          template: `Default ${index}`,
          editable: { template: true },
        });
      }

      const authed = await PromptSettingsService.create(
        { db },
        { authorize: () => true },
      );
      for (const key of keys) {
        await authed.setAppPromptOverride(key, `Override for ${key}`);
      }

      // A host that configures list bounds application-wide (an ordinary
      // thing to do) must not silently cap this internal enumeration.
      const bounded = await PromptSettingsService.create({
        db,
        defaultListLimit: 1,
        maxListLimit: 1,
      } as any);

      const rows = await bounded.listPromptSettings({ keys });
      for (const row of rows) {
        expect(row.appTemplate).toBe(`Override for ${row.key}`);
        expect(row.supplyingLevel).toBe('app');
      }
    });
  });

  describe('getPromptSetting', () => {
    it('returns one row, or null for an unknown key', async () => {
      const { service } = await setup();

      await expect(service.getPromptSetting(REPORTS)).resolves.toMatchObject({
        key: REPORTS,
        effectiveTemplate: 'Reports default text.',
      });
      await expect(
        service.getPromptSetting('never.registered'),
      ).resolves.toBeNull();
    });
  });

  describe('setPromptOverride', () => {
    it('writes a tenant override once the host authorizer allows it', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { service } = await setup({ authorize });

      await service.setTenantPromptOverride(DRAFTS, 'tenant-a', 'New text.');

      expect(authorize).toHaveBeenCalledWith({
        operation: 'set',
        key: DRAFTS,
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        template: 'New text.',
      });
      const [row] = await service.listPromptSettings({ tenantId: 'tenant-a' });
      expect(row.tenantTemplate).toBe('New text.');
    });

    it('clears the override with template: null, reverting to what it inherits', async () => {
      const { service } = await setup({ authorize: () => true });
      await service.setTenantPromptOverride(DRAFTS, 'tenant-a', 'New text.');

      await service.setTenantPromptOverride(DRAFTS, 'tenant-a', null);

      const [row] = await service.listPromptSettings({ tenantId: 'tenant-a' });
      expect(row.tenantTemplate).toBeNull();
      expect(row.effectiveTemplate).toBe('Draft default text.');
    });

    it('refuses a key that has no definition, and writes nothing', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { service } = await setup({ authorize });

      await expect(
        service.setTenantPromptOverride(
          'attacker.supplied.key',
          'tenant-a',
          'Text.',
        ),
      ).rejects.toBeInstanceOf(UnknownPromptKeyError);
      expect(authorize).not.toHaveBeenCalled();
    });

    it('refuses a blank or untrimmed key', async () => {
      const { service } = await setup({ authorize: () => true });

      for (const key of ['', '   ', ` ${DRAFTS}`]) {
        await expect(
          service.setTenantPromptOverride(key, 'tenant-a', 'Text.'),
        ).rejects.toBeInstanceOf(UnknownPromptKeyError);
      }
    });

    it('refuses a template override when the definition marks it not editable', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { service } = await setup({ authorize });

      await expect(
        service.setTenantPromptOverride(REPORTS, 'tenant-a', 'New text.'),
      ).rejects.toBeInstanceOf(PromptFieldNotEditableError);
      expect(authorize).not.toHaveBeenCalled();

      // Reverting (null) is always allowed, even when editing is not.
      await expect(
        service.setTenantPromptOverride(REPORTS, 'tenant-a', null),
      ).resolves.toBeDefined();
    });

    it('refuses an app write under any id but the canonical app scope', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { service } = await setup({ authorize });

      await expect(
        service.setPromptOverride({
          key: DRAFTS,
          scopeType: 'app',
          scopeId: 'tenant-a',
          template: 'Text.',
        }),
      ).rejects.toBeInstanceOf(InvalidPromptScopeError);
      expect(authorize).not.toHaveBeenCalled();
    });

    it('refuses a scope type nothing reads back', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { service } = await setup({ authorize });

      for (const scopeType of ['global', 'GLOBAL', '', undefined]) {
        await expect(
          service.setPromptOverride({
            key: DRAFTS,
            scopeType: scopeType as any,
            scopeId: 'tenant-a',
            template: 'Text.',
          }),
        ).rejects.toBeInstanceOf(InvalidPromptScopeError);
      }
      expect(authorize).not.toHaveBeenCalled();
    });

    it('refuses a blank or untrimmed tenant scope id', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { service } = await setup({ authorize });

      for (const scopeId of ['', '   ', ' tenant-a', 'tenant-a ']) {
        await expect(
          service.setTenantPromptOverride(DRAFTS, scopeId, 'Text.'),
        ).rejects.toBeInstanceOf(InvalidPromptScopeError);
      }
      expect(authorize).not.toHaveBeenCalled();
    });

    it('fails closed when the host supplies no authorizer', async () => {
      const { service } = await setup();

      await expect(
        service.setTenantPromptOverride(DRAFTS, 'tenant-a', 'Text.'),
      ).rejects.toBeInstanceOf(PromptOverrideAuthorizationError);
      const [row] = await service.listPromptSettings({ tenantId: 'tenant-a' });
      expect(row.tenantTemplate).toBeNull();
    });

    it('fails closed when the authorizer declines the scope', async () => {
      const authorize = vi.fn(
        (request: any) =>
          request.scopeType === 'tenant' && request.scopeId === 'tenant-a',
      );
      const { service } = await setup({ authorize });

      await expect(
        service.setTenantPromptOverride(DRAFTS, 'tenant-b', 'Text.'),
      ).rejects.toBeInstanceOf(PromptOverrideAuthorizationError);
      await expect(
        service.setTenantPromptOverride(DRAFTS, 'tenant-a', 'Text.'),
      ).resolves.toBeTruthy();
    });
  });
});
