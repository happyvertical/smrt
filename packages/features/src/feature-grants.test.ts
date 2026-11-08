import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureDefinitionCollection } from './feature-definitions.js';
import {
  FEATURE_GRANT_SOURCE_SLOT_KEY,
  getFeatureGrantSource,
  setFeatureGrantSource,
} from './feature-grants.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import { FeatureResolver } from './feature-resolver.js';
import { FeatureSyncService } from './feature-sync.js';
import {
  defineFrameworkFeature,
  getFrameworkFeature,
  isFrameworkFeatureKey,
} from './framework-features.js';
import {
  checkFeature,
  FEATURE_UPGRADE_REQUIRED_CODE,
  FeatureUpgradeRequiredError,
  featureGateResponse,
  requireFeature,
} from './require-feature.js';
import {
  FEATURE_CLOUD_HOSTED,
  FEATURE_INFERENCE_HOSTED,
  FEATURE_SYNC_DEVICES,
  STANDARD_FEATURE_KEYS,
  STANDARD_FEATURES,
} from './standard-features.js';
import { type FeatureGrantSource, FeatureOverrideEffect } from './types.js';

function grantSource(
  grants: Record<string, string[]>,
  plans: Record<string, { planKey: string; name?: string }> = {},
): FeatureGrantSource & {
  getGrants: ReturnType<typeof vi.fn>;
} {
  return {
    getGrants: vi.fn(async (tenantId: string) =>
      grants[tenantId]
        ? { featureKeys: grants[tenantId], planKey: 'pro' }
        : null,
    ),
    findGrantingPlan: async (featureKey: string) => plans[featureKey] ?? null,
  };
}

describe('plan grants as feature flags (#4761)', () => {
  const closers = new Set<() => Promise<void>>();

  afterEach(async () => {
    setFeatureGrantSource(undefined);
    for (const close of closers) {
      await close();
    }
    closers.clear();
  });

  async function setup() {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });
    const overrides = await (FeatureOverrideCollection as any).create({ db });
    const resolver = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null },
    );
    return { db, overrides, resolver };
  }

  it('defines the standard paid keys as framework features that default off', () => {
    expect(Object.values(STANDARD_FEATURE_KEYS).sort()).toEqual([
      'backup.vault',
      'cloud.hosted',
      'inference.hosted',
      'plugins.remote',
      'sync.devices',
    ]);
    for (const definition of STANDARD_FEATURES) {
      expect(isFrameworkFeatureKey(definition.featureKey)).toBe(true);
      expect(definition.defaultEnabled).toBe(false);
      expect(definition.metadata?.paid).toBe(true);
      expect(definition.description).toBeTruthy();
      expect(getFrameworkFeature(definition.featureKey)).toEqual(definition);
    }
    expect(Object.isFrozen(STANDARD_FEATURES[0]?.metadata)).toBe(true);
  });

  it('rejects class-style keys and conflicting redefinitions', () => {
    const firstStandard = STANDARD_FEATURES[0];
    if (!firstStandard) throw new Error('expected a standard feature');
    expect(isFrameworkFeatureKey('@app/x:Thing#drafts')).toBe(false);
    expect(() =>
      defineFrameworkFeature({
        featureKey: 'Bad#key',
        packageName: '@test/app',
        defaultEnabled: false,
      }),
    ).toThrow(/Invalid framework feature key/);
    expect(() =>
      defineFrameworkFeature({
        ...firstStandard,
        defaultEnabled: true,
      }),
    ).toThrow(/already defined/);
    expect(defineFrameworkFeature({ ...firstStandard })).toEqual(
      STANDARD_FEATURES[0],
    );
  });

  it('keeps paid keys off with no grant source (local install)', async () => {
    const { resolver } = await setup();
    expect(getFeatureGrantSource()).toBeUndefined();
    await expect(
      resolver.isEnabled(FEATURE_INFERENCE_HOSTED, { tenantId: 't1' }),
    ).resolves.toBe(false);
    await expect(resolver.isEnabled(FEATURE_INFERENCE_HOSTED)).resolves.toBe(
      false,
    );
  });

  it('resolves a plan grant true for the tenant', async () => {
    const { resolver } = await setup();
    const source = grantSource({ t1: [FEATURE_INFERENCE_HOSTED] });
    await expect(
      resolver.isEnabled(FEATURE_INFERENCE_HOSTED, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toBe(true);
    // No tenant context: grants are tenant-level and never consulted.
    await expect(
      resolver.isEnabled(FEATURE_INFERENCE_HOSTED, { grantSource: source }),
    ).resolves.toBe(false);
    // Another tenant without a subscription.
    await expect(
      resolver.isEnabled(FEATURE_INFERENCE_HOSTED, {
        tenantId: 't2',
        grantSource: source,
      }),
    ).resolves.toBe(false);
  });

  it('lets a tenant override beat a plan grant', async () => {
    const { overrides, resolver } = await setup();
    await overrides.setTenantOverride(
      FEATURE_SYNC_DEVICES,
      't1',
      FeatureOverrideEffect.DISABLE,
    );
    const source = grantSource({ t1: [FEATURE_SYNC_DEVICES] });
    await expect(
      resolver.isEnabled(FEATURE_SYNC_DEVICES, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toBe(false);
  });

  it('ranks a plan grant above the global scope', async () => {
    const { overrides, resolver } = await setup();
    await overrides.setGlobalOverride(
      FEATURE_SYNC_DEVICES,
      FeatureOverrideEffect.DISABLE,
    );
    const source = grantSource({ t1: [FEATURE_SYNC_DEVICES] });
    await expect(
      resolver.isEnabled(FEATURE_SYNC_DEVICES, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toBe(true);
  });

  it('lets an ungranted key fall through to global and default', async () => {
    const { overrides, resolver } = await setup();
    const source = grantSource({ t1: [FEATURE_INFERENCE_HOSTED] });
    await expect(
      resolver.isEnabled(FEATURE_CLOUD_HOSTED, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toBe(false);
    await overrides.setGlobalOverride(
      FEATURE_CLOUD_HOSTED,
      FeatureOverrideEffect.ENABLE,
    );
    await expect(
      resolver.isEnabled(FEATURE_CLOUD_HOSTED, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toBe(true);
  });

  it('uses the registered global source, overridable per resolver and per call', async () => {
    const { db } = await setup();
    const global = grantSource({ t1: [FEATURE_INFERENCE_HOSTED] });
    setFeatureGrantSource(global);
    expect((globalThis as any)[Symbol.for(FEATURE_GRANT_SOURCE_SLOT_KEY)]).toBe(
      global,
    );

    const resolver = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null },
    );
    await expect(
      resolver.isEnabled(FEATURE_INFERENCE_HOSTED, { tenantId: 't1' }),
    ).resolves.toBe(true);
    await expect(
      resolver.isEnabled(FEATURE_INFERENCE_HOSTED, {
        tenantId: 't1',
        grantSource: null,
      }),
    ).resolves.toBe(false);

    const noGrants = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null, grantSource: null },
    );
    await expect(
      noGrants.isEnabled(FEATURE_INFERENCE_HOSTED, { tenantId: 't1' }),
    ).resolves.toBe(false);
  });

  it('applies the grant as the tenant-walk baseline with a hierarchy', async () => {
    const { db, overrides } = await setup();
    const resolver = new FeatureResolver(
      { db },
      {
        tenantHierarchyLoader: async () => ({
          getChain: async (tenantId: string) => [
            { id: 'root', inheritPermissions: true, cascadePermissions: true },
            {
              id: tenantId,
              inheritPermissions: true,
              cascadePermissions: true,
            },
          ],
        }),
      },
    );
    const source = grantSource({ child: [FEATURE_SYNC_DEVICES] });
    await expect(
      resolver.isEnabled(FEATURE_SYNC_DEVICES, {
        tenantId: 'child',
        grantSource: source,
      }),
    ).resolves.toBe(true);
    await overrides.setTenantOverride(
      FEATURE_SYNC_DEVICES,
      'root',
      FeatureOverrideEffect.DISABLE,
    );
    await expect(
      resolver.isEnabled(FEATURE_SYNC_DEVICES, {
        tenantId: 'child',
        grantSource: source,
      }),
    ).resolves.toBe(false);
  });

  it('returns a structured upgrade response naming the granting plan', async () => {
    const { resolver } = await setup();
    const source = grantSource(
      { t1: [] },
      { [FEATURE_INFERENCE_HOSTED]: { planKey: 'cloud', name: 'Cloud' } },
    );

    const denied = await checkFeature(FEATURE_INFERENCE_HOSTED, {
      resolver,
      tenantId: 't1',
      grantSource: source,
    });
    expect(denied).toEqual({
      allowed: false,
      featureKey: FEATURE_INFERENCE_HOSTED,
      upgrade: {
        code: FEATURE_UPGRADE_REQUIRED_CODE,
        featureKey: FEATURE_INFERENCE_HOSTED,
        label: 'Hosted AI',
        paid: true,
        tenantId: 't1',
        grantingPlan: { planKey: 'cloud', name: 'Cloud' },
        message: 'Hosted AI requires the Cloud plan.',
      },
    });

    const response = await featureGateResponse(FEATURE_INFERENCE_HOSTED, {
      resolver,
      tenantId: 't1',
      grantSource: source,
    });
    expect(response?.status).toBe(403);
    expect(response?.headers.get('content-type')).toBe('application/json');
    await expect(response?.json()).resolves.toMatchObject({
      error: 'Hosted AI requires the Cloud plan.',
      code: FEATURE_UPGRADE_REQUIRED_CODE,
      featureKey: FEATURE_INFERENCE_HOSTED,
      grantingPlan: { planKey: 'cloud' },
    });

    const error = await requireFeature(FEATURE_INFERENCE_HOSTED, {
      resolver,
      tenantId: 't1',
      grantSource: source,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FeatureUpgradeRequiredError);
    expect((error as FeatureUpgradeRequiredError).status).toBe(403);
    expect((error as FeatureUpgradeRequiredError).featureKey).toBe(
      FEATURE_INFERENCE_HOSTED,
    );
    expect((error as FeatureUpgradeRequiredError).toResponse().status).toBe(
      403,
    );
  });

  it('allows a granted key and keeps a denial when plan lookup fails', async () => {
    const { resolver } = await setup();
    const granted = grantSource({ t1: [FEATURE_INFERENCE_HOSTED] });
    await expect(
      requireFeature(FEATURE_INFERENCE_HOSTED, {
        resolver,
        tenantId: 't1',
        grantSource: granted,
      }),
    ).resolves.toBeUndefined();
    await expect(
      featureGateResponse(FEATURE_INFERENCE_HOSTED, {
        resolver,
        tenantId: 't1',
        grantSource: granted,
      }),
    ).resolves.toBeNull();

    const failing: FeatureGrantSource = {
      getGrants: async () => null,
      findGrantingPlan: async () => {
        throw new Error('plan catalog unavailable');
      },
    };
    const denied = await checkFeature(FEATURE_INFERENCE_HOSTED, {
      resolver,
      tenantId: 't1',
      grantSource: failing,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.allowed ? null : denied.upgrade).toMatchObject({
      grantingPlan: null,
      message: 'Hosted AI is not included in the current plan.',
    });
  });

  it('syncs framework definitions and never prunes them from a class sync', async () => {
    const { db, resolver } = await setup();
    const sync = new FeatureSyncService({ db });
    const result = await sync.syncFrameworkDefinitions();
    expect(result.featureKeys).toEqual(
      expect.arrayContaining(Object.values(STANDARD_FEATURE_KEYS)),
    );

    await sync.syncDefinitions();

    const definitions = await (FeatureDefinitionCollection as any).create({
      db,
    });
    const row = await definitions.findByFeatureKey(FEATURE_INFERENCE_HOSTED);
    expect(row).toBeTruthy();
    expect(row.qualifiedClassName).toBe('');
    expect(row.getMetadata()).toEqual({ paid: true });
    await expect(resolver.isEnabled(FEATURE_INFERENCE_HOSTED)).resolves.toBe(
      false,
    );
  });
});
