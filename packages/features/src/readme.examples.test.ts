import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { describe, expect, it } from 'vitest';
import {
  FeatureDefinitionCollection,
  FeatureOverrideEffect,
  FeatureResolver,
  FeatureSettingsService,
  FeatureSyncService,
} from './index.js';

@smrt({
  packageName: '@your/app',
  features: {
    drafts: {
      defaultEnabled: false,
      label: 'Invoice drafts',
      description: 'Save invoices as drafts before sending.',
    },
  },
})
class Invoice extends SmrtObject {}

describe('README quick start (#3012)', () => {
  it('syncs the declared class and resolves both public lookup forms', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    try {
      const dbOptions = { db };
      const currentTenantId = 'invoice-tenant';
      const sync = new FeatureSyncService(dbOptions);
      const result = await sync.syncDefinitions({
        classNames: ['@your/app:Invoice'],
      });
      const resolver = new FeatureResolver(dbOptions, {
        tenantHierarchyLoader: async () => null,
      });
      const enabled = await resolver.isEnabledFor(Invoice, 'drafts', {
        tenantId: currentTenantId,
      });
      const enabledByKey = await resolver.isEnabled(
        '@your/app:Invoice#drafts',
        {
          tenantId: currentTenantId,
        },
      );
      expect(result.featureKeys).toEqual(['@your/app:Invoice#drafts']);
      expect(enabled).toBe(false);
      expect(enabledByKey).toBe(false);
      const definitions = await FeatureDefinitionCollection.create(dbOptions);
      expect(
        await definitions.findByFeatureKey(result.featureKeys[0]),
      ).toMatchObject({
        defaultEnabled: false,
        label: 'Invoice drafts',
      });
      const settings = await FeatureSettingsService.create(dbOptions, {
        authorize: (request) =>
          request.scopeType === 'tenant' && request.scopeId === currentTenantId,
      });
      await settings.setTenantFeatureOverride(
        result.featureKeys[0],
        currentTenantId,
        FeatureOverrideEffect.ENABLE,
      );
      expect(
        await resolver.isEnabledFor(Invoice, 'drafts', {
          tenantId: currentTenantId,
        }),
      ).toBe(true);
      expect(
        await resolver.isEnabledFor(Invoice, 'drafts', {
          tenantId: 'other-tenant',
        }),
      ).toBe(false);
      await expect(resolver.isEnabledFor(Invoice, 'missing')).rejects.toThrow(
        'not declared',
      );
    } finally {
      await db.close?.();
    }
  });
});
