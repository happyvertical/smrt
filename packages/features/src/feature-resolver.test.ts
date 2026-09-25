import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TenantCollection } from '../../users/src/index.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import { FeatureResolver } from './feature-resolver.js';
import { FeatureOverrideEffect, type FeatureTenantNode } from './types.js';
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

  it('still applies an ancestor tenant override when the chain exceeds a host-configured list limit (#3056)', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const featureKey =
      '@test/smrt-feature-resolver:FeatureResolverFixture#newEditor';

    // Three-node synthetic chain, walked root-to-leaf. `getOverrideMap()`
    // fetches every scope in one `list({ where: { scopeId: [...] } })` call
    // with no explicit `limit`, so a host-configured `defaultListLimit`
    // smaller than the chain length must not be allowed to reach it (#3056).
    // The two decoy nodes carry an explicit INHERIT row (a no-op) purely to
    // make the query match more rows than the limit; the root's ENABLE row
    // is the only one that can change the resolved value, and its scope id
    // is chosen to sort last so it is the row a naive per-query LIMIT drops.
    const rootId = 'zz-ancestor-root';
    const midId = 'aa-ancestor-mid';
    const leafId = 'bb-ancestor-leaf';
    const chain: FeatureTenantNode[] = [
      { id: rootId, inheritPermissions: true, cascadePermissions: true },
      { id: midId, inheritPermissions: true, cascadePermissions: true },
      { id: leafId, inheritPermissions: true, cascadePermissions: true },
    ];

    const overrides = await (FeatureOverrideCollection as any).create({ db });
    await overrides.setTenantOverride(
      featureKey,
      rootId,
      FeatureOverrideEffect.ENABLE,
    );
    await overrides.setTenantOverride(
      featureKey,
      midId,
      FeatureOverrideEffect.INHERIT,
    );
    await overrides.setTenantOverride(
      featureKey,
      leafId,
      FeatureOverrideEffect.INHERIT,
    );

    // `newEditor` defaults to disabled, so only the root's ENABLE override
    // (correctly applied and cascaded down through two no-op nodes) can make
    // this resolve to `true`.
    const resolver = new FeatureResolver(
      { db, defaultListLimit: 2, maxListLimit: 2 },
      { tenantHierarchyLoader: async () => ({ getChain: async () => chain }) },
    );

    await expect(
      resolver.isEnabledFor(FeatureResolverFixture, 'newEditor', {
        tenantId: leafId,
      }),
    ).resolves.toBe(true);
  });
});
