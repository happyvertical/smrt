import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import type { SceneAssetRole } from './scene-asset.js';
import { SceneOwnedAsset } from './scene-owned-asset.js';

export interface SceneOwnedAssetCollectionOptions
  extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class SceneOwnedAssetCollection extends SmrtCollection<SceneOwnedAsset> {
  static readonly _itemClass = SceneOwnedAsset;

  async getForScene(
    sceneId: string,
    role?: SceneAssetRole,
  ): Promise<SceneOwnedAsset[]> {
    const where = role ? { sceneId, role } : { sceneId };

    return (await this.list({
      where,
      orderBy: 'sort_order ASC',
    })) as SceneOwnedAsset[];
  }

  async getForAsset(assetId: string): Promise<SceneOwnedAsset[]> {
    return (await this.list({
      where: { assetId },
      orderBy: 'sort_order ASC',
    })) as SceneOwnedAsset[];
  }

  async attach(
    sceneId: string,
    assetId: string,
    role: SceneAssetRole = 'source',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<SceneOwnedAsset> {
    return (await this.create({
      sceneId,
      assetId,
      role,
      sortOrder,
      tenantId,
    })) as SceneOwnedAsset;
  }

  async detach(
    sceneId: string,
    assetId: string,
    role?: SceneAssetRole,
  ): Promise<void> {
    const where: Record<string, string> = { sceneId, assetId };
    if (role) {
      where.role = role;
    }

    const links = (await this.list({ where })) as SceneOwnedAsset[];
    for (const link of links) {
      await link.delete();
    }
  }
}
