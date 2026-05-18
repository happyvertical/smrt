import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { PerformerOwnedAsset } from './performer-owned-asset.js';

export interface PerformerOwnedAssetCollectionOptions
  extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class PerformerOwnedAssetCollection extends SmrtJunction<PerformerOwnedAsset> {
  static readonly _itemClass = PerformerOwnedAsset;
  protected leftField = 'performerId';
  protected rightField = 'assetId';
}
