import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TenantCollection } from '../../users/src/index.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import { FeatureResolver } from './feature-resolver.js';
import { FeatureOverrideEffect } from './types.js';
import { resolveFeatureKeyForTarget } from './utils.js';

@smrt({
  packageName: '@test/smrt-feature-resolver',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
  features: {
    newEditor: {
      defaultEnabled: false,
      label: 'New Editor',
    },
    reports: {
      defaultEnabled: true,
    },
  },
})
class FeatureResolverFixture extends SmrtObject {}

describe('FeatureResolver', () => {
  const closers = new Set<() => Promise<void>>();

  afterEach(async () => {
    for (const close of closers) {
      await close();
    }
    closers.clear();
  });

  it('builds canonical feature keys from qualified class names', () => {
    const resolved = resolveFeatureKeyForTarget(
      FeatureResolverFixture,
      'newEditor',
    );

    expect(resolved).toEqual({
      featureKey:
        '@test/smrt-feature-resolver:FeatureResolverFixture#newEditor',
      defaultEnabled: false,
    });
  });

  it('applies a global override over the decorator default', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const overrides = await (FeatureOverrideCollection as any).create({ db });
    await overrides.setGlobalOverride(
      '@test/smrt-feature-resolver:FeatureResolverFixture#newEditor',
      FeatureOverrideEffect.ENABLE,
    );

    const resolver = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null },
    );

    await expect(
      resolver.isEnabledFor(FeatureResolverFixture, 'newEditor'),
    ).resolves.toBe(true);
  });

  it('applies direct tenant overrides when smrt-users is unavailable', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const overrides = await (FeatureOverrideCollection as any).create({ db });
    await overrides.setTenantOverride(
      '@test/smrt-feature-resolver:FeatureResolverFixture#reports',
      'tenant-direct',
      FeatureOverrideEffect.DISABLE,
    );

    const resolver = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null },
    );

    await expect(
      resolver.isEnabledFor(FeatureResolverFixture, 'reports', {
        tenantId: 'tenant-direct',
      }),
    ).resolves.toBe(false);
  });

  it('treats explicit INHERIT as a fallback to the current baseline', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const overrides = await (FeatureOverrideCollection as any).create({ db });
    const featureKey =
      '@test/smrt-feature-resolver:FeatureResolverFixture#newEditor';

    await overrides.setGlobalOverride(featureKey, FeatureOverrideEffect.ENABLE);
    await overrides.setTenantOverride(
      featureKey,
      'tenant-inherit',
      FeatureOverrideEffect.INHERIT,
    );

    const resolver = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null },
    );

    await expect(
      resolver.isEnabled(featureKey, { tenantId: 'tenant-inherit' }),
    ).resolves.toBe(true);
  });

  it('uses smrt-users tenant hierarchy when available', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride', 'Tenant'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const tenants = await (TenantCollection as any).create({ db });
    const root = await tenants.create({ name: 'Root Tenant' });
    await root.save();
    const child = await tenants.createChild(root.id, {
      name: 'Child Tenant',
      inheritPermissions: true,
    });

    const overrides = await (FeatureOverrideCollection as any).create({ db });
    await overrides.setTenantOverride(
      '@test/smrt-feature-resolver:FeatureResolverFixture#newEditor',
      root.id,
      FeatureOverrideEffect.ENABLE,
    );

    const resolver = new FeatureResolver({ db });

    await expect(
      resolver.isEnabledFor(FeatureResolverFixture, 'newEditor', {
        tenantId: child.id,
      }),
    ).resolves.toBe(true);
  });
});
