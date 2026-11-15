import { Asset, type AssetRuntimeLike } from '@happyvertical/smrt-assets';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as models from '../models.js';
import { IngestionService } from '../server.js';

for (const replaced of [false, true]) {
  describe(`cleanup asset, app replacement=${replaced}`, () => {
    let restore: () => void;
    let expected: typeof Asset;
    let db: DatabaseInterface;
    beforeAll(async () => {
      // The helper is core-internal and not a package export. Resolve it at
      // runtime so this package's test typecheck stays inside its rootDir.
      const testUtilsPath = new URL(
        '../../../core/src/test-utils.ts',
        import.meta.url,
      ).href;
      const { snapshotObjectRegistryState } = (await import(testUtilsPath)) as {
        snapshotObjectRegistryState(): () => void;
      };
      restore = snapshotObjectRegistryState();
      db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: [
          ...Object.keys(models),
          'Asset',
          'AssetAssociation',
          'AssetTag',
          'AssetType',
          'AssetStatus',
          'Folder',
          'SmrtJob',
          'SmrtJobEvent',
          'SmrtWorker',
          'Content',
          'ContentDocument',
          'ContentAsset',
          'ContentContributionAttachment',
          'ProfileAsset',
        ],
      });
      expected = replaced
        ? (await import('./issue-4931-app.fixture.js')).Asset
        : Asset;
    });
    afterAll(async () => {
      await db?.close?.();
      restore();
    });

    it('passes an unsaved effective Asset locator to removeFile after the row was pruned', async () => {
      const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        actorId: 'owner',
        confidentialScopeId: 'private',
      };
      await withTenant({ tenantId: scope.tenantId }, async () => {
        const items = await ObjectRegistry.getCollection<models.IntakeItem>(
          'IntakeItem',
          { db },
        );
        const item = await items.create({
          tenantId: scope.tenantId,
          confidentialScopeId: scope.confidentialScopeId,
          sourceId: 'source',
          sourceVersion: '1',
          deliveryKey: 'delivery',
          payloadDigest: 'payload',
          scopeDigest: 'scope',
          receiptState: 'accepted',
          processingState: 'expired',
          visibility: 'expired',
          traceId: 'trace',
          leaseToken: 'released',
          submitterId: 'owner',
          ownerKey: 'fixture:owner',
          data: '{}',
        });
        const deletions =
          await ObjectRegistry.getCollection<models.IntakeDeletion>(
            'IntakeDeletion',
            { db },
          );
        await deletions.create({
          tenantId: scope.tenantId,
          confidentialScopeId: scope.confidentialScopeId,
          itemId: item.id!,
          state: 'completed',
          data: JSON.stringify({
            cleanup: [{ assetId: 'asset-1', sourceUri: 'file:///late-bytes' }],
          }),
        });
      });
      const removeFile = vi.fn().mockResolvedValue(undefined);
      const service = new IngestionService({
        db,
        scope,
        authorize: async () => true,
        jobTarget: { objectType: 'Worker', method: 'process' },
        purgeDerived: async () => {},
        assets: { store: { removeFile } } as unknown as AssetRuntimeLike,
      });
      const initialize = vi.spyOn(Asset.prototype, 'initialize');
      const save = vi.spyOn(Asset.prototype, 'save');
      try {
        expect(await service.repairDeletions()).toBe(0);
        expect(removeFile).toHaveBeenCalledTimes(1);
        const asset = removeFile.mock.calls[0][0] as Asset;
        expect(asset.constructor).toBe(expected);
        expect(asset).toMatchObject({
          id: 'asset-1',
          tenantId: scope.tenantId,
          sourceUri: 'file:///late-bytes',
        });
        expect(asset.options.db).toBe(db);
        expect(initialize).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
}
