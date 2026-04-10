import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { SmartObjectManifest } from '@happyvertical/smrt-core/manifest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureDefinitionCollection } from './feature-definitions.js';
import { FeatureSyncService } from './feature-sync.js';

@smrt({
  packageName: '@test/smrt-feature-sync',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
  features: {
    alphaRollout: {
      defaultEnabled: false,
      label: 'Alpha Rollout',
      description: 'First stage rollout',
    },
    staffReports: {
      defaultEnabled: true,
      metadata: {
        audience: 'staff',
      },
    },
  },
})
class FeatureSyncFixture extends SmrtObject {}

describe('FeatureSyncService', () => {
  const closers = new Set<() => Promise<void>>();

  afterEach(async () => {
    for (const close of closers) {
      await close();
    }
    closers.clear();
  });

  it('syncs decorator-defined features into _smrt_feature_definitions and is idempotent', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const syncService = new FeatureSyncService({ db });

    const first = await syncService.syncDefinitions({
      classNames: ['FeatureSyncFixture'],
    });
    const second = await syncService.syncDefinitions({
      classNames: ['FeatureSyncFixture'],
    });

    const definitions = await (FeatureDefinitionCollection as any).create({
      db,
    });
    const alpha = await definitions.findByFeatureKey(
      '@test/smrt-feature-sync:FeatureSyncFixture#alphaRollout',
    );
    const staff = await definitions.findByFeatureKey(
      '@test/smrt-feature-sync:FeatureSyncFixture#staffReports',
    );

    expect(first).toMatchObject({
      total: 2,
      created: 2,
      updated: 0,
      unchanged: 0,
      deleted: 0,
    });
    expect(second).toMatchObject({
      total: 2,
      created: 0,
      updated: 0,
      unchanged: 2,
      deleted: 0,
    });
    expect(alpha?.defaultEnabled).toBe(false);
    expect(alpha?.label).toBe('Alpha Rollout');
    expect(staff?.defaultEnabled).toBe(true);
    expect(staff?.getMetadata()).toEqual({ audience: 'staff' });
  });

  it('prunes stale synced definitions within the touched package when syncing a manifest', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const syncService = new FeatureSyncService({ db });
    const definitions = await (FeatureDefinitionCollection as any).create({
      db,
    });

    const firstManifest: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/smrt-feature-manifest',
      objects: {
        '@test/smrt-feature-manifest:ManifestFixture': {
          className: 'ManifestFixture',
          qualifiedName: '@test/smrt-feature-manifest:ManifestFixture',
          collection: 'manifestfixtures',
          filePath: '/tmp/ManifestFixture.ts',
          fields: {},
          methods: {},
          decoratorConfig: {
            features: {
              alpha: {
                defaultEnabled: false,
              },
              beta: {
                defaultEnabled: true,
              },
            },
          },
        },
      },
    };

    const secondManifest: SmartObjectManifest = {
      ...firstManifest,
      timestamp: Date.now() + 1,
      objects: {
        '@test/smrt-feature-manifest:ManifestFixture': {
          ...firstManifest.objects[
            '@test/smrt-feature-manifest:ManifestFixture'
          ],
          decoratorConfig: {
            features: {
              beta: {
                defaultEnabled: false,
                label: 'Beta',
              },
            },
          },
        },
      },
    };

    await syncService.syncManifest(firstManifest);
    const result = await syncService.syncManifest(secondManifest);

    const alpha = await definitions.findByFeatureKey(
      '@test/smrt-feature-manifest:ManifestFixture#alpha',
    );
    const beta = await definitions.findByFeatureKey(
      '@test/smrt-feature-manifest:ManifestFixture#beta',
    );

    expect(result).toMatchObject({
      total: 1,
      created: 0,
      updated: 1,
      unchanged: 0,
      deleted: 1,
    });
    expect(alpha).toBeNull();
    expect(beta?.defaultEnabled).toBe(false);
    expect(beta?.label).toBe('Beta');
  });

  it('prunes stale definitions when a touched package removes its last feature', async () => {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition'],
    });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const syncService = new FeatureSyncService({ db });
    const definitions = await (FeatureDefinitionCollection as any).create({
      db,
    });

    const firstManifest: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/smrt-feature-empty-manifest',
      objects: {
        '@test/smrt-feature-empty-manifest:ManifestFixture': {
          className: 'ManifestFixture',
          qualifiedName: '@test/smrt-feature-empty-manifest:ManifestFixture',
          collection: 'manifestfixtures',
          filePath: '/tmp/ManifestFixture.ts',
          fields: {},
          methods: {},
          decoratorConfig: {
            features: {
              alpha: {
                defaultEnabled: false,
              },
            },
          },
        },
      },
    };

    const secondManifest: SmartObjectManifest = {
      ...firstManifest,
      timestamp: Date.now() + 1,
      objects: {
        '@test/smrt-feature-empty-manifest:ManifestFixture': {
          ...firstManifest.objects[
            '@test/smrt-feature-empty-manifest:ManifestFixture'
          ],
          decoratorConfig: {},
        },
      },
    };

    await syncService.syncManifest(firstManifest);
    const result = await syncService.syncManifest(secondManifest);

    const alpha = await definitions.findByFeatureKey(
      '@test/smrt-feature-empty-manifest:ManifestFixture#alpha',
    );

    expect(result).toMatchObject({
      total: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 1,
    });
    expect(alpha).toBeNull();
  });
});
