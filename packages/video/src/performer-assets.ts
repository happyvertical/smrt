import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import type { PerformerAssetRole } from './performer-asset.js';
import { PerformerOwnedAsset } from './performer-owned-asset.js';

export interface PerformerOwnedAssetCollectionOptions
  extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class PerformerOwnedAssetCollection extends SmrtCollection<PerformerOwnedAsset> {
  static readonly _itemClass = PerformerOwnedAsset;

  async getForPerformer(
    performerId: string,
    role?: PerformerAssetRole,
  ): Promise<PerformerOwnedAsset[]> {
    const where = role ? { performerId, role } : { performerId };

    return (await this.list({
      where,
      orderBy: 'sort_order ASC',
    })) as PerformerOwnedAsset[];
  }

  async getForAsset(assetId: string): Promise<PerformerOwnedAsset[]> {
    return (await this.list({
      where: { assetId },
      orderBy: 'sort_order ASC',
    })) as PerformerOwnedAsset[];
  }

  async attach(
    performerId: string,
    assetId: string,
    role: PerformerAssetRole = 'reference',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<PerformerOwnedAsset> {
    return (await this.create({
      performerId,
      assetId,
      role,
      sortOrder,
      tenantId,
    })) as PerformerOwnedAsset;
  }

  async detach(
    performerId: string,
    assetId: string,
    role?: PerformerAssetRole,
  ): Promise<void> {
    const where: Record<string, string> = { performerId, assetId };
    if (role) {
      where.role = role;
    }

    const links = (await this.list({ where })) as PerformerOwnedAsset[];
    for (const link of links) {
      await link.delete();
    }
  }
}
