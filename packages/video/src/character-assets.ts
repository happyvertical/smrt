import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { CharacterOwnedAsset } from './character-owned-asset.js';

export interface CharacterOwnedAssetCollectionOptions
  extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class CharacterOwnedAssetCollection extends SmrtJunction<CharacterOwnedAsset> {
  static readonly _itemClass = CharacterOwnedAsset;
  protected leftField = 'characterId';
  protected rightField = 'assetId';
}
