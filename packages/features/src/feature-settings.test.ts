import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureDefinitionCollection } from './feature-definitions.js';
import { FeatureOverrideAuthorizationError } from './feature-override-service.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import {
  FeatureSettingsService,
  featureOverrideEffectFromValue,
  UnknownFeatureKeyError,
} from './feature-settings.js';
import {
  type FeatureDefinitionSeed,
  FeatureOverrideEffect,
  GLOBAL_FEATURE_SCOPE_ID,
} from './types.js';

const PACKAGE_NAME = '@test/smrt-feature-settings';
const DRAFTS = `${PACKAGE_NAME}:Invoice#drafts`;
const REPORTS = `${PACKAGE_NAME}:Invoice#reports`;
const OTHER_PACKAGE_KEY = '@test/other-package:Widget#beta';

function seed(
  featureKey: string,
  overrides: Partial<FeatureDefinitionSeed> = {},
): FeatureDefinitionSeed {
  const [qualifiedClassName, localId] = featureKey.split('#');
  return {
    featureKey,
    packageName: PACKAGE_NAME,
    qualifiedClassName,
    className: qualifiedClassName.split(':')[1] ?? '',
    localId: localId ?? '',
    defaultEnabled: false,
    label: '',
    description: '',
    ...overrides,
  };
}

describe('FeatureSettingsService', () => {
  const closers = new Set<() => Promise<void>>();

  afterEach(async () => {
    for (const close of closers) {
      await close();
    }
    closers.clear();
  });

  /** A database with the two feature tables and the three seeded definitions. */
  async function setup(
    options: { authorize?: any; tenantHierarchyLoader?: any } = {},
  ) {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const definitions = await (FeatureDefinitionCollection as any).create({
      db,
    });
    await definitions.upsertDefinition(
      seed(DRAFTS, {
        defaultEnabled: false,
        label: 'Invoice drafts',
        description: 'Save invoices as drafts before sending.',
      }),
    );
    await definitions.upsertDefinition(
      seed(REPORTS, { defaultEnabled: true, label: 'Reports' }),
    );
    await definitions.upsertDefinition(
      seed(OTHER_PACKAGE_KEY, {
        packageName: '@test/other-package',
        defaultEnabled: true,
        label: 'Beta widget',
      }),
    );

    const overrides = await (FeatureOverrideCollection as any).create({ db });
    const service = await FeatureSettingsService.create(
      { db },
      {
        authorize: options.authorize,
        resolver: {
          tenantHierarchyLoader:
            options.tenantHierarchyLoader ?? (async () => null),
        },
      },
    );

    return { db, definitions, overrides, service };
  }

  describe('listFeatureSettings', () => {
    it('returns the full row shape for a definition with no overrides', async () => {
      const { service } = await setup();

      const rows = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
        tenantId: 'tenant-a',
      });

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        featureKey: DRAFTS,
        label: 'Invoice drafts',
        description: 'Save invoices as drafts before sending.',
        packageName: PACKAGE_NAME,
        qualifiedClassName: `${PACKAGE_NAME}:Invoice`,
        className: 'Invoice',
        localId: 'drafts',
        visibility: 'public',
        metadata: {},
        defaultEnabled: false,
        effectiveEnabled: false,
        globalEffect: null,
        tenantEffect: null,
        inheritedEnabled: false,
      });
    });

    it('scopes to one package and orders by package, label, then key', async () => {
      const { service } = await setup();

      const scoped = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
      });
      expect(scoped.map((row) => row.featureKey)).toEqual([DRAFTS, REPORTS]);

      const all = await service.listFeatureSettings({});
      expect(all.map((row) => row.featureKey)).toEqual([
        OTHER_PACKAGE_KEY,
        DRAFTS,
        REPORTS,
      ]);
    });

    it('filters to an explicit key allowlist and ignores unknown keys', async () => {
      const { service } = await setup();

      const rows = await service.listFeatureSettings({
        featureKeys: [REPORTS, 'never.registered'],
      });

      expect(rows.map((row) => row.featureKey)).toEqual([REPORTS]);
    });

    it('reports the definition default when nothing overrides it', async () => {
      const { service } = await setup();

      const [drafts, reports] = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
        tenantId: 'tenant-a',
      });

      expect(drafts.effectiveEnabled).toBe(false);
      expect(reports.effectiveEnabled).toBe(true);
    });

    it('reports the global override as effective, and surfaces it as globalEffect', async () => {
      const { overrides, service } = await setup();
      await overrides.setGlobalOverride(DRAFTS, FeatureOverrideEffect.ENABLE);

      const [drafts] = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
        tenantId: 'tenant-a',
      });

      expect(drafts.effectiveEnabled).toBe(true);
      expect(drafts.globalEffect).toBe(FeatureOverrideEffect.ENABLE);
      expect(drafts.tenantEffect).toBeNull();
      expect(drafts.defaultEnabled).toBe(false);
      expect(drafts.inheritedEnabled).toBe(true);
    });

    it('lets a tenant override win over the global override', async () => {
      const { overrides, service } = await setup();
      await overrides.setGlobalOverride(DRAFTS, FeatureOverrideEffect.ENABLE);
      await overrides.setTenantOverride(
        DRAFTS,
        'tenant-a',
        FeatureOverrideEffect.DISABLE,
      );

      const [forTenantA] = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
        tenantId: 'tenant-a',
      });
      expect(forTenantA.effectiveEnabled).toBe(false);
      expect(forTenantA.globalEffect).toBe(FeatureOverrideEffect.ENABLE);
      expect(forTenantA.tenantEffect).toBe(FeatureOverrideEffect.DISABLE);
      // The tenant has an override of its own, so what it would inherit is not
      // knowable from this pass — the panel must not name a state.
      expect(forTenantA.inheritedEnabled).toBeNull();

      // A different tenant still sees the global override.
      const [forTenantB] = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
        tenantId: 'tenant-b',
      });
      expect(forTenantB.effectiveEnabled).toBe(true);
      expect(forTenantB.tenantEffect).toBeNull();
      // With no override of its own, the inherited state is the effective one.
      expect(forTenantB.inheritedEnabled).toBe(true);
    });

    it('reports a global-only view when no tenant is requested', async () => {
      const { overrides, service } = await setup();
      await overrides.setGlobalOverride(DRAFTS, FeatureOverrideEffect.ENABLE);
      await overrides.setTenantOverride(
        DRAFTS,
        'tenant-a',
        FeatureOverrideEffect.DISABLE,
      );

      const [drafts] = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
      });

      expect(drafts.effectiveEnabled).toBe(true);
      expect(drafts.tenantEffect).toBeNull();
      // No tenant was requested, so nothing tenant-inherited was computed. The
      // global state is not an answer to a question about a tenant.
      expect(drafts.inheritedEnabled).toBeNull();
    });
  });

  describe('listFeatureSettings under a tenant hierarchy', () => {
    /** root → child, with the cascade flags that let an override flow down. */
    const hierarchy = async () => ({
      async getChain(tenantId: string) {
        return tenantId === 'child'
          ? [
              {
                id: 'root',
                inheritPermissions: false,
                cascadePermissions: true,
              },
              {
                id: 'child',
                inheritPermissions: true,
                cascadePermissions: false,
              },
            ]
          : [
              {
                id: tenantId,
                inheritPermissions: true,
                cascadePermissions: true,
              },
            ];
      },
    });

    it('reports an ancestor-inherited state that no global-layer derivation could produce', async () => {
      const { overrides, service } = await setup({
        tenantHierarchyLoader: hierarchy,
      });
      // Only the ancestor holds an override. Global says nothing and the code
      // default is false, so anything derived from `globalEffect` and
      // `defaultEnabled` alone would report "disabled" for the child.
      await overrides.setTenantOverride(
        DRAFTS,
        'root',
        FeatureOverrideEffect.ENABLE,
      );

      const [drafts] = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
        tenantId: 'child',
      });

      expect(drafts.globalEffect).toBeNull();
      expect(drafts.tenantEffect).toBeNull();
      expect(drafts.defaultEnabled).toBe(false);
      expect(drafts.effectiveEnabled).toBe(true);
      expect(drafts.inheritedEnabled).toBe(true);
    });

    it('claims nothing for a child that holds its own override', async () => {
      const { overrides, service } = await setup({
        tenantHierarchyLoader: hierarchy,
      });
      await overrides.setTenantOverride(
        DRAFTS,
        'root',
        FeatureOverrideEffect.ENABLE,
      );
      await overrides.setTenantOverride(
        DRAFTS,
        'child',
        FeatureOverrideEffect.DISABLE,
      );

      const [drafts] = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
        tenantId: 'child',
      });

      expect(drafts.effectiveEnabled).toBe(false);
      expect(drafts.tenantEffect).toBe(FeatureOverrideEffect.DISABLE);
      // The inherited state depends on the ancestor chain, which one resolution
      // pass with the child's own override in place cannot isolate.
      expect(drafts.inheritedEnabled).toBeNull();
    });
  });

  describe('getFeatureSetting', () => {
    it('returns one row, or null for an unknown key', async () => {
      const { service } = await setup();

      await expect(service.getFeatureSetting(REPORTS)).resolves.toMatchObject({
        featureKey: REPORTS,
        effectiveEnabled: true,
      });
      await expect(service.getFeatureSetting('never.registered')).resolves.toBe(
        null,
      );
    });
  });

  describe('setFeatureOverride', () => {
    it('writes a tenant override once the host authorizer allows it', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { overrides, service } = await setup({ authorize });

      await service.setTenantFeatureOverride(
        DRAFTS,
        'tenant-a',
        FeatureOverrideEffect.ENABLE,
      );

      expect(authorize).toHaveBeenCalledWith({
        operation: 'set',
        featureKey: DRAFTS,
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        effect: FeatureOverrideEffect.ENABLE,
      });
      const stored = await overrides.getTenantOverride(DRAFTS, 'tenant-a');
      expect(stored?.effect).toBe(FeatureOverrideEffect.ENABLE);
    });

    it('removes the override row for INHERIT, returning the feature to its default', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { overrides, service } = await setup({ authorize });
      await overrides.setTenantOverride(
        REPORTS,
        'tenant-a',
        FeatureOverrideEffect.DISABLE,
      );

      await service.setTenantFeatureOverride(
        REPORTS,
        'tenant-a',
        FeatureOverrideEffect.INHERIT,
      );

      expect(authorize).toHaveBeenCalledWith({
        operation: 'remove',
        featureKey: REPORTS,
        scopeType: 'tenant',
        scopeId: 'tenant-a',
      });
      await expect(
        overrides.getTenantOverride(REPORTS, 'tenant-a'),
      ).resolves.toBe(null);

      const [, reports] = await service.listFeatureSettings({
        packageName: PACKAGE_NAME,
        tenantId: 'tenant-a',
      });
      expect(reports.tenantEffect).toBeNull();
      expect(reports.effectiveEnabled).toBe(true);
    });

    it('writes the global scope through setGlobalFeatureOverride', async () => {
      const { overrides, service } = await setup({ authorize: () => true });

      await service.setGlobalFeatureOverride(
        DRAFTS,
        FeatureOverrideEffect.ENABLE,
      );

      const stored = await overrides.findByFeatureAndScope(
        DRAFTS,
        'global',
        GLOBAL_FEATURE_SCOPE_ID,
      );
      expect(stored?.effect).toBe(FeatureOverrideEffect.ENABLE);
    });

    it('refuses a key that has no definition, and writes nothing', async () => {
      const authorize = vi.fn().mockReturnValue(true);
      const { overrides, service } = await setup({ authorize });

      await expect(
        service.setTenantFeatureOverride(
          'attacker.supplied.key',
          'tenant-a',
          FeatureOverrideEffect.ENABLE,
        ),
      ).rejects.toBeInstanceOf(UnknownFeatureKeyError);

      expect(authorize).not.toHaveBeenCalled();
      await expect(
        overrides.findByFeatureKey('attacker.supplied.key'),
      ).resolves.toEqual([]);
    });

    it('refuses an unknown key on removal too', async () => {
      const { service } = await setup({ authorize: () => true });

      await expect(
        service.setTenantFeatureOverride(
          'attacker.supplied.key',
          'tenant-a',
          FeatureOverrideEffect.INHERIT,
        ),
      ).rejects.toBeInstanceOf(UnknownFeatureKeyError);
    });

    it('refuses a blank or untrimmed key', async () => {
      const { service } = await setup({ authorize: () => true });

      for (const key of ['', '   ', ` ${DRAFTS}`]) {
        await expect(
          service.setTenantFeatureOverride(
            key,
            'tenant-a',
            FeatureOverrideEffect.ENABLE,
          ),
        ).rejects.toBeInstanceOf(UnknownFeatureKeyError);
      }
    });

    it('rejects an effect value that is not a FeatureOverrideEffect', async () => {
      const { service } = await setup({ authorize: () => true });

      await expect(
        service.setFeatureOverride({
          featureKey: DRAFTS,
          scopeType: 'tenant',
          scopeId: 'tenant-a',
          effect: 'sudo-enable' as any,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('fails closed when the host supplies no authorizer', async () => {
      const { overrides, service } = await setup();

      await expect(
        service.setTenantFeatureOverride(
          DRAFTS,
          'tenant-a',
          FeatureOverrideEffect.ENABLE,
        ),
      ).rejects.toBeInstanceOf(FeatureOverrideAuthorizationError);
      await expect(
        overrides.getTenantOverride(DRAFTS, 'tenant-a'),
      ).resolves.toBe(null);
    });

    it('fails closed when the authorizer declines the scope', async () => {
      const authorize = vi.fn(
        (request: any) =>
          request.scopeType === 'tenant' && request.scopeId === 'tenant-a',
      );
      const { overrides, service } = await setup({ authorize });

      await expect(
        service.setTenantFeatureOverride(
          DRAFTS,
          'tenant-b',
          FeatureOverrideEffect.ENABLE,
        ),
      ).rejects.toBeInstanceOf(FeatureOverrideAuthorizationError);
      await expect(
        overrides.getTenantOverride(DRAFTS, 'tenant-b'),
      ).resolves.toBe(null);
      await expect(
        service.setTenantFeatureOverride(
          DRAFTS,
          'tenant-a',
          FeatureOverrideEffect.ENABLE,
        ),
      ).resolves.toBeTruthy();
    });
  });
});

describe('featureOverrideEffectFromValue', () => {
  it('passes through the two explicit effects', () => {
    expect(featureOverrideEffectFromValue('enable')).toBe(
      FeatureOverrideEffect.ENABLE,
    );
    expect(featureOverrideEffectFromValue('disable')).toBe(
      FeatureOverrideEffect.DISABLE,
    );
  });

  it('falls back to INHERIT for anything else', () => {
    for (const value of [null, undefined, '', 'ENABLE', 'sudo', 1, {}]) {
      expect(featureOverrideEffectFromValue(value)).toBe(
        FeatureOverrideEffect.INHERIT,
      );
    }
  });
});
