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
  FEATURE_DISABLED_CODE,
  FEATURE_UPGRADE_REQUIRED_CODE,
  FeatureUnavailableError,
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

  it('lets a global DISABLE override beat a plan grant', async () => {
    const { overrides, resolver } = await setup();
    const source = grantSource({ t1: [FEATURE_SYNC_DEVICES] });
    await overrides.setGlobalOverride(
      FEATURE_SYNC_DEVICES,
      FeatureOverrideEffect.DISABLE,
    );
    await expect(
      resolver.explain(FEATURE_SYNC_DEVICES, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toEqual({ enabled: false, decidedBy: 'global_override' });

    // An `inherit` global row sets nothing, so the grant stands.
    await overrides.setGlobalOverride(
      FEATURE_SYNC_DEVICES,
      FeatureOverrideEffect.INHERIT,
    );
    await expect(
      resolver.explain(FEATURE_SYNC_DEVICES, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toEqual({ enabled: true, decidedBy: 'plan_grant' });
  });

  it('lets a tenant ENABLE override beat a global DISABLE, granted or not', async () => {
    const { overrides, resolver } = await setup();
    await overrides.setGlobalOverride(
      FEATURE_SYNC_DEVICES,
      FeatureOverrideEffect.DISABLE,
    );
    await overrides.setTenantOverride(
      FEATURE_SYNC_DEVICES,
      't1',
      FeatureOverrideEffect.ENABLE,
    );
    for (const source of [
      grantSource({ t1: [FEATURE_SYNC_DEVICES] }),
      grantSource({}),
    ]) {
      await expect(
        resolver.explain(FEATURE_SYNC_DEVICES, {
          tenantId: 't1',
          grantSource: source,
        }),
      ).resolves.toEqual({ enabled: true, decidedBy: 'tenant_override' });
    }
    // Another granted tenant without its own override stays off.
    await expect(
      resolver.isEnabled(FEATURE_SYNC_DEVICES, {
        tenantId: 't2',
        grantSource: grantSource({ t2: [FEATURE_SYNC_DEVICES] }),
      }),
    ).resolves.toBe(false);
  });

  it('enables a grant with no global row and ignores grants without a tenant', async () => {
    const { overrides, resolver } = await setup();
    const source = grantSource({ t1: [FEATURE_SYNC_DEVICES] });
    await expect(
      resolver.explain(FEATURE_SYNC_DEVICES, {
        tenantId: 't1',
        grantSource: source,
      }),
    ).resolves.toEqual({ enabled: true, decidedBy: 'plan_grant' });
    await expect(
      resolver.explain(FEATURE_SYNC_DEVICES, { grantSource: source }),
    ).resolves.toEqual({ enabled: false, decidedBy: 'default' });

    // No tenant context: default then global, as before.
    await overrides.setGlobalOverride(
      FEATURE_SYNC_DEVICES,
      FeatureOverrideEffect.ENABLE,
    );
    await expect(
      resolver.explain(FEATURE_SYNC_DEVICES, { grantSource: source }),
    ).resolves.toEqual({ enabled: true, decidedBy: 'global_override' });
    await overrides.setGlobalOverride(
      FEATURE_SYNC_DEVICES,
      FeatureOverrideEffect.DISABLE,
    );
    await expect(
      resolver.isEnabled(FEATURE_SYNC_DEVICES, { grantSource: source }),
    ).resolves.toBe(false);
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

  it('resets a non-inheriting tenant to the post-global state', async () => {
    const { db, overrides } = await setup();
    const resolver = new FeatureResolver(
      { db },
      {
        tenantHierarchyLoader: async () => ({
          getChain: async (tenantId: string) => [
            { id: 'root', inheritPermissions: true, cascadePermissions: true },
            {
              id: tenantId,
              inheritPermissions: false,
              cascadePermissions: true,
            },
          ],
        }),
      },
    );
    const source = grantSource({ child: [FEATURE_SYNC_DEVICES] });
    // The root's ENABLE does not reach a non-inheriting child; the child's
    // baseline is grant then global, and the global DISABLE wins there.
    await overrides.setTenantOverride(
      FEATURE_SYNC_DEVICES,
      'root',
      FeatureOverrideEffect.ENABLE,
    );
    await overrides.setGlobalOverride(
      FEATURE_SYNC_DEVICES,
      FeatureOverrideEffect.DISABLE,
    );
    await expect(
      resolver.explain(FEATURE_SYNC_DEVICES, {
        tenantId: 'child',
        grantSource: source,
      }),
    ).resolves.toEqual({ enabled: false, decidedBy: 'global_override' });

    // Without the global row the child resets to its grant.
    await overrides.setGlobalOverride(
      FEATURE_SYNC_DEVICES,
      FeatureOverrideEffect.INHERIT,
    );
    await overrides.setTenantOverride(
      FEATURE_SYNC_DEVICES,
      'root',
      FeatureOverrideEffect.DISABLE,
    );
    await expect(
      resolver.explain(FEATURE_SYNC_DEVICES, {
        tenantId: 'child',
        grantSource: source,
      }),
    ).resolves.toEqual({ enabled: true, decidedBy: 'plan_grant' });
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
      denial: {
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
    expect(error).toBeInstanceOf(FeatureUnavailableError);
    expect((error as FeatureUnavailableError).status).toBe(403);
    expect((error as FeatureUnavailableError).code).toBe(
      FEATURE_UPGRADE_REQUIRED_CODE,
    );
    expect((error as FeatureUnavailableError).featureKey).toBe(
      FEATURE_INFERENCE_HOSTED,
    );
    expect((error as FeatureUnavailableError).toResponse().status).toBe(403);
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
    expect(denied.allowed ? null : denied.denial).toMatchObject({
      grantingPlan: null,
      message: 'Hosted AI is not included in the current plan.',
    });
  });

  it('answers feature_disabled, not an upgrade, under a DISABLE override', async () => {
    const { overrides, resolver } = await setup();
    const findGrantingPlan = vi.fn(async () => ({
      planKey: 'cloud',
      name: 'Cloud',
    }));
    const source: FeatureGrantSource = {
      getGrants: async (tenantId: string) =>
        tenantId === 't1'
          ? { featureKeys: [FEATURE_INFERENCE_HOSTED], planKey: 'cloud' }
          : null,
      findGrantingPlan,
    };
    await overrides.setGlobalOverride(
      FEATURE_INFERENCE_HOSTED,
      FeatureOverrideEffect.DISABLE,
    );

    // Granted and ungranted tenants alike: upgrading would not help.
    for (const tenantId of ['t1', 't2']) {
      const denied = await checkFeature(FEATURE_INFERENCE_HOSTED, {
        resolver,
        tenantId,
        grantSource: source,
      });
      expect(denied).toEqual({
        allowed: false,
        featureKey: FEATURE_INFERENCE_HOSTED,
        denial: {
          code: FEATURE_DISABLED_CODE,
          featureKey: FEATURE_INFERENCE_HOSTED,
          label: 'Hosted AI',
          paid: true,
          tenantId,
          disabledBy: 'global_override',
          message: 'Hosted AI is disabled.',
        },
      });
    }
    expect(findGrantingPlan).not.toHaveBeenCalled();

    const response = await featureGateResponse(FEATURE_INFERENCE_HOSTED, {
      resolver,
      tenantId: 't1',
      grantSource: source,
    });
    expect(response?.status).toBe(403);
    const body = await response?.json();
    expect(body).toMatchObject({
      error: 'Hosted AI is disabled.',
      code: FEATURE_DISABLED_CODE,
    });
    expect(body).not.toHaveProperty('grantingPlan');

    const error = await requireFeature(FEATURE_INFERENCE_HOSTED, {
      resolver,
      tenantId: 't1',
      grantSource: source,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FeatureUnavailableError);
    expect((error as FeatureUnavailableError).code).toBe(FEATURE_DISABLED_CODE);

    // A tenant DISABLE on a granted tenant is also not an upgrade.
    await overrides.setGlobalOverride(
      FEATURE_INFERENCE_HOSTED,
      FeatureOverrideEffect.INHERIT,
    );
    await overrides.setTenantOverride(
      FEATURE_INFERENCE_HOSTED,
      't1',
      FeatureOverrideEffect.DISABLE,
    );
    const tenantDenied = await checkFeature(FEATURE_INFERENCE_HOSTED, {
      resolver,
      tenantId: 't1',
      grantSource: source,
    });
    expect(tenantDenied.allowed ? null : tenantDenied.denial).toMatchObject({
      code: FEATURE_DISABLED_CODE,
      disabledBy: 'tenant_override',
    });

    // Merely ungranted, with no override: still the upgrade answer.
    const ungranted = await checkFeature(FEATURE_INFERENCE_HOSTED, {
      resolver,
      tenantId: 't2',
      grantSource: source,
    });
    expect(ungranted.allowed ? null : ungranted.denial).toMatchObject({
      code: FEATURE_UPGRADE_REQUIRED_CODE,
      grantingPlan: { planKey: 'cloud', name: 'Cloud' },
      message: 'Hosted AI requires the Cloud plan.',
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
