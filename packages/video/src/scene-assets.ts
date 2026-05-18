import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { SceneOwnedAsset } from './scene-owned-asset.js';

export interface SceneOwnedAssetCollectionOptions
  extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class SceneOwnedAssetCollection extends SmrtJunction<SceneOwnedAsset> {
  static readonly _itemClass = SceneOwnedAsset;
  protected leftField = 'sceneId';
  protected rightField = 'assetId';
}
